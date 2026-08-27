import { FastifyInstance, FastifyReply } from "fastify";
import fs from "node:fs";
import { db } from "./db";
import { actionResultSchema, ackSchema, agentCreateRoomSchema, attachmentUploadSchema, enrollSchema, heartbeatSchema, identityKeySchema, noticeSchema, proposeActionSchema, sendMessageSchema } from "./types";
import { requireAgentAuth } from "./auth";
import { ATTACHMENT_UPLOAD_BODY_LIMIT, config } from "./config";
import { decodeBase64Strict, isAllowedMime, isImageMime, sanitizeFilename, sniffImageMatches } from "./attachments";
import { evaluateMessageGate, sendGateDenial } from "./message-gate";

/**
 * Stream an attachment to the client with hardened headers. EVERY type is forced
 * to download via Content-Disposition: attachment and X-Content-Type-Options:
 * nosniff + a restrictive CSP, so nothing is ever inline-executed. Only image
 * types are returned with their image/* content-type (for object-URL preview);
 * docs are served as application/octet-stream. Shared by agent + operator routes.
 */
export function sendAttachment(reply: FastifyReply, att: { filename: string; mime: string; storage_path: string }) {
  const contentType = isAllowedMime(att.mime) && isImageMime(att.mime) ? att.mime : "application/octet-stream";
  const safeName = sanitizeFilename(att.filename);
  reply
    .header("Content-Type", contentType)
    .header("Content-Disposition", `attachment; filename="${safeName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`)
    .header("X-Content-Type-Options", "nosniff")          // no MIME sniffing
    .header("Content-Security-Policy", "default-src 'none'; sandbox") // neutralize any HTML/JS
    .header("Cache-Control", "private, no-store");
  return reply.send(fs.createReadStream(att.storage_path));
}

/**
 * Clamp a `?limit=` query param to 1..max, defaulting when absent or unparseable.
 * Truncated to an INTEGER: better-sqlite3 binds 1.5 as a REAL and SQLite rejects
 * a fractional LIMIT with SQLITE_MISMATCH, which would turn `?limit=1.5` into a
 * 500 on a read-only endpoint.
 */
function clampLimit(raw: string | undefined, fallback: number, max = 100): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

export async function registerAgentRoutes(app: FastifyInstance) {
  app.post("/v1/enroll", async (request, reply) => {
    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    // Atomic claim-and-create: a single guarded transaction rejects an already-
    // used / expired / wrong-fleet token (null) before any agent row exists.
    const created = db.createAgentFromEnrollment({
      fleetId: parsed.data.fleet_id,
      token: parsed.data.token,
      displayName: parsed.data.display_name,
      runtime: parsed.data.runtime,
      hostname: parsed.data.hostname
    });
    if (!created) {
      return reply.code(400).send({ error: "invalid or expired token" });
    }

    // Register the agent's own identity key (peer trust); endorsed later by the operator.
    if (parsed.data.identity_public_key) {
      db.setAgentIdentityKey(created.agentId, parsed.data.fleet_id, parsed.data.identity_public_key);
    }

    return reply.send({
      agent_id: created.agentId,
      secret: created.secret,
      relay_base_url: config.baseUrl,
      heartbeat_interval_seconds: config.heartbeatIntervalSeconds,
      poll_interval_seconds: config.pollIntervalSeconds,
      policy_profile: "default",
      // Pin the operator's signing keys at enrollment — the trust bootstrap.
      operator_keys: db.getActiveOperatorKeys(parsed.data.fleet_id).map((k) => ({
        key_id: k.key_id,
        public_key: k.public_key,
        endorsed_by_key_id: k.endorsed_by_key_id,
        endorsement_sig: k.endorsement_sig
      }))
    });
  });

  // An enrolled agent registers (or rotates) its own identity public key. Works
  // for already-enrolled agents that predate enrollment-time registration; the
  // operator then endorses it. Idempotent (re-posting the same key is a no-op).
  app.post("/v1/identity-key", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = identityKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { keyId } = db.setAgentIdentityKey(request.agent.id, request.agent.fleetId, parsed.data.public_key);
    return reply.send({ key_id: keyId });
  });

  // Agent-opened topic room. When two+ agents are collaborating on a real
  // topic, an agent can open a named room and continue there instead of repeated
  // 1:1 direct messages — it's discoverable for the operator and scoped so the
  // rest of the fleet isn't woken. The creating agent is auto-added as a member;
  // member_agent_ids must be real, non-revoked agents in this same fleet (the
  // relay drops anything else), so an agent can't pull in foreign ids.
  app.post("/v1/rooms", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) return reply.code(401).send({ error: "unauthorized" });
    if (request.agent.status === "quarantined" || request.agent.status === "paused") {
      return reply.code(403).send({ error: `agent is ${request.agent.status}` });
    }
    const parsed = agentCreateRoomSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const room = db.createRoom(
      request.agent.fleetId,
      { kind: "agent", id: request.agent.id },
      parsed.data.name,
      parsed.data.member_agent_ids
    );
    return reply.code(201).send(room);
  });

  app.post("/v1/messages", { preHandler: requireAgentAuth }, async (request, reply) => {
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success || !request.agent) {
      return reply.code(400).send({ error: parsed.success ? "unauthorized" : parsed.error.flatten() });
    }

    // Quarantine/pause, rate limit, policy and extension checks live in the
    // shared gate (#59) so the A2A transport enforces the identical set — see
    // message-gate.ts. The rejection shapes below are unchanged.
    const gate = await evaluateMessageGate({
      db,
      agent: request.agent,
      recipientId: parsed.data.recipient.id ?? null,
      messageType: parsed.data.message_type,
      priority: parsed.data.priority,
      body: parsed.data.body as Record<string, unknown>,
      metadata: parsed.data.metadata as Record<string, unknown> | undefined
    });
    if (!gate.allowed) {
      return sendGateDenial(reply, gate);
    }

    // Fold a peer signature into metadata (relayed verbatim). operator_sig is NOT
    // accepted here — the inbox only surfaces it for genuine operator senders.
    const sigMeta =
      parsed.data.agent_sig && parsed.data.key_id && parsed.data.sig_canonical
        ? { agent_sig: parsed.data.agent_sig, key_id: parsed.data.key_id, sig_canonical: parsed.data.sig_canonical }
        : {};

    // Server-side envelope replay guard (#10): claim the signature nonce at
    // ingest, so a captured envelope re-POSTed as a "new" message (fresh relay
    // message_id, fresh transport auth) is refused here instead of relying on
    // each recipient's in-memory nonce set. Recipient-side burning stays as the
    // second line — this claim is per-SENDER, so it does not cover a
    // compromised relay, only what the relay can honestly enforce.
    if (parsed.data.sig_canonical) {
      const rawNonce = (parsed.data.sig_canonical as Record<string, unknown>).nonce;
      // A signed envelope MUST carry a usable nonce or the recipient rejects it
      // ("replay") anyway — but don't let a non-string (e.g. numeric) or empty
      // nonce silently skip the server-side claim and reopen the replay window
      // (#10 follow-up). Normalise string|number to a string; reject anything
      // else on a present sig_canonical.nonce. Absent nonce → nothing to claim
      // (recipient still enforces presence).
      if (rawNonce !== undefined && rawNonce !== null) {
        const nonce = typeof rawNonce === "string" || typeof rawNonce === "number" ? String(rawNonce).trim() : "";
        if (!nonce) {
          return reply.code(400).send({ error: "envelope nonce must be a non-empty string" });
        }
        if (nonce.length > 256) {
          return reply.code(400).send({ error: "envelope nonce too long" });
        }
        if (!db.claimEnvelopeNonce(request.agent.id, nonce)) {
          return reply.code(409).send({ error: "envelope nonce already used (replay)" });
        }
      }
    }
    const mergedMeta = { ...(parsed.data.metadata ?? {}), ...sigMeta };

    let result: { messageId: string; createdAt: string };
    try {
      result = db.createMessage({
        fleetId: request.agent.fleetId,
        senderAgentId: request.agent.id,
        recipientKind: parsed.data.recipient.kind,
        recipientId: parsed.data.recipient.id,
        messageType: parsed.data.message_type,
        priority: parsed.data.priority,
        ttlSeconds: parsed.data.ttl_seconds,
        requiresApproval: parsed.data.requires_approval,
        body: parsed.data.body,
        metadata: Object.keys(mergedMeta).length ? mergedMeta : undefined,
        conversationId: parsed.data.conversation_id,
        correlationId: parsed.data.correlation_id
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return reply.code(404).send({ error: msg });
      if (msg.includes("too many") || msg.includes("unsupported recipient") || msg.includes("recipient/conversation mismatch"))
        return reply.code(400).send({ error: msg });
      throw err;
    }

    return reply.send({ message_id: result.messageId, status: "queued", queued_at: result.createdAt });
  });

  // #22 — sender-side read-back. The send call's own return value is a claim by
  // the component whose failure mode is in question; this is the relay's own
  // answer for a message this agent sent. Scoped to sender_agent_id: an unknown
  // id and another agent's id both 404, so the endpoint never discloses that
  // someone else's message exists.
  app.get("/v1/messages/:message_id/status", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) return reply.code(401).send({ error: "unauthorized" });
    const messageId = String((request.params as { message_id: string }).message_id || "");
    if (!messageId) return reply.code(400).send({ error: "message id required" });
    const status = db.getSentMessageStatus(request.agent.fleetId, request.agent.id, messageId);
    if (!status) return reply.code(404).send({ error: "message not found" });
    return reply.send(status);
  });

  // #17 — the threads this agent has been in, so a session can find the ones its
  // SIBLING sessions used. An Ekho identity is per-box and many sessions share
  // it; "check your own session history" returns a confident false negative.
  app.get("/v1/conversations", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) return reply.code(401).send({ error: "unauthorized" });
    const limit = clampLimit((request.query as { limit?: string }).limit, 25);
    return reply.send({ conversations: db.listAgentConversations(request.agent.fleetId, request.agent.id, limit) });
  });

  // #17 — this agent's own outbound messages. Enough on its own to answer "did I
  // say this?" truthfully across sessions, and to drive a cross-thread
  // correction. `since` is an ISO-8601 instant, exclusive.
  app.get("/v1/sent", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) return reply.code(401).send({ error: "unauthorized" });
    const query = request.query as { since?: string; limit?: string };
    const limit = clampLimit(query.limit, 25);

    let since: string | undefined;
    if (query.since !== undefined) {
      // Reject an unparseable `since` rather than silently ignoring it — a
      // filter that quietly doesn't filter is exactly the false confidence #17
      // is about. Normalised to the stored ISO form so string compare is sound.
      const parsedSince = new Date(query.since);
      if (Number.isNaN(parsedSince.getTime())) {
        return reply.code(400).send({ error: "since must be an ISO-8601 timestamp" });
      }
      since = parsedSince.toISOString();
    }

    return reply.send({
      messages: db.listSentMessages(request.agent.fleetId, request.agent.id, { since, limit }),
      since: since ?? null
    });
  });

  // Upload — raised body limit on THIS route only (Fastify 5 defaults to 1 MB).
  app.post("/v1/attachments", { preHandler: requireAgentAuth, bodyLimit: ATTACHMENT_UPLOAD_BODY_LIMIT }, async (request, reply) => {
    if (!request.agent) return reply.code(401).send({ error: "unauthorized" });
    if (request.agent.status === "quarantined" || request.agent.status === "paused") {
      return reply.code(403).send({ error: `agent is ${request.agent.status}` });
    }
    const parsed = attachmentUploadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { filename, mime, size_bytes, data_base64 } = parsed.data;

    // #7: rate-limit the upload path itself — the message limiter never covered
    // it, so one agent could loop 25 MiB uploads unthrottled.
    const uploadRate = db.checkAndIncrementUploadLimit(request.agent.id, request.agent.fleetId);
    if (!uploadRate.allowed) {
      return reply.code(429).send({ error: "upload rate limit exceeded", retry_after_seconds: config.rateLimitWindowSeconds });
    }

    if (!isAllowedMime(mime)) return reply.code(415).send({ error: "unsupported media type", mime });
    if (size_bytes > config.attachmentMaxBytes) return reply.code(413).send({ error: "declared size exceeds cap", max_bytes: config.attachmentMaxBytes });

    let bytes: Buffer;
    try { bytes = decodeBase64Strict(data_base64); }
    catch { return reply.code(400).send({ error: "invalid base64" }); }

    if (bytes.length > config.attachmentMaxBytes) return reply.code(413).send({ error: "decoded size exceeds cap", max_bytes: config.attachmentMaxBytes });
    if (!sniffImageMatches(mime, bytes)) return reply.code(415).send({ error: "file bytes do not match declared image type" });

    // #7: per-fleet byte quota — the aggregate cap that actually bounds disk use.
    if (db.getFleetAttachmentBytes(request.agent.fleetId) + bytes.length > config.attachmentFleetQuotaBytes) {
      return reply.code(413).send({ error: "fleet attachment quota exceeded", quota_bytes: config.attachmentFleetQuotaBytes });
    }

    const result = db.createAttachment({
      fleetId: request.agent.fleetId,
      uploaderKind: "agent",
      uploaderId: request.agent.id,
      filename: sanitizeFilename(filename),
      mime,
      bytes
    });
    return reply.code(201).send(result); // { id, filename, mime, size_bytes, created_at }
  });

  // Download — HMAC; fleet-scoped. Cross-fleet/miss → 404 (never 403).
  app.get("/v1/attachments/:id", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) return reply.code(401).send({ error: "unauthorized" });
    const { id: attachmentId } = request.params as { id: string };
    const att = db.getAttachment(request.agent.fleetId, attachmentId);
    if (!att || !fs.existsSync(att.storage_path)) return reply.code(404).send({ error: "attachment not found" });
    return sendAttachment(reply, att);
  });

  app.get("/v1/inbox", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const limit = clampLimit((request.query as { limit?: string }).limit, 25);
    return reply.send(db.getInbox(request.agent.id, limit));
  });

  app.post("/v1/acks", { preHandler: requireAgentAuth }, async (request, reply) => {
    const parsed = ackSchema.safeParse(request.body);
    if (!parsed.success || !request.agent) {
      return reply.code(400).send({ error: parsed.success ? "unauthorized" : parsed.error.flatten() });
    }

    const updated = db.ackMessages(request.agent.id, parsed.data.acks);
    return reply.send({ updated });
  });

  // Floor control — an agent acquires a conversation's floor before replying so
  // agents take turns instead of all answering at once. The response carries a
  // fresh catch-up tail; the holder releases when its turn is done (or the TTL
  // auto-releases on crash).
  app.post("/v1/conversations/:id/floor", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) return reply.code(401).send({ error: "unauthorized" });
    const conversationId = String((request.params as { id: string }).id || "");
    if (!conversationId) return reply.code(400).send({ error: "conversation id required" });
    // Only a participant may take the floor or read the catch-up tail (no
    // cross-conversation grief or info disclosure).
    if (!db.isConversationParticipant(request.agent.fleetId, conversationId, request.agent.id)) {
      return reply.code(404).send({ error: "not found" });
    }
    const rawTtl = Number((request.body as { ttl_seconds?: number } | undefined)?.ttl_seconds);
    const ttl = Math.max(0, Math.min(Number.isFinite(rawTtl) ? rawTtl : config.floorTtlSeconds, config.floorTtlMaxSeconds));
    const result = db.acquireFloor(request.agent.fleetId, conversationId, request.agent.id, ttl);
    const conversation_tail = db.getConversationTail(request.agent.fleetId, conversationId, config.floorTailLimit);
    return reply.send({
      granted: result.granted,
      holder_agent_id: result.holderAgentId,
      expires_at: result.expiresAt,
      conversation_tail
    });
  });

  app.delete("/v1/conversations/:id/floor", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) return reply.code(401).send({ error: "unauthorized" });
    const conversationId = String((request.params as { id: string }).id || "");
    if (!db.isConversationParticipant(request.agent.fleetId, conversationId, request.agent.id)) {
      return reply.code(404).send({ error: "not found" });
    }
    const released = db.releaseFloor(request.agent.fleetId, conversationId, request.agent.id);
    return reply.send({ released });
  });

  // An agent raises an operator-visible notice when a conversation stalls — the
  // peer-turn budget is exhausted and a real peer message was withheld. Recorded
  // as a `conversation.stalled` event (surfaced via /v1/operator/events), so the
  // operator can re-engage. Idempotent per (fleet, agent, conversation) until the
  // next operator message re-opens the conversation, so a repeating poll loop can
  // call it every tick without flooding the feed.
  app.post("/v1/notices", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) return reply.code(401).send({ error: "unauthorized" });
    const parsed = noticeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = db.recordConversationStall(request.agent.fleetId, request.agent.id, parsed.data.conversation_id, {
      reason: parsed.data.reason,
      pending_count: parsed.data.pending_count,
      budget: parsed.data.budget
    });
    return reply.send({ ok: true, recorded: result.recorded });
  });

  app.post("/v1/heartbeats", { preHandler: requireAgentAuth }, async (request, reply) => {
    const parsed = heartbeatSchema.safeParse(request.body);
    if (!parsed.success || !request.agent) {
      return reply.code(400).send({ error: parsed.success ? "unauthorized" : parsed.error.flatten() });
    }

    db.insertHeartbeat(request.agent.id, parsed.data.status, {
      active_conversation_ids: parsed.data.active_conversation_ids,
      metrics: parsed.data.metrics
    });
    return reply.send({ ok: true, next_heartbeat_due_seconds: config.heartbeatIntervalSeconds });
  });

  app.post("/v1/actions/propose", { preHandler: requireAgentAuth }, async (request, reply) => {
    const parsed = proposeActionSchema.safeParse(request.body);
    if (!parsed.success || !request.agent) {
      return reply.code(400).send({ error: parsed.success ? "unauthorized" : parsed.error.flatten() });
    }

    const result = db.proposeAction({
      agentId: request.agent.id,
      conversationId: parsed.data.conversation_id,
      actionType: parsed.data.action_type,
      summary: parsed.data.summary,
      riskLevel: parsed.data.risk_level,
      payload: parsed.data.payload
    });
    return reply.send(result.decision === "pending_approval" ? { decision: result.decision, approval_id: result.approvalId } : result);
  });

  app.post("/v1/actions/result", { preHandler: requireAgentAuth }, async (request, reply) => {
    const parsed = actionResultSchema.safeParse(request.body);
    if (!parsed.success || !request.agent) {
      return reply.code(parsed.success ? 401 : 400).send({ error: parsed.success ? "unauthorized" : parsed.error.flatten() });
    }

    const ok = db.completeActionResult(parsed.data.approval_id, request.agent.fleetId, request.agent.id, parsed.data.result, parsed.data.output);
    return reply.send({ ok });
  });

  app.get("/v1/actions/:approvalId", { preHandler: requireAgentAuth }, async (request, reply) => {
    if (!request.agent) return reply.code(401).send({ error: "unauthorized" });
    const params = request.params as { approvalId: string };
    const approval = db.getApprovalStatus(params.approvalId, request.agent.fleetId, request.agent.id);
    if (!approval) {
      return reply.code(404).send({ error: "approval not found" });
    }
    return reply.send(approval);
  });
}

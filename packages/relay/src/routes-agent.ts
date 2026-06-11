import { FastifyInstance, FastifyReply } from "fastify";
import fs from "node:fs";
import { db } from "./db";
import { actionResultSchema, ackSchema, attachmentUploadSchema, enrollSchema, heartbeatSchema, identityKeySchema, proposeActionSchema, sendMessageSchema } from "./types";
import { requireAgentAuth } from "./auth";
import { ATTACHMENT_UPLOAD_BODY_LIMIT, config } from "./config";
import { decodeBase64Strict, isAllowedMime, isImageMime, sanitizeFilename, sniffImageMatches } from "./attachments";
import { getExtensions } from "./license";

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

export async function registerAgentRoutes(app: FastifyInstance) {
  app.post("/v1/enroll", async (request, reply) => {
    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const token = db.consumeEnrollmentToken(parsed.data.token, parsed.data.fleet_id);
    if (!token) {
      return reply.code(400).send({ error: "invalid or expired token" });
    }

    const created = db.createAgentFromEnrollment({
      fleetId: parsed.data.fleet_id,
      tokenId: String(token.id),
      displayName: parsed.data.display_name,
      runtime: parsed.data.runtime,
      hostname: parsed.data.hostname
    });

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

  app.post("/v1/messages", { preHandler: requireAgentAuth }, async (request, reply) => {
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success || !request.agent) {
      return reply.code(400).send({ error: parsed.success ? "unauthorized" : parsed.error.flatten() });
    }

    if (request.agent.status === "quarantined" || request.agent.status === "paused") {
      return reply.code(403).send({ error: `agent is ${request.agent.status}` });
    }

    const rateCheck = db.checkAndIncrementRateLimit(request.agent.id, request.agent.fleetId);
    if (!rateCheck.allowed) {
      const retryAfter = config.rateLimitWindowSeconds;
      return reply.code(429).send({ error: "rate limit exceeded", retry_after_seconds: retryAfter });
    }

    const policyResult = db.evaluateMessagePolicies(
      request.agent.fleetId,
      request.agent.id,
      parsed.data.recipient.id ?? null,
      parsed.data.message_type,
      parsed.data.priority
    );
    if (!policyResult.allowed) {
      return reply.code(403).send({ error: "blocked by policy", policy: policyResult.deniedByPolicy });
    }

    for (const ext of getExtensions()) {
      if (ext.onBeforeMessage) {
        try {
          await ext.onBeforeMessage({
            fleetId: request.agent.fleetId,
            senderAgentId: request.agent.id,
            recipientId: parsed.data.recipient.id ?? null,
            messageType: parsed.data.message_type,
            priority: parsed.data.priority,
            body: parsed.data.body as Record<string, unknown>,
            metadata: parsed.data.metadata as Record<string, unknown> | undefined
          });
        } catch (err) {
          return reply.code(403).send({ error: `blocked by extension ${ext.name}: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }

    // Fold a peer signature into metadata (relayed verbatim). operator_sig is NOT
    // accepted here — the inbox only surfaces it for genuine operator senders.
    const sigMeta =
      parsed.data.agent_sig && parsed.data.key_id && parsed.data.sig_canonical
        ? { agent_sig: parsed.data.agent_sig, key_id: parsed.data.key_id, sig_canonical: parsed.data.sig_canonical }
        : {};
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
      if (msg.includes("too many") || msg.includes("unsupported recipient")) return reply.code(400).send({ error: msg });
      throw err;
    }

    return reply.send({ message_id: result.messageId, status: "queued", queued_at: result.createdAt });
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

    if (!isAllowedMime(mime)) return reply.code(415).send({ error: "unsupported media type", mime });
    if (size_bytes > config.attachmentMaxBytes) return reply.code(413).send({ error: "declared size exceeds cap", max_bytes: config.attachmentMaxBytes });

    let bytes: Buffer;
    try { bytes = decodeBase64Strict(data_base64); }
    catch { return reply.code(400).send({ error: "invalid base64" }); }

    if (bytes.length > config.attachmentMaxBytes) return reply.code(413).send({ error: "decoded size exceeds cap", max_bytes: config.attachmentMaxBytes });
    if (!sniffImageMatches(mime, bytes)) return reply.code(415).send({ error: "file bytes do not match declared image type" });

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

    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Number(query.limit), 100) : 25;
    return reply.send(db.getInbox(request.agent.id, Number.isFinite(limit) ? limit : 25));
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
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const ok = db.completeActionResult(parsed.data.approval_id, parsed.data.result, parsed.data.output);
    return reply.send({ ok });
  });

  app.get("/v1/actions/:approvalId", { preHandler: requireAgentAuth }, async (request, reply) => {
    const params = request.params as { approvalId: string };
    const approval = db.getApprovalStatus(params.approvalId);
    if (!approval) {
      return reply.code(404).send({ error: "approval not found" });
    }
    return reply.send(approval);
  });
}

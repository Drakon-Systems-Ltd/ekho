import { FastifyInstance } from "fastify";
import fs from "node:fs";
import { ATTACHMENT_UPLOAD_BODY_LIMIT, config } from "./config";
import { requireOperatorAuth } from "./auth";
import { db } from "./db";
import { evaluateTailnetGate, tailnetLoginFromHeaders } from "./tailnet";
import { attachmentUploadSchema, createFeedSchema, createPolicySchema, createRoomSchema, endorseAgentKeySchema, endorseOperatorKeySchema, feedSubscribersSchema, operatorControlSchema, operatorKeySchema, operatorLoginSchema, operatorMessageSchema, operatorProfileSchema, operatorTrustSchema, peerAutoreplySchema, projectModeSchema, resumeConversationSchema, updatePolicySchema } from "./types";
import { fetchFeedUrl, isAllowedFeedUrl } from "./feeds";
import { decodeBase64Strict, isAllowedMime, sanitizeFilename, sniffImageMatches } from "./attachments";
import { sendAttachment } from "./routes-agent";
import { loginThrottle, resolveClientIp } from "./login-throttle";
import { issueOperatorSession } from "./operator-session";
import { sign } from "./utils";

function parsePagination(query: Record<string, unknown>) {
  const limitRaw = Number(query.limit ?? 20);
  const pageRaw = Number(query.page ?? 1);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 20;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { limit, page, offset: (page - 1) * limit };
}

export async function registerOperatorRoutes(app: FastifyInstance) {
  app.post("/v1/operator/login", async (request, reply) => {
    // Tailnet gate first: don't even process credentials off-tailnet.
    const gate = evaluateTailnetGate({
      require: config.operatorRequireTailnet,
      allowedUser: config.operatorTailnetUser,
      login: tailnetLoginFromHeaders(request.headers as Record<string, unknown>)
    });
    if (!gate.allowed) {
      return reply.code(403).send({ error: gate.reason });
    }

    const parsed = operatorLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    // Brute-force throttle: check BEFORE spending a scrypt verification, so a
    // flood of guesses can't also be used as a CPU exhaustion lever.
    // request.ip is the raw socket peer (trustProxy is deliberately unset);
    // resolveClientIp unwraps the one trusted forwarding hop. See #8.
    const clientIp = resolveClientIp(request.ip, request.headers["x-forwarded-for"]);
    const gateDecision = loginThrottle.check(parsed.data.fleet_name, parsed.data.email, clientIp);
    if (!gateDecision.allowed) {
      reply.header("Retry-After", String(gateDecision.retryAfterSeconds ?? 60));
      return reply.code(429).send({ error: "too many failed login attempts" });
    }

    const operator = db.authenticateOperator(parsed.data.fleet_name, parsed.data.email, parsed.data.password);
    if (!operator) {
      loginThrottle.recordFailure(parsed.data.fleet_name, parsed.data.email, clientIp);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    loginThrottle.recordSuccess(parsed.data.fleet_name, parsed.data.email);

    return reply.send({
      token: issueOperatorSession(
        config.operatorSessionSecret,
        String(operator.id),
        String(operator.fleet_id),
        Math.floor(Date.now() / 1000)
      ),
      expires_in: config.operatorSessionTtlSeconds,
      fleet_id: operator.fleet_id,
      display_name: (operator as Record<string, unknown>).display_name ?? null
    });
  });

  // Operator profile: the team-visible display name. GET on load (the token in
  // localStorage survives reloads, so the name must be refetchable), PATCH to set.
  app.get("/v1/operator/profile", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const profile = db.getOperatorProfile(request.operator.id);
    if (!profile) return reply.code(404).send({ error: "operator not found" });
    return reply.send(profile);
  });

  app.patch("/v1/operator/profile", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const parsed = operatorProfileSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const profile = db.setOperatorDisplayName(request.operator.id, parsed.data.display_name);
    if (!profile) return reply.code(404).send({ error: "operator not found" });
    return reply.send(profile);
  });

  app.get("/v1/operator/overview", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send(db.getFleetOverview(request.operator.fleetId));
  });

  app.get("/v1/operator/fleet-health", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send({ agents: db.getFleetHealth(request.operator.fleetId) });
  });

  app.get("/v1/operator/attention", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send(db.getAttentionItems(request.operator.fleetId));
  });

  app.get("/v1/operator/topology", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as Record<string, unknown>;
    const rawWindow = Number(query.window_minutes ?? 60);
    const windowMinutes = Number.isFinite(rawWindow) ? Math.max(5, Math.min(1440, Math.trunc(rawWindow))) : 60;
    return reply.send(db.getTopology(request.operator.fleetId, { windowMinutes }));
  });

  app.get("/v1/operator/activity", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as Record<string, unknown>;
    const rawLimit = Number(query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.trunc(rawLimit))) : 50;
    const type = typeof query.type === "string" && query.type ? query.type : undefined;
    return reply.send({ events: db.getActivity(request.operator.fleetId, { limit, type }) });
  });

  app.get("/v1/operator/agents", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as Record<string, unknown>;
    const { limit, page, offset } = parsePagination(query);
    const result = db.listAgents(request.operator.fleetId, {
      search: typeof query.search === "string" ? query.search : undefined,
      status: typeof query.status === "string" ? query.status : undefined,
      sortBy: typeof query.sortBy === "string" ? query.sortBy : undefined,
      sortOrder: typeof query.sortOrder === "string" ? query.sortOrder : undefined,
      limit,
      offset
    });
    return reply.send({ agents: result.items, total: result.total, page, limit });
  });

  app.get("/v1/operator/approvals", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as Record<string, unknown>;
    const { limit, page, offset } = parsePagination(query);
    const result = db.listPendingApprovals(request.operator.fleetId, {
      search: typeof query.search === "string" ? query.search : undefined,
      risk: typeof query.risk === "string" ? query.risk : undefined,
      dateFrom: typeof query.dateFrom === "string" ? query.dateFrom : undefined,
      dateTo: typeof query.dateTo === "string" ? query.dateTo : undefined,
      sortBy: typeof query.sortBy === "string" ? query.sortBy : undefined,
      sortOrder: typeof query.sortOrder === "string" ? query.sortOrder : undefined,
      limit,
      offset
    });
    return reply.send({ approvals: result.items, total: result.total, page, limit });
  });

  app.get("/v1/operator/events", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as Record<string, unknown>;
    const { limit, page, offset } = parsePagination(query);
    const result = db.listEvents(request.operator.fleetId, {
      search: typeof query.search === "string" ? query.search : undefined,
      type: typeof query.type === "string" ? query.type : undefined,
      dateFrom: typeof query.dateFrom === "string" ? query.dateFrom : undefined,
      dateTo: typeof query.dateTo === "string" ? query.dateTo : undefined,
      sortBy: typeof query.sortBy === "string" ? query.sortBy : undefined,
      sortOrder: typeof query.sortOrder === "string" ? query.sortOrder : undefined,
      limit,
      offset
    });
    return reply.send({ events: result.items, total: result.total, page, limit });
  });

  app.post("/v1/operator/enrollment-tokens", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const token = db.issueEnrollmentToken(request.operator.fleetId, request.operator.id);
    return reply.send({ token });
  });

  // ---- Operator signing keys (verifiable operator identity) ----------------

  app.get("/v1/operator/keys", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send({ keys: db.listOperatorKeys(request.operator.fleetId) });
  });

  // Fleet agent identity keys — drives the Security screen's endorse-agents panel.
  app.get("/v1/operator/agent-keys", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send({ keys: db.getAgentIdentityKeys(request.operator.fleetId) });
  });

  app.post("/v1/operator/keys", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = operatorKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { public_key, label, endorsement } = parsed.data;
    try {
      const { keyId } = db.registerOperatorKey(
        request.operator.fleetId,
        public_key,
        label,
        endorsement && {
          endorsedByKeyId: endorsement.endorsed_by_key_id,
          signature: endorsement.signature
        },
        request.operator.id
      );
      return reply.code(201).send({ key_id: keyId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already registered")) return reply.code(409).send({ error: msg });
      // endorsement / unknown-key / bad-signature are all client errors.
      return reply.code(400).send({ error: msg });
    }
  });

  // #19: endorse an already-registered key from a device that holds a live one.
  // Recovery path for a device whose key was revoked: it can mint a new key but
  // never endorse it (no live seed in that browser), so the healthy device signs
  // for it and agents chain-adopt on their next poll.
  app.post("/v1/operator/keys/:keyId/endorse", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { keyId } = request.params as { keyId: string };
    const parsed = endorseOperatorKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      db.endorseOperatorKey(
        request.operator.fleetId,
        keyId,
        {
          endorsedByKeyId: parsed.data.endorsed_by_key_id,
          signature: parsed.data.signature
        },
        parsed.data.endorsed_by_key_id
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return reply.code(404).send({ error: msg });
      // revoked target/endorser, self-endorsement and bad signatures are all
      // client errors — the caller sent something it should not have.
      return reply.code(400).send({ error: msg });
    }
    return reply.send({ endorsed: true, key_id: keyId, endorsed_by_key_id: parsed.data.endorsed_by_key_id });
  });

  app.delete("/v1/operator/keys/:keyId", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { keyId } = request.params as { keyId: string };
    // #53: the audit actor is the AUTHENTICATED session, never the query string.
    // Sourcing actor_id from ?actor_key_id= let any operator session mint a
    // revoke attributed to another device's key. The claimed id is still useful
    // for debugging ("which browser fired this?"), so it is kept in the payload
    // — clearly labelled as unverified, where nothing reads it as identity.
    const query = request.query as { actor_key_id?: string } | undefined;
    const claimedActorKeyId =
      typeof query?.actor_key_id === "string" && query.actor_key_id ? query.actor_key_id : null;
    const revoked = db.revokeOperatorKey(
      request.operator.fleetId,
      keyId,
      request.operator.id,
      claimedActorKeyId
    );
    if (!revoked) return reply.code(404).send({ error: "key not found" });
    return reply.send({ revoked: true });
  });

  // Operator endorses an agent's identity key — roots peer trust at the operator.
  app.post("/v1/operator/agents/:agentId/endorse-key", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = endorseAgentKeySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { agentId } = request.params as { agentId: string };
    try {
      const ok = db.endorseAgentKey(
        request.operator.fleetId,
        agentId,
        parsed.data.key_id,
        {
          endorsedByKeyId: parsed.data.endorsed_by_key_id,
          signature: parsed.data.signature
        },
        parsed.data.endorsed_by_key_id
      );
      if (!ok) return reply.code(404).send({ error: "agent identity key not found" });
      return reply.send({ endorsed: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return reply.code(404).send({ error: msg });
      return reply.code(400).send({ error: msg });
    }
  });

  app.post("/v1/operator/messages", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = operatorMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    // Guard canonical channel ids: a client may only post into dm-<fleet>-<recipient>
    // for the agent it is actually addressing — never another agent's or fleet's DM
    // by naming the id. grp- keys are display-only and never a real send target.
    const convId = parsed.data.conversation_id;
    if (convId && convId.startsWith("dm-") && convId !== `dm-${request.operator.fleetId}-${parsed.data.recipient_agent_id}`) {
      return reply.code(400).send({ error: "conversation_id does not match the addressed agent's DM" });
    }
    if (convId && convId.startsWith("grp-")) {
      return reply.code(400).send({ error: "grp- is a display channel, not a send target" });
    }
    let result: { messageId: string; conversationId: string; createdAt: string };
    try {
      const { operator_sig, key_id, sig_canonical } = parsed.data;
      const signature =
        operator_sig && key_id && sig_canonical
          ? { sig: operator_sig, keyId: key_id, canonical: sig_canonical }
          : undefined;
      result = db.createOperatorMessage({
        fleetId: request.operator.fleetId,
        operatorId: request.operator.id,
        recipientId: parsed.data.recipient_agent_id,
        roomId: parsed.data.room_id,
        text: parsed.data.text,
        conversationId: parsed.data.conversation_id,
        attachmentIds: parsed.data.attachment_ids,
        mentions: parsed.data.mentions,
        replyTo: parsed.data.reply_to,
        signature
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return reply.code(404).send({ error: msg });
      if (msg.includes("too many")) return reply.code(400).send({ error: msg });
      throw err;
    }
    return reply.code(201).send({ message_id: result.messageId, conversation_id: result.conversationId, queued_at: result.createdAt });
  });

  // Upload — raised body limit on THIS route only (Fastify 5 defaults to 1 MB).
  app.post("/v1/operator/attachments", { preHandler: requireOperatorAuth, bodyLimit: ATTACHMENT_UPLOAD_BODY_LIMIT }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
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

    // #7: operator uploads land on the same disk — same fleet quota and their
    // own upload rate budget (keyed on the operator id).
    const uploadRate = db.checkAndIncrementUploadLimit(request.operator.id, request.operator.fleetId);
    if (!uploadRate.allowed) {
      return reply.code(429).send({ error: "upload rate limit exceeded", retry_after_seconds: config.rateLimitWindowSeconds });
    }
    if (db.getFleetAttachmentBytes(request.operator.fleetId) + bytes.length > config.attachmentFleetQuotaBytes) {
      return reply.code(413).send({ error: "fleet attachment quota exceeded", quota_bytes: config.attachmentFleetQuotaBytes });
    }

    const result = db.createAttachment({
      fleetId: request.operator.fleetId,
      uploaderKind: "operator",
      uploaderId: request.operator.id,
      filename: sanitizeFilename(filename),
      mime,
      bytes
    });
    return reply.code(201).send(result); // { id, filename, mime, size_bytes, created_at }
  });

  // Download — fleet-scoped. Cross-fleet/miss → 404 (never 403).
  app.get("/v1/operator/attachments/:id", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const { id: attachmentId } = request.params as { id: string };
    const att = db.getAttachment(request.operator.fleetId, attachmentId);
    if (!att || !fs.existsSync(att.storage_path)) return reply.code(404).send({ error: "attachment not found" });
    return sendAttachment(reply, att);
  });

  app.get("/v1/operator/conversations/:conversationId", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const params = request.params as { conversationId: string };
    const query = request.query as Record<string, unknown>;
    const { limit, page, offset } = parsePagination(query);
    const result = db.getConversation(request.operator.fleetId, params.conversationId, {
      search: typeof query.search === "string" ? query.search : undefined,
      type: typeof query.type === "string" ? query.type : undefined,
      dateFrom: typeof query.dateFrom === "string" ? query.dateFrom : undefined,
      dateTo: typeof query.dateTo === "string" ? query.dateTo : undefined,
      sortBy: typeof query.sortBy === "string" ? query.sortBy : undefined,
      sortOrder: typeof query.sortOrder === "string" ? query.sortOrder : undefined,
      // Keyset cursor for infinite scroll-back: return events strictly older
      // than (before_at, before_id).
      beforeAt: typeof query.before_at === "string" ? query.before_at : undefined,
      beforeId: typeof query.before_id === "string" ? query.before_id : undefined,
      limit,
      offset
    });
    return reply.send({ events: result.items, total: result.total, page, limit });
  });

  app.get("/v1/operator/agents/:agentId", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const params = request.params as { agentId: string };
    const detail = db.getAgentDetail(request.operator.fleetId, params.agentId);
    if (!detail) {
      return reply.code(404).send({ error: "agent not found" });
    }
    return reply.send(detail);
  });

  app.post("/v1/operator/approvals/:approvalId/:decision", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const params = request.params as { approvalId: string; decision: string };
    if (params.decision !== "approve" && params.decision !== "reject") {
      return reply.code(400).send({ error: "unsupported decision" });
    }
    const ok = db.approveOrReject(params.approvalId, request.operator.fleetId, request.operator.id, params.decision === "approve" ? "approved" : "rejected");
    return reply.send({ ok });
  });

  app.post("/v1/operator/agents/:agentId/trust", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = operatorTrustSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const params = request.params as { agentId: string };
    const result = db.setAgentTrust(request.operator.fleetId, params.agentId, request.operator.id, parsed.data.trusted);
    if (result === null) {
      return reply.code(404).send({ error: "agent not found" });
    }

    return reply.send({ agent_id: params.agentId, operator_trusted: result });
  });

  // Toggle bounded agent-to-agent delegation (+ optional turn budget) per agent.
  // The agent reads both live on its next inbox poll — no restart.
  app.post("/v1/operator/agents/:agentId/peer-autoreply", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = peerAutoreplySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const params = request.params as { agentId: string };
    const result = db.setPeerAutoreply(
      request.operator.fleetId,
      params.agentId,
      request.operator.id,
      parsed.data.autoreply,
      parsed.data.budget
    );
    if (result === null) {
      return reply.code(404).send({ error: "agent not found" });
    }

    return reply.send({ agent_id: params.agentId, ...result });
  });

  // Rooms — named conversations with a chosen set of member agents.
  app.get("/v1/operator/rooms", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    return reply.send({ rooms: db.listRooms(request.operator.fleetId) });
  });

  app.post("/v1/operator/rooms", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const parsed = createRoomSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const room = db.createRoom(request.operator.fleetId, { kind: "operator", id: request.operator.id }, parsed.data.name, parsed.data.member_agent_ids);
    return reply.code(201).send(room);
  });

  app.delete("/v1/operator/rooms/:roomId", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const params = request.params as { roomId: string };
    const ok = db.deleteRoom(request.operator.fleetId, params.roomId, request.operator.id);
    if (!ok) return reply.code(404).send({ error: "room not found" });
    return reply.send({ ok: true });
  });

  // Project mode: a higher per-room peer budget for designated working rooms.
  // Members read the override live on their next inbox poll — no restart.
  app.post("/v1/operator/rooms/:roomId/project-mode", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const parsed = projectModeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const params = request.params as { roomId: string };
    const result = db.setRoomProjectMode(
      request.operator.fleetId,
      params.roomId,
      request.operator.id,
      parsed.data.enabled,
      parsed.data.budget
    );
    if (result === null) return reply.code(404).send({ error: "room not found" });
    return reply.send({ room_id: params.roomId, ...result });
  });

  // One-click resume for a thread that stalled on budget exhaustion: a relay-
  // minted operator nudge re-opens every participant's latch, wakes them, and —
  // as operator engagement — re-arms the once-per-close stall escalation.
  app.post("/v1/operator/conversations/:conversationId/resume", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const parsed = resumeConversationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const params = request.params as { conversationId: string };
    const result = db.resumeConversation(request.operator.fleetId, request.operator.id, params.conversationId, parsed.data.text);
    if (result === null) return reply.code(404).send({ error: "conversation not found" });
    return reply.code(201).send({
      message_id: result.messageId,
      conversation_id: result.conversationId,
      queued_at: result.createdAt
    });
  });

  // Feeds — operator-configured sources delivered to subscribed agents as
  // non-waking context.
  app.get("/v1/operator/feeds", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    return reply.send({ feeds: db.listFeeds(request.operator.fleetId) });
  });

  app.post("/v1/operator/feeds", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const parsed = createFeedSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!isAllowedFeedUrl(parsed.data.url)) {
      return reply.code(400).send({ error: "feed url must be a public http(s) address" });
    }
    const feed = db.createFeed(
      request.operator.fleetId,
      request.operator.id,
      parsed.data.name,
      parsed.data.url,
      parsed.data.poll_interval_minutes,
      parsed.data.subscriber_agent_ids
    );
    return reply.code(201).send(feed);
  });

  app.delete("/v1/operator/feeds/:feedId", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const params = request.params as { feedId: string };
    const ok = db.deleteFeed(request.operator.fleetId, params.feedId, request.operator.id);
    if (!ok) return reply.code(404).send({ error: "feed not found" });
    return reply.send({ ok: true });
  });

  app.post("/v1/operator/feeds/:feedId/subscribers", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const parsed = feedSubscribersSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const params = request.params as { feedId: string };
    const ok = db.setFeedSubscribers(request.operator.fleetId, params.feedId, request.operator.id, parsed.data.agent_ids);
    if (!ok) return reply.code(404).send({ error: "feed not found" });
    return reply.send({ ok: true });
  });

  app.post("/v1/operator/feeds/:feedId/poll", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const params = request.params as { feedId: string };
    // Scope the feed to the operator's fleet before polling.
    const items = db.getFeedItems(request.operator.fleetId, params.feedId, 1);
    if (items === null) return reply.code(404).send({ error: "feed not found" });
    const result = await db.pollFeed(params.feedId, fetchFeedUrl);
    return reply.send(result);
  });

  app.get("/v1/operator/feeds/:feedId/items", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const params = request.params as { feedId: string };
    const items = db.getFeedItems(request.operator.fleetId, params.feedId, 50);
    if (items === null) return reply.code(404).send({ error: "feed not found" });
    return reply.send({ items });
  });

  app.post("/v1/operator/agents/:agentId/:action", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const parsed = operatorControlSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const params = request.params as { agentId: string; action: string };
    if (params.action !== "pause" && params.action !== "resume" && params.action !== "quarantine") {
      return reply.code(400).send({ error: "unsupported action" });
    }

    const ok = db.controlAgent(request.operator.fleetId, params.agentId, request.operator.id, params.action, {
      reason: parsed.data.reason,
      expires_at: parsed.data.expires_at ?? null,
      redirect_agent_id: parsed.data.redirect_agent_id ?? null
    });
    if (!ok) {
      return reply.code(404).send({ error: "agent not found" });
    }

    return reply.send({ ok });
  });

  // --- Policy CRUD ---

  app.get("/v1/operator/policies", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const policies = db.listPolicies(request.operator.fleetId);
    return reply.send({ policies });
  });

  app.post("/v1/operator/policies", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const parsed = createPolicySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = db.createPolicy(request.operator.fleetId, {
      name: parsed.data.name,
      scopeKind: parsed.data.scope_kind,
      scopeId: parsed.data.scope_id,
      rule: parsed.data.rule,
      enabled: parsed.data.enabled
    });
    return reply.code(201).send(result);
  });

  app.put("/v1/operator/policies/:policyId", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const params = request.params as { policyId: string };
    const parsed = updatePolicySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const ok = db.updatePolicy(params.policyId, request.operator.fleetId, {
      name: parsed.data.name,
      scopeKind: parsed.data.scope_kind,
      scopeId: parsed.data.scope_id,
      rule: parsed.data.rule,
      enabled: parsed.data.enabled
    });
    if (!ok) return reply.code(404).send({ error: "policy not found" });
    return reply.send({ ok: true });
  });

  app.delete("/v1/operator/policies/:policyId", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const params = request.params as { policyId: string };
    const ok = db.deletePolicy(params.policyId, request.operator.fleetId);
    if (!ok) return reply.code(404).send({ error: "policy not found" });
    return reply.send({ ok: true });
  });

  // --- Dead letters ---

  app.get("/v1/operator/dead-letters", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const query = request.query as Record<string, unknown>;
    const { limit, page, offset } = parsePagination(query);
    const result = db.listDeadLetters(request.operator.fleetId, { limit, offset });
    return reply.send({ dead_letters: result.items, total: result.total, page, limit });
  });

  app.get("/v1/operator/dead-letters/:id", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const params = request.params as { id: string };
    const dl = db.getDeadLetterDetail(request.operator.fleetId, params.id);
    if (!dl) return reply.code(404).send({ error: "dead letter not found" });
    return reply.send(dl);
  });

  // --- Rate limit history ---

  app.get("/v1/operator/agents/:agentId/rate-limits", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) return reply.code(401).send({ error: "unauthorized" });
    const params = request.params as { agentId: string };
    const violations = db.getAgentRateLimitHistory(request.operator.fleetId, params.agentId);
    return reply.send({ violations });
  });
}

import { FastifyInstance } from "fastify";
import { db } from "./db";
import { actionResultSchema, ackSchema, enrollSchema, heartbeatSchema, proposeActionSchema, sendMessageSchema } from "./types";
import { requireAgentAuth } from "./auth";
import { config } from "./config";

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

    return reply.send({
      agent_id: created.agentId,
      secret: created.secret,
      relay_base_url: config.baseUrl,
      heartbeat_interval_seconds: config.heartbeatIntervalSeconds,
      poll_interval_seconds: config.pollIntervalSeconds,
      policy_profile: "default"
    });
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

    const result = db.createMessage({
      fleetId: request.agent.fleetId,
      senderAgentId: request.agent.id,
      recipientKind: parsed.data.recipient.kind,
      recipientId: parsed.data.recipient.id,
      messageType: parsed.data.message_type,
      priority: parsed.data.priority,
      ttlSeconds: parsed.data.ttl_seconds,
      requiresApproval: parsed.data.requires_approval,
      body: parsed.data.body,
      metadata: parsed.data.metadata,
      conversationId: parsed.data.conversation_id,
      correlationId: parsed.data.correlation_id
    });

    return reply.send({ message_id: result.messageId, status: "queued", queued_at: result.createdAt });
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

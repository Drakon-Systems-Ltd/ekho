import { FastifyInstance } from "fastify";
import { config } from "./config";
import { requireOperatorAuth } from "./auth";
import { db } from "./db";
import { createPolicySchema, operatorControlSchema, operatorLoginSchema, updatePolicySchema } from "./types";
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
    const parsed = operatorLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const operator = db.authenticateOperator(parsed.data.fleet_name, parsed.data.email, parsed.data.password);
    if (!operator) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const tokenCore = `${operator.id}.${operator.fleet_id}`;
    return reply.send({
      token: `${tokenCore}.${sign(config.operatorSessionSecret, tokenCore)}`,
      fleet_id: operator.fleet_id
    });
  });

  app.get("/v1/operator/overview", { preHandler: requireOperatorAuth }, async (request, reply) => {
    if (!request.operator) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.send(db.getFleetOverview(request.operator.fleetId));
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
    const ok = db.approveOrReject(params.approvalId, request.operator.id, params.decision === "approve" ? "approved" : "rejected");
    return reply.send({ ok });
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

    const ok = db.controlAgent(params.agentId, request.operator.id, params.action, {
      reason: parsed.data.reason,
      expires_at: parsed.data.expires_at ?? null,
      redirect_agent_id: parsed.data.redirect_agent_id ?? null
    });

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

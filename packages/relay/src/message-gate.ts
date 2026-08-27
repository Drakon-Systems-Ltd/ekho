/**
 * The admission gate every agent-originated message must clear before it becomes
 * an Ekho message.
 *
 * #59: these checks used to live inline in POST /v1/messages only. The A2A
 * transport reached `db.createMessage` directly, so a quarantined agent, an agent
 * over its rate limit, or a sender a policy explicitly denies could still deliver
 * by switching from `/v1/messages` to `/a2a` — the same fleet, the same delivery
 * machinery, none of the controls. docs/a2a.md advertised the opposite.
 *
 * Both transports now call `evaluateMessageGate`, so a new check added here is
 * enforced on every path by construction and the two cannot drift. The verdict is
 * transport-neutral: `sendGateDenial` renders it as the existing REST responses,
 * and the A2A layer maps the same verdict onto JSON-RPC error codes.
 */
import type { FastifyReply } from "fastify";
import { config } from "./config";
import type { EkhoDb } from "./db";
import { getExtensions } from "./license";

export type MessageGateDenial =
  /** Sender is quarantined or paused — it may authenticate, but it may not send. */
  | { kind: "sender_status"; status: string }
  /** Sender exceeded its per-window message allowance. */
  | { kind: "rate_limit"; current: number; limit: number; retryAfterSeconds: number }
  /** A fleet/agent-scoped policy denied this sender→recipient/type/priority. */
  | { kind: "policy"; policy?: string }
  /** A licensed extension's onBeforeMessage hook rejected the message. */
  | { kind: "extension"; extension: string; reason: string };

export type MessageGateVerdict = { allowed: true } | ({ allowed: false } & MessageGateDenial);

export interface MessageGateInput {
  db: EkhoDb;
  /** The AUTHENTICATED sender — status comes from the agents row, never the request. */
  agent: { id: string; fleetId: string; status: string };
  recipientId: string | null;
  messageType: string;
  priority: string;
  body: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Run the checks in the order POST /v1/messages has always run them: cheapest and
 * most absolute first (status), then the counter that must be incremented exactly
 * once per attempt (rate limit), then policy, then extensions.
 */
export async function evaluateMessageGate(input: MessageGateInput): Promise<MessageGateVerdict> {
  const { db, agent } = input;

  if (agent.status === "quarantined" || agent.status === "paused") {
    return { allowed: false, kind: "sender_status", status: agent.status };
  }

  const rateCheck = db.checkAndIncrementRateLimit(agent.id, agent.fleetId);
  if (!rateCheck.allowed) {
    return {
      allowed: false,
      kind: "rate_limit",
      current: rateCheck.current,
      limit: rateCheck.limit,
      retryAfterSeconds: config.rateLimitWindowSeconds,
    };
  }

  const policyResult = db.evaluateMessagePolicies(
    agent.fleetId,
    agent.id,
    input.recipientId,
    input.messageType,
    input.priority
  );
  if (!policyResult.allowed) {
    return { allowed: false, kind: "policy", policy: policyResult.deniedByPolicy };
  }

  for (const ext of getExtensions()) {
    if (!ext.onBeforeMessage) continue;
    try {
      await ext.onBeforeMessage({
        fleetId: agent.fleetId,
        senderAgentId: agent.id,
        recipientId: input.recipientId,
        messageType: input.messageType,
        priority: input.priority,
        body: input.body,
        metadata: input.metadata,
      });
    } catch (err) {
      return {
        allowed: false,
        kind: "extension",
        extension: ext.name,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { allowed: true };
}

/** Render a denial as the REST response POST /v1/messages has always returned. */
export function sendGateDenial(reply: FastifyReply, denial: MessageGateDenial) {
  switch (denial.kind) {
    case "sender_status":
      return reply.code(403).send({ error: `agent is ${denial.status}` });
    case "rate_limit":
      return reply.code(429).send({ error: "rate limit exceeded", retry_after_seconds: denial.retryAfterSeconds });
    case "policy":
      return reply.code(403).send({ error: "blocked by policy", policy: denial.policy });
    case "extension":
      return reply.code(403).send({ error: `blocked by extension ${denial.extension}: ${denial.reason}` });
  }
}

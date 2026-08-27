import type { EkhoDb } from "../db";
import { id } from "../utils";
import { evaluateMessageGate, type MessageGateDenial } from "../message-gate";
import type { A2ATaskStore } from "./task-store";
import {
  JsonRpcException,
  A2A_TASK_NOT_FOUND,
  A2A_TASK_NOT_CANCELABLE,
  JSONRPC_INVALID_PARAMS,
  EKHO_SENDER_NOT_PERMITTED,
  EKHO_RATE_LIMIT_EXCEEDED,
  EKHO_BLOCKED_BY_POLICY,
  EKHO_BLOCKED_BY_EXTENSION,
} from "./jsonrpc";
import type { A2AMessage, A2ATask, TaskState } from "./types";
import { TERMINAL_STATES } from "./types";

type JsonObject = Record<string, unknown>;

function assertObject(params: unknown): JsonObject {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new JsonRpcException(JSONRPC_INVALID_PARAMS, "params must be an object");
  }
  return params as JsonObject;
}

function requireString(obj: JsonObject, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value) {
    throw new JsonRpcException(JSONRPC_INVALID_PARAMS, `${key} must be a non-empty string`);
  }
  return value;
}

function normalizeInboundMessage(raw: unknown, agentId: string): A2AMessage {
  const obj = assertObject(raw);
  const parts = Array.isArray(obj.parts) ? obj.parts : [];
  if (parts.length === 0) {
    throw new JsonRpcException(JSONRPC_INVALID_PARAMS, "message.parts must be a non-empty array");
  }
  return {
    messageId: typeof obj.messageId === "string" ? obj.messageId : id("a2a-msg"),
    role: obj.role === "agent" ? "agent" : "user",
    parts: parts as A2AMessage["parts"],
    taskId: typeof obj.taskId === "string" ? obj.taskId : undefined,
    contextId: typeof obj.contextId === "string" ? obj.contextId : undefined,
    metadata: obj.metadata && typeof obj.metadata === "object" ? (obj.metadata as JsonObject) : undefined,
    kind: "message",
  };
}

function messageToEkhoBody(message: A2AMessage): { body: JsonObject; summary: string } {
  const textPart = message.parts.find((p) => p.kind === "text" && typeof p.text === "string");
  const summary = textPart?.text?.slice(0, 120) ?? "a2a message";
  return {
    body: {
      a2a: true,
      messageId: message.messageId,
      role: message.role,
      parts: message.parts as unknown[],
      taskId: message.taskId,
      contextId: message.contextId,
      metadata: message.metadata ?? null,
    },
    summary,
  };
}

export interface A2AMethodContext {
  db: EkhoDb;
  tasks: A2ATaskStore;
  senderAgentId: string;
  senderFleetId: string;
  /** The AUTHENTICATED sender's agents.status — drives the quarantine/pause gate (#59). */
  senderStatus: string;
  /** Optional: when called from /agents/{id}/a2a this constrains target */
  targetAgentId?: string;
}

/**
 * #59: turn a shared message-gate denial into a JSON-RPC error. The A2A
 * transport must fail for exactly the reasons POST /v1/messages fails, and say
 * which one — a quarantined sender that got back a generic internal error would
 * look like a relay bug and be retried forever. Codes are documented in
 * docs/a2a.md; `data` carries what a client can act on.
 */
function gateDenialToRpcError(denial: MessageGateDenial): JsonRpcException {
  switch (denial.kind) {
    case "sender_status":
      return new JsonRpcException(
        EKHO_SENDER_NOT_PERMITTED,
        `sender agent is ${denial.status}`,
        { status: denial.status }
      );
    case "rate_limit":
      return new JsonRpcException(
        EKHO_RATE_LIMIT_EXCEEDED,
        "rate limit exceeded",
        { retryAfterSeconds: denial.retryAfterSeconds, limit: denial.limit }
      );
    case "policy":
      return new JsonRpcException(
        EKHO_BLOCKED_BY_POLICY,
        "blocked by policy",
        denial.policy ? { policy: denial.policy } : undefined
      );
    case "extension":
      return new JsonRpcException(
        EKHO_BLOCKED_BY_EXTENSION,
        `blocked by extension ${denial.extension}: ${denial.reason}`,
        { extension: denial.extension }
      );
  }
}

/**
 * #58: fetch a task the caller is a participant of, or refuse. A task the caller
 * is not on is reported as NOT FOUND rather than forbidden — an A2A task id is
 * guessable-adjacent and "forbidden" would confirm another agent's task exists,
 * which is the disclosure the native /v1/messages/:id/status route already
 * avoids for the same reason.
 */
function requireOwnTask(ctx: A2AMethodContext, taskId: string) {
  const task = ctx.tasks.getTaskForParticipant(taskId, {
    fleetId: ctx.senderFleetId,
    agentId: ctx.senderAgentId,
  });
  if (!task) {
    throw new JsonRpcException(A2A_TASK_NOT_FOUND, `task ${taskId} not found`);
  }
  return task;
}

export async function messageSend(ctx: A2AMethodContext, params: unknown): Promise<A2ATask> {
  const p = assertObject(params);
  const messageRaw = p.message;
  if (!messageRaw) {
    throw new JsonRpcException(JSONRPC_INVALID_PARAMS, "message is required");
  }
  const message = normalizeInboundMessage(messageRaw, ctx.senderAgentId);

  // Resolve recipient agent
  const recipientId = ctx.targetAgentId
    ?? (typeof p.recipientAgentId === "string" ? p.recipientAgentId : undefined)
    ?? (typeof message.metadata?.recipientAgentId === "string" ? (message.metadata.recipientAgentId as string) : undefined);

  if (!recipientId) {
    throw new JsonRpcException(
      JSONRPC_INVALID_PARAMS,
      "recipient agent required (use /agents/{id}/a2a endpoint, or pass params.recipientAgentId)"
    );
  }

  // #58: the recipient must be a live agent in the SENDER's own fleet. The
  // per-agent route already resolves fleet-scoped, but params.recipientAgentId
  // on the fleet hub does not — without this a cross-fleet id would mint a task
  // row stamped with the wrong fleet before createMessage refused delivery.
  if (!ctx.db.findFleetAgent(ctx.senderFleetId, recipientId)) {
    throw new JsonRpcException(JSONRPC_INVALID_PARAMS, `recipient agent ${recipientId} not found`);
  }

  // The Ekho message this A2A message becomes. Built up front so the gate sees
  // exactly the body that would be delivered, not an approximation of it.
  const { body } = messageToEkhoBody(message);

  // #59: same admission gate as POST /v1/messages — quarantine/pause, rate
  // limit, policy, extensions — BEFORE any task row or Ekho message exists.
  const gate = await evaluateMessageGate({
    db: ctx.db,
    agent: { id: ctx.senderAgentId, fleetId: ctx.senderFleetId, status: ctx.senderStatus },
    recipientId,
    messageType: "a2a.message",
    priority: "normal",
    body,
    metadata: message.metadata,
  });
  if (!gate.allowed) {
    throw gateDenialToRpcError(gate);
  }

  // Reuse existing task if taskId provided
  let task: A2ATask;
  if (message.taskId) {
    // #58: continuing a task requires being on it. Without this any enrolled
    // agent could append to a stranger's task history — and read the whole
    // history back, since the method returns the task.
    const participants = ctx.tasks.taskParticipants(message.taskId);
    const onTask =
      participants !== null &&
      participants.fleetId === ctx.senderFleetId &&
      (participants.recipientAgentId === ctx.senderAgentId || participants.senderAgentId === ctx.senderAgentId);
    if (!onTask) {
      throw new JsonRpcException(A2A_TASK_NOT_FOUND, `task ${message.taskId} not found`);
    }
    // ...and the message must go to the OTHER party on that task, not be
    // re-addressed to a third agent who was never part of the exchange.
    if (recipientId !== participants.recipientAgentId && recipientId !== participants.senderAgentId) {
      throw new JsonRpcException(
        JSONRPC_INVALID_PARAMS,
        `recipient ${recipientId} is not a participant of task ${message.taskId}`
      );
    }
    const existing = ctx.tasks.getTask(message.taskId)!;
    if (TERMINAL_STATES.includes(existing.status.state)) {
      throw new JsonRpcException(A2A_TASK_NOT_CANCELABLE, `task ${message.taskId} is in terminal state`);
    }
    ctx.tasks.appendMessage(existing.id, message);
    task = ctx.tasks.getTask(existing.id)!;
  } else {
    task = ctx.tasks.createTask({
      fleetId: ctx.senderFleetId,
      agentId: recipientId,
      senderAgentId: ctx.senderAgentId,
      contextId: message.contextId,
      initialMessage: message,
    });
  }

  // Create corresponding Ekho message for store-and-forward delivery
  const { messageId } = ctx.db.createMessage({
    fleetId: ctx.senderFleetId,
    senderAgentId: ctx.senderAgentId,
    recipientKind: "agent",
    recipientId,
    messageType: "a2a.message",
    priority: "normal",
    ttlSeconds: 3600,
    requiresApproval: false,
    body,
    metadata: { a2a_task_id: task.id, a2a_context_id: task.contextId },
    conversationId: task.contextId,
    correlationId: task.id,
  });
  ctx.tasks.linkMessage(task.id, messageId);

  return task;
}

export function tasksGet(ctx: A2AMethodContext, params: unknown): A2ATask {
  const p = assertObject(params);
  const taskId = requireString(p, "id");
  const task = requireOwnTask(ctx, taskId);
  // If historyLength = 0, strip history
  if (p.historyLength === 0) {
    return { ...task, history: [] };
  }
  return task;
}

export function tasksList(ctx: A2AMethodContext, params: unknown): { tasks: A2ATask[]; total: number } {
  const p = (params && typeof params === "object" && !Array.isArray(params))
    ? (params as JsonObject)
    : {};
  const limit = typeof p.limit === "number" ? Math.min(Math.max(1, p.limit), 200) : 50;
  const offset = typeof p.offset === "number" ? Math.max(0, p.offset) : 0;
  const state = typeof p.state === "string" ? (p.state as TaskState) : undefined;

  // #58: scoped to the caller's own tasks in the caller's own fleet. The
  // per-agent endpoint narrows further to the tasks shared with that agent —
  // it used to be the ONLY filter, which is how /a2a (targetAgentId undefined)
  // returned every task in the fleet.
  return ctx.tasks.listTasks({
    fleetId: ctx.senderFleetId,
    participantAgentId: ctx.senderAgentId,
    counterpartyAgentId: ctx.targetAgentId,
    state,
    limit,
    offset,
  });
}

export function tasksCancel(ctx: A2AMethodContext, params: unknown): A2ATask {
  const p = assertObject(params);
  const taskId = requireString(p, "id");
  const existing = requireOwnTask(ctx, taskId);
  if (TERMINAL_STATES.includes(existing.status.state)) {
    throw new JsonRpcException(
      A2A_TASK_NOT_CANCELABLE,
      `task ${taskId} is in terminal state ${existing.status.state}`
    );
  }
  const canceled = ctx.tasks.cancelTask(taskId);
  if (!canceled) {
    throw new JsonRpcException(A2A_TASK_NOT_FOUND, `task ${taskId} disappeared`);
  }
  return canceled;
}

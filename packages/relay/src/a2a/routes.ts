import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db";
import { config } from "../config";
import { requireAgentAuth } from "../auth";
import { A2ATaskStore } from "./task-store";
import {
  fromException,
  JsonRpcException,
  parseRequest,
  success,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  type JsonRpcResponse,
} from "./jsonrpc";
import { messageSend, tasksCancel, tasksGet, tasksList, type A2AMethodContext } from "./methods";
import { openSseStream } from "./streaming";
import { buildAgentCard, buildFleetCard } from "./agent-card";

interface FleetRow {
  id: string;
  name: string;
}

function resolveFleet(): FleetRow | null {
  // Try "default" first (standard deploy), then fall back to the first fleet (tests, single-tenant Pro).
  const byName = db.findFleetByName("default") as FleetRow | undefined;
  if (byName) return byName;
  const first = db.raw().prepare("SELECT id, name FROM fleets ORDER BY created_at LIMIT 1").get() as FleetRow | undefined;
  return first ?? null;
}

interface AgentRow {
  id: string;
  fleet_id: string;
  display_name: string | null;
  runtime: string | null;
  status: string;
}

/**
 * Unscoped lookup — ONLY for the public Agent Card, which is discovery data the
 * A2A spec serves unauthenticated. Every authenticated path resolves its target
 * through db.findFleetAgent(callerFleetId, ...) instead (#58).
 */
function findAgent(agentId: string): AgentRow | null {
  const row = db
    .raw()
    .prepare("SELECT id, fleet_id, display_name, runtime, status FROM agents WHERE id = ?")
    .get(agentId) as AgentRow | undefined;
  return row ?? null;
}

function listFleetAgents(fleetId: string): AgentRow[] {
  return db
    .raw()
    .prepare(
      "SELECT id, fleet_id, display_name, runtime, status FROM agents WHERE fleet_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 200"
    )
    .all(fleetId) as AgentRow[];
}

export async function registerA2ARoutes(app: FastifyInstance) {
  const tasks = new A2ATaskStore(db.raw());

  // Fleet-level Agent Card (directory)
  app.get("/.well-known/agent-card.json", async (_request, reply) => {
    const fleet = resolveFleet();
    const agents = fleet ? listFleetAgents(fleet.id) : [];
    return reply.send(buildFleetCard({ baseUrl: config.baseUrl, fleetName: fleet?.name ?? "default", agents }));
  });

  // Per-agent Agent Card
  app.get<{ Params: { agentId: string } }>(
    "/agents/:agentId/.well-known/agent-card.json",
    async (request, reply) => {
      const agent = findAgent(request.params.agentId);
      if (!agent) {
        return reply.code(404).send({ error: "agent not found" });
      }
      const fleet = resolveFleet();
      return reply.send(buildAgentCard({ baseUrl: config.baseUrl, fleetName: fleet?.name ?? "default", agent }));
    }
  );

  // Fleet-level JSON-RPC endpoint
  app.post("/a2a", { preHandler: requireAgentAuth }, async (request, reply) => {
    return handleJsonRpc({
      app,
      request,
      reply,
      tasks,
      targetAgentId: undefined,
    });
  });

  // Per-agent JSON-RPC endpoint
  app.post<{ Params: { agentId: string } }>(
    "/agents/:agentId/a2a",
    { preHandler: requireAgentAuth },
    async (request, reply) => {
      if (!request.agent) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      // #58: resolve the target inside the CALLER's fleet. An agent from another
      // fleet is indistinguishable from one that does not exist — same 404, so
      // this endpoint is not a cross-fleet agent-existence oracle either.
      const target = db.findFleetAgent(request.agent.fleetId, request.params.agentId);
      if (!target) {
        return reply.code(404).send({ error: "agent not found" });
      }
      return handleJsonRpc({
        app,
        request,
        reply,
        tasks,
        targetAgentId: target.id,
      });
    }
  );

  app.log.info("a2a protocol endpoints registered");
}

async function handleJsonRpc(args: {
  app: FastifyInstance;
  request: FastifyRequest;
  reply: FastifyReply;
  tasks: A2ATaskStore;
  targetAgentId?: string;
}): Promise<JsonRpcResponse | void> {
  const { request, reply, tasks, targetAgentId } = args;

  if (!request.agent) {
    return reply.code(401).send({ error: "unauthorized" });
  }

  let rpc;
  try {
    rpc = parseRequest(request.body);
  } catch (err) {
    return reply.send(fromException(null, err));
  }

  const ctx: A2AMethodContext = {
    db,
    tasks,
    senderAgentId: request.agent.id,
    senderFleetId: request.agent.fleetId,
    targetAgentId,
  };

  const rpcId = rpc.id ?? null;

  try {
    switch (rpc.method) {
      case "message/send": {
        const result = await messageSend(ctx, rpc.params);
        return reply.send(success(rpcId, result));
      }
      case "tasks/get": {
        const result = tasksGet(ctx, rpc.params);
        return reply.send(success(rpcId, result));
      }
      case "tasks/list": {
        const result = tasksList(ctx, rpc.params);
        return reply.send(success(rpcId, result));
      }
      case "tasks/cancel": {
        const result = tasksCancel(ctx, rpc.params);
        return reply.send(success(rpcId, result));
      }
      case "message/stream": {
        const task = await messageSend(ctx, rpc.params);
        openSseStream({ request, reply, task, rpcId, initialEvent: task });
        return;
      }
      case "tasks/resubscribe": {
        const result = tasksGet(ctx, rpc.params);
        openSseStream({ request, reply, task: result, rpcId, initialEvent: result });
        return;
      }
      default:
        return reply.send(
          fromException(rpcId, new JsonRpcException(JSONRPC_METHOD_NOT_FOUND, `method ${rpc.method} not found`))
        );
    }
  } catch (err) {
    return reply.send(fromException(rpcId, err));
  }
}

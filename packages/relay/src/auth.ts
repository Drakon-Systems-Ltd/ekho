import { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config";
import { db } from "./db";
import { hashSecret, sha256, sign, timingSafeEqualStr } from "./utils";
import { evaluateTailnetGate, tailnetLoginFromHeaders } from "./tailnet";

declare module "fastify" {
  interface FastifyRequest {
    agent?: {
      id: string;
      fleetId: string;
      status: string;
    };
    operator?: {
      id: string;
      fleetId: string;
    };
  }
}

function unauthorized(reply: FastifyReply, message: string) {
  return reply.code(401).send({ error: message });
}

export async function requireAgentAuth(request: FastifyRequest, reply: FastifyReply) {
  const agentId = request.headers["x-ekho-agent-id"];
  const timestamp = request.headers["x-ekho-timestamp"];
  const nonce = request.headers["x-ekho-nonce"];
  const signature = request.headers["x-ekho-signature"];
  const sharedSecret = request.headers["x-ekho-agent-secret"];

  if (
    typeof agentId !== "string" ||
    typeof timestamp !== "string" ||
    typeof nonce !== "string" ||
    typeof signature !== "string" ||
    typeof sharedSecret !== "string"
  ) {
    return unauthorized(reply, "missing auth headers");
  }

  const agent = db.authenticateAgent(agentId, sharedSecret);
  if (!agent || !timingSafeEqualStr(String(agent.secret_hash), hashSecret(sharedSecret))) {
    return unauthorized(reply, "invalid agent credentials");
  }

  const skewSeconds = Math.abs(Date.now() - new Date(timestamp).getTime()) / 1000;
  if (!Number.isFinite(skewSeconds) || skewSeconds > config.timestampSkewSeconds) {
    return unauthorized(reply, "timestamp outside allowed skew");
  }

  if (db.findNonce(agentId, nonce)) {
    return unauthorized(reply, "replayed nonce");
  }

  const body = request.body ? JSON.stringify(request.body) : "";
  const normalizedPath = request.url.split("?")[0] ?? request.url;
  const payload = `${request.method}\n${normalizedPath}\n${timestamp}\n${nonce}\n${sha256(body)}`;
  const expected = sign(sharedSecret, payload);
  if (!timingSafeEqualStr(expected, signature)) {
    return unauthorized(reply, "invalid signature");
  }

  db.rememberNonce(agentId, nonce);
  request.agent = { id: agentId, fleetId: String(agent.fleet_id), status: String(agent.status) };
}

export async function requireOperatorAuth(request: FastifyRequest, reply: FastifyReply) {
  // Tailnet gate (defense in depth): even a valid token is rejected off-tailnet.
  const gate = evaluateTailnetGate({
    require: config.operatorRequireTailnet,
    allowedUser: config.operatorTailnetUser,
    login: tailnetLoginFromHeaders(request.headers as Record<string, unknown>)
  });
  if (!gate.allowed) {
    return reply.code(403).send({ error: gate.reason });
  }

  const session = request.headers.authorization;
  if (!session?.startsWith("Bearer ")) {
    return unauthorized(reply, "missing operator session");
  }

  const token = session.slice("Bearer ".length);
  const [operatorId, fleetId, signature] = token.split(".");
  if (!operatorId || !fleetId || !signature) {
    return unauthorized(reply, "malformed operator session");
  }

  const expected = sign(config.operatorSessionSecret, `${operatorId}.${fleetId}`);
  if (!timingSafeEqualStr(expected, signature)) {
    return unauthorized(reply, "invalid operator session");
  }

  request.operator = { id: operatorId, fleetId };
}

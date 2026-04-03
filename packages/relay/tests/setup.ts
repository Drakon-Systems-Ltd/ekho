import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

export type TestRelay = Awaited<ReturnType<typeof createTestRelay>>;

// Set env once before any relay module loads
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-test-"));
process.env.EKHO_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.EKHO_OPERATOR_SESSION_SECRET = "test-secret";
process.env.EKHO_DELIVERY_TIMEOUT_SECONDS = "2";
process.env.EKHO_SWEEP_INTERVAL_MS = "999999";
process.env.EKHO_RATE_LIMIT_WINDOW_SECONDS = "5";
process.env.EKHO_RATE_LIMIT_MAX_MESSAGES = "5";
process.env.EKHO_HEARTBEAT_TIMEOUT_SECONDS = "3";
process.env.EKHO_HEARTBEAT_LIVENESS_THRESHOLD = "2";
process.env.EKHO_RATE_LIMIT_VIOLATION_THRESHOLD = "3";
process.env.EKHO_RATE_LIMIT_VIOLATION_WINDOW_SECONDS = "60";

let testCounter = 0;

export async function createTestRelay() {
  const testId = ++testCounter;
  const fleetName = `test-fleet-${testId}-${Date.now()}`;

  const fastify = (await import("fastify")).default;
  const { db } = await import("../src/db");
  const { registerAgentRoutes } = await import("../src/routes-agent");
  const { registerOperatorRoutes } = await import("../src/routes-operator");
  const { sign } = await import("../src/utils");

  const app = fastify({ logger: false });
  await registerAgentRoutes(app);
  await registerOperatorRoutes(app);

  const { fleetId, operatorId } = db.createBootstrap(fleetName, `admin-${testId}@test.com`, "testpassword1");
  const tokenCore = `${operatorId}.${fleetId}`;
  const operatorToken = `${tokenCore}.${sign("test-secret", tokenCore)}`;

  async function enrollAgent(displayName: string) {
    const enrollmentToken = db.issueEnrollmentToken(fleetId, operatorId);
    const res = await app.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: { fleet_id: fleetId, token: enrollmentToken, display_name: displayName, runtime: "custom" }
    });
    return JSON.parse(res.body) as { agent_id: string; secret: string };
  }

  function signedHeaders(agentId: string, secret: string, method: string, urlPath: string, body: string) {
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const sha256 = (input: string) => crypto.createHash("sha256").update(input).digest("hex");
    const payload = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${sha256(body)}`;
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return {
      "content-type": "application/json",
      "x-ekho-agent-id": agentId,
      "x-ekho-agent-secret": secret,
      "x-ekho-timestamp": timestamp,
      "x-ekho-nonce": nonce,
      "x-ekho-signature": signature
    };
  }

  async function agentRequest(agentId: string, secret: string, method: string, url: string, payload?: unknown) {
    const body = payload ? JSON.stringify(payload) : "";
    const signaturePath = url.split("?")[0];
    const res = await app.inject({
      method: method as "GET" | "POST" | "PUT" | "DELETE",
      url,
      headers: signedHeaders(agentId, secret, method, signaturePath, body),
      payload: payload ?? undefined
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  async function operatorRequest(method: string, url: string, payload?: unknown) {
    const res = await app.inject({
      method: method as "GET" | "POST" | "PUT" | "DELETE",
      url,
      headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      payload: payload ?? undefined
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  function cleanup() {
    app.close();
  }

  return { app, db, fleetId, operatorId, operatorToken, enrollAgent, agentRequest, operatorRequest, cleanup };
}

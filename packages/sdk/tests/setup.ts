import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-sdk-test-"));
process.env.EKHO_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.EKHO_OPERATOR_SESSION_SECRET = "test-secret";
process.env.EKHO_DELIVERY_TIMEOUT_SECONDS = "2";
process.env.EKHO_SWEEP_INTERVAL_MS = "999999";
process.env.EKHO_RATE_LIMIT_WINDOW_SECONDS = "60";
process.env.EKHO_RATE_LIMIT_MAX_MESSAGES = "100";

let testCounter = 0;

export async function createTestRelayForSdk() {
  const testId = ++testCounter;
  const fleetName = `sdk-fleet-${testId}-${Date.now()}`;

  const fastify = (await import("fastify")).default;
  const { db } = await import("../../relay/src/db");
  const { registerAgentRoutes } = await import("../../relay/src/routes-agent");
  const { registerOperatorRoutes } = await import("../../relay/src/routes-operator");
  const { sign } = await import("../../relay/src/utils");

  const app = fastify({ logger: false });
  await registerAgentRoutes(app);
  await registerOperatorRoutes(app);

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const { fleetId, operatorId } = db.createBootstrap(fleetName, `admin-${testId}@sdk-test.com`, "testpassword1");

  async function enrollAgent(displayName: string) {
    const enrollmentToken = db.issueEnrollmentToken(fleetId, operatorId);
    const res = await fetch(`${baseUrl}/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fleet_id: fleetId,
        token: enrollmentToken,
        display_name: displayName,
        runtime: "custom"
      })
    });
    const body = await res.json() as { agent_id: string; secret: string };
    return { ...body, relayBaseUrl: baseUrl };
  }

  function cleanup() {
    app.close();
  }

  return { baseUrl, fleetId, enrollAgent, cleanup };
}

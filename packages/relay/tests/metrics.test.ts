import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

describe("Prometheus /metrics", () => {
  let relay: TestRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  it("serves a Prometheus-formatted response", async () => {
    const res = await relay.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");

    const body = res.body;
    expect(body).toContain("# HELP ekho_up");
    expect(body).toContain("# TYPE ekho_up gauge");
    expect(body).toContain("ekho_up 1");
    expect(body).toContain("# HELP ekho_relay_info");
    expect(body).toContain("# HELP ekho_fleets_total");
  });

  it("reflects agent enrollment in ekho_agents_total", async () => {
    await relay.enrollAgent("metrics-agent-1");
    await relay.enrollAgent("metrics-agent-2");

    const res = await relay.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/ekho_agents_total\{status="[^"]+"\} \d+/);
  });

  it("surfaces A2A task counts after tasks are created", async () => {
    const sender = await relay.enrollAgent("m-sender");
    const receiver = await relay.enrollAgent("m-receiver");

    await relay.agentRequest(
      sender.agent_id,
      sender.secret,
      "POST",
      `/agents/${receiver.agent_id}/a2a`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            messageId: "msg_metrics",
            role: "user",
            parts: [{ kind: "text", text: "metrics test" }],
            kind: "message",
          },
        },
      }
    );

    const res = await relay.app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("ekho_a2a_tasks_total");
    expect(res.body).toMatch(/ekho_a2a_tasks_total\{state="submitted"\} \d+/);
  });
});

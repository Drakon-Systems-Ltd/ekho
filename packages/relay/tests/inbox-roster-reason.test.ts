import { beforeEach, describe, expect, it } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

describe("inbox roster quarantine reason (#115)", () => {
  let relay: TestRelay;
  beforeEach(async () => { relay = await createTestRelay(); });

  it("reports the current status and reason, including null after recovery", async () => {
    const receiver = await relay.enrollAgent("roster receiver");
    const peer = await relay.enrollAgent("roster peer");
    relay.db.raw().prepare("UPDATE agents SET status = 'quarantined', quarantine_reason = 'heartbeat_timeout' WHERE id = ?").run(peer.agent_id);
    const first = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
    expect(first.status).toBe(200);
    expect(first.body.roster.find((r: { agent_id: string }) => r.agent_id === peer.agent_id)).toMatchObject({
      status: "quarantined", quarantine_reason: "heartbeat_timeout"
    });
    relay.db.raw().prepare("UPDATE agents SET status = 'healthy', quarantine_reason = NULL WHERE id = ?").run(peer.agent_id);
    const second = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
    expect(second.body.roster.find((r: { agent_id: string }) => r.agent_id === peer.agent_id)).toMatchObject({
      status: "healthy", quarantine_reason: null
    });
  });
});

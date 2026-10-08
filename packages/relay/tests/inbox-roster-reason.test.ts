import { beforeEach, describe, expect, it } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

describe("inbox roster quarantine reason (#115)", () => {
  let relay: TestRelay;
  beforeEach(async () => { relay = await createTestRelay(); });

  it("tracks automatic quarantine and operator transitions without leaking payload text", async () => {
    const receiver = await relay.enrollAgent("roster receiver");
    const peer = await relay.enrollAgent("roster peer");
    const rosterPeer = async () => {
      const res = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
      expect(res.status).toBe(200);
      return res.body.roster.find((r: { agent_id: string }) => r.agent_id === peer.agent_id);
    };
    const stale = new Date(Date.now() - 30_000).toISOString();
    relay.db.raw().prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(stale, peer.agent_id);
    relay.db.sweepHeartbeatLiveness();
    expect(await rosterPeer()).toMatchObject({ status: "quarantined", quarantine_reason: "heartbeat_timeout" });

    const payload = { reason: "private operator payload" };
    relay.db.controlAgent(relay.fleetId, peer.agent_id, relay.operatorId, "resume", payload);
    expect(await rosterPeer()).toMatchObject({ status: "healthy", quarantine_reason: null });
    relay.db.controlAgent(relay.fleetId, peer.agent_id, relay.operatorId, "pause", payload);
    expect(await rosterPeer()).toMatchObject({ status: "paused", quarantine_reason: null });
    relay.db.controlAgent(relay.fleetId, peer.agent_id, relay.operatorId, "quarantine", payload);
    expect(await rosterPeer()).toMatchObject({ status: "quarantined", quarantine_reason: "operator" });
    relay.db.insertHeartbeat(peer.agent_id, "healthy", {});
    expect(await rosterPeer()).toMatchObject({ status: "quarantined", quarantine_reason: "operator" });
    expect(JSON.stringify(await rosterPeer())).not.toContain(payload.reason);
  });

  it("hides unknown reason categories even on quarantined agents", async () => {
    const receiver = await relay.enrollAgent("receiver");
    const peer = await relay.enrollAgent("peer");
    relay.db.raw().prepare("UPDATE agents SET status = 'quarantined', quarantine_reason = 'private text' WHERE id = ?").run(peer.agent_id);
    const res = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
    expect(res.body.roster.find((r: { agent_id: string }) => r.agent_id === peer.agent_id).quarantine_reason).toBeNull();
  });
});

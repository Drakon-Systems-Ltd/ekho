import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// H4 — enrollment-token consumption must be a single atomic claim (guarded
// conditional UPDATE + .changes check, claimed BEFORE the agent is created),
// so one single-use token can never mint two agents and a rejected reuse leaves
// no orphan agent/credential rows.
describe("atomic enrollment-token consumption", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  const agentCount = (r: TestRelay) =>
    (r.db.raw().prepare("SELECT COUNT(*) AS c FROM agents WHERE fleet_id = ? AND runtime = 'custom'").get(r.fleetId) as { c: number }).c;
  const credCount = (r: TestRelay) =>
    (r.db.raw().prepare("SELECT COUNT(*) AS c FROM agent_credentials").get() as { c: number }).c;

  it("db.createAgentFromEnrollment claims the token once, returns null on reuse", () => {
    const token = relay.db.issueEnrollmentToken(relay.fleetId, relay.operatorId);
    const first = relay.db.createAgentFromEnrollment({
      fleetId: relay.fleetId, token, displayName: "a1", runtime: "custom"
    });
    expect(first).not.toBeNull();
    expect(first!.agentId).toBeTruthy();
    expect(first!.secret).toBeTruthy();

    const before = { agents: agentCount(relay), creds: credCount(relay) };
    const second = relay.db.createAgentFromEnrollment({
      fleetId: relay.fleetId, token, displayName: "a2", runtime: "custom"
    });
    expect(second).toBeNull(); // token already claimed
    // no orphan rows from the rejected reuse
    expect(agentCount(relay)).toBe(before.agents);
    expect(credCount(relay)).toBe(before.creds);
    // token is stamped to the first agent only
    const row = relay.db.raw()
      .prepare("SELECT used_at, used_by_agent_id FROM enrollment_tokens WHERE fleet_id = ?")
      .get(relay.fleetId) as { used_at: string | null; used_by_agent_id: string | null };
    expect(row.used_at).toBeTruthy();
    expect(row.used_by_agent_id).toBe(first!.agentId);
  });

  it("HTTP: a second enroll with the same token is rejected, mints no agent", async () => {
    const token = relay.db.issueEnrollmentToken(relay.fleetId, relay.operatorId);
    const body = { fleet_id: relay.fleetId, token, display_name: "dup", runtime: "custom" };
    const first = await relay.app.inject({ method: "POST", url: "/v1/enroll", payload: body });
    expect(first.statusCode).toBe(200);
    const after1 = agentCount(relay);

    const second = await relay.app.inject({ method: "POST", url: "/v1/enroll", payload: body });
    expect(second.statusCode).toBe(400);
    expect(JSON.parse(second.body).error).toMatch(/invalid or expired token/);
    expect(agentCount(relay)).toBe(after1); // unchanged
  });

  it("rejects an expired token (no agent created)", () => {
    const token = relay.db.issueEnrollmentToken(relay.fleetId, relay.operatorId);
    // force-expire it
    relay.db.raw()
      .prepare("UPDATE enrollment_tokens SET expires_at = ? WHERE fleet_id = ?")
      .run("2000-01-01T00:00:00.000Z", relay.fleetId);
    const before = agentCount(relay);
    const created = relay.db.createAgentFromEnrollment({
      fleetId: relay.fleetId, token, displayName: "x", runtime: "custom"
    });
    expect(created).toBeNull();
    expect(agentCount(relay)).toBe(before);
  });

  it("rejects a token presented with the wrong fleet id", () => {
    const token = relay.db.issueEnrollmentToken(relay.fleetId, relay.operatorId);
    const created = relay.db.createAgentFromEnrollment({
      fleetId: "flt_someoneelse", token, displayName: "x", runtime: "custom"
    });
    expect(created).toBeNull();
  });

  // Peer auto-reply ON by default: a freshly enrolled agent must land peer-ON even
  // on a migrated DB (where the column was created DEFAULT 0), so the INSERT sets
  // peer_autoreply = 1 explicitly rather than relying on the column default.
  it("enrolls new agents with peer auto-reply ON by default", () => {
    const token = relay.db.issueEnrollmentToken(relay.fleetId, relay.operatorId);
    const created = relay.db.createAgentFromEnrollment({
      fleetId: relay.fleetId, token, displayName: "fresh", runtime: "custom"
    });
    expect(created).not.toBeNull();
    const row = relay.db.raw()
      .prepare("SELECT peer_autoreply, peer_turn_budget FROM agents WHERE id = ?")
      .get(created!.agentId) as { peer_autoreply: number; peer_turn_budget: number };
    expect(row.peer_autoreply).toBe(1);
    expect(row.peer_turn_budget).toBe(25); // working-session default, set explicitly at enroll
  });
});

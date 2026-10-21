import { describe, it, expect } from "vitest";
import { createTestRelay } from "./setup";

// Auto-quarantine (heartbeat-timeout and rate-limit) writes a control_actions
// row whose issued_by_operator_id FKs to operators(id). The code attributed
// these to the literal "system", which is not a real operator row — so every
// auto-quarantine threw `SqliteError: FOREIGN KEY constraint failed` and rolled
// back the whole sweep transaction (observed live on tars: the liveness sweep
// failing every 30s for minutes, stale agents never quarantined).
describe("auto-quarantine attributes control actions to a real operator", () => {
  it("heartbeat sweep quarantines a stale agent without a foreign-key error", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("StaleBot");
    // Age it well past the liveness threshold (test env: timeout 3s, threshold 2).
    const stale = new Date(Date.now() - 30_000).toISOString();
    relay.db.raw().prepare("UPDATE agents SET status = 'healthy', last_seen_at = ? WHERE id = ?").run(stale, agent_id);

    const quarantined = relay.db.sweepHeartbeatLiveness();

    expect(quarantined).toBeGreaterThanOrEqual(1);
    const row = relay.db.raw().prepare("SELECT status FROM agents WHERE id = ?").get(agent_id) as { status: string };
    expect(row.status).toBe("quarantined");
  });

  it("records the quarantine against an operator row that actually exists, and re-runs cleanly", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("StaleBot2");
    const stale = new Date(Date.now() - 30_000).toISOString();
    relay.db.raw().prepare("UPDATE agents SET status = 'healthy', last_seen_at = ? WHERE id = ?").run(stale, agent_id);

    relay.db.sweepHeartbeatLiveness();
    // A second pass must not throw — the system operator is created once, then reused.
    expect(() => relay.db.sweepHeartbeatLiveness()).not.toThrow();

    // The control action references a real operators row (the FK is genuinely satisfiable).
    const ca = relay.db.raw().prepare(
      `SELECT ca.issued_by_operator_id AS op, o.id AS resolved
       FROM control_actions ca
       LEFT JOIN operators o ON o.id = ca.issued_by_operator_id
       WHERE ca.target_id = ? AND ca.action = 'quarantine'`
    ).get(agent_id) as { op: string; resolved: string | null } | undefined;
    expect(ca?.op).toBeTruthy();
    expect(ca?.resolved).toBe(ca?.op);
  });

  it("rate-limit auto-quarantine also attributes to a real operator (no FK error)", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("SpamBot");
    // Seed violations past the threshold (test env: EKHO_RATE_LIMIT_VIOLATION_THRESHOLD=3).
    const now = Date.now();
    const insert = relay.db.raw().prepare(
      `INSERT INTO rate_limit_violations (id, fleet_id, agent_id, window_start, message_count, limit_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 3; i++) {
      const ts = new Date(now - i * 1000).toISOString();
      insert.run(`rlv-${i}-${agent_id}`, relay.fleetId, agent_id, ts, 10, 5, ts);
    }

    expect(() => relay.db.checkRateLimitQuarantine(agent_id, relay.fleetId)).not.toThrow();

    const row = relay.db.raw().prepare("SELECT status FROM agents WHERE id = ?").get(agent_id) as { status: string };
    expect(row.status).toBe("quarantined");
  });
});

// Quarantine controls are inserted with expires_at = NULL and the agent inbox
// serves every unexpired control on every poll — so an agent that had EVER been
// auto-quarantined carried stale "quarantine" controls forever (observed live:
// Jarvis polling two quarantine controls weeks after recovering). Restoring an
// agent must retire the controls that announced the state it left.
describe("stale quarantine controls are retired on restore", () => {
  it("gives an operator-resumed agent a full heartbeat window before quarantine returns", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("ResumedBot");
    const db = relay.db.raw();
    const oldBeat = new Date(Date.now() - 30_000).toISOString();
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(oldBeat, agent_id);
    relay.db.controlAgent(relay.fleetId, agent_id, relay.operatorId, "resume", {});
    expect(relay.db.sweepHeartbeatLiveness()).toBe(0);
    expect(db.prepare("SELECT status, last_seen_at FROM agents WHERE id = ?").get(agent_id)).toMatchObject({ status: "healthy", last_seen_at: oldBeat });

    // Move only the resume's timestamp beyond the test's 3s × 2 window.
    db.prepare("UPDATE control_actions SET created_at = ? WHERE target_id = ? AND action = 'resume'")
      .run(new Date(Date.now() - 7_000).toISOString(), agent_id);
    expect(relay.db.sweepHeartbeatLiveness()).toBe(1);
    expect(db.prepare("SELECT status FROM agents WHERE id = ?").get(agent_id)).toMatchObject({ status: "quarantined" });
  });

  it("only a resume from the agent's own fleet grants the grace window", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("ForeignResumeBot");
    const db = relay.db.raw();
    const oldBeat = new Date(Date.now() - 30_000).toISOString();
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(oldBeat, agent_id);
    // A resume row naming this agent id but filed under another fleet must not count.
    const otherFleet = "flt_other_resume";
    const created = new Date().toISOString();
    db.prepare("INSERT INTO fleets (id, name, created_at) VALUES (?, ?, ?)").run(otherFleet, "other-resume-fleet", created);
    const otherOp = relay.db.ensureSystemOperator(otherFleet);
    db.prepare(
      "INSERT INTO control_actions (id, fleet_id, target_kind, target_id, action, payload_json, issued_by_operator_id, created_at) VALUES (?, ?, 'agent', ?, 'resume', '{}', ?, ?)"
    ).run("ctl_foreign_resume", otherFleet, agent_id, otherOp, created);

    expect(relay.db.sweepHeartbeatLiveness()).toBe(1);
    expect(db.prepare("SELECT status FROM agents WHERE id = ?").get(agent_id)).toMatchObject({ status: "quarantined" });
  });

  it("the resume lookup uses the full idx_controls_target prefix", async () => {
    const relay = await createTestRelay();
    const db = relay.db.raw();
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT MAX(ca.created_at) FROM control_actions ca
       WHERE ca.fleet_id = ? AND ca.target_kind = 'agent' AND ca.target_id = ? AND ca.action = 'resume'`
    ).all("f", "a") as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join("\n")).toMatch(/idx_controls_target \(fleet_id=\? AND target_kind=\? AND target_id=\?/);
    // The sweep's SQL must carry the fleet predicate that unlocks that prefix.
    const src = relay.db.sweepHeartbeatLiveness.toString();
    expect(src).toContain("ca.fleet_id = a.fleet_id");
  });

  it("heartbeat-resume expires the agent's standing quarantine controls", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("SleepyBot");
    const stale = new Date(Date.now() - 30_000).toISOString();
    relay.db.raw().prepare("UPDATE agents SET status = 'healthy', last_seen_at = ? WHERE id = ?").run(stale, agent_id);
    relay.db.sweepHeartbeatLiveness();

    const pending = () =>
      relay.db.raw().prepare(
        "SELECT COUNT(*) AS n FROM control_actions WHERE target_id = ? AND action = 'quarantine' AND (expires_at IS NULL OR expires_at > ?)"
      ).get(agent_id, new Date().toISOString()) as { n: number };
    expect(pending().n).toBeGreaterThanOrEqual(1);

    relay.db.insertHeartbeat(agent_id, "healthy", {});

    expect(pending().n).toBe(0);
    const row = relay.db.raw().prepare("SELECT status FROM agents WHERE id = ?").get(agent_id) as { status: string };
    expect(row.status).toBe("healthy");
  });

  it("operator resume expires pause/quarantine controls and its own control gets a TTL", async () => {
    const relay = await createTestRelay();
    const { agent_id, fleet_id, operator_id } = await relay.enrollAgentWithMeta
      ? await relay.enrollAgentWithMeta("PausedBot")
      : { ...(await relay.enrollAgent("PausedBot")), fleet_id: undefined, operator_id: undefined } as any;
    const db = relay.db.raw();
    const agentRow = db.prepare("SELECT fleet_id FROM agents WHERE id = ?").get(agent_id) as { fleet_id: string };
    const opRow = db.prepare("SELECT id FROM operators WHERE fleet_id = ? LIMIT 1").get(agentRow.fleet_id) as { id: string } | undefined;
    const fleetId = fleet_id ?? agentRow.fleet_id;
    const operatorId = operator_id ?? opRow?.id ?? relay.db.ensureSystemOperator(fleetId);

    relay.db.controlAgent(fleetId, agent_id, operatorId, "quarantine", { reason: "test" });
    relay.db.controlAgent(fleetId, agent_id, operatorId, "resume", { reason: "test-over" });

    const standing = db.prepare(
      "SELECT action FROM control_actions WHERE target_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at"
    ).all(agent_id, new Date().toISOString()) as Array<{ action: string }>;
    // Only the resume survives, and it carries a TTL rather than NULL.
    expect(standing.map((r) => r.action)).toEqual(["resume"]);
    const resumeRow = db.prepare(
      "SELECT expires_at FROM control_actions WHERE target_id = ? AND action = 'resume'"
    ).get(agent_id) as { expires_at: string | null };
    expect(resumeRow.expires_at).not.toBeNull();
  });
});

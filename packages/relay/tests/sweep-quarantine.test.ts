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

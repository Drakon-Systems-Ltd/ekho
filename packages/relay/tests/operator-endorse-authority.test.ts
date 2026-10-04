import { describe, it, expect } from "vitest";
import { endorseAuthority, rescueGuard } from "../frontend/src/operatorTrust.js";

/**
 * 16 Aug 2026, 08:33Z — the fleet-wide break this exists to stop.
 *
 * The operator's laptop held X6NvGXWiMP32k0J6: live on the relay, but endorsed
 * by nobody and pinned by no agent. From that device he pressed panel ③'s
 * "re-endorse all under this device", and all 8 agent identity keys were
 * re-rooted onto it. Every agent still pinned 2T8znI7sDIHiwaL1, so from that
 * moment every agent-to-agent message was acked and dead-lettered:
 *
 *   reason = endorser-not-pinned   from: agent_e894430afdd8  08:38:42.337Z
 *
 * Nothing in either endorse path asked whether the signing key was itself
 * trusted. "Live" is not "trusted" — that is the whole lesson, and it is the
 * same confusion that made "active" read as usable in panel ②.
 */

const key = (key_id: string, extra: Record<string, unknown> = {}) => ({
  key_id,
  label: key_id,
  revoked_at: null,
  endorsed_by_key_id: null,
  ...extra,
});
const agentKey = (agent_id: string, endorsed_by_key_id: string | null) => ({
  agent_id,
  key_id: `k-${agent_id}`,
  endorsed_by_key_id,
});

describe("endorseAuthority", () => {
  it("allows a key the agents actually pin — it is a real trust root", () => {
    const keys = [key("root"), key("orphan")];
    const agentKeys = [agentKey("a1", "root"), agentKey("a2", "root")];
    expect(endorseAuthority("root", keys, agentKeys)).toEqual({ allowed: true, reason: null });
  });

  it("REFUSES an unendorsed key that no agent pins — the 16 Aug break", () => {
    const keys = [key("root"), key("orphan")];
    const agentKeys = [agentKey("a1", "root"), agentKey("a2", "root")];
    const g = endorseAuthority("orphan", keys, agentKeys);
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/no agent trusts|not trusted|endorse/i);
    // Must name the way out, not just say no.
    expect(g.reason).toMatch(/device that holds|another device|trusted key/i);
  });

  it("allows a key that chains to a live trusted key", () => {
    const keys = [key("root"), key("child", { endorsed_by_key_id: "root" })];
    const agentKeys = [agentKey("a1", "root")];
    expect(endorseAuthority("child", keys, agentKeys).allowed).toBe(true);
  });

  it("refuses a key chained to a REVOKED endorser", () => {
    const keys = [
      { ...key("dead"), revoked_at: "2026-08-10T09:47:24Z" },
      key("child", { endorsed_by_key_id: "dead" }),
      key("root"),
    ];
    const agentKeys = [agentKey("a1", "root")];
    expect(endorseAuthority("child", keys, agentKeys).allowed).toBe(false);
  });

  it("refuses a revoked key outright", () => {
    const keys = [{ ...key("dead"), revoked_at: "2026-08-10T09:47:24Z" }, key("root")];
    const agentKeys = [agentKey("a1", "root")];
    const g = endorseAuthority("dead", keys, agentKeys);
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/revoked/i);
  });

  it("allows the first key on a fresh fleet — bootstrap must not be bricked", () => {
    expect(endorseAuthority("first", [key("first")], []).allowed).toBe(true);
  });

  it("refuses when this browser is locked", () => {
    expect(endorseAuthority(null as never, [key("root")], []).allowed).toBe(false);
  });

  it("refuses a key the relay has never seen", () => {
    const g = endorseAuthority("ghost", [key("root")], [agentKey("a1", "root")]);
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/unknown|not registered|never/i);
  });
});

/**
 * #93 — the console side of the one-off recovery grant. The live shape: X6Nv
 * endorsed _sthCg, every agent is on _sthCg, _sthCg's passphrase is lost, and
 * the operator has generated a fresh unendorsed key ("succ") in a new browser.
 * The relay is the control (endorseOperatorKey); these pin what the buttons say.
 */
describe("endorseAuthority / rescueGuard with a one-off recovery grant (#93)", () => {
  const keys = [
    key("X6Nv", { endorsed_by_key_id: "2T8z" }),
    key("2T8z", { revoked_at: "2026-08-17T00:00:00Z" }),
    key("sthCg", { endorsed_by_key_id: "X6Nv" }),
    key("succ"),
    key("other"),
  ];
  const agentKeys = [agentKey("a1", "sthCg"), agentKey("a2", "sthCg")];
  const NOW = Date.parse("2026-10-04T11:00:00Z");
  const grant = {
    grant_id: "rcg_1",
    endorser_key_id: "X6Nv",
    target_key_id: "succ",
    expires_at: "2026-10-04T11:30:00Z",
  };

  it("with NO grant, the recovering key is refused — the standing #93 rule is gone", () => {
    expect(endorseAuthority("X6Nv", keys, agentKeys).allowed).toBe(false);
    expect(rescueGuard("succ", keys, "X6Nv", agentKeys).allowed).toBe(false);
  });

  it("ALLOWS exactly the grant's target from the grant's endorser, with plain one-time copy", () => {
    const g = endorseAuthority("X6Nv", keys, agentKeys, { recoveryGrant: grant, targetKeyId: "succ", now: NOW });
    expect(g.allowed).toBe(true);
    expect(g.recovery).toBe(true);
    expect(g.notice).toMatch(/one-time recovery/i);
    expect(g.notice).toMatch(/once/i);
    expect(g.notice).toMatch(/re-endorse every agent.*only then revoke/i);
  });

  it("refuses the agent panels (no target) even with a grant, and says why", () => {
    const g = endorseAuthority("X6Nv", keys, agentKeys, { recoveryGrant: grant, now: NOW });
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/ONE recovery endorsement only/);
    expect(g.reason).toMatch(/cannot endorse agents/);
  });

  it("refuses any other target", () => {
    expect(
      endorseAuthority("X6Nv", keys, agentKeys, { recoveryGrant: grant, targetKeyId: "other", now: NOW }).allowed
    ).toBe(false);
  });

  it("refuses the wrong endorser", () => {
    expect(
      endorseAuthority("other", keys, agentKeys, { recoveryGrant: grant, targetKeyId: "succ", now: NOW }).allowed
    ).toBe(false);
  });

  it("refuses once the grant has expired by this browser's clock", () => {
    const later = Date.parse("2026-10-04T11:30:00Z");
    expect(
      endorseAuthority("X6Nv", keys, agentKeys, { recoveryGrant: grant, targetKeyId: "succ", now: later }).allowed
    ).toBe(false);
  });

  it("rescueGuard (panel ② Endorse) passes the grant through for its one target only", () => {
    // rescueGuard reads the real clock, so give it a grant that is live now.
    const live = { ...grant, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() };
    const ok = rescueGuard("succ", keys, "X6Nv", agentKeys, live);
    expect(ok.allowed).toBe(true);
    expect(ok.recovery).toBe(true);
    expect(rescueGuard("other", keys, "X6Nv", agentKeys, live).allowed).toBe(false);
    const already = keys.map((k) => (k.key_id === "succ" ? { ...k, endorsed_by_key_id: "sthCg" } : k));
    expect(rescueGuard("succ", already, "X6Nv", agentKeys, live).allowed).toBe(false);
  });

  it("Case: a later agent pinned only to the root, and a divergent fleet, still give no standing authority", () => {
    const late = [...agentKeys, agentKey("zeus", "sthCg")];
    expect(endorseAuthority("X6Nv", keys, late).allowed).toBe(false);
    const split = [agentKey("a1", "sthCg"), agentKey("a2", "other")];
    const splitKeys = keys.map((k) => (k.key_id === "other" ? { ...k, endorsed_by_key_id: "sthCg" } : k));
    expect(endorseAuthority("X6Nv", splitKeys, split).allowed).toBe(false);
  });
});

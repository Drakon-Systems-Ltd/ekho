import { describe, it, expect } from "vitest";
import { endorseAuthority } from "../frontend/src/operatorTrust.js";

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

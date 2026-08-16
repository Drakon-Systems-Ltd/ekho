import { describe, it, expect } from "vitest";
// Pure trust-state helpers shared by the Security screen. No React, so they unit-test cleanly.
import { orphanedOperatorKeys, rescueGuard } from "../frontend/src/operatorTrust.js";

/**
 * #19 — recovering a stranded device.
 *
 * A key registered without an endorsement is invisible to every agent: they
 * chain-adopt from an endorsed key or they do not adopt at all. The device that
 * minted it cannot fix it, because the console signs an endorsement only with
 * the key in its own browser and that key is the revoked one. These helpers
 * drive the panel that lets a HEALTHY device rescue the stranded one.
 */

const live = (key_id: string, extra: Record<string, unknown> = {}) => ({
  key_id,
  label: key_id,
  revoked_at: null,
  endorsed_by_key_id: null,
  ...extra,
});

describe("orphanedOperatorKeys", () => {
  it("lists live keys with no endorsement — the ones agents silently ignore", () => {
    const keys = [
      live("root", { endorsed_by_key_id: null }),
      live("orphan"),
      live("adopted", { endorsed_by_key_id: "root" }),
      { key_id: "dead", label: "dead", revoked_at: "2026-08-10T09:47:24Z", endorsed_by_key_id: null },
    ];
    expect(orphanedOperatorKeys(keys, "root").map((k) => k.key_id)).toEqual(["orphan"]);
  });

  it("never lists the trust root itself — it is what everything else chains to", () => {
    const keys = [live("root"), live("orphan")];
    expect(orphanedOperatorKeys(keys, "root").map((k) => k.key_id)).toEqual(["orphan"]);
  });

  it("excludes revoked keys — endorsing a dead key would achieve nothing", () => {
    const keys = [
      live("root"),
      { key_id: "dead", label: "dead", revoked_at: "2026-08-10T09:47:24Z", endorsed_by_key_id: null },
    ];
    expect(orphanedOperatorKeys(keys, "root")).toEqual([]);
  });

  it("is empty and safe on missing input", () => {
    expect(orphanedOperatorKeys(undefined as never, "root")).toEqual([]);
    expect(orphanedOperatorKeys([], undefined as never)).toEqual([]);
  });
});

describe("rescueGuard", () => {
  const keys = [live("root"), live("orphan"), { key_id: "dead", label: "dead", revoked_at: "2026-08-10T09:47:24Z", endorsed_by_key_id: null }];

  it("allows a live unlocked key to endorse a live orphan", () => {
    expect(rescueGuard("orphan", keys, "root")).toEqual({ allowed: true, reason: null });
  });

  it("refuses when this browser holds no unlocked key", () => {
    const g = rescueGuard("orphan", keys, null);
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/unlock/i);
  });

  it("refuses when this device's own key is revoked — the exact #19 dead end", () => {
    const g = rescueGuard("orphan", keys, "dead");
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/revoked/i);
    // Must point at the device that CAN do it, not at Forget device — that
    // advice is what burnt a key id on 16 Aug.
    expect(g.reason).toMatch(/another device|device that holds|live key/i);
  });

  it("refuses self-endorsement", () => {
    const g = rescueGuard("root", keys, "root");
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/itself|self/i);
  });

  it("refuses an unknown target", () => {
    const g = rescueGuard("ghost", keys, "root");
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/unknown|not found/i);
  });

  it("refuses a revoked target", () => {
    const g = rescueGuard("dead", keys, "root");
    expect(g.allowed).toBe(false);
    expect(g.reason).toMatch(/revoked/i);
  });
});

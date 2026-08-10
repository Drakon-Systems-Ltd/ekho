import { describe, it, expect } from "vitest";
// Pure trust-state helpers shared by the Security screen. No React, so they unit-test cleanly.
import {
  endorserStatus,
  dependentsOf,
  trustHealth,
  deviceKeySigningState,
  liveOperatorKeys,
  revokeGuard,
  pickEndorser,
} from "../frontend/src/operatorTrust.js";

const opKeys = [
  { key_id: "live1", label: "MacBook", revoked_at: null },
  { key_id: "live2", label: "iPhone", revoked_at: null },
  { key_id: "dead1", label: "cli-bootstrap", revoked_at: "2026-06-07T21:22:53.694Z" },
];

describe("endorserStatus", () => {
  it("flags an agent endorsed by a revoked key as needing action", () => {
    const s = endorserStatus({ endorsed_by_key_id: "dead1" }, opKeys, "live1");
    expect(s.state).toBe("revoked");
    expect(s.needsAction).toBe(true);
    expect(s.endorserLabel).toBe("cli-bootstrap");
  });

  it("flags an unendorsed agent as needing action", () => {
    const s = endorserStatus({ endorsed_by_key_id: null }, opKeys, "live1");
    expect(s.state).toBe("unendorsed");
    expect(s.needsAction).toBe(true);
  });

  it("treats an agent endorsed by the current device key as settled", () => {
    const s = endorserStatus({ endorsed_by_key_id: "live1" }, opKeys, "live1");
    expect(s.state).toBe("current");
    expect(s.needsAction).toBe(false);
  });

  it("treats an agent endorsed by another active device as foreign-but-ok", () => {
    const s = endorserStatus({ endorsed_by_key_id: "live2" }, opKeys, "live1");
    expect(s.state).toBe("foreign");
    expect(s.needsAction).toBe(false);
    expect(s.endorserLabel).toBe("iPhone");
  });

  it("treats an endorser that isn't in the key list as revoked/unknown", () => {
    const s = endorserStatus({ endorsed_by_key_id: "ghost" }, opKeys, "live1");
    expect(s.state).toBe("revoked");
    expect(s.needsAction).toBe(true);
  });
});

describe("dependentsOf", () => {
  it("counts how many agents are endorsed by a given key", () => {
    const agents = [
      { agent_id: "a", endorsed_by_key_id: "dead1" },
      { agent_id: "b", endorsed_by_key_id: "dead1" },
      { agent_id: "c", endorsed_by_key_id: "live1" },
    ];
    expect(dependentsOf("dead1", agents)).toBe(2);
    expect(dependentsOf("live1", agents)).toBe(1);
    expect(dependentsOf("live2", agents)).toBe(0);
  });
});

describe("trustHealth", () => {
  it("is ok when every agent is endorsed by an active key", () => {
    const agents = [
      { agent_id: "a", endorsed_by_key_id: "live1" },
      { agent_id: "b", endorsed_by_key_id: "live2" },
    ];
    const h = trustHealth(opKeys, agents, "live1");
    expect(h.ok).toBe(true);
    expect(h.problems).toEqual([]);
  });

  it("reports revoked + unendorsed agents as problems", () => {
    const agents = [
      { agent_id: "a", endorsed_by_key_id: "dead1" },
      { agent_id: "b", endorsed_by_key_id: "dead1" },
      { agent_id: "c", endorsed_by_key_id: null },
      { agent_id: "d", endorsed_by_key_id: "live1" },
    ];
    const h = trustHealth(opKeys, agents, "live1");
    expect(h.ok).toBe(false);
    expect(h.revoked).toBe(2);
    expect(h.unendorsed).toBe(1);
    expect(h.problems.length).toBe(2);
  });
});

// #15: on 10 Aug 2026 the operator revoked every key — including the console's
// OWN browser-held device key — and the Security page went on offering
// "Re-endorse all under this device". Each press signed with the dead key,
// failed for all eight agents, and the failure text named the agents rather
// than the actual cause. With zero live keys the fleet then verified nothing
// and, under the default requireSigned: "warn", processed messages unauthenticated.
describe("device-key signing state (#15)", () => {
  const withDeviceRevoked = [
    { key_id: "dev", label: "this device", revoked_at: "2026-08-10T09:50:00.000Z" },
    { key_id: "other", label: "iPhone", revoked_at: null },
  ];

  it("reports a live device key as able to sign", () => {
    const s = deviceKeySigningState(opKeys, "live1");
    expect(s.canSign).toBe(true);
    expect(s.reason).toBeNull();
  });

  it("reports a REVOKED device key as unable to sign, naming the real cause", () => {
    const s = deviceKeySigningState(withDeviceRevoked, "dev");
    expect(s.canSign).toBe(false);
    expect(s.revoked).toBe(true);
    expect(s.reason).toMatch(/revoked/i);
    // The recovery action must be named — nothing on the page pointed to it.
    expect(s.recovery).toMatch(/forget/i);
  });

  it("reports a device key the relay has never seen as unable to sign", () => {
    const s = deviceKeySigningState(opKeys, "ghost");
    expect(s.canSign).toBe(false);
    expect(s.reason).toMatch(/not known to the relay/i);
  });

  it("treats a locked console (no unlocked key) as simply not signing", () => {
    const s = deviceKeySigningState(opKeys, null);
    expect(s.canSign).toBe(false);
    expect(s.revoked).toBe(false);
    expect(s.reason).toMatch(/unlock/i);
  });
});

describe("live operator key count (#15)", () => {
  it("counts only non-revoked keys", () => {
    expect(liveOperatorKeys(opKeys).map((k) => k.key_id)).toEqual(["live1", "live2"]);
  });

  it("zero live keys is the alarm state — agents accept unverified messages", () => {
    const allDead = opKeys.map((k) => ({ ...k, revoked_at: "2026-08-10T09:50:00.000Z" }));
    expect(liveOperatorKeys(allDead)).toHaveLength(0);
  });
});

describe("revocation guard (#15)", () => {
  it("blocks revoking the last live key outright", () => {
    const g = revokeGuard("live1", [{ key_id: "live1", revoked_at: null }], "live1", 0);
    expect(g.blocked).toBe(true);
    expect(g.message).toMatch(/only live operator key/i);
  });

  it("demands a distinct confirmation for the console's OWN device key", () => {
    const g = revokeGuard("live1", opKeys, "live1", 0);
    expect(g.blocked).toBe(false);
    expect(g.selfRevoke).toBe(true);
    expect(g.message).toMatch(/this device/i);
    expect(g.message).toMatch(/endorse/i); // says what you lose
  });

  it("keeps the plain dependents warning for someone else's key", () => {
    const g = revokeGuard("live2", opKeys, "live1", 3);
    expect(g.blocked).toBe(false);
    expect(g.selfRevoke).toBe(false);
    expect(g.message).toMatch(/3 agent/);
  });
});

// #13: every operator key on every fleet carried endorsed_by_key_id: null, so
// the endorsement-chaining branch in the agents' pin sync had never fired once.
// The relay verified and stored endorsements all along — the console simply
// never sent one when generating a replacement key.
describe("pickEndorser (#13)", () => {
  it("chains a new key to the live key currently held by this browser", () => {
    expect(pickEndorser({ keyId: "live1", seed: new Uint8Array(32) }, opKeys)?.keyId).toBe("live1");
  });

  it("refuses a revoked endorser — the relay rejects it and agents drop it anyway", () => {
    expect(pickEndorser({ keyId: "dead1", seed: new Uint8Array(32) }, opKeys)).toBeNull();
  });

  it("refuses a key the relay has never seen", () => {
    expect(pickEndorser({ keyId: "ghost", seed: new Uint8Array(32) }, opKeys)).toBeNull();
  });

  it("returns null for a locked console (first enrolment / post-revocation recovery)", () => {
    expect(pickEndorser(null, opKeys)).toBeNull();
  });
});

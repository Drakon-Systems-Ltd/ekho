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
  mayGenerateNewOperatorIdentity,
  trustRootKey,
  thisBrowserHoldsTrustRoot,
  actingDeviceLabel,
  endorseAuthority,
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
    // #19 (16 Aug): it used to say "Forget device, enrol a new key, re-endorse".
    // Following that on a stranded device mints a key it can NEVER endorse
    // (pickEndorser needs a live seed in the same browser) and registerOperatorKey
    // refuses the id ever after — the operator stayed locked out and burnt a key.
    // The recovery must point at a device that still holds a live key.
    expect(s.recovery).toMatch(/another device|device that holds|live key/i);
    expect(s.recovery).not.toMatch(/forget/i);
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
    expect(g.message).toMatch(/cannot be undone/i);
    expect(g.message).toMatch(/mint a new device key/i);
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

// #19 follow-up: second-device Generate must not be blocked when the live root
// sits on another browser. Empty phone + live X6Nv on laptop is the happy path.
describe("mayGenerateNewOperatorIdentity (#19 second device)", () => {
  const agents = [
    { agent_id: "a", key_id: "ka", endorsed_by_key_id: "live1" },
    { agent_id: "b", key_id: "kb", endorsed_by_key_id: "live1" },
  ];

  it("allows mint on an empty browser when a live trust root exists elsewhere", () => {
    const r = mayGenerateNewOperatorIdentity(null, opKeys, agents);
    expect(r.allowed).toBe(true);
    expect(r.nextStep).toMatch(/Endorse/i);
    expect(r.nextStep).toMatch(/live1|trust root/i);
  });

  it("allows mint when this browser already holds a live endorser", () => {
    const r = mayGenerateNewOperatorIdentity({ keyId: "live1", seed: new Uint8Array(32) }, opKeys, agents);
    expect(r.allowed).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("allows mint when the fleet has zero live keys (recovery)", () => {
    const allDead = opKeys.map((k) => ({ ...k, revoked_at: "2026-08-10T09:50:00.000Z" }));
    expect(mayGenerateNewOperatorIdentity(null, allDead, []).allowed).toBe(true);
  });

  it("refuses mint while this browser still holds a revoked/unlocked dead seed", () => {
    const r = mayGenerateNewOperatorIdentity({ keyId: "dead1", seed: new Uint8Array(32) }, opKeys, agents);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Forget device|cannot endorse/i);
  });
});

// #19 (16 Aug, 08:33Z): the console's device model was invisible. Every device
// rendered the same Security screen, so nothing said which key was THE fleet
// trust root, whether this browser held it, or — when it did not — which device
// did. These helpers make that model explicit so the UI can say "held on
// 'Mike iPhone 15 Pro Max' — this browser cannot endorse" instead of a generic
// refusal that names no way out.
describe("fleet trust root (#19)", () => {
  const rootedKeys = [
    { key_id: "spareK", label: "MacBook", revoked_at: null, endorsed_by_key_id: null },
    { key_id: "rootK", label: "Mike iPhone 15 Pro Max", revoked_at: null, endorsed_by_key_id: null },
    { key_id: "deadK", label: "old-laptop", revoked_at: "2026-08-10T09:47:24Z", endorsed_by_key_id: null },
  ];
  const rootedAgents = [
    { agent_id: "a", key_id: "k-a", endorsed_by_key_id: "rootK" },
    { agent_id: "b", key_id: "k-b", endorsed_by_key_id: "rootK" },
  ];

  describe("trustRootKey", () => {
    it("identifies the live key with dependents as the root", () => {
      expect(trustRootKey(rootedKeys, rootedAgents)?.key_id).toBe("rootK");
    });

    it("does not pick another live key with zero dependents, whatever the list order", () => {
      // spareK is listed first and is live — but no agent pins it.
      expect(trustRootKey(rootedKeys, rootedAgents)?.key_id).not.toBe("spareK");
    });

    it("picks the live key with the MOST dependents when trust is split", () => {
      const split = [
        ...rootedAgents,
        { agent_id: "c", key_id: "k-c", endorsed_by_key_id: "spareK" },
      ];
      expect(trustRootKey(rootedKeys, split)?.key_id).toBe("rootK");
    });

    it("never returns a revoked key, even one agents still pin — a dead chain is not a root", () => {
      const agents = [{ agent_id: "a", key_id: "k-a", endorsed_by_key_id: "deadK" }];
      expect(trustRootKey(rootedKeys, agents)).toBeNull();
    });

    it("returns null on a fresh fleet — no agent endorsed means no root exists yet", () => {
      expect(trustRootKey(rootedKeys, [])).toBeNull();
      expect(trustRootKey(rootedKeys, [{ agent_id: "a", key_id: "k-a", endorsed_by_key_id: null }])).toBeNull();
    });

    it("is null and safe on missing input", () => {
      expect(trustRootKey(undefined as never, undefined as never)).toBeNull();
    });
  });

  describe("thisBrowserHoldsTrustRoot", () => {
    it("is true when the unlocked key IS the fleet trust root", () => {
      expect(thisBrowserHoldsTrustRoot("rootK", rootedKeys, rootedAgents)).toBe(true);
    });

    it("is false when this browser holds a different live key", () => {
      expect(thisBrowserHoldsTrustRoot("spareK", rootedKeys, rootedAgents)).toBe(false);
    });

    it("is false when the console is locked", () => {
      expect(thisBrowserHoldsTrustRoot(null, rootedKeys, rootedAgents)).toBe(false);
    });

    it("is false when no root exists at all", () => {
      expect(thisBrowserHoldsTrustRoot("rootK", rootedKeys, [])).toBe(false);
    });
  });

  describe("actingDeviceLabel", () => {
    it("returns the root key's device label — the device that can act", () => {
      expect(actingDeviceLabel(rootedKeys, rootedAgents)).toBe("Mike iPhone 15 Pro Max");
    });

    it("falls back to the key id when the root carries no label", () => {
      const keys = [{ key_id: "rootK", label: null, revoked_at: null, endorsed_by_key_id: null }];
      expect(actingDeviceLabel(keys, rootedAgents)).toBe("rootK");
    });

    it("is null when no device can act", () => {
      expect(actingDeviceLabel(rootedKeys, [])).toBeNull();
    });
  });

  // The refusal copy must name the device that CAN act, not just say "another
  // device" — on 16 Aug the operator had no way to know which browser to walk to.
  describe("blocked actions name the acting device (#19)", () => {
    it("endorseAuthority names the root device when this key is revoked", () => {
      const keys = [
        { key_id: "devK", label: "this device", revoked_at: "2026-08-16T08:33:00Z", endorsed_by_key_id: null },
        ...rootedKeys,
      ];
      const g = endorseAuthority("devK", keys, rootedAgents);
      expect(g.allowed).toBe(false);
      expect(g.reason).toMatch(/Mike iPhone 15 Pro Max/);
    });

    it("endorseAuthority names the root device when this key is live but untrusted", () => {
      const g = endorseAuthority("spareK", rootedKeys, rootedAgents);
      expect(g.allowed).toBe(false);
      expect(g.reason).toMatch(/Mike iPhone 15 Pro Max/);
    });

    it("endorseAuthority keeps a generic pointer when no root is known", () => {
      // Every agent chains to a revoked key: no live root exists to name.
      const keys = [
        { key_id: "devK", label: "this device", revoked_at: "2026-08-16T08:33:00Z", endorsed_by_key_id: null },
        { key_id: "deadK", label: "old-laptop", revoked_at: "2026-08-10T09:47:24Z", endorsed_by_key_id: null },
      ];
      const agents = [{ agent_id: "a", key_id: "k-a", endorsed_by_key_id: "deadK" }];
      const g = endorseAuthority("devK", keys, agents);
      expect(g.allowed).toBe(false);
      expect(g.reason).toMatch(/another device|device that holds|live key/i);
    });

    it("deviceKeySigningState recovery names the root device when agent keys are provided", () => {
      const keys = [
        { key_id: "devK", label: "this device", revoked_at: "2026-08-16T08:33:00Z", endorsed_by_key_id: null },
        ...rootedKeys,
      ];
      const s = deviceKeySigningState(keys, "devK", rootedAgents);
      expect(s.canSign).toBe(false);
      expect(s.recovery).toMatch(/Mike iPhone 15 Pro Max/);
      expect(s.recovery).not.toMatch(/forget/i);
    });

    it("deviceKeySigningState keeps the generic recovery when agent keys are unknown", () => {
      const keys = [
        { key_id: "devK", label: "this device", revoked_at: "2026-08-16T08:33:00Z", endorsed_by_key_id: null },
        ...rootedKeys,
      ];
      const s = deviceKeySigningState(keys, "devK");
      expect(s.recovery).toMatch(/another device|device that holds|live key/i);
    });
  });
});

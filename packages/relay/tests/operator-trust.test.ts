import { describe, it, expect } from "vitest";
// Pure trust-state helpers shared by the Security screen. No React, so they unit-test cleanly.
import { endorserStatus, dependentsOf, trustHealth } from "../frontend/src/operatorTrust.js";

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

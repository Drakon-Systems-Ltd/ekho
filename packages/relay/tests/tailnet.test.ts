import { describe, it, expect } from "vitest";
import { evaluateTailnetGate, isTrustedTailnetPeer, tailnetLoginFromHeaders } from "../src/tailnet";

const TRUSTED = ["127.0.0.1", "::1", "::ffff:127.0.0.1"] as const;

describe("tailnetLoginFromHeaders", () => {
  it("reads the Tailscale identity header (string or array)", () => {
    expect(tailnetLoginFromHeaders({ "tailscale-user-login": "alice@example.com" })).toBe("alice@example.com");
    expect(tailnetLoginFromHeaders({ "tailscale-user-login": [" bob@x "] })).toBe("bob@x");
    expect(tailnetLoginFromHeaders({})).toBe("");
  });
});

describe("isTrustedTailnetPeer (#60)", () => {
  it("accepts a configured trusted proxy socket address", () => {
    expect(isTrustedTailnetPeer("127.0.0.1", TRUSTED)).toBe(true);
    expect(isTrustedTailnetPeer("::1", TRUSTED)).toBe(true);
  });
  it("treats an IPv4-mapped address as its IPv4 form, both directions", () => {
    // Dual-stack listener reports loopback as ::ffff:127.0.0.1 — Tailscale
    // Serve must keep working whichever form the deployment configured.
    expect(isTrustedTailnetPeer("::ffff:127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(isTrustedTailnetPeer("127.0.0.1", ["::ffff:127.0.0.1"])).toBe(true);
    expect(isTrustedTailnetPeer("::FFFF:127.0.0.1", TRUSTED)).toBe(true);
  });
  it("ignores an IPv6 zone id and brackets", () => {
    expect(isTrustedTailnetPeer("[::1]", TRUSTED)).toBe(true);
    expect(isTrustedTailnetPeer("::1%lo0", TRUSTED)).toBe(true);
  });
  it("rejects any other peer, and fails closed on a missing address", () => {
    expect(isTrustedTailnetPeer("198.51.100.7", TRUSTED)).toBe(false);
    expect(isTrustedTailnetPeer("::ffff:198.51.100.7", TRUSTED)).toBe(false);
    expect(isTrustedTailnetPeer("", TRUSTED)).toBe(false);
    expect(isTrustedTailnetPeer(undefined, TRUSTED)).toBe(false);
    expect(isTrustedTailnetPeer("127.0.0.1", [])).toBe(false);
  });
});

describe("evaluateTailnetGate", () => {
  it("allows everything when the gate is off", () => {
    expect(evaluateTailnetGate({ require: false, allowedUser: "", login: "", peerTrusted: false }).allowed).toBe(true);
  });
  it("blocks a request with no tailnet identity when required", () => {
    const r = evaluateTailnetGate({ require: true, allowedUser: "", login: "", peerTrusted: true });
    expect(r.allowed).toBe(false);
  });
  it("allows any tailnet identity when no user allowlist is set", () => {
    expect(evaluateTailnetGate({ require: true, allowedUser: "", login: "anyone@x", peerTrusted: true }).allowed).toBe(true);
  });
  it("allows only the allowlisted tailnet user", () => {
    expect(evaluateTailnetGate({ require: true, allowedUser: "me@x", login: "me@x", peerTrusted: true }).allowed).toBe(true);
    expect(evaluateTailnetGate({ require: true, allowedUser: "me@x", login: "other@x", peerTrusted: true }).allowed).toBe(false);
  });
  it("rejects an identity asserted by an untrusted peer (#60)", () => {
    // The header is client-settable; only the trusted proxy may assert it.
    expect(evaluateTailnetGate({ require: true, allowedUser: "", login: "me@x", peerTrusted: false }).allowed).toBe(false);
    expect(evaluateTailnetGate({ require: true, allowedUser: "me@x", login: "me@x", peerTrusted: false }).allowed).toBe(false);
  });
});

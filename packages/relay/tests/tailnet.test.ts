import { describe, it, expect } from "vitest";
import { evaluateTailnetGate, tailnetLoginFromHeaders } from "../src/tailnet";

describe("tailnetLoginFromHeaders", () => {
  it("reads the Tailscale identity header (string or array)", () => {
    expect(tailnetLoginFromHeaders({ "tailscale-user-login": "alice@example.com" })).toBe("alice@example.com");
    expect(tailnetLoginFromHeaders({ "tailscale-user-login": [" bob@x "] })).toBe("bob@x");
    expect(tailnetLoginFromHeaders({})).toBe("");
  });
});

describe("evaluateTailnetGate", () => {
  it("allows everything when the gate is off", () => {
    expect(evaluateTailnetGate({ require: false, allowedUser: "", login: "" }).allowed).toBe(true);
  });
  it("blocks a request with no tailnet identity when required", () => {
    const r = evaluateTailnetGate({ require: true, allowedUser: "", login: "" });
    expect(r.allowed).toBe(false);
  });
  it("allows any tailnet identity when no user allowlist is set", () => {
    expect(evaluateTailnetGate({ require: true, allowedUser: "", login: "anyone@x" }).allowed).toBe(true);
  });
  it("allows only the allowlisted tailnet user", () => {
    expect(evaluateTailnetGate({ require: true, allowedUser: "me@x", login: "me@x" }).allowed).toBe(true);
    expect(evaluateTailnetGate({ require: true, allowedUser: "me@x", login: "other@x" }).allowed).toBe(false);
  });
});

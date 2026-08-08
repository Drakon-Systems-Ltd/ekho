import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectVerificationRejects } from "../src/autoreply";
import { appendDeadLetters, DEAD_LETTER_FILE } from "../src/dead-letter";
import type { VerifyResult } from "../src/verify";

function msg(over: Record<string, unknown> = {}): any {
  return {
    message_id: "m1",
    conversation_id: "c1",
    sender_agent_id: "peer1",
    sender_kind: "agent",
    message_type: "direct",
    body: { text: "hi" },
    agent_sig: "sig",
    key_id: "k1",
    sig_canonical: { nonce: "n1" },
    ...over
  };
}

const failed: VerifyResult = { verified: false, kind: "peer", reason: "sender-key-unendorsed", keyId: "k1" };
const passed: VerifyResult = { verified: true, kind: "peer", reason: null, keyId: "k1" };

describe("collectVerificationRejects", () => {
  it("collects a signed peer message that failed verification", () => {
    const m = msg();
    const rejects = collectVerificationRejects([m], { m1: failed }, "self");
    expect(rejects).toHaveLength(1);
    expect(rejects[0].message).toBe(m);
    expect(rejects[0].verdict.reason).toBe("sender-key-unendorsed");
  });

  it("collects a signed operator message that failed verification", () => {
    const m = msg({ sender_kind: "operator", sender_agent_id: "op", agent_sig: null, operator_sig: "osig" });
    const rejects = collectVerificationRejects([m], { m1: { ...failed, kind: "operator" } }, "self");
    expect(rejects).toHaveLength(1);
  });

  it("skips verified messages", () => {
    expect(collectVerificationRejects([msg()], { m1: passed }, "self")).toHaveLength(0);
  });

  it("skips unsigned messages (graceful fallback, not a reject)", () => {
    const m = msg({ agent_sig: null });
    const rejects = collectVerificationRejects([m], { m1: { ...failed, reason: "unsigned" } }, "self");
    expect(rejects).toHaveLength(0);
  });

  it("skips messages with no verdict (verification dormant)", () => {
    expect(collectVerificationRejects([msg()], { m1: null }, "self")).toHaveLength(0);
    expect(collectVerificationRejects([msg()], {}, "self")).toHaveLength(0);
  });

  it("skips our own outbound", () => {
    const m = msg({ sender_agent_id: "self" });
    expect(collectVerificationRejects([m], { m1: failed }, "self")).toHaveLength(0);
  });
});

describe("appendDeadLetters", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-dl-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appends one JSONL record per reject with the full message", () => {
    appendDeadLetters(dir, [
      { rejected_at: "2026-08-08T07:00:00Z", reason: "sender-key-unendorsed", kind: "peer", key_id: "k1", message: msg() }
    ]);
    appendDeadLetters(dir, [
      { rejected_at: "2026-08-08T07:01:00Z", reason: "bad-signature", kind: "peer", key_id: "k2", message: msg({ message_id: "m2" }) }
    ]);
    const lines = fs
      .readFileSync(path.join(dir, DEAD_LETTER_FILE), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].reason).toBe("sender-key-unendorsed");
    expect(lines[0].message.body.text).toBe("hi");
    expect(lines[1].message.message_id).toBe("m2");
  });

  it("writes nothing for an empty batch", () => {
    appendDeadLetters(dir, []);
    expect(fs.existsSync(path.join(dir, DEAD_LETTER_FILE))).toBe(false);
  });

  it("rotates once past the size cap instead of growing unbounded", () => {
    const filePath = path.join(dir, DEAD_LETTER_FILE);
    fs.writeFileSync(filePath, "x".repeat(5 * 1024 * 1024 + 1));
    appendDeadLetters(dir, [
      { rejected_at: "2026-08-08T07:00:00Z", reason: "stale", kind: "peer", key_id: "k1", message: msg() }
    ]);
    expect(fs.existsSync(`${filePath}.1`)).toBe(true);
    const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});

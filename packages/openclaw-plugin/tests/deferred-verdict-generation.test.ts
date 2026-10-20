// #149, end to end through the real poll loop: a passing verdict held in the
// deferred-turn stash must not outlive the trust-pin generation it was computed
// under. A signed operator message is stashed behind a held floor; the next poll
// carries the relay's GENUINE signed revocation of the signing key, which unpins
// it; the held-back message must then not render "CRYPTOGRAPHICALLY VERIFIED" —
// neither on the deferred-retry path nor when a fresh message covers the stash.
//
// The relay is real (its signed /v1/inbox operator_keys feed the loop); only the
// turn's child process is mocked so its prompt can be inspected.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

const hoisted = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (_cmd: string, args: string[]) => {
      hoisted.calls.push(args);
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => {};
      setTimeout(() => child.emit("exit", 0), 0);
      return child;
    }
  };
});

import {
  b64url,
  keyId,
  sha256Hex,
  signCanonical,
  endorsementPayload,
  agentKeyEndorsementPayload,
  revocationPayload
} from "../src/identity";
import { resetAdvisoryRevocationWarningStateForTests, type OperatorKeyEntryLike } from "../src/verification";
import {
  buildStash,
  createAutoReplyState,
  mergeCoveredStashes,
  stashDeferred,
  stashVerdicts,
  startAutoReply,
  verificationGeneration
} from "../src/autoreply";
import type { EkhoIdentity } from "../src/credentials";
import type { VerifyResult } from "../src/verify";
import { createTestRelay, type TestRelay } from "../../relay/tests/setup";

let fill = 90;
function makeKey() {
  const seed = new Uint8Array(32).fill(fill++);
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, pubB64: b64url(pub), id: keyId(pub) };
}
type K = ReturnType<typeof makeKey>;

const QUIET = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} };

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = performance.now();
  while (!pred()) {
    if (performance.now() - started > timeoutMs) throw new Error("timed out waiting for the tick");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The "• From …" line that introduces the message whose body holds `text`. */
function fromLine(prompt: string, text: string): string {
  const head = prompt.slice(0, prompt.indexOf(text));
  return head.slice(head.lastIndexOf("• From"));
}

function peerMsg(id: string, conv: string, text: string): any {
  return {
    message_id: id,
    conversation_id: conv,
    sender_agent_id: "peer1",
    sender_kind: "agent",
    message_type: "direct",
    body: { text }
  };
}

describe("#149 a stashed passing verdict does not survive a signed revocation", () => {
  let relay: TestRelay;
  let root: K;
  let successor: K;
  let agent: { agent_id: string; secret: string };

  const inboxKeys = async (): Promise<OperatorKeyEntryLike[]> => {
    const res = await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox?limit=10");
    expect(res.status).toBe(200);
    return res.body.operator_keys as OperatorKeyEntryLike[];
  };

  /** A genuinely signed operator message to the agent. */
  const signedOperatorMsg = (id: string, conv: string, text: string, key: K): any => {
    const canonical = {
      v: 1,
      fleet_id: relay.fleetId,
      operator_id: "op",
      key_id: key.id,
      recipient: { kind: "agent", id: "self" },
      conversation_id: conv,
      body_sha256: sha256Hex(text),
      sent_at: new Date().toISOString(),
      nonce: `n-${id}`
    };
    return {
      message_id: id,
      conversation_id: conv,
      sender_kind: "operator",
      sender_agent_id: "op_" + relay.fleetId,
      message_type: "direct",
      body: { text },
      operator_sig: signCanonical(canonical, key.seed),
      agent_sig: null,
      key_id: key.id,
      sig_canonical: canonical
    };
  };

  /** Revoke `root` on the console, signed by `successor` — the real route. */
  const revokeRoot = async () => {
    const revokedAt = new Date().toISOString();
    const res = await relay.operatorRequest("POST", `/v1/operator/keys/${root.id}/revoke`, {
      revoked_by_key_id: successor.id,
      revoked_at: revokedAt,
      signature: signCanonical(revocationPayload(relay.fleetId, root.id, revokedAt), successor.seed)
    });
    expect(res.status).toBe(200);
  };

  beforeEach(async () => {
    resetAdvisoryRevocationWarningStateForTests();
    relay = await createTestRelay();
    root = makeKey();
    successor = makeKey();
    await relay.operatorRequest("POST", "/v1/operator/keys", { public_key: root.pubB64, label: "lost-browser" });
    await relay.operatorRequest("POST", "/v1/operator/keys", {
      public_key: successor.pubB64,
      label: "new-browser",
      endorsement: {
        endorsed_by_key_id: root.id,
        signature: signCanonical(endorsementPayload(relay.fleetId, successor.id, successor.pubB64), root.seed)
      }
    });
    agent = await relay.enrollAgent("Jarvis");
    // As in relay-signed-revocation.test.ts: root is a genuine trust root, and
    // the agent is carried onto the successor before root is revoked.
    const ak = makeKey();
    const akId = relay.db.setAgentIdentityKey(agent.agent_id, relay.fleetId, ak.pubB64).keyId;
    for (const by of [root, successor]) {
      relay.db.endorseAgentKey(relay.fleetId, agent.agent_id, akId, {
        endorsedByKeyId: by.id,
        signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, agent.agent_id, akId, ak.pubB64), by.seed)
      });
    }
  });
  afterEach(() => {
    hoisted.calls.length = 0;
    relay.cleanup();
  });

  const pinnedBoth = (): EkhoIdentity => ({
    seedHex: "33".repeat(32),
    pinnedOperatorKeys: { [root.id]: root.pubB64, [successor.id]: successor.pubB64 },
    tofuAt: "2026-08-01T00:00:00.000Z"
  });

  /**
   * Drive the loop: tick 1 stashes `held` behind a busy floor under the
   * pre-revocation keys; then root is revoked and every later poll serves the
   * relay's post-revocation keys (plus `tick2Messages`, once), with the floor
   * now free.
   */
  async function run(held: any[], tick2Messages: any[]) {
    const keysBefore = await inboxKeys();
    let revoked = false;
    let keysAfter: OperatorKeyEntryLike[] = [];
    let served = 0;
    let acquires = 0;
    const identity = pinnedBoth();
    const client = {
      getInbox: async () => {
        served++;
        if (served === 1) {
          return { messages: held, operator_trusted: true, peer_autoreply: true, roster: [], fleet_id: relay.fleetId, operator_keys: keysBefore };
        }
        if (!revoked) return { messages: [], operator_trusted: true, roster: [], fleet_id: relay.fleetId, operator_keys: keysBefore };
        const messages = served === tick2Served ? tick2Messages : [];
        return { messages, operator_trusted: true, peer_autoreply: true, roster: [], fleet_id: relay.fleetId, operator_keys: keysAfter };
      },
      ackMessages: async () => {},
      // Held until the revocation has reached the inbox; free from then on.
      acquireFloor: async () => {
        acquires++;
        return revoked ? { granted: true } : { granted: false, holder_agent_id: "agent_holder" };
      },
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    let tick2Served = -1;
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      identity: identity as any,
      log: QUIET
    });
    try {
      // Tick 1 deferred the batch behind the held floor; nothing ran.
      await waitFor(() => acquires > 0);
      expect(hoisted.calls).toHaveLength(0);
      await revokeRoot();
      keysAfter = await inboxKeys();
      const dead = keysAfter.find((k) => k.key_id === root.id)!;
      expect(dead.revocation_sig).toBeTruthy();
      tick2Served = served + 1;
      revoked = true;
      await waitFor(() => hoisted.calls.length > 0);
    } finally {
      stop();
    }
    // The revocation genuinely took effect in the loop's identity.
    expect(identity.pinnedOperatorKeys[root.id]).toBeUndefined();
    expect(identity.pinnedOperatorKeys[successor.id]).toBe(successor.pubB64);
    expect(hoisted.calls).toHaveLength(1);
    return hoisted.calls[0][hoisted.calls[0].length - 1];
  }

  it("deferred path: the held-back operator message is not rendered CRYPTOGRAPHICALLY VERIFIED", async () => {
    const prompt = await run(
      [
        peerMsg("p1", "c-held", "teammate contends for the floor"),
        signedOperatorMsg("op1", "c-held", "signed by the soon-revoked root", root)
      ],
      []
    );
    expect(prompt).toContain("signed by the soon-revoked root"); // still delivered…
    const line = fromLine(prompt, "signed by the soon-revoked root");
    expect(line).not.toContain("CRYPTOGRAPHICALLY VERIFIED"); // …but not as verified
    expect(line).toContain("relay-authenticated fleet operator"); // the attested wording
    expect(prompt).toContain("teammate contends for the floor");
  });

  it("covering path: a fresh message covering the stash does not carry the stale verdict", async () => {
    const prompt = await run(
      [
        peerMsg("p1", "c-held", "teammate contends for the floor"),
        signedOperatorMsg("op1", "c-held", "signed by the soon-revoked root", root)
      ],
      // Signed by the still-pinned successor: verified under the NEW generation.
      [signedOperatorMsg("op2", "c-held", "fresh ask signed by the successor", successor)]
    );
    expect(prompt).toContain("[HELD BACK"); // it really was a covering turn
    const held = fromLine(prompt, "signed by the soon-revoked root");
    expect(held).toContain("HELD BACK");
    expect(held).not.toContain("CRYPTOGRAPHICALLY VERIFIED");
    expect(held).toContain("relay-authenticated fleet operator");
    // Positive control: a verdict computed under the current pins still renders.
    expect(fromLine(prompt, "fresh ask signed by the successor")).toContain("CRYPTOGRAPHICALLY VERIFIED");
  });
});

describe("#149 stash verdicts are bound to the verification generation", () => {
  const msg = (id: string): any => ({
    message_id: id,
    conversation_id: "c",
    sender_agent_id: "op",
    sender_kind: "operator",
    message_type: "direct",
    body: { text: id }
  });
  const pass: VerifyResult = { verified: true, kind: "operator", keyId: "k1" } as VerifyResult;
  const fail: VerifyResult = { verified: false, kind: "operator", keyId: "k1", reason: "bad-signature" } as VerifyResult;

  it("verificationGeneration changes with pins, revocations and TOFU", () => {
    const base = { seedHex: "00".repeat(32), pinnedOperatorKeys: { a: "A" } } as EkhoIdentity;
    const g = verificationGeneration(base);
    expect(verificationGeneration({ ...base })).toBe(g);
    expect(verificationGeneration({ ...base, pinnedOperatorKeys: {} })).not.toBe(g);
    expect(verificationGeneration({ ...base, revokedOperatorKeys: { a: "t" } } as EkhoIdentity)).not.toBe(g);
    expect(verificationGeneration({ ...base, tofuAt: "t" } as EkhoIdentity)).not.toBe(g);
  });

  it("downgrades a passing verdict to null across a generation change, and keeps a failed one", () => {
    const state = createAutoReplyState();
    stashDeferred(state, "c", [msg("ok"), msg("bad")], { ok: pass, bad: fail }, 0, "gen-1");
    const stash = state.deferredByConversation.get("c")!;
    const same = Object.values(stashVerdicts(stash, "gen-1"));
    expect(same).toEqual([pass, fail]);
    const moved = Object.values(stashVerdicts(stash, "gen-2"));
    expect(moved).toEqual([null, fail]);
    // An entry with no recorded generation is never treated as current.
    const legacy = buildStash([{ message: msg("ok"), verification: pass }], 0);
    expect(Object.values(stashVerdicts(legacy, "gen-1"))).toEqual([null]);
  });

  it("a retained entry keeps the generation its verdict was computed under", () => {
    const state = createAutoReplyState();
    stashDeferred(state, "c", [msg("ok")], { ok: pass }, 0, "gen-1");
    // Redelivered under a new generation with no fresh verdict: the stored one
    // is reused, but must stay stamped with gen-1.
    stashDeferred(state, "c", [msg("ok")], {}, 1, "gen-2");
    expect(Object.values(stashVerdicts(state.deferredByConversation.get("c")!, "gen-2"))).toEqual([null]);
  });

  it("the covering merge applies the same rule to held entries only", () => {
    const state = createAutoReplyState();
    stashDeferred(state, "c", [msg("ok"), msg("bad")], { ok: pass, bad: fail }, 0, "gen-1");
    const fresh = msg("fresh");
    const cover = mergeCoveredStashes(state, [fresh], { fresh: pass }, 1, "gen-2");
    expect(Object.values(cover.verifications)).toEqual([null, fail, pass]);
    const same = mergeCoveredStashes(state, [fresh], { fresh: pass }, 1, "gen-1");
    expect(Object.values(same.verifications)).toEqual([pass, fail, pass]);
  });
});

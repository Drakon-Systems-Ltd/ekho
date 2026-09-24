// #78, end to end through the real poll loop: a peer message deferred to a
// floor holder that never lets go is delivered LATE rather than binned, and a
// stash the FIFO cap pushes out leaves a dead-letter record behind it.
//
// The child process is mocked so the tick can spawn a "turn" and be inspected
// without running a gateway; only `Date` is faked, so the loop's own interval
// still runs on real time.

import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ calls: [] as string[][], spawnFails: false }));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (_cmd: string, args: string[]) => {
      hoisted.calls.push(args);
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => {};
      setTimeout(() => {
        // `spawnFails` reproduces a child that never starts: triggerTurn reports
        // "did not start", which must never be read as "delivered".
        if (hoisted.spawnFails) child.emit("error", new Error("no gateway entry"));
        else child.emit("exit", 0);
      }, 0);
      return child;
    }
  };
});

import { startAutoReply, DEFERRED_MESSAGES_PER_CONV, DEFERRED_RETRY_TTL_MS } from "../src/autoreply";

function peerMsg(i: number, conv = `c${i}`): any {
  return {
    message_id: `m${i}`,
    conversation_id: conv,
    sender_agent_id: `peer${i}`,
    sender_kind: "agent",
    message_type: "direct",
    body: { text: `teammate says ${i}` }
  };
}

/** Poll a predicate on REAL time (only Date is faked in these tests). */
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = performance.now();
  while (!pred()) {
    if (performance.now() - started > timeoutMs) throw new Error("timed out waiting for the tick");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function operatorMsg(conv: string, id: string, text: string): any {
  return {
    message_id: id,
    conversation_id: conv,
    sender_agent_id: "op",
    sender_kind: "operator",
    message_type: "direct",
    body: { text }
  };
}

/** Serve one batch per getInbox call, then empty batches forever. */
function inboxQueue(batches: any[]): () => Promise<any> {
  let i = 0;
  return async () => batches[i++] ?? { messages: [] };
}

/** The "• From …" line that introduces the message whose body holds `text`. */
function fromLine(prompt: string, text: string): string {
  const head = prompt.slice(0, prompt.indexOf(text));
  return head.slice(head.lastIndexOf("• From"));
}

afterEach(() => {
  hoisted.calls.length = 0;
  hoisted.spawnFails = false;
  vi.useRealTimers();
});

describe("#78 the tick delivers an overrun stash late, without the floor", () => {
  it("wakes the agent once the retry window is spent, even though the holder still holds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));

    const acquires: string[] = [];
    const releases: string[] = [];
    let served = 0;
    const client = {
      getInbox: async () =>
        served++ === 0
          ? { messages: [peerMsg(1, "c-held")], operator_trusted: false, peer_autoreply: true, roster: [] }
          : { messages: [] },
      ackMessages: async () => {},
      // The reported failure mode: the holder simply never lets go.
      acquireFloor: async (conv: string) => {
        acquires.push(conv);
        return { granted: false, holder_agent_id: "agent_holder" };
      },
      releaseFloor: async (conv: string) => {
        releases.push(conv);
      },
      raiseNotice: async () => {}
    };
    const warnings: string[] = [];
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      log: { warn: (m: unknown) => warnings.push(String(m)), info: () => {}, debug: () => {}, error: () => {} }
    });

    try {
      // Tick 1: floor held -> deferred + stashed, no turn.
      await waitFor(() => acquires.length > 0);
      expect(hoisted.calls).toHaveLength(0);

      // Past the whole retry window, with the floor STILL held.
      vi.setSystemTime(Date.now() + DEFERRED_RETRY_TTL_MS + 60_000);
      await waitFor(() => hoisted.calls.length > 0);
      expect(hoisted.calls).toHaveLength(1);
    } finally {
      stop();
    }

    const prompt = hoisted.calls[0][hoisted.calls[0].length - 1];
    expect(prompt).toContain("teammate says 1"); // the held-back message itself
    expect(prompt).toContain("waited past the floor window"); // the overrun marker
    expect(prompt).toContain("WITHOUT the floor");
    // An overrun turn takes no floor, so it has none to release either.
    expect(releases).toEqual([]);
    expect(
      warnings.some(
        (w) => w.includes("exceeded retry window") && w.includes("delivering late without the floor")
      )
    ).toBe(true);
  });
});

describe("#78 the tick dead-letters a stash the cap evicts", () => {
  it("records the evicted messages and warns instead of dropping them silently", async () => {
    // One more deferred conversation than the 50-conversation cap. Each comes
    // from a distinct peer so the per-peer rate gate doesn't thin the batch.
    const messages = Array.from({ length: 51 }, (_, i) => peerMsg(i));
    let served = 0;
    const client = {
      getInbox: async () =>
        served++ === 0
          ? { messages, operator_trusted: false, peer_autoreply: true, roster: [] }
          : { messages: [] },
      ackMessages: async () => {},
      acquireFloor: async () => ({ granted: false, holder_agent_id: "agent_holder" }),
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    const records: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      log: { warn: (m: unknown) => warnings.push(String(m)), info: () => {}, debug: () => {}, error: () => {} },
      onDeadLetter: (r) => records.push(...(r as unknown as Array<Record<string, unknown>>))
    });

    try {
      await waitFor(() => records.length > 0);
    } finally {
      stop();
    }

    expect(records).toHaveLength(1);
    expect(records[0].reason).toBe("deferred_evicted_cap");
    expect(records[0].kind).toBe("deferred");
    expect((records[0].message as { message_id: string }).message_id).toBe("m0"); // FIFO: oldest out
    expect(hoisted.calls).toHaveLength(0); // every conversation was deferred
    expect(warnings.some((w) => w.includes("evicted at the"))).toBe(true);
  });
});

describe("#78 r2 a covering turn delivers the stash instead of clearing it", () => {
  it("carries the held-back peer message into the operator's turn", async () => {
    // An operator message bypasses the floor, so it triggered a turn in a
    // conversation whose peer message was still stashed for that same floor.
    // The turn cleared the stash and spawned WITHOUT it: no turn, no record.
    const client = {
      getInbox: inboxQueue([
        { messages: [peerMsg(1, "c-held")], operator_trusted: false, peer_autoreply: true, roster: [] },
        { messages: [operatorMsg("c-held", "op1", "operator ping")], operator_trusted: true, roster: [] }
      ]),
      ackMessages: async () => {},
      acquireFloor: async () => ({ granted: false, holder_agent_id: "agent_holder" }),
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    const records: unknown[] = [];
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
      onDeadLetter: (r) => records.push(...(r as unknown[]))
    });

    try {
      await waitFor(() => hoisted.calls.length > 0);
    } finally {
      stop();
    }

    expect(hoisted.calls).toHaveLength(1);
    const prompt = hoisted.calls[0][hoisted.calls[0].length - 1];
    expect(prompt).toContain("teammate says 1"); // the held-back message
    expect(prompt).toContain("operator ping"); // and the one that covered it
    expect(prompt).toContain("[HELD BACK — delivered late]");
    expect(records).toEqual([]);
  });

  it("keeps the stash when the covering turn never starts, and delivers it later", async () => {
    // Clearing before the spawn made a failed covering turn unrecoverable.
    let floorGranted = false;
    const client = {
      getInbox: inboxQueue([
        { messages: [peerMsg(1, "c-held")], operator_trusted: false, peer_autoreply: true, roster: [] },
        { messages: [operatorMsg("c-held", "op1", "operator ping")], operator_trusted: true, roster: [] }
      ]),
      ackMessages: async () => {},
      acquireFloor: async () => ({ granted: floorGranted, holder_agent_id: "agent_holder" }),
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    const records: unknown[] = [];
    const warnings: string[] = [];
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      log: { warn: (m: unknown) => warnings.push(String(m)), info: () => {}, debug: () => {}, error: () => {} },
      onDeadLetter: (r) => records.push(...(r as unknown[]))
    });

    try {
      hoisted.spawnFails = true; // the covering turn's child never starts
      await waitFor(() => warnings.some((w) => w.includes("keeping the held-back stash")));
      expect(records).toEqual([]); // still retryable, so nothing is dead-lettered yet
      // The stash survived the failure: once a turn can start and the floor
      // frees up, the ordinary retry path delivers it.
      hoisted.spawnFails = false;
      floorGranted = true;
      await waitFor(() => hoisted.calls.length > 1);
    } finally {
      stop();
    }

    const late = hoisted.calls[hoisted.calls.length - 1];
    expect(late[late.length - 1]).toContain("teammate says 1");
    expect(records).toEqual([]);
  });
});

describe("#78 r2 the tick dead-letters a per-conversation overflow", () => {
  it("records the oldest messages the per-conversation cap pushed out", async () => {
    // One more than the per-conversation cap, all in ONE conversation. Each
    // comes from a distinct peer so the per-peer rate gate doesn't thin them.
    const cap = DEFERRED_MESSAGES_PER_CONV;
    const messages = Array.from({ length: cap + 1 }, (_, i) => peerMsg(i, "c-held"));
    const client = {
      getInbox: inboxQueue([
        { messages, operator_trusted: false, peer_autoreply: true, roster: [] }
      ]),
      ackMessages: async () => {},
      acquireFloor: async () => ({ granted: false, holder_agent_id: "agent_holder" }),
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    const records: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      log: { warn: (m: unknown) => warnings.push(String(m)), info: () => {}, debug: () => {}, error: () => {} },
      onDeadLetter: (r) => records.push(...(r as unknown as Array<Record<string, unknown>>))
    });

    try {
      await waitFor(() => records.length > 0);
    } finally {
      stop();
    }

    expect(records).toHaveLength(1);
    expect(records[0].reason).toBe("deferred_overflow_per_conv");
    expect(records[0].kind).toBe("deferred");
    expect((records[0].message as { message_id: string }).message_id).toBe("m0"); // oldest out
    expect(hoisted.calls).toHaveLength(0); // the whole conversation was deferred
    expect(warnings.some((w) => w.includes("overflowed the"))).toBe(true);
  });
});

describe("#78 r2 ticks are serialised", () => {
  it("does not start a second tick while one is awaiting the floor acquire", async () => {
    // The interval used to start tick B while tick A sat on an await, so two
    // ticks could spawn turns at once and the first to finish cleared inFlight
    // under the other.
    let inboxCalls = 0;
    let openAcquire!: () => void;
    const acquireGate = new Promise<void>((r) => { openAcquire = r; });
    let acquireCalls = 0;
    const client = {
      getInbox: async () => {
        inboxCalls += 1;
        return inboxCalls === 1
          ? { messages: [peerMsg(1, "c-held")], operator_trusted: false, peer_autoreply: true, roster: [] }
          : { messages: [] };
      },
      ackMessages: async () => {},
      acquireFloor: async () => {
        acquireCalls += 1;
        // 1st: planFloorTurn defers the message. 2nd: the deferred retry, which
        // hangs here long enough for several more interval periods to elapse.
        if (acquireCalls === 1) return { granted: false, holder_agent_id: "agent_holder" };
        await acquireGate;
        return { granted: true };
      },
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }
    });

    try {
      await waitFor(() => acquireCalls >= 2); // tick 1 is parked on the retry acquire
      const parkedAt = inboxCalls;
      await new Promise((r) => setTimeout(r, 120)); // ~24 interval periods
      expect(inboxCalls).toBe(parkedAt); // no tick re-entered while tick 1 awaited
      expect(acquireCalls).toBe(2);
      expect(hoisted.calls).toHaveLength(0);

      openAcquire();
      await waitFor(() => hoisted.calls.length > 0);
      expect(hoisted.calls).toHaveLength(1); // exactly one turn, not two
    } finally {
      stop();
    }
  });
});

// #78 r3: a message merged into a covering turn keeps ITS OWN verdict.
//
// Round 2 rebuilt the merged verification map from this tick's WHOLE-batch map,
// keyed by message_id — including messages the seen-filter had excluded. Since
// message_id is relay-chosen and reusable, a validly signed message that reused
// a stashed one's id (and so never reached the turn) handed its VERIFIED verdict
// to the held-back message, which the prompt then framed as the operator,
// "CRYPTOGRAPHICALLY VERIFIED".
describe("#78 r3 a covered message never inherits a filtered replacement's verdict", () => {
  it("delivers the stashed unsigned ask unverified, even under a reused id", async () => {
    const { signCanonical, publicKeyB64urlFromSeed, keyId, sha256Hex } = await import("../src/identity");
    const FLEET = "flt_r3";
    const OP_SEED = new Uint8Array(32).fill(7);
    const OP_PUB = publicKeyB64urlFromSeed(OP_SEED);
    const OP_KID = keyId(Buffer.from(OP_PUB, "base64url"));
    const sentAt = new Date().toISOString();
    const replacementText = "signed, and not what was stashed";
    const canonical = {
      v: 1,
      fleet_id: FLEET,
      operator_id: "op",
      key_id: OP_KID,
      recipient: { kind: "agent", id: "self" },
      conversation_id: "c-held",
      body_sha256: sha256Hex(replacementText),
      sent_at: sentAt,
      nonce: "n-r3"
    };
    // Reuses the STASHED message's id, and is genuinely signed.
    const replacement: any = {
      message_id: "unsigned-ask",
      conversation_id: "c-held",
      sender_kind: "operator",
      sender_agent_id: "op_" + FLEET,
      message_type: "direct",
      body: { text: replacementText },
      operator_sig: signCanonical(canonical, OP_SEED),
      agent_sig: null,
      key_id: OP_KID,
      sig_canonical: canonical
    };
    const client = {
      getInbox: inboxQueue([
        // Tick 1: a peer message contends for the held floor and takes the
        // unsigned operator ask in the same conversation down with it.
        {
          messages: [peerMsg(1, "c-held"), operatorMsg("c-held", "unsigned-ask", "unsigned operator ask")],
          operator_trusted: true,
          peer_autoreply: true,
          roster: [],
          fleet_id: FLEET
        },
        // Tick 2: the replacement (a different message, so NOT dropped by the
        // seen-filter since #83) plus a fresh operator message that covers the
        // conversation.
        {
          messages: [replacement, operatorMsg("c-held", "cover", "cover me")],
          operator_trusted: true,
          roster: [],
          fleet_id: FLEET
        }
      ]),
      ackMessages: async () => {},
      acquireFloor: async () => ({ granted: false, holder_agent_id: "agent_holder" }),
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      identity: { seedHex: "22".repeat(32), pinnedOperatorKeys: { [OP_KID]: OP_PUB } } as any,
      log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }
    });

    try {
      await waitFor(() => hoisted.calls.length > 0);
    } finally {
      stop();
    }

    const prompt = hoisted.calls[0][hoisted.calls[0].length - 1];
    expect(prompt).toContain("unsigned operator ask"); // still delivered…
    expect(fromLine(prompt, "unsigned operator ask")).toContain("relay-authenticated fleet operator");
    expect(fromLine(prompt, "unsigned operator ask")).not.toContain("CRYPTOGRAPHICALLY VERIFIED");
    // …and the replacement is delivered as itself, with its own verdict (#83).
    expect(fromLine(prompt, replacementText)).toContain("CRYPTOGRAPHICALLY VERIFIED");
  });
});

// #78 r3: a covering turn can absorb stashes from SEVERAL conversations. Naming
// only the oldest in the deferred context put every other covered
// conversation's catch-up tail under the "already seen, do NOT re-answer"
// header — which is exactly where an unseen correction goes to die.
describe("#78 r3 a covering turn frames every covered conversation's tail as unseen", () => {
  it("does not label C2's correction as already seen", async () => {
    const client = {
      getInbox: inboxQueue([
        // Tick 1: C1 defers first, then C2 — both stashed for the held floor.
        {
          messages: [peerMsg(1, "c1")],
          operator_trusted: false,
          peer_autoreply: true,
          roster: []
        },
        {
          messages: [peerMsg(2, "c2")],
          operator_trusted: false,
          peer_autoreply: true,
          roster: []
        },
        // Tick 3: one batch of operator messages covers BOTH conversations.
        {
          messages: [operatorMsg("c1", "o1", "cover c1"), operatorMsg("c2", "o2", "cover c2")],
          operator_trusted: true,
          roster: [],
          conversation_history: {
            c1: [{ sender_label: "Case", text: "c1 tail line" }],
            c2: [{ sender_label: "Molly", text: "CORRECTION: ignore that" }]
          }
        }
      ]),
      ackMessages: async () => {},
      acquireFloor: async () => ({ granted: false, holder_agent_id: "agent_holder" }),
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }
    });

    try {
      await waitFor(() => hoisted.calls.length > 0);
    } finally {
      stop();
    }

    const prompt = hoisted.calls[0][hoisted.calls[0].length - 1];
    expect(prompt).toContain("teammate says 1");
    expect(prompt).toContain("teammate says 2");
    const before = (needle: string) => prompt.slice(0, prompt.indexOf(needle));
    expect(before("CORRECTION: ignore that")).not.toContain("you have already seen this");
    expect(before("CORRECTION: ignore that")).toContain("WHILE YOUR TURN WAS HELD BACK");
    expect(before("c1 tail line")).toContain("WHILE YOUR TURN WAS HELD BACK");
  });
});

// #78 r4: message_id is not an identity.
//
// Round 3 bound a verdict to the object inside the covering merge, but the
// RE-STASH path was still id-keyed: a stash re-stashed on a later tick looked
// every message's verdict up in that tick's whole-batch, id-keyed map. A
// validly signed message reusing a stashed message's id therefore handed its
// VERIFIED verdict to the retained one, which the eventual turn framed as the
// operator, "CRYPTOGRAPHICALLY VERIFIED".
describe("#78 r4 a re-stashed message never inherits a filtered replacement's verdict", () => {
  it("stays unverified across three ticks: stash, re-stash, deliver", async () => {
    const { signCanonical, publicKeyB64urlFromSeed, keyId, sha256Hex } = await import("../src/identity");
    const FLEET = "flt_r4";
    const OP_SEED = new Uint8Array(32).fill(9);
    const OP_PUB = publicKeyB64urlFromSeed(OP_SEED);
    const OP_KID = keyId(Buffer.from(OP_PUB, "base64url"));
    const replacementText = "signed, and not what was stashed";
    const canonical = {
      v: 1,
      fleet_id: FLEET,
      operator_id: "op",
      key_id: OP_KID,
      recipient: { kind: "agent", id: "self" },
      conversation_id: "c-held",
      body_sha256: sha256Hex(replacementText),
      sent_at: new Date().toISOString(),
      nonce: "n-r4"
    };
    // Reuses the STASHED message's id, and is genuinely signed.
    const replacement: any = {
      message_id: "reused",
      conversation_id: "c-held",
      sender_kind: "operator",
      sender_agent_id: "op_" + FLEET,
      message_type: "direct",
      body: { text: replacementText },
      operator_sig: signCanonical(canonical, OP_SEED),
      agent_sig: null,
      key_id: OP_KID,
      sig_canonical: canonical
    };
    const batches = [
      // Tick 1: a peer message contends for the held floor and takes the
      // unsigned operator ask in the same conversation down with it.
      {
        messages: [peerMsg(1, "c-held"), operatorMsg("c-held", "reused", "unsigned operator ask")],
        operator_trusted: true,
        peer_autoreply: true,
        roster: [],
        fleet_id: FLEET
      },
      // Tick 2: the replacement (a different message, so NOT dropped by the
      // seen-filter since #83) plus a FRESH peer message. The floor is still held, so the stash is RE-STASHED with this
      // batch's verdict map in hand.
      {
        messages: [replacement, peerMsg(2, "c-held")],
        operator_trusted: true,
        peer_autoreply: true,
        roster: [],
        fleet_id: FLEET
      }
    ];
    let served = 0;
    const client = {
      getInbox: async () => {
        served += 1;
        return (
          batches[served - 1] ?? {
            messages: [],
            operator_trusted: true,
            peer_autoreply: true,
            roster: [],
            fleet_id: FLEET
          }
        );
      },
      ackMessages: async () => {},
      // Held through ticks 1 and 2; free from tick 3, which delivers the stash.
      acquireFloor: async () => ({ granted: served >= 3, holder_agent_id: "agent_holder" }),
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      identity: { seedHex: "33".repeat(32), pinnedOperatorKeys: { [OP_KID]: OP_PUB } } as any,
      log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }
    });

    try {
      await waitFor(() => hoisted.calls.length > 0);
    } finally {
      stop();
    }

    const prompt = hoisted.calls[0][hoisted.calls[0].length - 1];
    expect(prompt).toContain("unsigned operator ask"); // delivered…
    expect(prompt).toContain("teammate says 2"); // …with the later peer message
    expect(fromLine(prompt, "unsigned operator ask")).toContain("relay-authenticated fleet operator");
    expect(fromLine(prompt, "unsigned operator ask")).not.toContain("CRYPTOGRAPHICALLY VERIFIED");
    // …and the replacement is delivered as itself, with its own verdict (#83).
    expect(fromLine(prompt, replacementText)).toContain("CRYPTOGRAPHICALLY VERIFIED");
  });
});

// #78 r4: two DIFFERENT messages in DIFFERENT conversations sharing a
// message_id, both deferred. The covering merge's id-keyed heldSeen let the
// first stash claim the id and skipped the second — which the covering turn
// then cleared, unread and undead-lettered.
describe("#78 r4 two conversations sharing a message_id are both delivered", () => {
  it("carries both held-back messages into the covering turn", async () => {
    const dup = (conv: string, sender: string, text: string): any => ({
      message_id: "dup",
      conversation_id: conv,
      sender_agent_id: sender,
      sender_kind: "agent",
      message_type: "direct",
      body: { text }
    });
    const client = {
      getInbox: inboxQueue([
        // Tick 1: both floors are held -> A stashes under c1, B under c2.
        {
          messages: [
            dup("c1", "peer1", "A: the migration is blocked"),
            dup("c2", "peer2", "B: the numbers are wrong")
          ],
          operator_trusted: true,
          peer_autoreply: true,
          roster: []
        },
        // Tick 2: one operator batch covers BOTH conversations (operator
        // messages bypass the floor), so both stashes ride along in the one turn.
        {
          messages: [operatorMsg("c1", "o1", "cover c1"), operatorMsg("c2", "o2", "cover c2")],
          operator_trusted: true,
          roster: []
        }
      ]),
      ackMessages: async () => {},
      acquireFloor: async () => ({ granted: false, holder_agent_id: "agent_holder" }),
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    const records: unknown[] = [];
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true,
      log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
      onDeadLetter: (r) => records.push(...(r as unknown[]))
    });

    try {
      await waitFor(() => hoisted.calls.length > 0);
    } finally {
      stop();
    }

    const prompt = hoisted.calls[0][hoisted.calls[0].length - 1];
    expect(prompt).toContain("A: the migration is blocked");
    expect(prompt).toContain("B: the numbers are wrong");
    // Both are marked late, and neither was dropped.
    expect(prompt.match(/\[HELD BACK — delivered late\]/g)).toHaveLength(2);
    expect(records).toEqual([]);
  });
});

describe("#83 the seen-filter keys on heldKey, not message_id", () => {
  it("a reused id carrying a different message is not dropped as seen; a true redelivery still is", async () => {
    let getInboxCalls = 0;
    const batches = [
      operatorMsg("c1", "dup", "first: ship it"),
      // The relay hands the same id back attached to a different message.
      operatorMsg("c1", "dup", "second: roll it back"),
      // A genuine redelivery of that second message: same id, same material.
      operatorMsg("c1", "dup", "second: roll it back")
    ].map((m) => ({ messages: [m], operator_trusted: true, peer_autoreply: true, roster: [] }));
    const next = inboxQueue(batches);
    const client = {
      getInbox: async () => {
        getInboxCalls++;
        return next();
      },
      ackMessages: async () => {},
      acquireFloor: async () => ({ granted: true }),
      releaseFloor: async () => {},
      raiseNotice: async () => {}
    };
    const stop = startAutoReply({
      client: client as any,
      api: {} as any,
      selfAgentId: "self",
      pollIntervalMs: 5,
      peerEnabled: true
    });
    try {
      // Well past all three batches.
      await waitFor(() => getInboxCalls > batches.length + 2);
    } finally {
      stop();
    }

    const prompts = hoisted.calls.map((args) => args[args.length - 1]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("first: ship it");
    expect(prompts[1]).toContain("second: roll it back");
  });
});

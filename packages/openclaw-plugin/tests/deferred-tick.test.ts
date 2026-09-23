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

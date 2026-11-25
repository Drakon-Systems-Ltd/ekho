// #111 S2b-1: the coarse reason map and the unwired disposition seam. Synthetic
// inputs only; a fake client and a fake hand-off, no network and no state dir.

import { afterEach, describe, expect, it, vi } from "vitest";

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

import { DEAD_LETTER_REASONS } from "../../sdk/src/types";
import {
  DEFERRED_EVICTED_REASON,
  DEFERRED_LOOP_STOPPED_REASON,
  DEFERRED_MESSAGES_PER_CONV,
  DEFERRED_OVERFLOW_REASON,
  DEFERRED_RETRY_SPAWN_FAILED_REASON,
  DEFERRED_SPAWN_FAILED_REASON,
  INFLIGHT_LOOP_STOPPED_REASON,
  RELOAD_DUPLICATE_PREFIX,
  RELOAD_READMITTED_REASON,
  RELOAD_WITHHELD_PREFIX,
  startAutoReply
} from "../src/autoreply";
import { coarseDeadLetterReason } from "../src/delivery-disposition";

afterEach(() => {
  hoisted.calls.length = 0;
});

describe("coarseDeadLetterReason", () => {
  it("M1: maps every internal reason to its coarse value or null", () => {
    const W = RELOAD_WITHHELD_PREFIX;
    const table: Array<[string, string | null]> = [
      [DEFERRED_EVICTED_REASON, "deferred_evicted_cap"],
      [DEFERRED_OVERFLOW_REASON, "deferred_overflow_per_conv"],
      [DEFERRED_SPAWN_FAILED_REASON, "deferred_expired_spawn_failed"],
      [DEFERRED_RETRY_SPAWN_FAILED_REASON, "deferred_retry_spawn_failed"],
      [`${W}expired`, "deadline_passed"],
      [`${W}no_deadline`, "deadline_passed"],
      [`${W}handoff_overflow`, "handoff_unclaimed"],
      [`${W}handoff_unclaimed_too_long`, "handoff_unclaimed"],
      [`${W}malformed`, "withheld_by_recipient"],
      [`${W}stash_failed`, "withheld_by_recipient"],
      [DEFERRED_LOOP_STOPPED_REASON, null],
      [INFLIGHT_LOOP_STOPPED_REASON, null],
      [RELOAD_READMITTED_REASON, null],
      [`${RELOAD_DUPLICATE_PREFIX}already_served`, null]
    ];
    for (const [input, out] of table) expect(coarseDeadLetterReason(input), input).toBe(out);
  });

  it("M2: every non-null output is a member of the SDK's reason list", () => {
    const inputs = [
      DEFERRED_EVICTED_REASON, DEFERRED_OVERFLOW_REASON, DEFERRED_SPAWN_FAILED_REASON, DEFERRED_RETRY_SPAWN_FAILED_REASON,
      `${RELOAD_WITHHELD_PREFIX}expired`, `${RELOAD_WITHHELD_PREFIX}handoff_overflow`, `${RELOAD_WITHHELD_PREFIX}anything`
    ];
    for (const i of inputs) {
      const out = coarseDeadLetterReason(i);
      expect(out).not.toBeNull();
      expect((DEAD_LETTER_REASONS as readonly string[]).includes(out as string)).toBe(true);
    }
  });

  it("M3: precise withheld reasons all collapse to withheld_by_recipient", () => {
    for (const r of [
      "verification:bad_signature", "peer_latch_closed", "not_admissible:x", "served_evidence_lost", "something_new"
    ]) {
      expect(coarseDeadLetterReason(`${RELOAD_WITHHELD_PREFIX}${r}`), r).toBe("withheld_by_recipient");
    }
  });

  it("M4: unknown, empty and non-string input gives null and never throws", () => {
    for (const v of ["nope", "", 7, null, undefined, {}, [], { toString: () => { throw new Error("x"); } }]) {
      expect(() => coarseDeadLetterReason(v)).not.toThrow();
      expect(coarseDeadLetterReason(v)).toBeNull();
    }
  });
});

function peer(i: number, conv: string, extra: Record<string, unknown> = {}): any {
  return {
    message_id: `m${i}`,
    conversation_id: conv,
    sender_agent_id: `peer${i}`,
    sender_kind: "agent",
    message_type: "direct",
    body: { text: `hello ${i}` },
    ...extra
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = performance.now();
  while (!pred()) {
    if (performance.now() - started > timeoutMs) throw new Error("timed out waiting for the tick");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const quiet = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} };

/** A client whose floor is always held, serving `first` once and then nothing. */
function heldClient(first: unknown[], peerAutoreply = true, ack: (n: number) => Promise<void> = async () => {}, second: unknown[] = []) {
  let served = 0;
  let acks = 0;
  return {
    getInbox: async () => {
      const n = served++;
      if (n === 0) return { messages: first, operator_trusted: false, peer_autoreply: peerAutoreply, roster: [] };
      if (n === 1 && second.length > 0) return { messages: second, operator_trusted: false, peer_autoreply: peerAutoreply, roster: [] };
      return { messages: [] };
    },
    ackMessages: async () => ack(++acks),
    acquireFloor: async () => ({ granted: false, holder_agent_id: "agent_holder" }),
    releaseFloor: async () => {},
    raiseNotice: async () => {}
  };
}

function handoffWith(taken: unknown[], dropped: unknown[] = [], over: Record<string, unknown> = {}) {
  let given = false;
  return {
    deposit: () => undefined,
    take: () => {
      if (given) return { taken: [], dropped: [] };
      given = true;
      return { taken, dropped };
    },
    noteServed: () => {},
    servedBy: () => undefined,
    servedForgotten: () => undefined,
    ...over
  };
}

const entry = (message: any, over: Record<string, unknown> = {}) => ({
  owner: "own",
  agentId: "self",
  fromGeneration: 1,
  fromEpoch: 1,
  reason: DEFERRED_LOOP_STOPPED_REASON,
  conversationId: message.conversation_id,
  message,
  firstDeferredAtMs: Date.now(),
  depositedAtMs: Date.now(),
  ...over
});

function run(client: any, extra: Record<string, unknown>) {
  const seen: Array<[string, string]> = [];
  const records: Array<Record<string, unknown>> = [];
  const stop = startAutoReply({
    client,
    api: {} as any,
    selfAgentId: "self",
    pollIntervalMs: 5,
    peerEnabled: true,
    log: quiet as any,
    onDeadLetter: (r: any) => { records.push(...r); return true; },
    onDisposition: (id: string, reason: string) => { seen.push([id, reason]); },
    ...extra
  } as any);
  return { seen, records, stop };
}

const hourAhead = () => new Date(Date.now() + 3_600_000).toISOString();

describe("startAutoReply onDisposition", () => {
  it("C1: sink true and ack resolved: a per-conversation overflow reports one call per dropped message", async () => {
    const msgs = Array.from({ length: DEFERRED_MESSAGES_PER_CONV + 1 }, (_, i) => peer(i, "c-same"));
    const { seen, records, stop } = run(heldClient(msgs), {});
    try {
      await waitFor(() => records.some((r) => r.reason === DEFERRED_OVERFLOW_REASON));
    } finally {
      await stop();
    }
    expect(seen).toEqual([["m0", "deferred_overflow_per_conv"]]);
  });

  it("C6a: an expired candidate and a policy withhold are recorded but report nothing (no ack evidence for a hand-off message)", async () => {
    const late = peer(1, "c1", { deadline_at: new Date(Date.now() - 1000).toISOString() });
    const policy = peer(2, "c2", { deadline_at: hourAhead() });
    const handoff = handoffWith([entry(late), entry(policy)]);
    const { seen, records, stop } = run(heldClient([], false), {
      reloadHandoff: handoff,
      cacheContext: () => "own.gen1",
      peerEnabled: false
    });
    try {
      await waitFor(() => records.filter((r) => String(r.reason).startsWith("reload_")).length >= 2);
    } finally {
      await stop();
    }
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual([]);
  });

  it("C6b: a same-owner bounds drop is recorded but reports nothing", async () => {
    const mine = entry(peer(3, "c3"), { owner: "own" });
    const theirs = entry(peer(4, "c4"), { owner: "someone-else" });
    const handoff = handoffWith([], [{ entry: mine, why: "overflow" }, { entry: theirs, why: "unclaimed_too_long" }]);
    const { seen, records, stop } = run(heldClient([]), { reloadHandoff: handoff, cacheContext: () => "own.gen1" });
    try {
      await waitFor(() => records.length > 0);
    } finally {
      await stop();
    }
    expect(seen).toEqual([]);
  });

  it("L4: an already-served duplicate and a re-admitted message report nothing", async () => {
    const dup = entry(peer(5, "c5", { deadline_at: hourAhead() }), { fromEpoch: 1 });
    const ok = entry(peer(6, "c6", { deadline_at: hourAhead() }), { fromEpoch: 5 });
    // The ledger says epoch 3 served m5 (newer than its depositor, epoch 1).
    const late = entry(peer(8, "c8", { deadline_at: new Date(Date.now() - 1000).toISOString() }), { fromEpoch: 5 });
    const handoff = handoffWith([dup, ok, late], [], {
      servedBy: (_o: string, kind: string, value: string) => (kind === "key" && value.includes("m5") ? 3 : undefined)
    });
    const { seen, records, stop } = run(heldClient([]), { reloadHandoff: handoff, cacheContext: () => "own.gen1" });
    try {
      await waitFor(() => records.some((r) => r.reason === RELOAD_READMITTED_REASON) && records.some((r) => String(r.reason).startsWith(RELOAD_DUPLICATE_PREFIX)));
    } finally {
      await stop();
    }
    // The duplicate, the re-admission and the expired control are all silent now.
    expect(seen).toEqual([]);
  });

  it("L5: stop() with a held stash and a hand-off wired reports nothing (an overflow control proves the seam is live)", async () => {
    const msgs = Array.from({ length: DEFERRED_MESSAGES_PER_CONV + 1 }, (_, i) => peer(i, "c-same"));
    const handoff = handoffWith([]);
    const { seen, records, stop } = run(heldClient(msgs), { reloadHandoff: handoff, cacheContext: () => "own.gen1" });
    await waitFor(() => records.some((r) => r.reason === DEFERRED_OVERFLOW_REASON));
    await stop();
    expect(records.some((r) => r.reason === DEFERRED_LOOP_STOPPED_REASON)).toBe(true);
    expect(seen).toEqual([["m0", "deferred_overflow_per_conv"]]); // nothing added by the stop
  });

  it("C8: a callback that throws on the first of a batch does not stop the second, the records, or stop()", async () => {
    const msgs = Array.from({ length: DEFERRED_MESSAGES_PER_CONV + 2 }, (_, i) => peer(i, "c-same"));
    const calls: string[] = [];
    const { seen, records, stop } = run(heldClient(msgs), {
      onDisposition: (id: string, reason: string) => {
        calls.push(id);
        if (id === "m0") throw new Error("callback failure");
        seen.push([id, reason]);
      }
    });
    try {
      await waitFor(() => calls.length >= 2);
    } finally {
      await expect(stop()).resolves.toBeUndefined();
    }
    expect(calls).toEqual(["m0", "m1"]);
    expect(seen).toEqual([["m1", "deferred_overflow_per_conv"]]);
    expect(records.filter((r) => r.reason === DEFERRED_OVERFLOW_REASON)).toHaveLength(2);
  });

  it("C5a: a throwing dead-letter sink means no disposition on the deferred path, and the tick survives", async () => {
    const msgs = Array.from({ length: DEFERRED_MESSAGES_PER_CONV + 1 }, (_, i) => peer(i, "c-same"));
    let attempts = 0;
    const { seen, stop } = run(heldClient(msgs), {
      onDeadLetter: () => { attempts++; throw new Error("disk full"); }
    });
    try {
      await waitFor(() => attempts > 0);
      await new Promise((r) => setTimeout(r, 40));
    } finally {
      await expect(stop()).resolves.toBeUndefined();
    }
    expect(seen).toEqual([]);
  });

  it("C5b: a throwing dead-letter sink means no disposition on the hand-off path", async () => {
    const mine = entry(peer(12, "c12"), { owner: "own" });
    const handoff = handoffWith([], [{ entry: mine, why: "overflow" }]);
    let attempts = 0;
    const { seen, stop } = run(heldClient([]), {
      reloadHandoff: handoff,
      cacheContext: () => "own.gen1",
      onDeadLetter: () => { attempts++; throw new Error("disk full"); }
    });
    try {
      await waitFor(() => attempts > 0);
      await new Promise((r) => setTimeout(r, 40));
    } finally {
      await expect(stop()).resolves.toBeUndefined();
    }
    expect(seen).toEqual([]);
  });
  it("C2: the same drop with the ack REJECTED reaches the sink but reports nothing", async () => {
    const msgs = Array.from({ length: DEFERRED_MESSAGES_PER_CONV + 1 }, (_, i) => peer(i, "c-same"));
    const { seen, records, stop } = run(heldClient(msgs, true, async () => { throw new Error("ack down"); }), {});
    try {
      await waitFor(() => records.some((r) => r.reason === DEFERRED_OVERFLOW_REASON));
      await new Promise((r) => setTimeout(r, 40));
    } finally {
      await stop();
    }
    expect(seen).toEqual([]);
  });

  it("C3: ack rejected in tick 1 and resolved for the same id in tick 2: no after-the-fact call for the tick 1 drop", async () => {
    const msgs = Array.from({ length: DEFERRED_MESSAGES_PER_CONV + 1 }, (_, i) => peer(i, "c-same"));
    const client = heldClient(msgs, true, async (n) => { if (n === 1) throw new Error("ack down"); }, [peer(0, "c-same")]);
    const { seen, records, stop } = run(client, {});
    try {
      await waitFor(() => records.some((r) => r.reason === DEFERRED_OVERFLOW_REASON));
      await new Promise((r) => setTimeout(r, 80));
    } finally {
      await stop();
    }
    expect(seen).toEqual([]);
  });

  it("C4a: a sink returning undefined or false means no disposition on the deferred path", async () => {
    for (const ret of [undefined, false]) {
      const msgs = Array.from({ length: DEFERRED_MESSAGES_PER_CONV + 1 }, (_, i) => peer(i, "c-same"));
      let attempts = 0;
      const { seen, stop } = run(heldClient(msgs), { onDeadLetter: () => { attempts++; return ret; } });
      try {
        await waitFor(() => attempts > 0);
        await new Promise((r) => setTimeout(r, 40));
      } finally {
        await stop();
      }
      expect(seen, String(ret)).toEqual([]);
    }
  });

  it("C4b: a sink returning undefined or false means no disposition on the hand-off path", async () => {
    for (const ret of [undefined, false]) {
      const mine = entry(peer(12, "c12"), { owner: "own" });
      const handoff = handoffWith([], [{ entry: mine, why: "overflow" }]);
      let attempts = 0;
      const { seen, stop } = run(heldClient([]), {
        reloadHandoff: handoff,
        cacheContext: () => "own.gen1",
        onDeadLetter: () => { attempts++; return ret; }
      });
      try {
        await waitFor(() => attempts > 0);
        await new Promise((r) => setTimeout(r, 40));
      } finally {
        await stop();
      }
      expect(seen, String(ret)).toEqual([]);
    }
  });

  it("C7: ids beyond the 2,000 bound evict the oldest: a drop for an evicted id reports nothing", async () => {
    const head = Array.from({ length: DEFERRED_MESSAGES_PER_CONV + 1 }, (_, i) => peer(i, "c-same"));
    const filler = Array.from({ length: 2100 }, (_, i) => peer(1000 + i, `c-f${i}`));
    const { seen, records, stop } = run(heldClient([...head, ...filler]), {});
    try {
      await waitFor(() => records.some((r) => r.reason === DEFERRED_OVERFLOW_REASON));
      await new Promise((r) => setTimeout(r, 40));
    } finally {
      await stop();
    }
    expect(seen.some(([id]) => id === "m0")).toBe(false);
  });
});

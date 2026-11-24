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
function heldClient(first: unknown[]) {
  let served = 0;
  return {
    getInbox: async () =>
      served++ === 0
        ? { messages: first, operator_trusted: false, peer_autoreply: true, roster: [] }
        : { messages: [] },
    ackMessages: async () => {},
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
    onDeadLetter: (r: any) => records.push(...r),
    onDisposition: (id: string, reason: string) => { seen.push([id, reason]); },
    ...extra
  } as any);
  return { seen, records, stop };
}

const hourAhead = () => new Date(Date.now() + 3_600_000).toISOString();

describe("startAutoReply onDisposition", () => {
  it("L1: a per-conversation stash overflow reports one call per dropped message", async () => {
    const msgs = Array.from({ length: DEFERRED_MESSAGES_PER_CONV + 1 }, (_, i) => peer(i, "c-same"));
    const { seen, records, stop } = run(heldClient(msgs), {});
    try {
      await waitFor(() => records.some((r) => r.reason === DEFERRED_OVERFLOW_REASON));
    } finally {
      await stop();
    }
    expect(seen).toEqual([["m0", "deferred_overflow_per_conv"]]);
  });

  it("L2: an expired candidate reports deadline_passed, a policy withhold reports withheld_by_recipient, with no precise text", async () => {
    const late = peer(1, "c1", { deadline_at: new Date(Date.now() - 1000).toISOString() });
    const policy = peer(2, "c2", { deadline_at: hourAhead() });
    const handoff = handoffWith([entry(late), entry(policy)]);
    const { seen, records, stop } = run(heldClient([]), {
      reloadHandoff: handoff,
      cacheContext: () => "own.gen1",
      peerEnabled: false
    });
    try {
      await waitFor(() => records.filter((r) => String(r.reason).startsWith("reload_")).length >= 2);
    } finally {
      await stop();
    }
    expect(seen).toEqual([["m1", "deadline_passed"], ["m2", "withheld_by_recipient"]]);
    expect(JSON.stringify(seen)).not.toMatch(/not_admissible|verification|reload_|latch/);
  });

  it("L3: a same-owner bounds drop reports handoff_unclaimed; another owner's reports nothing", async () => {
    const mine = entry(peer(3, "c3"), { owner: "own" });
    const theirs = entry(peer(4, "c4"), { owner: "someone-else" });
    const handoff = handoffWith([], [{ entry: mine, why: "overflow" }, { entry: theirs, why: "unclaimed_too_long" }]);
    const { seen, records, stop } = run(heldClient([]), { reloadHandoff: handoff, cacheContext: () => "own.gen1" });
    try {
      await waitFor(() => records.length > 0);
    } finally {
      await stop();
    }
    expect(seen).toEqual([["m3", "handoff_unclaimed"]]);
  });

  it("L4: an already-served duplicate and a re-admitted message report nothing", async () => {
    const dup = entry(peer(5, "c5", { deadline_at: hourAhead() }), { fromEpoch: 1 });
    const ok = entry(peer(6, "c6", { deadline_at: hourAhead() }), { fromEpoch: 5 });
    // The ledger says epoch 3 served m5 (newer than its depositor, epoch 1).
    const handoff = handoffWith([dup, ok], [], {
      servedBy: (_o: string, kind: string, value: string) => (kind === "key" && value.includes("m5") ? 3 : undefined)
    });
    const { seen, records, stop } = run(heldClient([]), { reloadHandoff: handoff, cacheContext: () => "own.gen1" });
    try {
      await waitFor(() => records.some((r) => r.reason === RELOAD_READMITTED_REASON) && records.some((r) => String(r.reason).startsWith(RELOAD_DUPLICATE_PREFIX)));
    } finally {
      await stop();
    }
    expect(seen).toEqual([]);
  });

  it("L5: stop() with a held stash and a hand-off wired reports nothing", async () => {
    const handoff = handoffWith([]);
    const { seen, records, stop } = run(heldClient([peer(7, "c7")]), { reloadHandoff: handoff, cacheContext: () => "own.gen1" });
    await waitFor(() => hoisted.calls.length === 0 && true);
    await new Promise((r) => setTimeout(r, 100));
    await stop();
    expect(records.some((r) => r.reason === DEFERRED_LOOP_STOPPED_REASON)).toBe(true);
    expect(seen).toEqual([]);
  });

  it("L6: a callback that throws neither breaks the tick, the record, nor stop()", async () => {
    const msgs = Array.from({ length: DEFERRED_MESSAGES_PER_CONV + 1 }, (_, i) => peer(i, "c-same"));
    const { records, stop } = run(heldClient(msgs), {
      onDisposition: () => { throw new Error("callback failure"); }
    });
    try {
      await waitFor(() => records.some((r) => r.reason === DEFERRED_OVERFLOW_REASON));
    } finally {
      await expect(stop()).resolves.toBeUndefined();
    }
    expect(records.some((r) => r.reason === DEFERRED_OVERFLOW_REASON)).toBe(true);
  });
});

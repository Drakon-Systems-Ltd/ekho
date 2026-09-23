// #78: an acked message deferred for the floor is NEVER silently dropped.
//
// Live evidence (the bug): a direct message logged "floor for oc-… held by
// agent_…; deferring (will retry)" and never got a retry or a wake. The retry
// window (600s) was SHORTER than the floor's own TTL (960s), so a holder that
// was legitimately mid-turn outlived the stash — and expiry binned it with no
// log and no dead-letter. Acked + dropped = the work is lost.

import { describe, it, expect } from "vitest";

import {
  buildPrompt,
  clearDeferred,
  createAutoReplyState,
  listRetryableDeferred,
  mergeCoveredStashes,
  serviceDeferredTurn,
  stashDeferred,
  takeExpiredDeferred,
  DEFERRED_EVICTED_REASON,
  DEFERRED_GRACE_SECONDS,
  DEFERRED_MESSAGES_PER_CONV,
  DEFERRED_OVERFLOW_REASON,
  DEFERRED_RETRY_SPAWN_FAILED_REASON,
  DEFERRED_RETRY_TTL_MS,
  DEFERRED_SPAWN_FAILED_REASON,
  FLOOR_TTL_SECONDS,
  type AutoReplyState,
  type DeferredTurnRunner,
  type ServiceDeferredOptions
} from "../src/autoreply";

// Asserted against the PRODUCTION floor constant, not a copy re-derived here: a
// re-derived copy agrees with itself no matter how far the real one drifts.
const FLOOR_TTL_MS = FLOOR_TTL_SECONDS * 1000;

function amsg(conv: string, id: string): any {
  return {
    message_id: id,
    conversation_id: conv,
    sender_agent_id: "peer1",
    sender_kind: "agent",
    message_type: "direct",
    body: { text: `teammate says ${id}` }
  };
}

interface Harness {
  opts: ServiceDeferredOptions;
  state: AutoReplyState;
  acquires: string[];
  releases: string[];
  turns: Array<{ conversationId: string; overrun: boolean; messageIds: string[] }>;
  deadLettered: Array<{ reason: string; messageIds: string[] }>;
  warnings: string[];
}

/** A serviceDeferredTurn harness: the floor is never granted (the reported
 *  failure mode — the holder simply keeps it), and the turn runner records
 *  instead of spawning. */
function harness(over: { granted?: boolean; run?: DeferredTurnRunner; nowMs?: number } = {}): Harness {
  const state = createAutoReplyState();
  const acquires: string[] = [];
  const releases: string[] = [];
  const turns: Harness["turns"] = [];
  const deadLettered: Harness["deadLettered"] = [];
  const warnings: string[] = [];
  const runTurn: DeferredTurnRunner =
    over.run ??
    (async ({ conversationId, stash, deferred }) => {
      turns.push({
        conversationId,
        overrun: Boolean(deferred.overrun),
        messageIds: stash.messages.map((m) => m.message_id)
      });
      return true;
    });
  const opts: ServiceDeferredOptions = {
    state,
    nowMs: over.nowMs ?? 0,
    acquireFloor: async (conv) => {
      acquires.push(conv);
      return { granted: Boolean(over.granted), holder_agent_id: "agent_holder" };
    },
    releaseFloor: async (conv) => {
      releases.push(conv);
    },
    runTurn,
    deadLetter: (messages, reason) => {
      deadLettered.push({ reason, messageIds: messages.map((m) => m.message_id) });
    },
    log: { warn: (...a: unknown[]) => warnings.push(a.join(" ")), info: () => {}, debug: () => {} }
  };
  return { opts, state, acquires, releases, turns, deadLettered, warnings };
}

describe("#78 deferred retry window", () => {
  it("outlives the floor it waits on (derived, not guessed)", () => {
    // If it is ever shorter again, a holder that is legitimately mid-turn
    // outlives the stash and the acked work is lost.
    expect(DEFERRED_RETRY_TTL_MS).toBeGreaterThan(FLOOR_TTL_MS);
    expect(DEFERRED_RETRY_TTL_MS).toBe(FLOOR_TTL_MS + DEFERRED_GRACE_SECONDS * 1000);
  });
});

describe("#78 takeExpiredDeferred", () => {
  it("returns and removes expired stashes oldest first, leaving live ones", () => {
    const s = createAutoReplyState();
    stashDeferred(s, "newer", [amsg("newer", "m2")], {}, 10_000);
    stashDeferred(s, "old", [amsg("old", "m1")], {}, 0);
    stashDeferred(s, "live", [amsg("live", "m3")], {}, 10_000_000);
    const past = DEFERRED_RETRY_TTL_MS + 20_000;

    const taken = takeExpiredDeferred(s, past, 1);
    expect(taken.map((t) => t.conversationId)).toEqual(["old"]);
    expect(taken[0].stash.messages.map((m) => m.message_id)).toEqual(["m1"]);
    expect(s.deferredByConversation.has("old")).toBe(false);

    const rest = takeExpiredDeferred(s, past);
    expect(rest.map((t) => t.conversationId)).toEqual(["newer"]);
    expect(s.deferredByConversation.has("live")).toBe(true); // inside the window
    expect(listRetryableDeferred(s, past)).toEqual(["live"]);
  });
});

describe("#78 serviceDeferredTurn: overrun delivery", () => {
  it("runs the held-back turn late, without the floor, when the holder never lets go", async () => {
    const h = harness({ granted: false, nowMs: DEFERRED_RETRY_TTL_MS + 30_000 });
    stashDeferred(h.state, "c-held", [amsg("c-held", "m1")], {}, 0);

    const spawned = await serviceDeferredTurn(h.opts);

    expect(spawned).toBe(1);
    expect(h.turns).toEqual([
      { conversationId: "c-held", overrun: true, messageIds: ["m1"] }
    ]);
    expect(h.state.deferredByConversation.has("c-held")).toBe(false);
    // An overrun turn takes no floor, so it has none to release.
    expect(h.acquires).toEqual([]);
    expect(h.releases).toEqual([]);
    expect(h.deadLettered).toEqual([]);
    expect(
      h.warnings.some(
        (w) => w.includes("exceeded retry window") && w.includes("delivering late without the floor")
      )
    ).toBe(true);
  });

  it("keeps the stash when a turn is already in flight, and runs it on the next tick", async () => {
    const h = harness({ granted: false, nowMs: DEFERRED_RETRY_TTL_MS + 30_000 });
    stashDeferred(h.state, "c-held", [amsg("c-held", "m1")], {}, 0);
    h.state.inFlight = true; // busy is not a reason to drop acked work

    expect(await serviceDeferredTurn(h.opts)).toBe(0);
    expect(h.turns).toEqual([]);
    expect(h.state.deferredByConversation.has("c-held")).toBe(true);
    expect(h.deadLettered).toEqual([]);

    h.state.inFlight = false;
    expect(await serviceDeferredTurn(h.opts)).toBe(1);
    expect(h.turns.map((t) => t.conversationId)).toEqual(["c-held"]);
    expect(h.state.deferredByConversation.has("c-held")).toBe(false);
  });

  it("runs at most one expired stash per tick, oldest first", async () => {
    const h = harness({ granted: false, nowMs: DEFERRED_RETRY_TTL_MS + 30_000 });
    stashDeferred(h.state, "c-new", [amsg("c-new", "m2")], {}, 10_000);
    stashDeferred(h.state, "c-old", [amsg("c-old", "m1")], {}, 0);

    expect(await serviceDeferredTurn(h.opts)).toBe(1);
    expect(h.turns.map((t) => t.conversationId)).toEqual(["c-old"]);
    expect([...h.state.deferredByConversation.keys()]).toEqual(["c-new"]);

    expect(await serviceDeferredTurn(h.opts)).toBe(1);
    expect(h.turns.map((t) => t.conversationId)).toEqual(["c-old", "c-new"]);
    expect(h.state.deferredByConversation.size).toBe(0);
  });

  it("dead-letters the stash when the overrun turn cannot be spawned", async () => {
    const h = harness({
      granted: false,
      nowMs: DEFERRED_RETRY_TTL_MS + 30_000,
      run: async () => {
        throw new Error("no gateway entry");
      }
    });
    stashDeferred(h.state, "c-held", [amsg("c-held", "m1")], {}, 0);

    expect(await serviceDeferredTurn(h.opts)).toBe(0);
    expect(h.state.deferredByConversation.has("c-held")).toBe(false);
    expect(h.deadLettered).toEqual([
      { reason: DEFERRED_SPAWN_FAILED_REASON, messageIds: ["m1"] }
    ]);
    expect(h.warnings.some((w) => w.includes("overrun turn failed to spawn"))).toBe(true);
  });

  it("dead-letters the stash when a spawn reports it never started", async () => {
    const h = harness({
      granted: false,
      nowMs: DEFERRED_RETRY_TTL_MS + 30_000,
      run: async () => false // triggerTurn: the child never started
    });
    stashDeferred(h.state, "c-held", [amsg("c-held", "m1")], {}, 0);

    expect(await serviceDeferredTurn(h.opts)).toBe(0);
    expect(h.deadLettered.map((d) => d.reason)).toEqual([DEFERRED_SPAWN_FAILED_REASON]);
  });

  it("still prefers the ordinary floored retry while the stash is live", async () => {
    const h = harness({ granted: true, nowMs: 30_000 });
    stashDeferred(h.state, "c-live", [amsg("c-live", "m1")], {}, 0);

    expect(await serviceDeferredTurn(h.opts)).toBe(1);
    expect(h.turns).toEqual([
      { conversationId: "c-live", overrun: false, messageIds: ["m1"] }
    ]);
    expect(h.acquires).toEqual(["c-live"]); // took the floor…
    expect(h.releases).toEqual(["c-live"]); // …and gave it back
  });

  it("dead-letters a retry turn that never started (the stash is already out)", async () => {
    const h = harness({ granted: true, nowMs: 30_000, run: async () => false });
    stashDeferred(h.state, "c-live", [amsg("c-live", "m1")], {}, 0);

    expect(await serviceDeferredTurn(h.opts)).toBe(0);
    expect(h.state.deferredByConversation.size).toBe(0);
    expect(h.deadLettered).toEqual([
      { reason: DEFERRED_RETRY_SPAWN_FAILED_REASON, messageIds: ["m1"] }
    ]);
  });
});

describe("#78 stashDeferred cap eviction", () => {
  it("returns what the cap evicted instead of dropping it", () => {
    const s = createAutoReplyState();
    for (let i = 0; i < 50; i++) {
      expect(stashDeferred(s, `c${i}`, [amsg(`c${i}`, `m${i}`)], {}, i)).toEqual([]);
    }
    const drops = stashDeferred(s, "c-new", [amsg("c-new", "m-new")], {}, 1);
    expect(drops.map((d) => d.conversationId)).toEqual(["c0"]); // FIFO: oldest out
    expect(drops.map((d) => d.reason)).toEqual([DEFERRED_EVICTED_REASON]);
    expect(drops[0].messages.map((m) => m.message_id)).toEqual(["m0"]);
    expect(s.deferredByConversation.has("c0")).toBe(false);
    expect(DEFERRED_EVICTED_REASON).toBe("deferred_evicted_cap");
  });
});

describe("#78 r2 stashDeferred per-conversation overflow", () => {
  it("returns the oldest messages the per-conversation cap pushed out", () => {
    // These used to fall out in a slice: acked, no turn, no log, no record.
    const s = createAutoReplyState();
    const cap = DEFERRED_MESSAGES_PER_CONV;
    const first = Array.from({ length: cap }, (_, i) => amsg("c1", `m${i}`));
    expect(stashDeferred(s, "c1", first, {}, 0)).toEqual([]);

    const drops = stashDeferred(s, "c1", [amsg("c1", `m${cap}`)], {}, 1);

    expect(drops.map((d) => d.reason)).toEqual([DEFERRED_OVERFLOW_REASON]);
    expect(drops[0].conversationId).toBe("c1");
    expect(drops[0].messages.map((m) => m.message_id)).toEqual(["m0"]);
    expect(s.deferredByConversation.get("c1")!.messages).toHaveLength(cap);
    expect(DEFERRED_OVERFLOW_REASON).toBe("deferred_overflow_per_conv");
  });
});

describe("#78 r2 mergeCoveredStashes", () => {
  it("puts the held-back messages first, dedupes by id, and leaves the stash in place", () => {
    const s = createAutoReplyState();
    stashDeferred(s, "c1", [amsg("c1", "m1"), amsg("c1", "m2")], { m1: null }, 10_000);
    const fresh = [amsg("c1", "op1"), amsg("c1", "m2")]; // m2 is in BOTH

    const cover = mergeCoveredStashes(s, fresh, { op1: null }, 70_000);

    expect(cover.messages.map((m) => m.message_id)).toEqual(["m1", "m2", "op1"]);
    expect(cover.coveredConversationIds).toEqual(["c1"]);
    expect(cover.deferred).toMatchObject({
      conversationId: "c1",
      heldMs: 60_000,
      merged: true,
      heldMessageIds: ["m1", "m2"]
    });
    expect(Object.keys(cover.verifications).sort()).toEqual(["m1", "m2", "op1"]);
    // Clearing is the CALLER's job, and only once its spawn has returned.
    expect(s.deferredByConversation.has("c1")).toBe(true);
  });

  it("is a passthrough when the turn covers no stash", () => {
    const s = createAutoReplyState();
    const fresh = [amsg("c1", "op1")];
    const cover = mergeCoveredStashes(s, fresh, { op1: null }, 5_000);
    expect(cover.messages).toBe(fresh);
    expect(cover.coveredConversationIds).toEqual([]);
    expect(cover.deferred).toBeUndefined();
  });

  it("ignores a conversation whose stash was already cleared", () => {
    const s = createAutoReplyState();
    stashDeferred(s, "c1", [amsg("c1", "m1")], {}, 0);
    clearDeferred(s, "c1");
    expect(mergeCoveredStashes(s, [amsg("c1", "op1")], {}, 1_000).deferred).toBeUndefined();
  });
});

describe("#78 r2 serviceDeferredTurn never starts a second concurrent turn", () => {
  it("stands down when a turn began while it awaited the floor acquire", async () => {
    // Tick A sits on acquireFloor for a LIVE stash while tick B starts an
    // overrun turn for an expired one. Without the re-check A would spawn on
    // top of B, and whichever finished first would clear inFlight under the
    // other.
    const nowMs = DEFERRED_RETRY_TTL_MS + 30_000;
    const state = createAutoReplyState();
    stashDeferred(state, "c-live", [amsg("c-live", "m-live")], {}, nowMs - 1_000);

    const turns: string[] = [];
    const releases: string[] = [];
    let openAcquire!: () => void;
    const acquireGate = new Promise<void>((r) => { openAcquire = r; });
    let finishTurnB!: () => void;
    const turnBGate = new Promise<void>((r) => { finishTurnB = r; });
    const base = {
      state,
      nowMs,
      releaseFloor: async (conv: string) => { releases.push(conv); },
      deadLetter: () => { throw new Error("nothing should be dead-lettered here"); },
      log: { warn: () => {}, info: () => {}, debug: () => {} }
    };
    const tickA: ServiceDeferredOptions = {
      ...base,
      acquireFloor: async () => { await acquireGate; return { granted: true }; },
      runTurn: async ({ conversationId }) => { turns.push(conversationId); return true; }
    };
    const tickB: ServiceDeferredOptions = {
      ...base,
      acquireFloor: async () => ({ granted: false }),
      runTurn: async ({ conversationId }) => { turns.push(conversationId); await turnBGate; return true; }
    };

    const pA = serviceDeferredTurn(tickA); // -> sits on the acquire
    await new Promise((r) => setTimeout(r, 0));
    stashDeferred(state, "c-exp", [amsg("c-exp", "m-exp")], {}, 0); // expired
    const pB = serviceDeferredTurn(tickB); // -> overrun turn, still running
    await new Promise((r) => setTimeout(r, 0));
    expect(state.inFlight).toBe(true);

    openAcquire();
    expect(await pA).toBe(0); // stood down instead of spawning
    expect(turns).toEqual(["c-exp"]); // exactly ONE turn
    expect(releases).toEqual(["c-live"]); // floor handed straight back
    expect(state.deferredByConversation.has("c-live")).toBe(true); // stash kept
    expect(state.inFlight).toBe(true); // B is still running; A did not clear it

    finishTurnB();
    expect(await pB).toBe(1);
    expect(state.inFlight).toBe(false);
  });
});

describe("#78 overrun prompt", () => {
  const batch: any = { messages: [], operator_trusted: false, roster: [] };

  it("tells the agent the message is being delivered without the floor", () => {
    const p = buildPrompt([amsg("room_1", "m1")], batch, undefined, "self", undefined, undefined, {
      conversationId: "room_1",
      heldMs: 18 * 60_000,
      overrun: true
    });
    expect(p).toContain("THIS TURN WAS HELD BACK");
    expect(p).toContain("waited past the floor window");
    expect(p).toContain("WITHOUT the floor");
    expect(p).toContain("keep it short");
  });

  it("marks only the held-back messages on a covering turn", () => {
    const p = buildPrompt(
      [amsg("room_1", "m-late"), amsg("room_1", "m-fresh")],
      batch,
      undefined,
      "self",
      undefined,
      undefined,
      { conversationId: "room_1", heldMs: 7 * 60_000, merged: true, heldMessageIds: ["m-late"] }
    );
    expect(p).toContain("SOME OF THE MESSAGE(S) BELOW WERE HELD BACK");
    expect(p).not.toContain("THIS TURN WAS HELD BACK"); // only part of this batch is late
    expect(p.match(/\[HELD BACK — delivered late\]/g)).toHaveLength(1);
    expect(p).toContain("teammate says m-late");
    expect(p).toContain("teammate says m-fresh");
  });

  it("says nothing about an overrun on an ordinary held-back turn", () => {
    const p = buildPrompt([amsg("room_1", "m1")], batch, undefined, "self", undefined, undefined, {
      conversationId: "room_1",
      heldMs: 3 * 60_000
    });
    expect(p).toContain("THIS TURN WAS HELD BACK");
    expect(p).not.toContain("waited past the floor window");
  });
});

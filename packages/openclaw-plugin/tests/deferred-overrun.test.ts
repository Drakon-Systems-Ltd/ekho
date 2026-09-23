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
  createAutoReplyState,
  listRetryableDeferred,
  serviceDeferredTurn,
  stashDeferred,
  takeExpiredDeferred,
  DEFERRED_EVICTED_REASON,
  DEFERRED_RETRY_SPAWN_FAILED_REASON,
  DEFERRED_RETRY_TTL_MS,
  DEFERRED_SPAWN_FAILED_REASON,
  type AutoReplyState,
  type DeferredTurnRunner,
  type ServiceDeferredOptions
} from "../src/autoreply";

// The floor TTL is module-private (it is derived from the turn timeout), so
// re-derive it here the same way. If either side drifts, the first test fails.
const TURN_TIMEOUT_SECONDS = (() => {
  const raw = Number(process.env.EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS);
  return Number.isFinite(raw) && raw >= 60 ? raw : 900;
})();
const FLOOR_TTL_MS = (TURN_TIMEOUT_SECONDS + 60) * 1000;

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
    expect(DEFERRED_RETRY_TTL_MS).toBe(FLOOR_TTL_MS + 120_000);
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
    const evicted = stashDeferred(s, "c-new", [amsg("c-new", "m-new")], {}, 1);
    expect(evicted.map((e) => e.conversationId)).toEqual(["c0"]); // FIFO: oldest out
    expect(evicted[0].stash.messages.map((m) => m.message_id)).toEqual(["m0"]);
    expect(s.deferredByConversation.has("c0")).toBe(false);
    expect(DEFERRED_EVICTED_REASON).toBe("deferred_evicted_cap");
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

  it("says nothing about an overrun on an ordinary held-back turn", () => {
    const p = buildPrompt([amsg("room_1", "m1")], batch, undefined, "self", undefined, undefined, {
      conversationId: "room_1",
      heldMs: 3 * 60_000
    });
    expect(p).toContain("THIS TURN WAS HELD BACK");
    expect(p).not.toContain("waited past the floor window");
  });
});

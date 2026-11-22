// #111: the reload hand-off store on the process-wide runtime registry. The
// end-to-end behaviour (re-admission under the successor's trust root, floor
// and deadline) is in plugin-reload.test.ts; these pin the store's own rules:
// take-once, full ownership, generation order, the current holder only, and
// bounded retention that reports what it drops.
import { afterEach, describe, expect, it } from "vitest";
import {
  RELOAD_HANDOFF_CAP,
  RELOAD_HANDOFF_MAX_AGE_MS,
  claimAgentRuntime,
  depositReloadHandoff,
  nextRuntimeGeneration,
  releaseAgentRuntime,
  reloadHandoffCount,
  takeReloadHandoff,
  type ReloadHandoffEntry
} from "../src/runtime-registry";

const KEY = Symbol.for("ekho-adapter.runtime");
const NOW = 1_800_000_000_000;

function entry(over: Partial<ReloadHandoffEntry> = {}): ReloadHandoffEntry {
  return {
    owner: "conn-a",
    agentId: "agent_x",
    fromGeneration: 1,
    reason: "deferred_loop_stopped",
    conversationId: "c",
    message: { message_id: "m", conversation_id: "c" },
    firstDeferredAtMs: NOW - 1_000,
    depositedAtMs: NOW,
    ...over,
    // Loops are ordered by epoch; these cases use one epoch per generation.
    fromEpoch: over.fromEpoch ?? over.fromGeneration ?? 1
  };
}

/** Two generations, the newer one holding agent_x. */
function holders() {
  const older = nextRuntimeGeneration();
  const newer = nextRuntimeGeneration();
  claimAgentRuntime("agent_x", { generation: newer, stop: () => {} });
  return { older, newer };
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

describe("reload hand-off store (#111)", () => {
  it("is taken once, and only by the current holder of a newer generation with the same owner", () => {
    const { older, newer } = holders();
    depositReloadHandoff([entry({ fromGeneration: older })], NOW);

    expect(takeReloadHandoff("agent_x", "conn-a", older, older, NOW).taken).toEqual([]); // not the holder
    expect(takeReloadHandoff("agent_x", "conn-b", newer, newer, NOW).taken).toEqual([]); // another connection
    expect(takeReloadHandoff("agent_y", "conn-a", newer, newer, NOW).taken).toEqual([]); // another agent
    expect(takeReloadHandoff("agent_x", "", newer, newer, NOW).taken).toEqual([]); // no owner at all
    expect(reloadHandoffCount("agent_x")).toBe(1);

    const first = takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW);
    expect(first.taken.map((e) => e.fromGeneration)).toEqual([older]);
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toEqual([]);
    expect(reloadHandoffCount("agent_x")).toBe(0);
  });

  it("a retired generation takes nothing, even its own successor's leftovers", () => {
    const { older, newer } = holders();
    depositReloadHandoff([entry({ fromGeneration: older })], NOW);
    releaseAgentRuntime("agent_x", newer); // the holder stopped: nobody holds the agent
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toEqual([]);
    expect(reloadHandoffCount("agent_x")).toBe(1);
  });

  it("an entry from the same or a newer generation, or another owner, is left untouched", () => {
    const { older, newer } = holders();
    depositReloadHandoff(
      [
        entry({ fromGeneration: newer }),
        entry({ fromGeneration: newer + 1 }),
        entry({ fromGeneration: older, owner: "conn-b" }),
        entry({ fromGeneration: older })
      ],
      NOW
    );
    const { taken } = takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW);
    expect(taken).toHaveLength(1);
    expect(reloadHandoffCount("agent_x")).toBe(3);
  });

  it("ignores malformed deposits instead of throwing", () => {
    const { older, newer } = holders();
    const junk = [null, 7, "x", { owner: "conn-a" }, entry({ fromGeneration: Number.NaN }), entry({ owner: "" })];
    expect(() => depositReloadHandoff([...junk, entry({ fromGeneration: older })] as never, NOW)).not.toThrow();
    expect(reloadHandoffCount("agent_x")).toBe(1);
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toHaveLength(1);
  });

  it("bounds what it holds per agent, oldest out first, and reports each drop", () => {
    const { older } = holders();
    const many = Array.from({ length: RELOAD_HANDOFF_CAP + 3 }, (_, i) =>
      entry({ fromGeneration: older, message: { message_id: `m${i}`, conversation_id: "c" } })
    );
    const dropped = depositReloadHandoff(many, NOW);
    expect(dropped.map((d) => [(d.entry.message as { message_id: string }).message_id, d.why])).toEqual([
      ["m0", "overflow"],
      ["m1", "overflow"],
      ["m2", "overflow"]
    ]);
    expect(reloadHandoffCount("agent_x")).toBe(RELOAD_HANDOFF_CAP);
  });

  it("drops (and reports) an entry nobody claimed within the age bound", () => {
    const { older, newer } = holders();
    depositReloadHandoff([entry({ fromGeneration: older })], NOW);
    const later = NOW + RELOAD_HANDOFF_MAX_AGE_MS + 1;
    const { taken, dropped } = takeReloadHandoff("agent_x", "conn-a", newer, newer, later);
    expect(taken).toEqual([]);
    expect(dropped.map((d) => d.why)).toEqual(["unclaimed_too_long"]);
    expect(reloadHandoffCount("agent_x")).toBe(0);
  });

  it("works on a registry an older bundle created without the hand-off field", () => {
    (globalThis as Record<symbol, unknown>)[KEY] = { generations: 0, byAgent: new Map() };
    const { older, newer } = holders();
    depositReloadHandoff([entry({ fromGeneration: older })], NOW);
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toHaveLength(1);
  });
});

// #111 R4: which generation last took ownership of a message or signature, per
// connection domain, so a late deposit from an older producer can be refused.
describe("reload served ledger (#111)", () => {
  it("keeps the NEWEST generation per key and nonce, scoped to agent and owner", async () => {
    const { noteReloadServed, reloadServedBy } = await import("../src/runtime-registry");
    noteReloadServed("agent_x", "conn-a", 3, { keys: ["k1"], nonces: ["n1"] }, NOW);
    noteReloadServed("agent_x", "conn-a", 5, { keys: ["k1"] }, NOW);
    noteReloadServed("agent_x", "conn-a", 4, { keys: ["k1"] }, NOW); // a late, older note never lowers it
    expect(reloadServedBy("agent_x", "conn-a", "key", "k1")).toBe(5);
    expect(reloadServedBy("agent_x", "conn-a", "nonce", "n1")).toBe(3);
    expect(reloadServedBy("agent_x", "conn-a", "nonce", "k1")).toBeUndefined();
    expect(reloadServedBy("agent_x", "conn-b", "key", "k1")).toBeUndefined();
    expect(reloadServedBy("agent_y", "conn-a", "key", "k1")).toBeUndefined();
  });

  it("is bounded by count (oldest out) and by age", async () => {
    const { noteReloadServed, reloadServedBy, RELOAD_SERVED_CAP } = await import("../src/runtime-registry");
    const keys = Array.from({ length: RELOAD_SERVED_CAP + 2 }, (_, i) => `k${i}`);
    noteReloadServed("agent_x", "conn-a", 2, { keys }, NOW);
    expect(reloadServedBy("agent_x", "conn-a", "key", "k0")).toBeUndefined();
    expect(reloadServedBy("agent_x", "conn-a", "key", "k1")).toBeUndefined();
    expect(reloadServedBy("agent_x", "conn-a", "key", "k2")).toBe(2);

    noteReloadServed("agent_x", "conn-a", 3, { keys: ["fresh"] }, NOW + RELOAD_HANDOFF_MAX_AGE_MS + 1);
    expect(reloadServedBy("agent_x", "conn-a", "key", "k2")).toBeUndefined();
    expect(reloadServedBy("agent_x", "conn-a", "key", "fresh")).toBe(3);
  });

  it("ignores junk instead of throwing", async () => {
    const { noteReloadServed, reloadServedBy } = await import("../src/runtime-registry");
    expect(() => noteReloadServed("", "conn-a", 1, { keys: ["k"] })).not.toThrow();
    expect(() => noteReloadServed("agent_x", "conn-a", Number.NaN, { keys: ["k"] })).not.toThrow();
    expect(() => noteReloadServed("agent_x", "conn-a", 1, { keys: [7 as never, ""] })).not.toThrow();
    expect(reloadServedBy("agent_x", "conn-a", "key", "k")).toBeUndefined();
  });

  it("orders by loop epoch, not generation: a resumed OLDER generation that holds the agent takes a newer generation's earlier deposit, and never a later loop's", async () => {
    const { claimAgentRuntime, nextReloadEpoch } = await import("../src/runtime-registry");
    const e1 = nextReloadEpoch();
    const e2 = nextReloadEpoch();
    const e3 = nextReloadEpoch();
    expect([e2 - e1, e3 - e2]).toEqual([1, 1]);
    // Generation 9 ran loop e2 and left work; generation 4 now holds the agent and runs loop e3.
    claimAgentRuntime("agent_x", { generation: 4, stop: () => {} });
    depositReloadHandoff(
      [
        entry({ fromGeneration: 9, fromEpoch: e2, message: { message_id: "earlier", conversation_id: "c" } }),
        entry({ fromGeneration: 4, fromEpoch: e3 + 1, message: { message_id: "later", conversation_id: "c" } }),
        entry({ fromGeneration: 4, fromEpoch: e3, message: { message_id: "own", conversation_id: "c" } })
      ],
      NOW
    );
    const { taken } = takeReloadHandoff("agent_x", "conn-a", 4, e3, NOW);
    expect(taken.map((e) => (e.message as { message_id: string }).message_id)).toEqual(["earlier"]);
    expect(takeReloadHandoff("agent_x", "conn-a", 9, e3 + 5, NOW).taken).toEqual([]); // generation 9 does not hold the agent
  });

  it("remembers the newest loop whose served record its bounds dropped, per kind", async () => {
    const { noteReloadServed, reloadServedBy, reloadServedForgotten, RELOAD_SERVED_CAP } = await import("../src/runtime-registry");
    expect(reloadServedForgotten("agent_x", "conn-a", "key")).toBeUndefined();
    noteReloadServed("agent_x", "conn-a", 3, { keys: ["m"], nonces: ["n"] }, NOW);
    noteReloadServed("agent_x", "conn-a", 2, { keys: Array.from({ length: RELOAD_SERVED_CAP }, (_, i) => `k${i}`) }, NOW);
    expect(reloadServedBy("agent_x", "conn-a", "key", "m")).toBeUndefined(); // pushed out by the cap
    expect(reloadServedForgotten("agent_x", "conn-a", "key")).toBe(3);
    expect(reloadServedForgotten("agent_x", "conn-a", "nonce")).toBeUndefined(); // nonces are bounded separately
    // Age-out counts the same way.
    noteReloadServed("agent_x", "conn-a", 5, { nonces: ["later"] }, NOW + RELOAD_HANDOFF_MAX_AGE_MS + 1);
    expect(reloadServedForgotten("agent_x", "conn-a", "nonce")).toBe(3);
    expect(reloadServedForgotten("agent_x", "conn-b", "key")).toBeUndefined(); // another connection identity
  });

  it("a served ledger dropped whole (more connection identities than the bound) leaves its newest epoch as a floor for every domain", async () => {
    const { noteReloadServed, reloadServedBy, reloadServedForgotten } = await import("../src/runtime-registry");
    noteReloadServed("agent_x", "conn-a", 7, { keys: ["m"], nonces: ["n"] }, NOW);
    for (let i = 0; i < 64; i++) noteReloadServed("agent_x", `other-${i}`, 1, { keys: ["k"] }, NOW);
    expect(reloadServedBy("agent_x", "conn-a", "key", "m")).toBeUndefined(); // the whole domain is gone
    expect(reloadServedForgotten("agent_x", "conn-a", "key")).toBe(7);
    expect(reloadServedForgotten("agent_x", "conn-a", "nonce")).toBe(7);
    expect(reloadServedForgotten("agent_x", "other-63", "key")).toBe(7); // which domain it was is not remembered
  });

  it("a stored value that is not an entry, or not a list, cannot jam the hand-off: valid work is still taken", async () => {
    const { older, newer } = holders();
    depositReloadHandoff([entry({ fromGeneration: older })], NOW);
    const store = (globalThis as unknown as Record<symbol, { reloadHandoffs: Map<string, unknown> }>)[KEY].reloadHandoffs;
    (store.get("agent_x") as unknown[]).unshift(null, 7);
    expect(() => depositReloadHandoff([entry({ fromGeneration: older, message: { message_id: "m2", conversation_id: "c" } })], NOW)).not.toThrow();
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toHaveLength(2);
    store.set("agent_x", "not a list");
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toEqual([]);
    expect(() => depositReloadHandoff([entry({ fromGeneration: older })], NOW)).not.toThrow();
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toHaveLength(1);
  });
});

// #192: a stored value whose property accessor throws (another bundle version,
// or anything else in this process, can put one in the shared registry) must
// not wedge the agent's hand-off or its served ledger.
describe("accessor isolation (#192)", () => {
  const store = () =>
    (globalThis as unknown as Record<symbol, { reloadHandoffs: Map<string, unknown[]> }>)[KEY].reloadHandoffs;
  /** An object whose named field throws when read; every other field reads as `base`. */
  const throwing = (base: Record<string, unknown>, field: string, after = 0): unknown => {
    let reads = 0;
    const copy: Record<string, unknown> = { ...base };
    delete copy[field];
    Object.defineProperty(copy, field, {
      enumerable: true,
      get() {
        if (reads++ >= after) throw new Error(`poisoned ${field}`);
        return base[field];
      }
    });
    return copy;
  };

  for (const field of ["owner", "agentId", "fromEpoch", "conversationId", "depositedAtMs"]) {
    it(`a stored entry whose ${field} getter throws is dropped: the valid entry beside it is still taken, and nothing throws`, () => {
      const { older, newer } = holders();
      depositReloadHandoff([entry({ fromGeneration: older })], NOW);
      store().get("agent_x")!.unshift(throwing(entry({ fromGeneration: older }), field));

      let got!: ReturnType<typeof takeReloadHandoff>;
      expect(() => (got = takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW))).not.toThrow();
      expect(got.taken.map((e) => (e.message as { message_id: string }).message_id)).toEqual(["m"]);
      expect(got.dropped).toEqual([]);
      expect(reloadHandoffCount("agent_x")).toBe(0); // the poisoned value is gone too
    });
  }

  it("a poisoned stored entry does not make a later deposit throw, and the deposit is kept", () => {
    const { older, newer } = holders();
    depositReloadHandoff([entry({ fromGeneration: older })], NOW);
    store().get("agent_x")!.unshift(throwing(entry({ fromGeneration: older }), "owner"));

    const second = entry({ fromGeneration: older, message: { message_id: "m2", conversation_id: "c" } });
    expect(() => depositReloadHandoff([second], NOW)).not.toThrow();
    expect(reloadHandoffCount("agent_x")).toBe(2);
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toHaveLength(2);
  });

  it("a deposited entry whose getter throws is refused without throwing or disturbing the rest of the deposit", () => {
    const { older, newer } = holders();
    const bad = throwing(entry({ fromGeneration: older }), "agentId") as ReloadHandoffEntry;
    expect(() => depositReloadHandoff([bad, entry({ fromGeneration: older })], NOW)).not.toThrow();
    expect(reloadHandoffCount("agent_x")).toBe(1);
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toHaveLength(1);
  });

  // An accessor that answers its first read and throws on a later one. The
  // registry reads each field once and keeps its own plain copy, so there is
  // no later read: what it hands out can be read any number of times.
  for (const field of ["owner", "agentId", "fromEpoch", "depositedAtMs", "message"]) {
    it(`an entry whose ${field} getter throws only on a later read is handed out as a plain copy that never throws`, () => {
      const { older, newer } = holders();
      const tricky = throwing(entry({ fromGeneration: older, message: { message_id: "tricky", conversation_id: "c" } }), field, 1);
      depositReloadHandoff([entry({ fromGeneration: older })], NOW);
      store().get("agent_x")!.unshift(tricky);

      let got!: ReturnType<typeof takeReloadHandoff>;
      expect(() => (got = takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW))).not.toThrow();
      expect(got.taken).toHaveLength(2);
      for (const e of got.taken) {
        expect(e === tricky).toBe(false);
        for (const d of Object.values(Object.getOwnPropertyDescriptors(e))) expect(d.get).toBeUndefined();
        for (let i = 0; i < 3; i++) expect(() => JSON.stringify(e)).not.toThrow();
      }
      expect(got.taken.map((e) => (e.message as { message_id: string }).message_id)).toEqual(["tricky", "m"]);
      expect(reloadHandoffCount("agent_x")).toBe(0);
    });
  }

  it("what the bounds drop is reported as a plain copy too: the caller's report cannot trip on it", () => {
    const { older, newer } = holders();
    const tricky = throwing(entry({ fromGeneration: older }), "owner", 1);
    depositReloadHandoff([entry({ fromGeneration: older, owner: "conn-b" })], NOW); // creates the list
    store().get("agent_x")!.unshift(tricky);
    const { dropped } = takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW + RELOAD_HANDOFF_MAX_AGE_MS + 1);
    expect(dropped).toHaveLength(2);
    for (const d of dropped) {
      expect(d.entry === tricky).toBe(false);
      expect(() => [d.entry.owner, d.entry.owner, d.entry.message]).not.toThrow();
    }
  });

  it("a deposit is stored as the registry's own copy: changing the depositor's object afterwards changes nothing", () => {
    const { older, newer } = holders();
    const mine = entry({ fromGeneration: older });
    depositReloadHandoff([mine], NOW);
    mine.owner = "conn-b";
    mine.fromEpoch = newer + 10;
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toHaveLength(1);
  });

  // The list itself, not a value in it, cannot be walked.
  const unwalkable = (): unknown[] =>
    new Proxy([entry()], {
      get() {
        throw new Error("poisoned list");
      }
    });

  it("a stored list that cannot be walked costs the agent its slot once: the take returns nothing and does not throw, and later work flows", () => {
    const { older, newer } = holders();
    depositReloadHandoff([entry({ fromGeneration: older })], NOW); // creates the store
    store().set("agent_x", unwalkable());
    let got!: ReturnType<typeof takeReloadHandoff>;
    expect(() => (got = takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW))).not.toThrow();
    expect(got).toEqual({ taken: [], dropped: [] });
    expect(store().has("agent_x")).toBe(false);

    depositReloadHandoff([entry({ fromGeneration: older })], NOW);
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toHaveLength(1);
  });

  it("a deposit over a stored list that cannot be walked replaces it and is kept", () => {
    const { older, newer } = holders();
    depositReloadHandoff([entry({ fromGeneration: older })], NOW); // creates the store
    store().set("agent_x", unwalkable());
    expect(() => depositReloadHandoff([entry({ fromGeneration: older })], NOW)).not.toThrow();
    expect(reloadHandoffCount("agent_x")).toBe(1);
    expect(takeReloadHandoff("agent_x", "conn-a", newer, newer, NOW).taken).toHaveLength(1);
  });

  it("another agent's hand-off is unaffected by a poisoned entry", () => {
    const { older, newer } = holders();
    claimAgentRuntime("agent_y", { generation: newer, stop: () => {} });
    depositReloadHandoff([entry({ fromGeneration: older, agentId: "agent_y" })], NOW);
    depositReloadHandoff([entry({ fromGeneration: older })], NOW);
    store().get("agent_x")!.unshift(throwing(entry({ fromGeneration: older }), "owner"));
    expect(takeReloadHandoff("agent_y", "conn-a", newer, newer, NOW).taken).toHaveLength(1);
  });

  describe("served ledger", () => {
    type Ledger = { keys: Map<string, unknown>; nonces: Map<string, unknown>; forgotten?: unknown };
    const ledgers = () =>
      (globalThis as unknown as Record<symbol, { reloadServed: Map<string, Ledger> }>)[KEY].reloadServed;
    const ledger = () => ledgers().get("agent_x\u0000conn-a")!;

    it("noting over an unreadable record replaces it, and its evidence counts as lost", async () => {
      const { noteReloadServed, reloadServedBy, reloadServedForgotten } = await import("../src/runtime-registry");
      noteReloadServed("agent_x", "conn-a", 3, { keys: ["k", "old"] }, NOW);
      ledger().keys.set("k", throwing({ generation: 3, atMs: NOW }, "generation"));
      expect(() => noteReloadServed("agent_x", "conn-a", 4, { keys: ["k"] }, NOW)).not.toThrow();
      expect(reloadServedBy("agent_x", "conn-a", "key", "k")).toBe(4);

      // The prior owner may have been a later loop: its evidence is lost.
      expect(reloadServedForgotten("agent_x", "conn-a", "key")).toBe(Number.POSITIVE_INFINITY);
      expect(reloadServedForgotten("agent_x", "conn-a", "nonce")).toBeUndefined(); // the other kind is intact
    });

    it("an unreadable record the age bound reaches is dropped and counted as lost evidence; the note still lands", async () => {
      const { noteReloadServed, reloadServedBy, reloadServedForgotten } = await import("../src/runtime-registry");
      noteReloadServed("agent_x", "conn-a", 3, { nonces: ["old"] }, NOW);
      ledger().nonces.set("old", throwing({ generation: 3, atMs: NOW }, "atMs"));
      const later = NOW + RELOAD_HANDOFF_MAX_AGE_MS + 1;
      expect(() => noteReloadServed("agent_x", "conn-a", 6, { nonces: ["fresh"] }, later)).not.toThrow();
      expect(reloadServedBy("agent_x", "conn-a", "nonce", "old")).toBeUndefined();
      expect(reloadServedBy("agent_x", "conn-a", "nonce", "fresh")).toBe(6);
      expect(reloadServedForgotten("agent_x", "conn-a", "nonce")).toBe(Number.POSITIVE_INFINITY);
      expect(reloadServedForgotten("agent_x", "conn-a", "key")).toBeUndefined();
    });

    it("lost evidence stays lost when the whole ledger is later dropped by the per-process bound", async () => {
      const { noteReloadServed, reloadServedBy, reloadServedForgotten } = await import("../src/runtime-registry");
      noteReloadServed("agent_x", "conn-a", 3, { keys: ["k"] }, NOW);
      ledger().keys.set("k", throwing({ generation: 3, atMs: NOW }, "generation"));
      noteReloadServed("agent_x", "conn-a", 3, { keys: ["k"] }, NOW); // meets the unreadable record
      expect(reloadServedForgotten("agent_x", "conn-a", "key")).toBe(Number.POSITIVE_INFINITY);

      for (let i = 0; i < 64; i++) noteReloadServed("agent_x", `other-${i}`, 1, { keys: ["k"] }, NOW);
      expect(reloadServedBy("agent_x", "conn-a", "key", "k")).toBeUndefined(); // the whole domain is gone
      // Its readable records were all epoch 3; the unreadable one could have
      // been later than any of them, so the floor is not 3.
      expect(reloadServedForgotten("agent_x", "conn-a", "key")).toBe(Number.POSITIVE_INFINITY);
      expect(reloadServedForgotten("agent_x", "conn-a", "nonce")).toBeUndefined(); // the other kind lost nothing
    });

    it("a ledger dropped whole leaves the lost-evidence mark as a floor for a second connection and for another agent's domain", async () => {
      const { noteReloadServed, reloadServedForgotten } = await import("../src/runtime-registry");
      noteReloadServed("agent_x", "conn-a", 3, { keys: ["k"] }, NOW);
      ledger().keys.set("k", throwing({ generation: 3, atMs: NOW }, "generation"));
      noteReloadServed("agent_x", "conn-a", 3, { keys: ["k"] }, NOW); // meets the unreadable record
      for (let i = 0; i < 64; i++) noteReloadServed("agent_x", `other-${i}`, 1, { keys: ["k"] }, NOW);
      expect(ledgers().has("agent_x\u0000conn-a")).toBe(false);
      for (const [agent, conn] of [["agent_x", "conn-b"], ["agent_y", "conn-c"]]) {
        expect(reloadServedForgotten(agent, conn, "key")).toBe(Number.POSITIVE_INFINITY);
        expect(reloadServedForgotten(agent, conn, "nonce")).toBeUndefined();
      }
    });

    it("before any ledger is dropped whole, an unreadable record marks its own connection only", async () => {
      const { noteReloadServed, reloadServedBy, reloadServedForgotten } = await import("../src/runtime-registry");
      noteReloadServed("agent_x", "conn-a", 3, { keys: ["k"] }, NOW);
      noteReloadServed("agent_x", "conn-b", 5, { keys: ["k"] }, NOW);
      ledger().keys.set("k", throwing({ generation: 3, atMs: NOW }, "generation"));
      noteReloadServed("agent_x", "conn-a", 4, { keys: ["k"] }, NOW); // meets the unreadable record
      expect(reloadServedForgotten("agent_x", "conn-a", "key")).toBe(Number.POSITIVE_INFINITY);
      expect(reloadServedForgotten("agent_x", "conn-b", "key")).toBeUndefined();
      expect(reloadServedForgotten("agent_x", "conn-b", "nonce")).toBeUndefined();
      expect(reloadServedBy("agent_x", "conn-b", "key", "k")).toBe(5);
    });
  });
});

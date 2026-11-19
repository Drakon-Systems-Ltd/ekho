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
});

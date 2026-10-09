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
    ...over
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

    expect(takeReloadHandoff("agent_x", "conn-a", older, NOW).taken).toEqual([]); // not the holder
    expect(takeReloadHandoff("agent_x", "conn-b", newer, NOW).taken).toEqual([]); // another connection
    expect(takeReloadHandoff("agent_y", "conn-a", newer, NOW).taken).toEqual([]); // another agent
    expect(takeReloadHandoff("agent_x", "", newer, NOW).taken).toEqual([]); // no owner at all
    expect(reloadHandoffCount("agent_x")).toBe(1);

    const first = takeReloadHandoff("agent_x", "conn-a", newer, NOW);
    expect(first.taken.map((e) => e.fromGeneration)).toEqual([older]);
    expect(takeReloadHandoff("agent_x", "conn-a", newer, NOW).taken).toEqual([]);
    expect(reloadHandoffCount("agent_x")).toBe(0);
  });

  it("a retired generation takes nothing, even its own successor's leftovers", () => {
    const { older, newer } = holders();
    depositReloadHandoff([entry({ fromGeneration: older })], NOW);
    releaseAgentRuntime("agent_x", newer); // the holder stopped: nobody holds the agent
    expect(takeReloadHandoff("agent_x", "conn-a", newer, NOW).taken).toEqual([]);
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
    const { taken } = takeReloadHandoff("agent_x", "conn-a", newer, NOW);
    expect(taken).toHaveLength(1);
    expect(reloadHandoffCount("agent_x")).toBe(3);
  });

  it("ignores malformed deposits instead of throwing", () => {
    const { older, newer } = holders();
    const junk = [null, 7, "x", { owner: "conn-a" }, entry({ fromGeneration: Number.NaN }), entry({ owner: "" })];
    expect(() => depositReloadHandoff([...junk, entry({ fromGeneration: older })] as never, NOW)).not.toThrow();
    expect(reloadHandoffCount("agent_x")).toBe(1);
    expect(takeReloadHandoff("agent_x", "conn-a", newer, NOW).taken).toHaveLength(1);
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
    const { taken, dropped } = takeReloadHandoff("agent_x", "conn-a", newer, later);
    expect(taken).toEqual([]);
    expect(dropped.map((d) => d.why)).toEqual(["unclaimed_too_long"]);
    expect(reloadHandoffCount("agent_x")).toBe(0);
  });

  it("works on a registry an older bundle created without the hand-off field", () => {
    (globalThis as Record<symbol, unknown>)[KEY] = { generations: 0, byAgent: new Map() };
    const { older, newer } = holders();
    depositReloadHandoff([entry({ fromGeneration: older })], NOW);
    expect(takeReloadHandoff("agent_x", "conn-a", newer, NOW).taken).toHaveLength(1);
  });
});

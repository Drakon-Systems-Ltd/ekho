// #78, end to end through the real poll loop: a peer message deferred to a
// floor holder that never lets go is delivered LATE rather than binned, and a
// stash the FIFO cap pushes out leaves a dead-letter record behind it.
//
// The child process is mocked so the tick can spawn a "turn" and be inspected
// without running a gateway; only `Date` is faked, so the loop's own interval
// still runs on real time.

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

import { startAutoReply, DEFERRED_RETRY_TTL_MS } from "../src/autoreply";

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

afterEach(() => {
  hoisted.calls.length = 0;
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

// PR #102 review, blocker 1: stop() must secure acknowledged work before it
// returns, and a stopped loop must not consume or process anything afterwards.
// Seeded from the reviewer's probe (astra-pr102-stop-probe.mjs): one message
// acked and held for a floor holder, the next poll still in flight at stop.
// Before the fix stop() returned undefined with the held message only in
// memory, and the late poll's batch was acked and spawned a turn after stop.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  spawns: [] as Array<{ afterStop: boolean; prompt: string }>,
  stopped: false,
  // When set, a spawned turn runs until the test calls its `exit`.
  holdTurns: false,
  running: [] as Array<() => void>
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (_cmd: string, args: string[]) => {
      hoisted.spawns.push({ afterStop: hoisted.stopped, prompt: args[args.length - 1] });
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => {};
      const exit = () => child.emit("exit", 0);
      if (hoisted.holdTurns) hoisted.running.push(exit);
      else setTimeout(exit, 0);
      return child;
    }
  };
});

import {
  startAutoReply,
  DEFERRED_LOOP_STOPPED_REASON,
  INFLIGHT_LOOP_STOPPED_REASON,
  STOP_DRAIN_MS
} from "../src/autoreply";

const POLL_MS = 5_000;

function peer(id: string, conv: string): any {
  return {
    message_id: id,
    conversation_id: conv,
    sender_agent_id: `peer-${id}`,
    sender_kind: "agent",
    message_type: "direct",
    body: { text: `synthetic ${id}` }
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A stub relay that records every call with whether it came after stop. */
function stubRelay() {
  const calls: Array<{ op: string; arg?: unknown; afterStop: boolean }> = [];
  const note = (op: string, arg?: unknown) => calls.push({ op, arg, afterStop: hoisted.stopped });
  return {
    calls,
    after: () => calls.filter((c) => c.afterStop).map((c) => c.op),
    client: {
      getInbox: vi.fn(async (): Promise<any> => ({ messages: [] })),
      ackMessages: vi.fn(async (batch: Array<{ message_id: string }>) => {
        note("ack", batch.map((b) => b.message_id));
        return {};
      }),
      acquireFloor: vi.fn(async (conv: string): Promise<any> => {
        note("acquire", conv);
        return { granted: conv !== "held-conv", holder_agent_id: "other" };
      }),
      releaseFloor: vi.fn(async (conv: string) => {
        note("release", conv);
      }),
      raiseNotice: vi.fn(async () => {})
    }
  };
}

function start(relay: ReturnType<typeof stubRelay>, records: any[], warnings: string[] = []) {
  return startAutoReply({
    client: relay.client as any,
    api: {} as any,
    selfAgentId: "self",
    peerEnabled: true,
    log: { info: () => {}, warn: (m: unknown) => warnings.push(String(m)), debug: () => {}, error: () => {} } as any,
    onDeadLetter: (r) => records.push(...r)
  });
}

const tick = () => vi.advanceTimersByTimeAsync(POLL_MS);

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.spawns.length = 0;
  hoisted.stopped = false;
  hoisted.holdTurns = false;
  hoisted.running.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stop() during an in-flight poll (reviewer probe)", () => {
  it("dead-letters the held stash before returning and processes nothing the late poll brings", async () => {
    const relay = stubRelay();
    const records: any[] = [];
    const poll2 = deferred<any>();
    relay.client.getInbox
      .mockResolvedValueOnce({ messages: [peer("held", "held-conv")], peer_autoreply: true })
      .mockReturnValueOnce(poll2.promise);
    const stop = start(relay, records);

    await tick(); // tick 1: acked, floor held by another agent -> stashed
    expect(relay.client.ackMessages).toHaveBeenCalledTimes(1);
    expect(records).toEqual([]);
    await tick(); // tick 2: poll in flight
    expect(relay.client.getInbox).toHaveBeenCalledTimes(2);

    hoisted.stopped = true;
    const returned = stop();
    // At return: a promise for the host to await, and the acked message is
    // already on the dead-letter sink — not only in memory.
    expect(returned).toBeInstanceOf(Promise);
    expect(records.map((r) => [r.message.message_id, r.reason])).toEqual([["held", DEFERRED_LOOP_STOPPED_REASON]]);

    let drained = false;
    void returned.then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false); // waits for the poll in flight

    poll2.resolve({ messages: [peer("arrived-after-stop", "free-conv")], peer_autoreply: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
    // Nothing acked, no floor taken, no turn: the relay still owns it.
    expect(relay.after()).toEqual([]);
    expect(hoisted.spawns).toEqual([]);
    expect(records).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(relay.client.getInbox).toHaveBeenCalledTimes(2);
    // Idempotent: a second unload signal gets the same promise.
    expect(stop()).toBe(returned);
  });

  it("a poll that never settles does not hold stop() past its bound", async () => {
    const relay = stubRelay();
    const warnings: string[] = [];
    relay.client.getInbox.mockReturnValueOnce(new Promise(() => {}));
    const stop = start(relay, [], warnings);
    await tick();

    let drained = false;
    void stop().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS - 1);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe(true);
    expect(warnings.some((w) => w.includes("in-flight tick still running"))).toBe(true);
  });

  it("an idle loop's stop() resolves at once", async () => {
    const relay = stubRelay();
    const stop = start(relay, []);
    await tick();
    let drained = false;
    void stop().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
  });
});

describe("stop() later in the tick", () => {
  it("between the ack and the turn: the acked batch is dead-lettered before stop returns, and gets no turn", async () => {
    const relay = stubRelay();
    const records: any[] = [];
    const ack = deferred<void>();
    relay.client.getInbox.mockResolvedValueOnce({ messages: [peer("m1", "free-conv")], peer_autoreply: true });
    relay.client.ackMessages.mockReturnValueOnce(ack.promise.then(() => ({})) as never);
    const stop = start(relay, records);
    await tick(); // poll done, ack in flight

    hoisted.stopped = true;
    const drained = stop();
    expect(records.map((r) => [r.message.message_id, r.reason])).toEqual([["m1", INFLIGHT_LOOP_STOPPED_REASON]]);

    ack.resolve();
    await drained;
    expect(relay.after()).toEqual([]); // no floor acquire, nothing else
    expect(hoisted.spawns).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it("while the floor acquire is in flight: dead-lettered at stop, the granted floor is handed back, no turn", async () => {
    const relay = stubRelay();
    const records: any[] = [];
    const acquire = deferred<any>();
    relay.client.getInbox.mockResolvedValueOnce({ messages: [peer("m1", "free-conv")], peer_autoreply: true });
    relay.client.acquireFloor.mockReturnValueOnce(acquire.promise);
    const stop = start(relay, records);
    await tick();
    expect(relay.client.acquireFloor).toHaveBeenCalledTimes(1);

    hoisted.stopped = true;
    const drained = stop();
    expect(records.map((r) => [r.message.message_id, r.reason])).toEqual([["m1", INFLIGHT_LOOP_STOPPED_REASON]]);

    acquire.resolve({ granted: true });
    await drained;
    expect(relay.after()).toEqual(["release"]);
    expect(hoisted.spawns).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it("a covering turn already running keeps its stash: no dead-letter for messages it delivers", async () => {
    const relay = stubRelay();
    const records: any[] = [];
    relay.client.getInbox
      .mockResolvedValueOnce({ messages: [peer("held", "held-conv")], peer_autoreply: true })
      .mockResolvedValueOnce({
        messages: [{ ...peer("op1", "held-conv"), sender_kind: "operator", sender_agent_id: "op" }],
        operator_trusted: true,
        peer_autoreply: true
      });
    const stop = start(relay, records);
    await tick(); // stash "held"
    hoisted.holdTurns = true;
    await tick(); // the operator's turn covers the stash and is running
    expect(hoisted.spawns).toHaveLength(1);
    expect(hoisted.spawns[0].prompt).toContain("synthetic held");

    hoisted.stopped = true;
    const drained = stop();
    expect(records).toEqual([]); // the turn has them, not stop()
    hoisted.running.forEach((exit) => exit());
    await drained;
    expect(records).toEqual([]);
  });
});

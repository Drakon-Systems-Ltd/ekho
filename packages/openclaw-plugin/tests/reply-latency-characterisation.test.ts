// #155: characterisation tests for reply latency (OpenClaw adapter).
//
// These PIN TODAY'S behaviour; they do not endorse it. #155 separates relay
// transport, conversation-floor waiting, a busy adapter, and agent work. Each
// test names the waiting state it pins. Tests marked "FLIPS" are the ones the
// #155 implementation is expected to change. That PR must update the test and
// docs/plans/2026-11-01-155-reply-latency-design.md together.
//
// The child process is mocked, and each fake "turn" stays running until the
// test exits it, so the test decides exactly when a turn ends. The loop runs
// on real time with a 5 ms poll. Every wait polls a predicate; no assertion
// depends on a timer race. The one "nothing happened" check waits a fixed 25
// poll intervals. A failure there means a real behaviour change, never noise.

import { afterEach, describe, expect, it, vi } from "vitest";

type FakeChild = { args: string[]; prompt: string; exit: (code?: number) => void; exited: boolean };

const hoisted = vi.hoisted(() => ({ children: [] as FakeChild[] }));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => {};
      const rec: FakeChild = {
        args,
        prompt: args[args.length - 1],
        exited: false,
        exit: (code = 0) => {
          if (rec.exited) return;
          rec.exited = true;
          child.emit("exit", code);
        }
      };
      hoisted.children.push(rec);
      return child;
    }
  };
});

import { planFloorTurn, startAutoReply } from "../src/autoreply";

const SHARED = "op-1730460616088-bcast001"; // an operator broadcast's conversation id
const quiet = { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} };

function operatorMsg(id: string, conv: string, text = "operator ask"): any {
  return { message_id: id, conversation_id: conv, sender_agent_id: "op", sender_kind: "operator", message_type: "direct", body: { text } };
}

function peerMsg(id: string, conv: string, sender = "agent_a", text = "peer status request"): any {
  return { message_id: id, conversation_id: conv, sender_agent_id: sender, sender_kind: "agent", message_type: "direct", body: { text } };
}

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = performance.now();
  while (!pred()) {
    if (performance.now() - started > timeoutMs) throw new Error("timed out waiting for the tick");
    await new Promise((r) => setTimeout(r, 2));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A shared relay-side floor table: granted when free or already ours
 *  (mirrors relay db.ts acquireFloor; expiry is out of scope here). */
function floorTable() {
  const holders = new Map<string, string>();
  return {
    holders,
    acquire(agent: string, conv: string) {
      const h = holders.get(conv);
      if (h === undefined || h === agent) {
        holders.set(conv, agent);
        return { granted: true, holder_agent_id: agent, conversation_tail: [] };
      }
      return { granted: false, holder_agent_id: h };
    },
    release(agent: string, conv: string) {
      if (holders.get(conv) === agent) holders.delete(conv);
    }
  };
}

/** A fake relay client for one agent: serves `batches` one per poll, then empty
 *  inboxes, and records every call in order. */
function fakeClient(agent: string, batches: any[], floors = floorTable()) {
  const calls: string[] = [];
  const acked: string[] = [];
  let polls = 0;
  return {
    calls,
    acked,
    floors,
    get polls() {
      return polls;
    },
    client: {
      getInbox: async () => {
        polls++;
        calls.push("getInbox");
        return batches.shift() ?? { messages: [] };
      },
      ackMessages: async (acks: Array<{ message_id: string }>) => {
        calls.push("ack");
        acked.push(...acks.map((a) => a.message_id));
      },
      acquireFloor: async (conv: string) => {
        calls.push(`acquire:${conv}`);
        return floors.acquire(agent, conv);
      },
      releaseFloor: async (conv: string) => {
        calls.push(`release:${conv}`);
        floors.release(agent, conv);
      },
      raiseNotice: async () => {}
    }
  };
}

function start(agent: string, client: unknown) {
  return startAutoReply({
    client: client as any,
    api: {} as any,
    selfAgentId: agent,
    pollIntervalMs: 5,
    peerEnabled: true,
    stopDrainMs: 200,
    log: quiet
  });
}

afterEach(() => {
  for (const c of hoisted.children) c.exit(0);
  hoisted.children.length = 0;
});

describe("#155 planFloorTurn: operator bypass and mixed batches (characterises current behaviour)", () => {
  const heldEverywhere = async () => ({ granted: false, holder_agent_id: "agent_c" });

  it("operator-only messages bypass the floor even while another agent holds it", async () => {
    const acquires: string[] = [];
    const plan = await planFloorTurn([operatorMsg("op1", SHARED), operatorMsg("op2", "room-ops")], async (conv) => {
      acquires.push(conv);
      return { granted: false, holder_agent_id: "agent_c" };
    });
    expect(acquires).toEqual([]);
    expect(plan.floored.map((m) => m.message_id)).toEqual(["op1", "op2"]);
    expect(plan.toRelease).toEqual([]);
    expect(plan.deferred).toEqual({});
  });

  it("a mixed batch on ONE conversation defers the operator message together with the peer's (FLIPS under #155)", async () => {
    const plan = await planFloorTurn([operatorMsg("op1", SHARED), peerMsg("p1", SHARED)], heldEverywhere);
    expect(plan.floored).toEqual([]);
    expect(plan.deferred[SHARED].map((m) => m.message_id)).toEqual(["op1", "p1"]);
  });

  it("a mixed batch across conversations lets the operator slice through; only the peer slice waits", async () => {
    const plan = await planFloorTurn([operatorMsg("op1", "dm-f-agent_b"), peerMsg("p1", SHARED)], heldEverywhere);
    expect(plan.floored.map((m) => m.message_id)).toEqual(["op1"]);
    expect(Object.keys(plan.deferred)).toEqual([SHARED]);
  });

  it("floors are per conversation id: a held floor on one id does not touch another id", async () => {
    const plan = await planFloorTurn([peerMsg("p1", "work-b"), peerMsg("p2", "work-d", "agent_c")], async (conv) =>
      conv === "work-b" ? { granted: false, holder_agent_id: "agent_x" } : { granted: true, conversation_tail: [] }
    );
    expect(plan.floored.map((m) => m.message_id)).toEqual(["p2"]);
    expect(plan.toRelease).toEqual(["work-d"]);
    expect(Object.keys(plan.deferred)).toEqual(["work-b"]);
  });
});

describe("#155 busy adapter: waiting on the ACTIVE TURN (characterises current behaviour)", () => {
  it("does not poll the relay at all while a turn runs, so a mid-turn message stays queued until the turn exits", async () => {
    const f = fakeClient("agent_b", [
      { messages: [operatorMsg("op1", "dm-f-agent_b", "first ask")], operator_trusted: true, roster: [] },
      { messages: [operatorMsg("op2", "dm-f-agent_b", "second ask")], operator_trusted: true, roster: [] }
    ]);
    const stop = start("agent_b", f.client);
    try {
      await waitFor(() => hoisted.children.length === 1);
      expect(hoisted.children[0].prompt).toContain("first ask");
      const pollsAtTurnStart = f.polls;
      expect(pollsAtTurnStart).toBe(1);

      // 25 poll intervals while the first turn is still running: the tick
      // holding the turn blocks the interval (`tickRunning`), so no poll happens.
      // op2 is never fetched or acked, and at the relay it reads plain `queued`.
      await sleep(125);
      expect(f.polls).toBe(pollsAtTurnStart);
      expect(f.acked).toEqual(["op1"]);
      expect(hoisted.children).toHaveLength(1);

      // The turn ends, and only now is op2 fetched, acked and woken.
      hoisted.children[0].exit(0);
      await waitFor(() => hoisted.children.length === 2);
      expect(f.acked).toEqual(["op1", "op2"]);
      expect(hoisted.children[1].prompt).toContain("second ask");
    } finally {
      await stop();
    }
  });
});

describe("#155 waiting on the FLOOR vs independent recipients (characterises current behaviour)", () => {
  /** agent_b is mid-turn on a peer-triggered conversation `work-b`, so it holds
   *  the floor. Meanwhile agent_d gets a peer direct on `convForD`. */
  async function bMidTurnThenD(convForD: string) {
    const floors = floorTable();
    const b = fakeClient(
      "agent_b",
      [{ messages: [peerMsg("p-b", "work-b", "agent_a", "b's own work")], operator_trusted: false, peer_autoreply: true, roster: [] }],
      floors
    );
    const stopB = start("agent_b", b.client);
    await waitFor(() => hoisted.children.length === 1);
    expect(floors.holders.get("work-b")).toBe("agent_b");

    const d = fakeClient(
      "agent_d",
      [{ messages: [peerMsg("p-d", convForD, "agent_c", "d's own work")], operator_trusted: false, peer_autoreply: true, roster: [] }],
      floors
    );
    const stopD = start("agent_d", d.client);
    return { floors, b, d, stop: async () => { await stopB(); await stopD(); } };
  }

  it("two recipients on DIFFERENT conversation ids do not block each other", async () => {
    const s = await bMidTurnThenD("work-d");
    try {
      await waitFor(() => hoisted.children.length === 2);
      expect(hoisted.children[1].prompt).toContain("d's own work");
      expect(hoisted.children[0].exited).toBe(false); // B is still mid-turn
      expect(s.floors.holders.get("work-d")).toBe("agent_d");
    } finally {
      await s.stop();
    }
  });

  it("a direct on a conversation whose floor another agent holds is acked at once but not woken until the floor frees (FLIPS under #155 option A)", async () => {
    const s = await bMidTurnThenD("work-b");
    try {
      await waitFor(() => s.d.calls.includes("acquire:work-b"));
      expect(s.d.acked).toEqual(["p-d"]); // "received", but nothing has answered it

      // B still holds work-b, so D keeps retrying and being refused. Wait on the
      // retry predicate (two more refused acquires), not on a fixed sleep. B's
      // child cannot exit until this test exits it, so every one of those
      // acquires is refused, and D still has no turn.
      const acquiresOnB = () => s.d.calls.filter((c) => c === "acquire:work-b").length;
      await waitFor(() => acquiresOnB() >= 3);
      expect(hoisted.children).toHaveLength(1);
      expect(s.floors.holders.get("work-b")).toBe("agent_b");

      // B's turn ends and B releases the floor. D's next retry gets it and wakes.
      hoisted.children[0].exit(0);
      await waitFor(() => hoisted.children.length === 2);
      expect(hoisted.children[1].prompt).toContain("d's own work");
      expect(hoisted.children[1].prompt).toContain("THIS TURN WAS HELD BACK"); // the deferred banner
    } finally {
      await s.stop();
    }
  });
});

describe("#155 covering turn vs a floor another agent holds (characterises current behaviour)", () => {
  it("an operator turn absorbs a peer message stashed behind agent_c's floor while agent_c still holds it (FLIPS under #155 Phase 7b)", async () => {
    // mergeCoveredStashes (#78) picks stashes by conversation id, not by the
    // floor the turn holds. The operator-only slice takes no floor, so its turn
    // carries the held peer message past agent_c's floor. Phase 7b: a covering
    // turn absorbs only stashes whose exact (conversation, lane) floor it holds;
    // the operator message runs alone and the peer message stays stashed.
    const floors = floorTable();
    floors.acquire("agent_c", SHARED); // agent_c is mid-turn on SHARED and never lets go here
    const f = fakeClient(
      "agent_b",
      [
        { messages: [peerMsg("p1", SHARED)], operator_trusted: false, peer_autoreply: true, roster: [] },
        { messages: [operatorMsg("op1", SHARED, "fleet status?")], operator_trusted: true, peer_autoreply: true, roster: [] }
      ],
      floors
    );
    const stop = start("agent_b", f.client);
    try {
      await waitFor(() => hoisted.children.length === 1);
      const prompt = hoisted.children[0].prompt;
      expect(prompt).toContain("fleet status?");
      expect(prompt).toContain("peer status request"); // the stashed peer message rode along
      expect(prompt).toContain("HELD BACK");
      expect(floors.holders.get(SHARED)).toBe("agent_c"); // ...and agent_c still holds the floor
      expect(f.acked).toEqual(["p1", "op1"]);
      // The covering tick took no floor: no acquire after its fetch, nothing to release.
      const coveringTick = f.calls.slice(f.calls.lastIndexOf("getInbox"));
      expect(coveringTick).not.toContain(`acquire:${SHARED}`);
      expect(f.calls).not.toContain(`release:${SHARED}`);
    } finally {
      await stop();
    }
  });
});

// #155 (part): the heartbeat says whether an auto-reply turn is running right
// now. These tests load the real plugin entry against a stub relay and a stub
// child process, and read what the heartbeat actually sent: the wiring between
// the loop (autoreply.ts) and the heartbeat (connection.ts), not a helper.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFERRED_RETRY_TTL_MS, FLOOR_TTL_SECONDS } from "../src/autoreply";

// The production turn timeout, read back from the exported constant built on
// it (FLOOR_TTL_SECONDS = timeout + 60). The timeout test below also checks it
// against the real kill timer, so this is not a number agreeing with itself.
const TURN_TIMEOUT_MS = (FLOOR_TTL_SECONDS - 60) * 1000;
const HEARTBEAT_MS = 1_000;
const POLL_MS = 5_000; // startAutoReply's default
const TURN_KEYS = ["adapter_state", "turn_started_at", "turn_deadline_at", "deferred_conversations"];
const START_ENV = "EKHO_TURN_STARTED_AT";
const DEADLINE_ENV = "EKHO_TURN_DEADLINE_AT";

interface Turn {
  env: Record<string, string | undefined>;
  exit: (code?: number) => void;
  fail: () => void;
}

const relay = vi.hoisted(() => ({
  heartbeats: [] as Array<Record<string, string>>,
  failHeartbeats: false,
  polls: 0,
  batches: [] as unknown[],
  floorFree: true,
  turns: [] as Turn[],
  spawnAttempts: 0,
  spawnThrows: false
}));

// Every spawned turn is held open until the test ends it, so a heartbeat can
// be read while the turn is running.
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (_cmd: string, _args: string[], opts: { env?: Record<string, string | undefined> } = {}) => {
      relay.spawnAttempts++;
      if (relay.spawnThrows) throw new Error("synthetic spawn throw");
      const child = new EventEmitter() as InstanceType<typeof EventEmitter> & { kill: () => void };
      child.kill = () => {};
      relay.turns.push({
        env: { ...(opts.env ?? {}) },
        exit: (code = 0) => void child.emit("exit", code),
        fail: () => void child.emit("error", new Error("synthetic spawn failure"))
      });
      return child;
    }
  };
});

vi.mock("@drakon-systems/ekho-sdk", () => ({
  EkhoAgentClient: class {
    async registerIdentityKey() {
      return {};
    }
    async heartbeat(payload: { metrics?: Record<string, string> }) {
      relay.heartbeats.push({ ...(payload.metrics ?? {}) });
      if (relay.failHeartbeats) throw new Error("synthetic heartbeat failure");
      return {};
    }
    async getInbox() {
      relay.polls++;
      return relay.batches.shift() ?? { messages: [] };
    }
    async ackMessages() {
      return {};
    }
    async acquireFloor() {
      return { granted: relay.floorFree, holder_agent_id: "other" };
    }
    async releaseFloor() {
      return {};
    }
    async raiseNotice() {
      return {};
    }
  }
}));

type Plugin = { register: (api: unknown) => void };
type Conn = typeof import("../src/connection");

const scratch: string[] = [];
const loaded: Conn[] = [];
let stateDir = "";

function mkScratch(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `ekho-turn-state-${tag}-`));
  scratch.push(d);
  return d;
}

function config(): Record<string, unknown> {
  return {
    relayBaseUrl: "http://relay.invalid",
    agentId: "agent_turn_state",
    agentSecret: "s3cret",
    heartbeatIntervalMs: HEARTBEAT_MS,
    allowNewIdentity: true,
    stateDir
  };
}

function hostApi(): Record<string, unknown> {
  return {
    pluginConfig: config(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerTool: () => {},
    on: () => {},
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} }
  };
}

/** Load a fresh copy of the plugin and register it with a host api: the
 *  gateway process, which runs the auto-reply loop unless the env disables it. */
async function startPlugin(): Promise<Conn> {
  vi.resetModules();
  const plugin = (await import("../src/index")).default as unknown as Plugin;
  const conn = await import("../src/connection");
  loaded.push(conn);
  plugin.register(hostApi());
  await conn.ensureConnected(config() as never);
  await vi.advanceTimersByTimeAsync(0);
  return conn;
}

/** The metrics of the next scheduled heartbeat. */
async function nextBeat(): Promise<Record<string, string>> {
  relay.heartbeats.length = 0;
  await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
  expect(relay.heartbeats.length).toBeGreaterThan(0);
  return relay.heartbeats.at(-1)!;
}

const turnKeysOf = (metrics: Record<string, string>) => Object.keys(metrics).filter((k) => TURN_KEYS.includes(k));

const operatorMessage = (id: string, conversation = "free-conv") => ({
  message_id: id,
  conversation_id: conversation,
  sender_agent_id: "op",
  sender_kind: "operator",
  message_type: "direct",
  body: { text: `operator message ${id}` }
});

const peerMessage = (id: string, conversation: string) => ({
  message_id: id,
  conversation_id: conversation,
  sender_agent_id: "peer",
  sender_kind: "agent",
  message_type: "direct",
  body: { text: `peer message ${id}` },
  deadline_at: new Date(Date.now() + 7 * 86_400_000).toISOString()
});

/** Start the plugin and let one operator message wake a turn that stays open. */
async function startWithRunningTurn(): Promise<{ conn: Conn; turn: Turn; before: number; after: number }> {
  relay.batches.push({ messages: [operatorMessage("m1")], operator_trusted: true });
  const conn = await startPlugin();
  const before = Date.now();
  await vi.advanceTimersByTimeAsync(POLL_MS);
  const after = Date.now();
  expect(relay.turns).toHaveLength(1);
  return { conn, turn: relay.turns[0], before, after };
}

beforeEach(() => {
  vi.useFakeTimers();
  relay.heartbeats.length = 0;
  relay.failHeartbeats = false;
  relay.polls = 0;
  relay.batches.length = 0;
  relay.floorFree = true;
  relay.turns.length = 0;
  relay.spawnAttempts = 0;
  relay.spawnThrows = false;
  vi.stubEnv("HOME", mkScratch("home"));
  vi.stubEnv("EKHO_AUTOREPLY_DISABLE", "");
  vi.stubEnv(START_ENV, "");
  vi.stubEnv(DEADLINE_ENV, "");
  stateDir = join(mkScratch("state"), "ekho-adapter");
});

afterEach(() => {
  for (const conn of loaded) conn.shutdown("test teardown");
  loaded.length = 0;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekho-adapter.runtime")];
  vi.doUnmock("../src/autoreply");
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("the turn child heartbeats (the claim this slice rests on)", () => {
  it("a process with the loop disabled by env still connects and sends heartbeats, and polls nothing", async () => {
    vi.stubEnv("EKHO_AUTOREPLY_DISABLE", "1");
    await startPlugin();
    expect(relay.heartbeats.length).toBeGreaterThan(0); // the beat sent on connect
    const beat = await nextBeat();
    expect(beat.turn_health).toBe("unknown");
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(relay.polls).toBe(0);
    expect(relay.turns).toHaveLength(0);
  });
});

describe("heartbeat turn state: the process that runs the loop", () => {
  it("reports idle with no times and a zero held count when nothing is running", async () => {
    await startPlugin();
    // The whole metrics object: the existing keys are unchanged beside the new ones.
    expect(await nextBeat()).toEqual({
      turn_health: "unknown",
      model_calls_1h: "0",
      adapter_state: "idle",
      deferred_conversations: "0"
    });
  });

  it("reports a running turn with its start and a deadline exactly the production timeout later", async () => {
    const { before, after } = await startWithRunningTurn();
    const beat = await nextBeat();
    expect(beat.adapter_state).toBe("turn_running");
    expect(beat.deferred_conversations).toBe("0");
    const started = Date.parse(beat.turn_started_at);
    const deadline = Date.parse(beat.turn_deadline_at);
    expect(new Date(started).toISOString()).toBe(beat.turn_started_at);
    expect(new Date(deadline).toISOString()).toBe(beat.turn_deadline_at);
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(after);
    expect(deadline - started).toBe(TURN_TIMEOUT_MS);
    // The existing keys ride along untouched.
    expect(beat.turn_health).toBe("unknown");
    expect(beat.model_calls_1h).toBe("0");
  });

  it("hands the same start and deadline to the turn child in its spawn environment", async () => {
    const { turn } = await startWithRunningTurn();
    const beat = await nextBeat();
    expect(turn.env.EKHO_AUTOREPLY_DISABLE).toBe("1");
    expect(turn.env[START_ENV]).toBe(beat.turn_started_at);
    expect(turn.env[DEADLINE_ENV]).toBe(beat.turn_deadline_at);
  });

  it("goes back to idle with no times when the turn exits", async () => {
    const { turn } = await startWithRunningTurn();
    expect((await nextBeat()).adapter_state).toBe("turn_running");
    turn.exit(0);
    const beat = await nextBeat();
    expect(beat).toMatchObject({ adapter_state: "idle", deferred_conversations: "0" });
    expect(turnKeysOf(beat)).toEqual(["adapter_state", "deferred_conversations"]);
    // The finished turn is what the existing turn-health keys now describe.
    expect(beat.turn_health).toBe("ok");
  });

  it("goes back to idle when the turn exits non-zero", async () => {
    const { turn } = await startWithRunningTurn();
    turn.exit(1);
    const beat = await nextBeat();
    expect(beat.adapter_state).toBe("idle");
    expect(turnKeysOf(beat)).toEqual(["adapter_state", "deferred_conversations"]);
  });

  it("stays running until the production timeout, then goes back to idle (the child never exits)", async () => {
    await startWithRunningTurn();
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS - POLL_MS - 2 * HEARTBEAT_MS);
    expect((await nextBeat()).adapter_state).toBe("turn_running");
    await vi.advanceTimersByTimeAsync(POLL_MS + 2 * HEARTBEAT_MS);
    const beat = await nextBeat();
    expect(beat.adapter_state).toBe("idle");
    expect(turnKeysOf(beat)).toEqual(["adapter_state", "deferred_conversations"]);
  });

  it("goes back to idle when the child fails to start", async () => {
    const { turn } = await startWithRunningTurn();
    expect((await nextBeat()).adapter_state).toBe("turn_running");
    turn.fail();
    const beat = await nextBeat();
    expect(beat.adapter_state).toBe("idle");
    expect(turnKeysOf(beat)).toEqual(["adapter_state", "deferred_conversations"]);
  });

  it("is idle after a spawn that throws", async () => {
    relay.spawnThrows = true;
    relay.batches.push({ messages: [operatorMessage("m1")], operator_trusted: true });
    await startPlugin();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(relay.spawnAttempts).toBe(1); // a turn was really attempted
    const beat = await nextBeat();
    expect(beat.adapter_state).toBe("idle");
    expect(turnKeysOf(beat)).toEqual(["adapter_state", "deferred_conversations"]);
  });

  it("counts held-back conversations, and the floor-free retry turn reports like any other turn", async () => {
    relay.floorFree = false;
    relay.batches.push({ messages: [peerMessage("h1", "held-a"), peerMessage("h2", "held-b")], peer_autoreply: true });
    await startPlugin();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(relay.turns).toHaveLength(0);
    expect(await nextBeat()).toMatchObject({ adapter_state: "idle", deferred_conversations: "2" });
    expect(turnKeysOf(relay.heartbeats.at(-1)!)).toEqual(["adapter_state", "deferred_conversations"]);

    relay.floorFree = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(relay.turns).toHaveLength(1);
    const running = await nextBeat();
    expect(running.adapter_state).toBe("turn_running");
    expect(running.deferred_conversations).toBe("1"); // one stash is in the turn, one still held
    expect(Date.parse(running.turn_deadline_at) - Date.parse(running.turn_started_at)).toBe(TURN_TIMEOUT_MS);
    expect(relay.turns[0].env[START_ENV]).toBe(running.turn_started_at);

    relay.floorFree = false; // keep the second stash held
    relay.turns[0].exit(0);
    const idle = await nextBeat();
    expect(idle).toMatchObject({ adapter_state: "idle", deferred_conversations: "1" });
    expect(turnKeysOf(idle)).toEqual(["adapter_state", "deferred_conversations"]);
  });

  it("the overrun turn (held past the retry window, floor never freed) reports the same way", async () => {
    relay.floorFree = false;
    relay.batches.push({ messages: [peerMessage("h1", "held-a")], peer_autoreply: true });
    await startPlugin();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect((await nextBeat()).deferred_conversations).toBe("1");

    vi.setSystemTime(Date.now() + DEFERRED_RETRY_TTL_MS + 60_000);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(relay.turns).toHaveLength(1);
    const running = await nextBeat();
    expect(running.adapter_state).toBe("turn_running");
    expect(running.deferred_conversations).toBe("0");
    expect(Date.parse(running.turn_deadline_at) - Date.parse(running.turn_started_at)).toBe(TURN_TIMEOUT_MS);
    expect(relay.turns[0].env[DEADLINE_ENV]).toBe(running.turn_deadline_at);

    relay.turns[0].fail(); // an overrun turn that could not start still ends the turn
    const idle = await nextBeat();
    expect(idle.adapter_state).toBe("idle");
    expect(turnKeysOf(idle)).toEqual(["adapter_state", "deferred_conversations"]);
  });

  it("ignores turn times left in its own environment: a looping process reports its loop, not an inherited value", async () => {
    vi.stubEnv(START_ENV, "2026-11-20T10:00:00.000Z");
    vi.stubEnv(DEADLINE_ENV, "2026-11-20T10:15:00.000Z");
    await startPlugin();
    const beat = await nextBeat();
    expect(beat.adapter_state).toBe("idle");
    expect(turnKeysOf(beat)).toEqual(["adapter_state", "deferred_conversations"]);
  });
});

describe("heartbeat turn state: no loop, no keys", () => {
  it("a process with the loop disabled by env and no turn times sends none of the keys", async () => {
    vi.stubEnv("EKHO_AUTOREPLY_DISABLE", "1");
    await startPlugin();
    const beat = await nextBeat();
    expect(turnKeysOf(beat)).toEqual([]);
    expect(beat).toEqual({ turn_health: "unknown", model_calls_1h: "0" });
  });

  it("a connection with no host api (no loop can start) sends none of the keys", async () => {
    vi.resetModules();
    const conn = await import("../src/connection");
    loaded.push(conn);
    await conn.ensureConnected(config() as never);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(relay.polls).toBe(0);
    expect(turnKeysOf(await nextBeat())).toEqual([]);
  });

  it("turn times in the environment of a process that is not a turn child (loop not disabled, no loop running) are ignored", async () => {
    vi.stubEnv(START_ENV, "2026-11-20T10:00:00.000Z");
    vi.stubEnv(DEADLINE_ENV, "2026-11-20T10:15:00.000Z");
    vi.resetModules();
    const conn = await import("../src/connection");
    loaded.push(conn);
    await conn.ensureConnected(config() as never);
    expect(turnKeysOf(await nextBeat())).toEqual([]);
  });

  it("while a rebind has stopped the loop the keys are gone, and they return with the new loop", async () => {
    const conn = await startPlugin();
    expect((await nextBeat()).adapter_state).toBe("idle");

    let rebound = false;
    void conn.rebindAutoReply(hostApi() as never, undefined, config() as never).then(() => {
      rebound = true;
    });
    // Synchronously after the call the old loop's handle is cleared and no new
    // loop exists yet: a beat built right now must not claim a loop.
    expect(rebound).toBe(false);
    relay.heartbeats.length = 0;
    vi.advanceTimersByTime(HEARTBEAT_MS); // timers only: the rebind's promise chain has not run
    expect(relay.heartbeats.length).toBeGreaterThan(0);
    expect(turnKeysOf(relay.heartbeats.at(-1)!)).toEqual([]);

    await vi.advanceTimersByTimeAsync(0);
    expect(rebound).toBe(true);
    expect(await nextBeat()).toMatchObject({ adapter_state: "idle", deferred_conversations: "0" });
  });

  it("after shutdown nothing beats at all", async () => {
    const conn = await startPlugin();
    expect((await nextBeat()).adapter_state).toBe("idle");
    await conn.shutdown("test stop");
    relay.heartbeats.length = 0;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(relay.heartbeats).toEqual([]);
  });
});

describe("heartbeat turn state: the turn child", () => {
  const START = "2026-11-20T10:00:00.000Z";
  const DEADLINE = "2026-11-20T10:15:00.000Z";

  async function childBeat(start: string | undefined, deadline: string | undefined) {
    vi.stubEnv("EKHO_AUTOREPLY_DISABLE", "1");
    vi.stubEnv(START_ENV, start ?? "");
    vi.stubEnv(DEADLINE_ENV, deadline ?? "");
    await startPlugin();
    return nextBeat();
  }

  it("reports turn_running with the two times its parent handed it, and no held count", async () => {
    expect(await childBeat(START, DEADLINE)).toEqual({
      turn_health: "unknown",
      model_calls_1h: "0",
      adapter_state: "turn_running",
      turn_started_at: START,
      turn_deadline_at: DEADLINE
    });
  });

  const broken: Array<[string, string | undefined, string | undefined]> = [
    ["the start is missing", undefined, DEADLINE],
    ["the deadline is missing", START, undefined],
    ["the start is not a time", "soon", DEADLINE],
    ["the deadline is not a time", START, "later"],
    ["the deadline is not after the start", DEADLINE, START]
  ];
  for (const [name, start, deadline] of broken) {
    it(`sends none of the keys when ${name}`, async () => {
      const beat = await childBeat(start, deadline);
      expect(turnKeysOf(beat)).toEqual([]);
      expect(beat).toEqual({ turn_health: "unknown", model_calls_1h: "0" });
    });
  }
});

describe("heartbeat turn state: a reader that throws", () => {
  it("never breaks the heartbeat: the beat still goes out with the existing keys and none of the turn keys", async () => {
    vi.doMock("../src/autoreply", async (original) => {
      const real = (await original()) as Record<string, unknown>;
      return {
        ...real,
        startAutoReply: (opts: { turnState?: (read: () => unknown) => void }) => {
          opts.turnState?.(() => {
            throw new Error("synthetic reader failure");
          });
          return () => Promise.resolve();
        }
      };
    });
    await startPlugin();
    const beat = await nextBeat();
    expect(beat).toEqual({ turn_health: "unknown", model_calls_1h: "0" });
    // And it keeps beating.
    expect(await nextBeat()).toEqual({ turn_health: "unknown", model_calls_1h: "0" });
  });
});

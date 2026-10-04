// A host hot reload (`openclaw plugins reload|update`) evaluates a FRESH copy
// of this plugin's module in the same gateway process. Before the fix each
// copy kept its own heartbeat setInterval and auto-reply poll forever, so every
// reload added another producer for the same agent. These tests load the real
// plugin entry (src/index.ts) twice in one process via vi.resetModules, against
// a stub relay client, and count who is still beating / polling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const relay = vi.hoisted(() => ({
  nextClient: 0,
  heartbeats: [] as Array<{ client: number; metrics: Record<string, string> }>,
  polls: [] as number[],
  // Set once the test has told the plugin to stop; relay calls note it.
  stopped: false,
  afterStop: [] as string[],
  // Overridable inbox; the default is an empty batch.
  inbox: null as null | (() => Promise<unknown>),
  floorFree: (conv: string) => conv !== "held-conv",
  spawnsAfterStop: 0
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: () => {
      if (relay.stopped) relay.spawnsAfterStop++;
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => {};
      setTimeout(() => child.emit("exit", 0), 0);
      return child;
    }
  };
});

// Stub relay: every client the plugin constructs gets a number, so a heartbeat
// or inbox poll can be traced to the module copy that sent it.
vi.mock("@drakon-systems/ekho-sdk", () => ({
  EkhoAgentClient: class {
    readonly n = ++relay.nextClient;
    async registerIdentityKey() {
      return {};
    }
    async heartbeat(payload: { metrics?: Record<string, string> }) {
      relay.heartbeats.push({ client: this.n, metrics: { ...(payload.metrics ?? {}) } });
      return {};
    }
    async getInbox() {
      relay.polls.push(this.n);
      return relay.inbox ? relay.inbox() : { messages: [] };
    }
    async ackMessages() {
      if (relay.stopped) relay.afterStop.push("ack");
      return {};
    }
    async acquireFloor(conv: string) {
      if (relay.stopped) relay.afterStop.push("acquire");
      return { granted: relay.floorFree(conv), holder_agent_id: "other" };
    }
    async releaseFloor() {
      return {};
    }
    async raiseNotice() {
      return {};
    }
  }
}));

const HEARTBEAT_MS = 1_000;
const POLL_MS = 5_000; // startAutoReply's default

type Plugin = { register: (api: unknown) => void };
type Conn = typeof import("../src/connection");
interface Loaded {
  plugin: Plugin;
  conn: Conn;
}

const scratch: string[] = [];
const loaded: Loaded[] = [];
let stateDir = "";

function mkScratch(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `ekho-reload-${tag}-`));
  scratch.push(d);
  return d;
}

/** One host "load": a fresh module graph, as a reload's new generation dir gives. */
async function loadPluginCopy(): Promise<Loaded> {
  vi.resetModules();
  const plugin = (await import("../src/index")).default as unknown as Plugin;
  // Same fresh graph as the index import above — the copy's own connection state.
  const conn = await import("../src/connection");
  const l = { plugin, conn };
  loaded.push(l);
  return l;
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** A fake host api. `signals` adds OpenClaw's unload surfaces (on + lifecycle). */
function fakeApi(signals: boolean, pluginConfig: Record<string, unknown> = defaultConfig()) {
  const disposers: Array<() => unknown> = [];
  const hooks = new Map<string, Array<(event: unknown) => unknown>>();
  const api: Record<string, unknown> = {
    pluginConfig,
    logger: logger()
  };
  if (signals) {
    api.on = (name: string, handler: (event: unknown) => unknown) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    };
    api.lifecycle = {
      signal: new AbortController().signal,
      onDispose: (fn: () => unknown) => {
        disposers.push(fn);
        return () => {};
      }
    };
  }
  return {
    api,
    log: api.logger as ReturnType<typeof logger>,
    // What the host gets back from each callback (OpenClaw awaits them).
    dispose: () => disposers.map((d) => d()),
    fire: (name: string, event: unknown) => (hooks.get(name) ?? []).map((h) => h(event))
  };
}

function defaultConfig(): Record<string, unknown> {
  return {
    relayBaseUrl: "http://relay.invalid",
    agentId: "agent_reload",
    agentSecret: "s3cret",
    heartbeatIntervalMs: HEARTBEAT_MS,
    allowNewIdentity: true,
    stateDir
  };
}

/** A config with no credentials yet: the first connect spends the token. */
function enrolConfig(): Record<string, unknown> {
  return {
    relayBaseUrl: "http://relay.invalid",
    fleetId: "fleet_reload",
    enrollmentToken: "single-use-token",
    heartbeatIntervalMs: HEARTBEAT_MS,
    stateDir
  };
}

function deadLetters(): Array<{ reason: string; message: { message_id: string } }> {
  const f = join(stateDir, ".ekho-dead-letter.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * A stub /v1/enroll with the relay's single-use token: the first call is held
 * until `release()`, then succeeds; any later call is refused with 400
 * (packages/relay/src/routes-agent.ts).
 */
function stubEnrolment() {
  const enrol = { calls: 0, release: () => {} };
  const held = new Promise<void>((r) => {
    enrol.release = r;
  });
  vi.stubGlobal("fetch", async (url: string) => {
    if (new URL(url).pathname !== "/v1/enroll") return Response.json({});
    enrol.calls++;
    if (enrol.calls > 1) return Response.json({ error: "invalid or expired token" }, { status: 400 });
    await held;
    return Response.json({ agent_id: "agent_enrolled", secret: "fresh-secret" });
  });
  return enrol;
}

/**
 * Wait for register()'s fire-and-forget startup connect. ensureConnected joins
 * the in-flight connect (or returns the copy's cached connection) — it never
 * connects twice — so awaiting it is awaiting the startup connect itself.
 */
async function untilConnected(conn: Conn) {
  await conn.ensureConnected(fakeApi(false).api.pluginConfig as never);
  await vi.advanceTimersByTimeAsync(0);
}

/** Producers seen over `ms` of fake time: client numbers that beat / polled. */
async function producersOver(ms: number) {
  relay.heartbeats.length = 0;
  relay.polls.length = 0;
  await vi.advanceTimersByTimeAsync(ms);
  return {
    heartbeat: [...new Set(relay.heartbeats.map((h) => h.client))],
    poll: [...new Set(relay.polls)],
    beats: relay.heartbeats.length
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  relay.nextClient = 0;
  relay.heartbeats.length = 0;
  relay.polls.length = 0;
  relay.stopped = false;
  relay.afterStop.length = 0;
  relay.inbox = null;
  relay.spawnsAfterStop = 0;
  // LEGACY_EKHO_DIR is read from HOME at import: keep every copy off the real home.
  vi.stubEnv("HOME", mkScratch("home"));
  vi.stubEnv("EKHO_AUTOREPLY_DISABLE", "");
  stateDir = join(mkScratch("state"), "ekho-adapter");
});

afterEach(() => {
  for (const l of loaded) l.conn.shutdown("test teardown");
  loaded.length = 0;
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekho-adapter.runtime")];
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  scratch.length = 0;
});

describe("plugin reload in one process", () => {
  it("a second load leaves exactly one heartbeat producer and one inbox poller (host sends no unload signal)", async () => {
    const a = await loadPluginCopy();
    const hostA = fakeApi(false);
    a.plugin.register(hostA.api);
    await untilConnected(a.conn);
    const first = await producersOver(POLL_MS * 2);
    expect(first.heartbeat).toEqual([1]);
    expect(first.poll).toEqual([1]);

    const b = await loadPluginCopy();
    const hostB = fakeApi(false);
    b.plugin.register(hostB.api);
    await untilConnected(b.conn);
    expect(b.conn.runtimeGeneration()).toBeGreaterThan(a.conn.runtimeGeneration());

    const after = await producersOver(POLL_MS * 4);
    // Only the new copy's client (2) — the old copy's timers were handed off.
    expect(after.heartbeat).toEqual([2]);
    expect(after.poll).toEqual([2]);
    expect(after.beats).toBe((POLL_MS * 4) / HEARTBEAT_MS);
    expect(hostA.log.info.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /stopped heartbeat and auto-reply \(superseded by generation/
    );
  });

  it("an OLDER copy that finishes connecting after a newer one stands down instead of stopping it", async () => {
    const a = await loadPluginCopy(); // generation n
    const b = await loadPluginCopy(); // generation n+1
    const hostB = fakeApi(false);
    b.plugin.register(hostB.api);
    await untilConnected(b.conn);

    const hostA = fakeApi(false);
    a.plugin.register(hostA.api); // the stale copy connects last
    await untilConnected(a.conn);

    const after = await producersOver(POLL_MS * 2);
    expect(after.heartbeat).toEqual([1]); // b's client was constructed first
    expect(after.poll).toEqual([1]);
    expect(hostA.log.info.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/is superseded for agent_reload/);
  });

  it("the host's dispose signal stops the heartbeat and the poll loop", async () => {
    const a = await loadPluginCopy();
    const host = fakeApi(true);
    a.plugin.register(host.api);
    await untilConnected(a.conn);
    expect((await producersOver(POLL_MS)).beats).toBeGreaterThan(0);

    host.dispose();
    const after = await producersOver(POLL_MS * 4);
    expect(after).toEqual({ heartbeat: [], poll: [], beats: 0 });
  });

  it("gateway_stop (OpenClaw's 'plugin replacement' signal) stops everything too", async () => {
    const a = await loadPluginCopy();
    const host = fakeApi(true);
    a.plugin.register(host.api);
    await untilConnected(a.conn);

    host.fire("gateway_stop", { reason: "plugin replacement" });
    expect(await producersOver(POLL_MS * 4)).toEqual({ heartbeat: [], poll: [], beats: 0 });
    expect(host.log.info.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /gateway_stop: plugin replacement/
    );
    // A straggling tool call on the stopped copy still gets a client, but
    // restarts nothing: that would put a second producer beside the new copy.
    await a.conn.ensureConnected(host.api.pluginConfig as never, undefined, host.api as never);
    expect(await producersOver(POLL_MS * 2)).toEqual({ heartbeat: [], poll: [], beats: 0 });
  });

  it("logs the unload and model_call hook routes at info, once per load", async () => {
    const a = await loadPluginCopy();
    const host = fakeApi(true);
    a.plugin.register(host.api);
    const info = host.log.info.mock.calls.map((c) => String(c[0]));
    expect(info.filter((l) => l.includes("model_call hooks:"))).toEqual(["[ekho-adapter] model_call hooks: typed"]);
    expect(info.filter((l) => l.includes("unload hooks:"))).toEqual([
      "[ekho-adapter] unload hooks: lifecycle.onDispose, gateway_stop"
    ]);

    const b = await loadPluginCopy();
    const bare = fakeApi(false);
    b.plugin.register(bare.api);
    const bareInfo = bare.log.info.mock.calls.map((c) => String(c[0]));
    expect(bareInfo).toContain("[ekho-adapter] model_call hooks: none");
    expect(bareInfo.some((l) => l.includes("unload hooks: none"))).toBe(true);
  });

  it("heartbeats turn_health 'unknown' with model_calls_1h 0 when no model call was recorded", async () => {
    const a = await loadPluginCopy();
    a.plugin.register(fakeApi(false).api);
    await untilConnected(a.conn);
    expect(relay.heartbeats[0].metrics).toMatchObject({ turn_health: "unknown", model_calls_1h: "0" });
  });
});

// PR #102 review, blocker 1, through the real plugin entry and both of
// OpenClaw's unload routes: a held (acked, deferred) message is on disk before
// the hook's promise is even awaited, and a poll still in flight at stop
// brings nothing that gets acked or turned.
describe("unload with work in flight", () => {
  const routes: Array<[string, (host: ReturnType<typeof fakeApi>) => unknown[]]> = [
    // Real gateway shutdown: OpenClaw's reason (src/gateway/server-start.ts:132).
    ["gateway_stop (gateway stopping)", (h) => h.fire("gateway_stop", { reason: "gateway stopping" })],
    ["gateway_stop (plugin replacement)", (h) => h.fire("gateway_stop", { reason: "plugin replacement" })],
    ["lifecycle.onDispose", (h) => h.dispose()]
  ];
  for (const [route, unload] of routes) {
    it(`${route}: secures the held message before returning and processes nothing afterwards`, async () => {
      let pending: (batch: unknown) => void = () => {};
      let served = 0;
      relay.inbox = () => {
        served++;
        if (served === 1) {
          return Promise.resolve({
            messages: [
              {
                message_id: "held",
                conversation_id: "held-conv",
                sender_agent_id: "peer",
                sender_kind: "agent",
                message_type: "direct",
                body: { text: "held for the floor holder" }
              }
            ],
            peer_autoreply: true
          });
        }
        return new Promise((r) => {
          pending = r;
        });
      };
      const a = await loadPluginCopy();
      const host = fakeApi(true);
      a.plugin.register(host.api);
      await untilConnected(a.conn);
      await vi.advanceTimersByTimeAsync(POLL_MS * 2); // tick 1 stashes, tick 2 polls
      expect(served).toBe(2);
      expect(deadLetters()).toEqual([]);

      relay.stopped = true;
      const results = unload(host);
      // The host awaits a promise, and the acked message is already on disk.
      expect(results.length).toBe(1);
      expect(results[0]).toBeInstanceOf(Promise);
      expect(deadLetters().map((r) => [r.message.message_id, r.reason])).toEqual([
        ["held", "deferred_loop_stopped"]
      ]);

      let drained = false;
      void (results[0] as Promise<void>).then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false); // still waiting on the poll in flight
      pending({
        messages: [
          {
            message_id: "late",
            conversation_id: "free-conv",
            sender_agent_id: "peer",
            sender_kind: "agent",
            message_type: "direct",
            body: { text: "arrived after stop" }
          }
        ],
        peer_autoreply: true
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(true);
      expect(relay.afterStop).toEqual([]);
      expect(relay.spawnsAfterStop).toBe(0);
      expect(deadLetters()).toHaveLength(1);
      expect(await producersOver(POLL_MS * 4)).toEqual({ heartbeat: [], poll: [], beats: 0 });
    });
  }
});

// PR #102 review, blocker 2: the agent id that keys the producer claim only
// exists once enrolment succeeds, and the token is single-use. Seeded from the
// reviewer's probe (astra-pr102-enroll-probe.mjs): before the fix a reload
// mid-enrolment left NO producer — the new copy spent the token again (400)
// and the old copy, retired, rightly started nothing.
describe("reload during first enrolment", () => {
  it("the new copy waits for the old copy's enrolment and becomes the one producer (probe)", async () => {
    const enrol = stubEnrolment();
    const a = await loadPluginCopy();
    const hostA = fakeApi(true, enrolConfig());
    a.plugin.register(hostA.api);
    await vi.advanceTimersByTimeAsync(0);
    expect(enrol.calls).toBe(1); // A has spent the token; its response is delayed

    hostA.fire("gateway_stop", { reason: "plugin replacement" });
    hostA.dispose();

    const b = await loadPluginCopy();
    const hostB = fakeApi(true, enrolConfig());
    b.plugin.register(hostB.api);
    await vi.advanceTimersByTimeAsync(0);
    expect(enrol.calls).toBe(1); // B queued behind A instead of re-enrolling

    enrol.release();
    await vi.advanceTimersByTimeAsync(0);
    const conn = await b.conn.ensureConnected(enrolConfig() as never);
    expect(conn.credentials.agentId).toBe("agent_enrolled");

    const after = await producersOver(POLL_MS * 2);
    expect(enrol.calls).toBe(1);
    expect(after.heartbeat).toHaveLength(1);
    expect(after.poll).toEqual(after.heartbeat);
    expect(after.beats).toBe((POLL_MS * 2) / HEARTBEAT_MS);
    expect(hostB.log.warn).not.toHaveBeenCalledWith(expect.stringMatching(/startup connect failed/));
  });

  it("two copies enrolling concurrently (no host signal): one enrol call, one producer", async () => {
    const enrol = stubEnrolment();
    const a = await loadPluginCopy();
    a.plugin.register(fakeApi(false, enrolConfig()).api);
    const b = await loadPluginCopy();
    const hostB = fakeApi(false, enrolConfig());
    b.plugin.register(hostB.api);
    await vi.advanceTimersByTimeAsync(0);
    expect(enrol.calls).toBe(1);

    enrol.release();
    await vi.advanceTimersByTimeAsync(0);
    await a.conn.ensureConnected(enrolConfig() as never);
    await b.conn.ensureConnected(enrolConfig() as never);

    const after = await producersOver(POLL_MS * 2);
    expect(enrol.calls).toBe(1);
    // A connected first (client 1) and was superseded by B (client 2).
    expect(after.heartbeat).toEqual([2]);
    expect(after.poll).toEqual([2]);
    expect(hostB.log.warn).not.toHaveBeenCalledWith(expect.stringMatching(/startup connect failed/));
  });

  it("a 400 on a spent token re-checks once for credentials saved meanwhile", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new URL(url).pathname === "/v1/enroll"
        ? Response.json({ error: "invalid or expired token" }, { status: 400 })
        : Response.json({})
    );
    const a = await loadPluginCopy();
    const host = fakeApi(false, enrolConfig());
    a.plugin.register(host.api);
    await vi.advanceTimersByTimeAsync(0);
    // Whoever spent the token (outside this process's registry) saves now.
    const { saveCredentials } = await import("../src/credentials");
    saveCredentials(stateDir, {
      agentId: "agent_elsewhere",
      secret: "s",
      relayBaseUrl: "http://relay.invalid",
      fleetId: "fleet_reload"
    });
    await vi.advanceTimersByTimeAsync(a.conn.ENROL_RECHECK_MS);
    const conn = await a.conn.ensureConnected(enrolConfig() as never);
    expect(conn.credentials.agentId).toBe("agent_elsewhere");
    expect((await producersOver(POLL_MS)).heartbeat).toEqual([1]);
    expect(host.log.warn).not.toHaveBeenCalledWith(expect.stringMatching(/startup connect failed/));
  });
});

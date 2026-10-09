// A host hot reload (`openclaw plugins reload|update`) evaluates a FRESH copy
// of this plugin's module in the same gateway process. Before the fix each
// copy kept its own heartbeat setInterval and auto-reply poll forever, so every
// reload added another producer for the same agent. These tests load the real
// plugin entry (src/index.ts) twice in one process via vi.resetModules, against
// a stub relay client, and count who is still beating / polling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFERRED_RETRY_TTL_MS, STOP_DRAIN_MS } from "../src/autoreply";

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
  spawnsAfterStop: 0,
  // Every spawned turn's prompt (#111), and turns held until the test fails them.
  prompts: [] as string[],
  failNextSpawns: 0,
  heldFailures: [] as Array<() => void>,
  notices: [] as unknown[]
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: (_cmd: string, args: string[] = []) => {
      if (relay.stopped) relay.spawnsAfterStop++;
      relay.prompts.push(String(args[args.length - 1] ?? ""));
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => {};
      if (relay.failNextSpawns > 0) {
        // Held until the test lets it fail: a turn whose spawn is undecided.
        relay.failNextSpawns--;
        relay.heldFailures.push(() => child.emit("error", new Error("synthetic spawn failure")));
      } else {
        setTimeout(() => child.emit("exit", 0), 0);
      }
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
    async downloadAttachment() { return { bytes: Buffer.from("ok") }; }
    async acquireFloor(conv: string) {
      if (relay.stopped) relay.afterStop.push("acquire");
      return { granted: relay.floorFree(conv), holder_agent_id: "other" };
    }
    async releaseFloor() {
      return {};
    }
    async raiseNotice(notice: unknown) {
      relay.notices.push(notice);
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
  const registered = new Map<string, { execute: (id: string, params: unknown) => Promise<{ details: any }> }>();
  const hooks = new Map<string, Array<(event: unknown) => unknown>>();
  const api: Record<string, unknown> = {
    pluginConfig,
    logger: logger(),
    registerTool: (tool: { name?: string }, opts?: { name?: string }) => {
      if (tool.name) registered.set(tool.name, tool as never);
      else if (opts?.name) registered.set(opts.name, tool as never);
    }
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
    inbox: async () => (await registered.get("ekho_inbox")!.execute("test", {})).details,
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
  relay.floorFree = (conv: string) => conv !== "held-conv";
  relay.prompts.length = 0;
  relay.failNextSpawns = 0;
  relay.heldFailures.length = 0;
  relay.notices.length = 0;
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
  it("registered inbox isolates transport-distinct base paths", async () => {
    const edge = { ...defaultConfig(), relayBaseUrl: "http://relay.invalid/edge" };
    const a = await loadPluginCopy();
    const hostA = fakeApi(false, edge);
    a.plugin.register(hostA.api);
    await a.conn.ensureConnected(edge as never);
    const cache = await import("../src/autoreply");
    cache.recordBatch({ messages: [{ message_id: "edge", conversation_id: "c", sender_agent_id: "peer", message_type: "direct", body: { text: "edge" } }] }, {}, "agent_reload", a.conn.connectedInboxContext(await a.conn.ensureConnected(edge as never)));
    expect((await hostA.inbox()).count).toBe(1);
    const slash = { ...edge, relayBaseUrl: "http://relay.invalid/edge/" };
    const b = await loadPluginCopy();
    const hostB = fakeApi(false, slash);
    b.plugin.register(hostB.api);
    await b.conn.ensureConnected(slash as never);
    expect(await hostB.inbox()).toMatchObject({ count: 0, verification_generation: "unavailable" });
  });
  it("registered inbox shares only the matching trust context and retains rejected material", async () => {
    const a = await loadPluginCopy();
    const hostA = fakeApi(false);
    a.plugin.register(hostA.api);
    await untilConnected(a.conn);
    const cacheA = await import("../src/autoreply");
    const connectionA = await a.conn.ensureConnected(defaultConfig() as never);
    const contextA = a.conn.connectedInboxContext(connectionA);
    const message = { message_id: "rejected", conversation_id: "room", sender_agent_id: "operator", sender_kind: "operator", message_type: "room", body: { text: "do this" } };
    cacheA.recordBatch({ messages: [message], roster: [{ agent_id: "peer", status: "healthy" }], operator_trusted: true }, {}, "agent_reload", contextA);
    cacheA.recordVerifications({ rejected: { verified: false, kind: "operator", reason: "invalid-signature", keyId: "old" } }, [], [message], "agent_reload", contextA);
    expect((await hostA.inbox()).messages[0].signature.status).toBe("failed");

    const b = await loadPluginCopy();
    const hostB = fakeApi(false);
    b.plugin.register(hostB.api);
    await untilConnected(b.conn);
    expect((await hostB.inbox()).count).toBe(1);
    expect((await hostB.inbox()).roster).toHaveLength(1);
    b.conn.getEkhoIdentity()!.pinnedOperatorKeys.changed = "different-public-key";
    const isolated = await hostB.inbox();
    expect(isolated).toMatchObject({ count: 1, verification_generation: "stale", degraded: true });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect((await hostB.inbox()).count).toBe(0);
    const cacheB = await import("../src/autoreply");
    const connectionB = await b.conn.ensureConnected(defaultConfig() as never);
    const contextB = b.conn.connectedInboxContext(connectionB);
    cacheB.recordBatch({ messages: [message], operator_trusted: true }, {}, "agent_reload", contextB);
    cacheB.recordVerifications({ rejected: { verified: true, kind: "operator", reason: null, keyId: "new" } }, [], [message], "agent_reload", contextB);
    expect((await hostB.inbox()).messages[0].signature.status).toBe("failed");

    const c = await loadPluginCopy();
    const alternate = { ...defaultConfig(), relayBaseUrl: "http://another-relay.invalid/fleet?ignored=1" };
    const hostC = fakeApi(false, alternate);
    c.plugin.register(hostC.api);
    await c.conn.ensureConnected(alternate as never);
    expect(await hostC.inbox()).toMatchObject({ count: 0, roster: [], operator_trusted: false, roster_fetched_at: null });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect((await hostC.inbox()).count).toBe(0);
  });

  it("registered inbox reports the new producer's latch after a quiet poll", async () => {
    const a = await loadPluginCopy();
    const hostA = fakeApi(false);
    a.plugin.register(hostA.api);
    await untilConnected(a.conn);
    const cacheA = await import("../src/autoreply");
    const context = a.conn.connectedInboxContext(await a.conn.ensureConnected(defaultConfig() as never));
    cacheA.recordBatch({ messages: [], peer_autoreply: true, peer_turn_budget: 1 }, {}, "agent_reload", context);
    cacheA.recordPeerUsage(new Map([["room", 1]]), "agent_reload", context);
    expect(cacheA.getCachedInbox("agent_reload", context).peer_turns_used.room).toBe(1);
    const b = await loadPluginCopy();
    const hostB = fakeApi(false);
    b.plugin.register(hostB.api);
    await untilConnected(b.conn);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const result = await hostB.inbox();
    expect(result.count).toBe(0);
    expect((await import("../src/autoreply")).getCachedInbox("agent_reload", context).peer_turns_used).toEqual({});
  });

  it("serves the producer's synced generation to both retained and new tools", async () => {
    const a = await loadPluginCopy();
    const hostA = fakeApi(false);
    a.plugin.register(hostA.api);
    await untilConnected(a.conn);
    const oldContext = a.conn.connectedInboxContext(await a.conn.ensureConnected(defaultConfig() as never));
    const oldCache = await import("../src/autoreply");
    oldCache.recordBatch({ messages: [{ message_id: "old", conversation_id: "c", sender_agent_id: "op", sender_kind: "operator", message_type: "direct", body: { text: "old" } }] }, {}, "agent_reload", oldContext);
    oldCache.recordVerifications({ old: { verified: true, kind: "operator", reason: null, keyId: "old" } }, [], undefined, "agent_reload", oldContext);

    const b = await loadPluginCopy();
    const hostB = fakeApi(false);
    b.plugin.register(hostB.api);
    await untilConnected(b.conn);
    relay.inbox = async () => ({
      fleet_id: "fleet_reload", operator_keys: [{ key_id: "new", public_key: "new-public-key" }],
      messages: [{ message_id: "new", conversation_id: "room", sender_agent_id: "peer", sender_kind: "agent", message_type: "room", body: { text: "evidence" }, attachments: [{ id: "att", filename: "evidence.txt", mime: "text/plain", size_bytes: 2 }] }],
      roster: [{ agent_id: "peer", status: "healthy" }], operator_trusted: true
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const newer = await hostB.inbox();
    const retained = await hostA.inbox();
    expect(newer).toMatchObject({ count: 1, verification_generation: "current", degraded: false, operator_trusted: true });
    expect(retained).toMatchObject({ count: 1, verification_generation: "stale", degraded: true, operator_trusted: true });
    expect(retained.messages[0].body).toEqual({ text: "evidence" });
    expect(retained.messages[0].signature.status).not.toBe("verified");
    expect(retained.roster).toHaveLength(1);
    expect(retained.messages[0].attachments).toHaveLength(1);
    const different = { ...defaultConfig(), relayBaseUrl: "http://other.invalid" };
    const c = await loadPluginCopy();
    const hostC = fakeApi(false, different);
    c.plugin.register(hostC.api);
    await c.conn.ensureConnected(different as never);
    expect(await hostC.inbox()).toMatchObject({ count: 0, verification_generation: "unavailable" });
  });

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

  // PR #102 r3 review (astra-pr102-r3-shutdown-logger-probe.mjs): shutdown()'s
  // own "stopped heartbeat" line ran unguarded after the work was secured, so a
  // throwing host logger made the unload callback throw instead of handing the
  // host the drain promise.
  it("a throwing host logger still gets the host the drain promise, with the work already secured", async () => {
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
      return new Promise(() => {}); // in flight at stop, never answers
    };
    const a = await loadPluginCopy();
    const host = fakeApi(true);
    a.plugin.register(host.api);
    await untilConnected(a.conn);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(served).toBe(2);

    const down = () => {
      throw new Error("logger down");
    };
    host.log.info.mockImplementation(down);
    host.log.warn.mockImplementation(down);
    host.log.error.mockImplementation(down);
    host.log.debug.mockImplementation(down);
    relay.stopped = true;
    let results: unknown[] = [];
    expect(() => {
      results = host.dispose();
    }).not.toThrow();
    expect(results[0]).toBeInstanceOf(Promise);
    expect(deadLetters().map((r) => [r.message.message_id, r.reason])).toEqual([
      ["held", "deferred_loop_stopped"]
    ]);
    // The same drain a repeat stop hands out, not a second one.
    expect(a.conn.shutdown("again", host.api.logger as never)).toBe(results[0]);

    let outcome: string | undefined;
    void (results[0] as Promise<void>).then(
      () => (outcome = "resolved"),
      () => (outcome = "rejected")
    );
    await vi.advanceTimersByTimeAsync(STOP_DRAIN_MS);
    expect(outcome).toBe("resolved");
    expect(deadLetters()).toHaveLength(1);
    expect(relay.afterStop).toEqual([]);
    expect(await producersOver(POLL_MS * 4)).toEqual({ heartbeat: [], poll: [], beats: 0 });
  });
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

  it("an enrolment request that never answers is abandoned at its deadline and frees the queued successor", async () => {
    // PR #102 round-2 review nit: the lock is held until fn settles, and the
    // enrol fetch had no deadline — a request that never answered held every
    // same-key successor forever. The stub never answers but honours abort.
    const enrol = { calls: 0, aborted: 0 };
    vi.stubGlobal("fetch", async (url: string, init?: { signal?: AbortSignal }) => {
      if (new URL(url).pathname !== "/v1/enroll") return Response.json({});
      enrol.calls++;
      if (enrol.calls > 1) return Response.json({ agent_id: "agent_enrolled", secret: "fresh-secret" });
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          enrol.aborted++;
          reject(init.signal!.reason);
        });
      });
    });
    const { ENROLL_TIMEOUT_MS } = await import("../src/credentials");
    const a = await loadPluginCopy();
    const hostA = fakeApi(true, enrolConfig());
    a.plugin.register(hostA.api);
    await vi.advanceTimersByTimeAsync(0);
    expect(enrol.calls).toBe(1);
    hostA.fire("gateway_stop", { reason: "plugin replacement" });
    hostA.dispose();

    const b = await loadPluginCopy();
    const hostB = fakeApi(true, enrolConfig());
    b.plugin.register(hostB.api);
    await vi.advanceTimersByTimeAsync(ENROLL_TIMEOUT_MS - 1);
    expect(enrol.calls).toBe(1); // B still queued: never two enrolments at once
    expect(enrol.aborted).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(enrol.aborted).toBe(1);
    const conn = await b.conn.ensureConnected(enrolConfig() as never);
    expect(conn.credentials.agentId).toBe("agent_enrolled");
    expect(enrol.calls).toBe(2);
    expect((await producersOver(POLL_MS)).heartbeat).toHaveLength(1);
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

// #111: a reload is a stop followed, seconds later, by a successor in the SAME
// process. The stop still writes its 0.6.0 dead-letter record; it also leaves
// the acked work in memory for that successor, which re-admits it under its
// own trust root, policy, deadline and floor. Through the real plugin entry,
// two (or more) module copies, the real registry and the real loop.
describe("reload hand-off of held work (#111)", () => {
  const FLEET = "fleet_reload";
  const hourAhead = () => new Date(Date.now() + 3_600_000).toISOString();

  function heldPeer(id: string, over: Record<string, unknown> = {}): any {
    return {
      message_id: id,
      conversation_id: "held-conv",
      sender_agent_id: "peer",
      sender_kind: "agent",
      message_type: "direct",
      body: { text: `held text ${id}` },
      deadline_at: hourAhead(),
      ...over
    };
  }

  /** Serve these batches in order to whichever copy polls, then `rest` forever. */
  function serve(batches: unknown[], rest: unknown = { messages: [] }) {
    let i = 0;
    relay.inbox = async () => (i < batches.length ? batches[i++] : rest);
  }

  async function startCopy(config: Record<string, unknown> = defaultConfig()) {
    const copy = await loadPluginCopy();
    const host = fakeApi(true, config);
    copy.plugin.register(host.api);
    await untilConnected(copy.conn);
    return { ...copy, host, config };
  }

  const poll = (n = 1) => vi.advanceTimersByTimeAsync(POLL_MS * n);
  const records = () =>
    deadLetters().map((r) => [(r.message as { message_id?: string } | null)?.message_id ?? null, r.reason]);
  const warned = (host: ReturnType<typeof fakeApi>) => host.log.warn.mock.calls.map((c) => String(c[0])).join("\n");
  const registry = () => import("../src/runtime-registry");

  async function operatorKey(seedByte: number) {
    const { publicKeyB64urlFromSeed, keyId } = await import("../src/identity");
    const seed = new Uint8Array(32).fill(seedByte);
    const pub = publicKeyB64urlFromSeed(seed);
    return { seed, pub, kid: keyId(Buffer.from(pub, "base64url")) };
  }

  /** An operator message signed by `key`, addressed to this agent unless overridden. */
  async function signedOperator(id: string, key: { seed: Uint8Array; kid: string }, over: { recipient?: unknown; text?: string } = {}) {
    const { signCanonical, sha256Hex } = await import("../src/identity");
    const text = over.text ?? `signed text ${id}`;
    const canonical = {
      v: 1,
      fleet_id: FLEET,
      operator_id: "op",
      key_id: key.kid,
      recipient: over.recipient ?? { kind: "agent", id: "agent_reload" },
      conversation_id: "held-conv",
      body_sha256: sha256Hex(text),
      sent_at: new Date().toISOString(),
      nonce: `nonce-${id}`
    };
    return {
      message_id: id,
      conversation_id: "held-conv",
      sender_kind: "operator",
      sender_agent_id: "op",
      message_type: "direct",
      body: { text },
      operator_sig: signCanonical(canonical, key.seed),
      agent_sig: null,
      key_id: key.kid,
      sig_canonical: canonical,
      deadline_at: hourAhead()
    } as any;
  }

  it("a held message inside its deadline is delivered exactly once by the successor, under the floor", async () => {
    serve([{ messages: [heldPeer("m1")], peer_autoreply: true }]);
    const a = await startCopy();
    await poll(); // floor held by another agent: deferred and stashed
    expect(relay.prompts).toEqual([]);

    a.host.fire("gateway_stop", { reason: "plugin replacement" });
    // The 0.6.0 forensic write is unchanged and still happens before the hook returns.
    expect(records()).toEqual([["m1", "deferred_loop_stopped"]]);
    expect(warned(a.host)).toMatch(/left them for a same-process successor to re-admit/);

    relay.floorFree = () => true;
    const b = await startCopy();
    expect(b.conn.runtimeGeneration()).toBeGreaterThan(a.conn.runtimeGeneration());
    await poll();
    expect(relay.prompts).toHaveLength(1);
    expect(relay.prompts[0]).toContain("held text m1");
    expect(relay.prompts[0]).toContain("THIS TURN WAS HELD BACK");

    await poll(3);
    expect(relay.prompts).toHaveLength(1);
    expect(records()).toEqual([
      ["m1", "deferred_loop_stopped"],
      ["m1", "reload_readmitted"]
    ]);
    expect((await registry()).reloadHandoffCount("agent_reload")).toBe(0);
    // Nothing was sent anywhere on the message's behalf.
    expect(relay.notices).toEqual([]);
  });

  it("a signed held message verifies afresh under an unchanged trust root and is delivered as verified", async () => {
    const op = await operatorKey(7);
    const cfg = { ...defaultConfig(), operatorPubkey: op.pub };
    serve(
      [{ messages: [heldPeer("p1"), await signedOperator("o1", op)], fleet_id: FLEET, peer_autoreply: true }],
      { messages: [], fleet_id: FLEET }
    );
    const a = await startCopy(cfg);
    await poll();
    a.host.fire("gateway_stop", { reason: "plugin replacement" });

    relay.floorFree = () => true;
    await startCopy(cfg);
    await poll(3);
    expect(relay.prompts).toHaveLength(1);
    const prompt = relay.prompts[0];
    const head = prompt.slice(0, prompt.indexOf("signed text o1"));
    expect(head.slice(head.lastIndexOf("• From"))).toContain("CRYPTOGRAPHICALLY VERIFIED");
    expect(prompt).toContain("held text p1");
  });

  it("an expired, missing or unparseable deadline is withheld with an explicit record; no turn, nobody notified", async () => {
    serve([
      {
        messages: [
          heldPeer("late", { deadline_at: new Date(Date.now() + 60_000).toISOString() }),
          heldPeer("nodl", { deadline_at: undefined }),
          heldPeer("junk", { deadline_at: "not a date" })
        ],
        peer_autoreply: true
      }
    ]);
    const a = await startCopy();
    await poll();
    a.host.fire("gateway_stop", { reason: "plugin replacement" });
    vi.setSystemTime(Date.now() + 120_000); // the reload took long enough for one to expire

    relay.floorFree = () => true;
    const b = await startCopy();
    await poll(3);
    expect(relay.prompts).toEqual([]);
    expect(records().filter(([, r]) => String(r).startsWith("reload_"))).toEqual([
      ["late", "reload_withheld:expired"],
      ["nodl", "reload_withheld:no_deadline"],
      ["junk", "reload_withheld:no_deadline"]
    ]);
    expect(warned(b.host)).toMatch(/withheld 3 acked msg\(s\).*neither the sender nor the operator console is told/);
    expect(relay.notices).toEqual([]);
  });

  it("a second reload before servicing carries the work on once; after delivery a reload finds nothing", async () => {
    serve([{ messages: [heldPeer("m1")], peer_autoreply: true }]);
    const a = await startCopy();
    await poll();
    a.host.fire("gateway_stop", { reason: "plugin replacement" });

    const b = await startCopy(); // the floor is still held: B re-admits and waits
    await poll(2);
    expect(relay.prompts).toEqual([]);
    b.host.fire("gateway_stop", { reason: "plugin replacement" });

    relay.floorFree = () => true;
    const c = await startCopy();
    await poll(4);
    expect(relay.prompts).toHaveLength(1);
    expect(records()).toEqual([
      ["m1", "deferred_loop_stopped"],
      ["m1", "reload_readmitted"],
      ["m1", "deferred_loop_stopped"],
      ["m1", "reload_readmitted"]
    ]);

    // Delivered: the stash is gone, so the next stop leaves nothing behind.
    c.host.fire("gateway_stop", { reason: "plugin replacement" });
    expect((await registry()).reloadHandoffCount("agent_reload")).toBe(0);
    await startCopy();
    await poll(3);
    expect(relay.prompts).toHaveLength(1);
    expect(records()).toHaveLength(4);
  });

  it("a predecessor's late flush (its covering turn failed after stop) is taken by the successor's next tick, once", async () => {
    serve([
      { messages: [heldPeer("m1")], peer_autoreply: true },
      {
        messages: [
          { message_id: "op1", conversation_id: "held-conv", sender_agent_id: "op", sender_kind: "operator", message_type: "direct", body: { text: "operator nudge" } }
        ],
        operator_trusted: true
      }
    ]);
    const a = await startCopy();
    await poll(); // m1 stashed
    relay.failNextSpawns = 1;
    await poll(); // the operator message's turn covers the stash; its spawn is undecided
    expect(relay.prompts).toHaveLength(1);
    a.host.fire("gateway_stop", { reason: "plugin replacement" });
    expect(records()).toEqual([]); // the covering turn still owns the stash

    relay.floorFree = () => true;
    const b = await startCopy();
    await poll();
    expect(relay.prompts).toHaveLength(1); // nothing to take yet

    relay.heldFailures.shift()!(); // A's spawn fails after A was retired
    await vi.advanceTimersByTimeAsync(0);
    expect(records()).toEqual([["m1", "deferred_loop_stopped"]]);

    await poll(3);
    expect(relay.prompts).toHaveLength(2);
    expect(relay.prompts[1]).toContain("held text m1");
    expect(records()).toEqual([
      ["m1", "deferred_loop_stopped"],
      ["m1", "reload_readmitted"]
    ]);
    expect(b.conn.runtimeGeneration()).toBeGreaterThan(a.conn.runtimeGeneration());
  });

  it("a changed trust root re-verifies: a signature the successor no longer trusts is withheld, never delivered on the old verdict", async () => {
    const op = await operatorKey(7);
    const other = await operatorKey(9);
    serve(
      [{ messages: [heldPeer("p1"), await signedOperator("o1", op)], fleet_id: FLEET, operator_trusted: false, peer_autoreply: true }],
      { messages: [], fleet_id: FLEET }
    );
    const a = await startCopy({ ...defaultConfig(), operatorPubkey: op.pub });
    await poll();
    a.host.fire("gateway_stop", { reason: "plugin replacement" });
    expect(records().map(([id]) => id).sort()).toEqual(["o1", "p1"]);

    // The #111 trigger shape: the successor's trust root no longer holds the key.
    const idFile = join(stateDir, ".ekho-identity.json");
    const id = JSON.parse(readFileSync(idFile, "utf8"));
    id.pinnedOperatorKeys = { [other.kid]: other.pub };
    writeFileSync(idFile, JSON.stringify(id));

    relay.floorFree = () => true;
    await startCopy();
    await poll(3);
    expect(relay.prompts).toHaveLength(1);
    expect(relay.prompts[0]).toContain("held text p1");
    expect(relay.prompts[0]).not.toContain("signed text o1");
    expect(records().filter(([, r]) => String(r).startsWith("reload_"))).toEqual([
      ["o1", "reload_withheld:verification:unknown-operator-key"],
      ["p1", "reload_readmitted"]
    ]);
  });

  const policyChanges: Array<[string, Record<string, unknown>, string]> = [
    ["peer delegation turned off", { peerAutoreply: false }, "reload_withheld:not_admissible:authority"],
    ["require-signed mode", { requireSigned: "require" }, "reload_withheld:unsigned-require-signed"]
  ];
  for (const [name, change, reason] of policyChanges) {
    it(`a successor's current policy applies (${name}): withheld with a record, no turn`, async () => {
      serve([{ messages: [heldPeer("m1")], peer_autoreply: true }]);
      const a = await startCopy();
      await poll();
      a.host.fire("gateway_stop", { reason: "plugin replacement" });

      relay.floorFree = () => true;
      await startCopy({ ...defaultConfig(), ...change });
      await poll(3);
      expect(relay.prompts).toEqual([]);
      expect(records()).toEqual([
        ["m1", "deferred_loop_stopped"],
        ["m1", reason]
      ]);
    });
  }

  it("a relay redelivery and the hand-off copy of the same message give ONE turn, whichever reaches the successor first", async () => {
    const m1 = heldPeer("m1");
    const m2 = heldPeer("m2");
    serve([{ messages: [m1, m2], peer_autoreply: true }]);
    const a = await startCopy();
    await poll();
    a.host.fire("gateway_stop", { reason: "plugin replacement" });

    // m1: its ack failed, so the relay redelivers it in the successor's first batch.
    // m2: re-admitted from the hand-off first, then redelivered a tick later.
    relay.floorFree = () => true;
    serve([
      { messages: [structuredClone(m1)], peer_autoreply: true },
      { messages: [structuredClone(m2)], peer_autoreply: true },
      { messages: [structuredClone(m1), structuredClone(m2)], peer_autoreply: true }
    ]);
    await startCopy();
    await poll(5);
    const delivered = (id: string) => relay.prompts.filter((p) => p.includes(`held text ${id}`)).length;
    expect(delivered("m1")).toBe(1);
    expect(delivered("m2")).toBe(1);
    expect(records().filter(([, r]) => String(r).startsWith("reload_"))).toEqual([
      ["m1", "reload_duplicate:redelivered"],
      ["m2", "reload_readmitted"]
    ]);
  });

  it("the successor waits for a floor that is still held, then delivers once", async () => {
    serve([{ messages: [heldPeer("m1")], peer_autoreply: true }]);
    const a = await startCopy();
    await poll();
    a.host.fire("gateway_stop", { reason: "plugin replacement" });

    await startCopy();
    await poll(4);
    expect(relay.prompts).toEqual([]); // re-admitted, but the floor is not ours
    relay.floorFree = () => true;
    await poll(3);
    expect(relay.prompts).toHaveLength(1);
    expect(relay.prompts[0]).toContain("THIS TURN WAS HELD BACK");
  });

  it("the overrun clock runs from the ORIGINAL deferral: a stash older than the retry window is delivered late, without the floor", async () => {
    serve([{ messages: [heldPeer("m1", { deadline_at: new Date(Date.now() + 86_400_000).toISOString() })], peer_autoreply: true }]);
    const a = await startCopy();
    await poll();
    a.host.fire("gateway_stop", { reason: "plugin replacement" });
    vi.setSystemTime(Date.now() + DEFERRED_RETRY_TTL_MS + 60_000);

    await startCopy(); // the floor is STILL held by the other agent
    await poll();
    expect(relay.prompts).toHaveLength(1);
    expect(relay.prompts[0]).toContain("WITHOUT the floor");
  });

  it("an untrusted hand-off entry is re-verified and owner-checked: tampered body, wrong recipient, forged verdict, foreign owner, newer generation, malformed", async () => {
    const op = await operatorKey(7);
    const cfg = { ...defaultConfig(), operatorPubkey: op.pub };
    serve([], { messages: [], fleet_id: FLEET });
    relay.floorFree = () => true;
    const b = await startCopy(cfg);
    const owner = b.conn.connectedInboxContext(await b.conn.ensureConnected(cfg as never)).split(".")[0];
    const gen = b.conn.runtimeGeneration();

    const tampered = await signedOperator("t1", op);
    tampered.body = { text: "not what was signed" };
    const misaddressed = await signedOperator("r1", op, { recipient: { kind: "agent", id: "agent_someone_else" } });
    // Signed material this agent already rejected stays rejected, even though it verifies now.
    const rejected = await signedOperator("x1", op);
    const cache = await import("../src/autoreply");
    const context = b.conn.connectedInboxContext(await b.conn.ensureConnected(cfg as never));
    cache.recordBatch({ messages: [rejected] }, {}, "agent_reload", context);
    cache.recordVerifications({}, [{ message: rejected, verdict: { verified: false, kind: "operator", reason: "bad-signature", keyId: op.kid } }], [rejected], "agent_reload", context);

    const entry = (message: unknown, over: Record<string, unknown> = {}) => ({
      owner,
      agentId: "agent_reload",
      fromGeneration: gen - 1,
      reason: "deferred_loop_stopped",
      conversationId: "held-conv",
      message,
      firstDeferredAtMs: Date.now(),
      depositedAtMs: Date.now(),
      // A late producer's claim of a positive verdict carries no weight.
      verification: { verified: true, kind: "operator", reason: null, keyId: op.kid },
      ...over
    });
    const { depositReloadHandoff, reloadHandoffCount } = await registry();
    depositReloadHandoff([
      entry(tampered),
      entry(misaddressed),
      entry(rejected),
      entry(await signedOperator("f1", op), { owner: "another-connection" }),
      entry(await signedOperator("g1", op), { fromGeneration: gen + 1 }),
      entry("not a message")
    ] as never);

    await poll(3);
    expect(relay.prompts).toEqual([]);
    expect(records()).toEqual([
      ["t1", "reload_withheld:verification:body-mismatch"],
      ["r1", "reload_withheld:verification:recipient-mismatch"],
      ["x1", "reload_withheld:verification:bad-signature"],
      [null, "reload_withheld:malformed"]
    ]);
    // Another connection domain's entry and a newer generation's are left untouched.
    expect(reloadHandoffCount("agent_reload")).toBe(2);
  });

  it("a successor on a different connection (relay) takes nothing", async () => {
    serve([{ messages: [heldPeer("m1")], peer_autoreply: true }]);
    const a = await startCopy();
    await poll();
    a.host.fire("gateway_stop", { reason: "plugin replacement" });

    relay.floorFree = () => true;
    await startCopy({ ...defaultConfig(), relayBaseUrl: "http://another-relay.invalid" });
    await poll(3);
    expect(relay.prompts).toEqual([]);
    expect(records()).toEqual([["m1", "deferred_loop_stopped"]]);
    expect((await registry()).reloadHandoffCount("agent_reload")).toBe(1);
  });

  it("with no successor the work stays bounded in memory, is reported when it ages out, and a fresh process never replays the disk record", async () => {
    serve([{ messages: [heldPeer("m1", { deadline_at: new Date(Date.now() + 86_400_000).toISOString() })], peer_autoreply: true }]);
    const a = await startCopy();
    await poll();
    a.host.fire("gateway_stop", { reason: "gateway stopping" });
    expect(records()).toEqual([["m1", "deferred_loop_stopped"]]);
    const { reloadHandoffCount, RELOAD_HANDOFF_MAX_AGE_MS } = await registry();
    expect(reloadHandoffCount("agent_reload")).toBe(1);
    await poll(3);
    expect(relay.prompts).toEqual([]);

    // Nobody claimed it within the bound: the next owner to look reports it.
    vi.setSystemTime(Date.now() + RELOAD_HANDOFF_MAX_AGE_MS + 1);
    relay.floorFree = () => true;
    const b = await startCopy();
    await poll(2);
    expect(relay.prompts).toEqual([]);
    expect(records()).toEqual([
      ["m1", "deferred_loop_stopped"],
      ["m1", "reload_withheld:handoff_unclaimed_too_long"]
    ]);
    b.host.fire("gateway_stop", { reason: "gateway stopping" });

    // A new process: a fresh registry, the same state directory. The disk
    // record is evidence, not work — nothing is re-admitted from it.
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekho-adapter.runtime")];
    await startCopy();
    await poll(3);
    expect(relay.prompts).toEqual([]);
    expect(records()).toHaveLength(2);
  });
});

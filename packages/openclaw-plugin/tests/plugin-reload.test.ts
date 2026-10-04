// A host hot reload (`openclaw plugins reload|update`) evaluates a FRESH copy
// of this plugin's module in the same gateway process. Before the fix each
// copy kept its own heartbeat setInterval and auto-reply poll forever, so every
// reload added another producer for the same agent. These tests load the real
// plugin entry (src/index.ts) twice in one process via vi.resetModules, against
// a stub relay client, and count who is still beating / polling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const relay = vi.hoisted(() => ({
  nextClient: 0,
  heartbeats: [] as Array<{ client: number; metrics: Record<string, string> }>,
  polls: [] as number[]
}));

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
      return { messages: [] };
    }
    async ackMessages() {
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
function fakeApi(signals: boolean) {
  const disposers: Array<() => unknown> = [];
  const hooks = new Map<string, Array<(event: unknown) => unknown>>();
  const api: Record<string, unknown> = {
    pluginConfig: {
      relayBaseUrl: "http://relay.invalid",
      agentId: "agent_reload",
      agentSecret: "s3cret",
      heartbeatIntervalMs: HEARTBEAT_MS,
      allowNewIdentity: true,
      stateDir
    },
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
    dispose: () => disposers.forEach((d) => d()),
    fire: (name: string, event: unknown) => (hooks.get(name) ?? []).forEach((h) => h(event))
  };
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

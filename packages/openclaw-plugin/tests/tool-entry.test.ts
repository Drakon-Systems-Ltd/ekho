import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { defineToolEntry, wrapToolResult, TOOL_PLUGIN_METADATA } from "../src/tool-entry";

/**
 * The plugin left `defineToolPlugin` (the plugin SDK's `tool-plugin` subpath,
 * marked deprecated by OpenClaw 2026.11.10) for `definePluginEntry` + its own
 * `api.registerTool` calls. Nothing the gateway is handed may change with that
 * move, and these tests are what holds it to that:
 *
 *   - the source must not import the deprecated subpath again (the built bundle
 *     is checked in bundle-identity.test.ts, which owns the one real build);
 *   - the three tools register with the names, labels, descriptions, parameters
 *     and options the old helper registered them with;
 *   - an execute tool's return value is wrapped the way the old helper wrapped
 *     it.
 */

const PKG_DIR = path.join(__dirname, "..");
const DEPRECATED_SUBPATH = "plugin-sdk/" + "tool-plugin";

describe("the deprecated tool-plugin subpath is gone from the source", () => {
  it("is imported by no file under src/", () => {
    const srcDir = path.join(PKG_DIR, "src");
    const files = fs.readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    // Any mention at all — import, import(), require(), `declare module`, or a
    // comment: tsc copies doc comments into dist/*.d.ts, and the release check
    // is a plain grep over src and dist.
    const offenders = files.filter((f) => fs.readFileSync(path.join(srcDir, f), "utf8").includes(DEPRECATED_SUBPATH));
    expect(offenders, "src files still naming the deprecated subpath").toEqual([]);
  });

  it("imports its host entry helper from plugin-sdk/plugin-entry instead", () => {
    const text = fs.readFileSync(path.join(PKG_DIR, "src", "tool-entry.ts"), "utf8");
    expect(text).toMatch(/from "openclaw\/plugin-sdk\/plugin-entry"/);
  });
});

/**
 * What the old helper did with an execute tool's return value, copied from the
 * host so the comparison is against the original rather than against a second
 * reading of our own code — openclaw 2026.11.10 (the fleet's current host),
 * dist/tool-plugin-Dml-gUYB.mjs `wrapToolPluginResult` over
 * dist/tool-results-BkLNMSCi.mjs `textResult` / `jsonResult` (compact JSON;
 * 2026.5.18 indented by two, newer hosts do not).
 */
function hostTextResult(text: string, details: unknown) {
  return { content: [{ type: "text", text }], details };
}
function hostJsonResult(payload: unknown) {
  return hostTextResult(JSON.stringify(payload), payload);
}
function hostWrapToolPluginResult(result: unknown) {
  if (typeof result === "string") return hostTextResult(result, result);
  return hostJsonResult(result);
}

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => Promise<unknown>;
};
type Registration = { tool: RegisteredTool | ((ctx: unknown) => RegisteredTool); opts?: unknown; argCount: number };

function fakeApi(pluginConfig?: Record<string, unknown>) {
  const registered: Registration[] = [];
  const api = {
    ...(pluginConfig ? { pluginConfig } : {}),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    registerTool: (...args: unknown[]) =>
      registered.push({ tool: args[0] as Registration["tool"], opts: args[1], argCount: args.length })
  };
  return { api, registered };
}

describe("an execute tool's result is wrapped as the old host helper wrapped it", () => {
  const seen: unknown[][] = [];
  const entry = defineToolEntry({
    id: "t",
    name: "T",
    description: "test entry",
    configSchema: Type.Object({ greeting: Type.Optional(Type.String()) }),
    tools: (tool) => [
      tool({
        name: "says_text",
        description: "returns a string",
        parameters: Type.Object({ who: Type.String() }),
        execute: (params, config, context) => {
          seen.push([params, config, context]);
          return `${config.greeting ?? "hello"} ${params.who}`;
        }
      }),
      tool({
        name: "says_object",
        label: "Says Object",
        description: "returns an object",
        parameters: Type.Object({}),
        execute: async () => ({ ok: true, nested: { list: [1, 2], none: null } })
      })
    ]
  });

  function register(pluginConfig?: Record<string, unknown>) {
    const host = fakeApi(pluginConfig);
    entry.register(host.api as never);
    const byName = (name: string) => host.registered.find((r) => (r.tool as RegisteredTool).name === name)!.tool as RegisteredTool;
    return { ...host, byName };
  }

  it("wraps a string as its own text, with the string as details", async () => {
    const { byName } = register({ greeting: "hi" });
    const result = await byName("says_text").execute("call_1", { who: "there" });
    expect(result).toEqual({ content: [{ type: "text", text: "hi there" }], details: "hi there" });
    expect(result).toEqual(hostWrapToolPluginResult("hi there"));
  });

  it("wraps an object as compact JSON text, with the object itself as details", async () => {
    const { byName } = register();
    const payload = { ok: true, nested: { list: [1, 2], none: null } };
    const result = (await byName("says_object").execute("call_2", {})) as ReturnType<typeof hostJsonResult>;
    expect(result).toEqual(hostWrapToolPluginResult(payload));
    // Spelled out, so this does not rest on the reference above alone.
    expect(Object.keys(result)).toEqual(["content", "details"]);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(payload) }]);
    expect(result.content[0].text).toBe('{"ok":true,"nested":{"list":[1,2],"none":null}}');
    expect(result.details).toEqual(payload);
  });

  it("matches the old wrapper for every kind of value an execute can return", () => {
    for (const value of ["", "plain", 0, 42, true, null, [], [1, "a"], {}, { a: { b: [1] } }, undefined]) {
      expect(wrapToolResult(value), `value: ${JSON.stringify(value)}`).toEqual(hostWrapToolPluginResult(value));
    }
  });

  it("calls execute with (params, config, { api, signal, toolCallId, onUpdate })", async () => {
    seen.length = 0;
    const config = { greeting: "yo" };
    const { api, byName } = register(config);
    const signal = new AbortController().signal;
    const onUpdate = () => {};
    await byName("says_text").execute("call_3", { who: "x" }, signal, onUpdate);
    expect(seen).toHaveLength(1);
    const [params, cfg, context] = seen[0] as [unknown, unknown, Record<string, unknown>];
    expect(params).toEqual({ who: "x" });
    expect(cfg).toBe(config); // the host's object, not a copy
    expect(Object.keys(context).sort()).toEqual(["api", "onUpdate", "signal", "toolCallId"]);
    expect(context.api).toBe(api);
    expect(context.signal).toBe(signal);
    expect(context.toolCallId).toBe("call_3");
    expect(context.onUpdate).toBe(onUpdate);
  });

  it("falls back to an empty config when the host supplies none", async () => {
    seen.length = 0;
    const { byName } = register();
    expect(await byName("says_text").execute("call_4", { who: "y" })).toEqual(hostWrapToolPluginResult("hello y"));
    expect(seen[0][1]).toEqual({});
  });

  it("registers an execute tool as a tool object with no options, label defaulting to the name", () => {
    const { registered } = register();
    expect(registered.map((r) => typeof r.tool)).toEqual(["object", "object"]);
    // One argument, as the old helper passed `undefined` options for a
    // non-optional tool.
    expect(registered.map((r) => r.opts)).toEqual([undefined, undefined]);
    const [text, object] = registered.map((r) => r.tool as RegisteredTool);
    expect(Object.keys(text).sort()).toEqual(["description", "execute", "label", "name", "parameters"]);
    expect(text.label).toBe("says_text");
    expect(object.label).toBe("Says Object");
  });

  it("hands the entry a wrapped config schema, not the raw one", () => {
    const schema = entry.configSchema as { safeParse?: unknown; jsonSchema?: Record<string, unknown> };
    expect(typeof schema.safeParse).toBe("function");
    expect(schema.jsonSchema).toMatchObject({ type: "object", properties: { greeting: { type: "string" } } });
  });

  it("refuses a tool that defines neither execute nor factory", () => {
    const broken = defineToolEntry({
      id: "b",
      name: "B",
      description: "broken",
      configSchema: Type.Object({}),
      tools: (tool) => [tool({ name: "nothing", description: "d", parameters: Type.Object({}) } as never)]
    });
    expect(() => broken.register(fakeApi().api as never)).toThrow("tool plugin tool nothing must define execute or factory");
  });
});

/**
 * tests/fixtures/registered-tools.golden.json is what the plugin registered
 * BEFORE the move: captured from the last commit that still used
 * defineToolPlugin (75f237d), by running that src/index.ts against the host
 * stub it shipped with and recording every registerTool call. The plugin must
 * still hand the gateway exactly this.
 */
describe("the plugin registers the same three tools it did through defineToolPlugin", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "registered-tools.golden.json"), "utf8")
  ) as {
    id: string;
    name: string;
    description: string;
    configSchema: unknown;
    tools: Array<{ form: string; opts?: unknown; name: string; label: string; description: string; parameters: unknown }>;
  };
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

  async function registerPlugin() {
    vi.resetModules();
    const plugin = (await import("../src/index.js")).default;
    const lines: string[] = [];
    const host = fakeApi({}); // no relayBaseUrl => no startup connect
    const order: string[] = [];
    const api = {
      ...host.api,
      registerTool: (...args: unknown[]) => {
        order.push("tool");
        host.api.registerTool(...args);
      },
      logger: { ...host.api.logger, info: (line: unknown) => { order.push("log"); lines.push(String(line)); } }
    };
    plugin.register(api as never);
    return { plugin, registered: host.registered, lines, order };
  }

  it("keeps the entry's id, name, description and config schema", async () => {
    const { plugin } = await registerPlugin();
    expect(plugin.id).toBe(golden.id);
    expect(plugin.name).toBe(golden.name);
    expect(plugin.description).toBe(golden.description);
    const schema = plugin.configSchema as { safeParse?: unknown; jsonSchema?: unknown };
    expect(typeof schema.safeParse).toBe("function");
    expect(plain(schema.jsonSchema)).toEqual(golden.configSchema);
  });

  it("registers ekho_send, ekho_open_room, ekho_inbox — same order, form and options", async () => {
    const { registered } = await registerPlugin();
    expect(golden.tools.map((t) => t.name)).toEqual(["ekho_send", "ekho_open_room", "ekho_inbox"]);
    expect(registered).toHaveLength(golden.tools.length);
    registered.forEach((r, i) => {
      const want = golden.tools[i];
      expect(typeof r.tool === "function" ? "factory" : "object", want.name).toBe(want.form);
      expect(r.opts, want.name).toEqual(want.opts);
    });
  });

  it("registers each with the same name, label, description and parameters", async () => {
    const { registered } = await registerPlugin();
    registered.forEach((r, i) => {
      const want = golden.tools[i];
      const tool = typeof r.tool === "function" ? r.tool({}) : r.tool;
      expect(tool.name).toBe(want.name);
      expect(tool.label).toBe(want.label);
      expect(tool.description).toBe(want.description);
      expect(plain(tool.parameters)).toEqual(want.parameters);
      expect(typeof tool.execute).toBe("function");
    });
  });

  it("registers the tools before the rest of startup runs, and still logs them", async () => {
    const { lines, order } = await registerPlugin();
    expect(lines).toContain("[ekho-adapter] registered tools: ekho_send, ekho_open_room, ekho_inbox");
    expect(order.slice(0, 3)).toEqual(["tool", "tool", "tool"]);
    expect(order.filter((o) => o === "tool")).toHaveLength(3);
  });

  it("wraps a real execute tool's result: ekho_inbox answers as compact JSON text plus details", async () => {
    const { registered } = await registerPlugin();
    const inbox = registered.map((r) => r.tool).find((t) => typeof t === "object" && t.name === "ekho_inbox") as RegisteredTool;
    const home = process.env.HOME;
    const stateDir = process.env.EKHO_STATE_DIR;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-tool-entry-"));
    process.env.HOME = scratch; // no saved credentials, nothing real to load
    process.env.EKHO_STATE_DIR = path.join(scratch, "state");
    try {
      // Empty config: the connect fails locally, and the tool answers degraded.
      const result = (await inbox.execute("call_1", {})) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
      expect(Object.keys(result)).toEqual(["content", "details"]);
      expect(result.details).toMatchObject({ listener: "down", count: 0, degraded: true });
      expect(String(result.details.error)).toMatch(/not connected/);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
      expect(result).toEqual(hostWrapToolPluginResult(result.details));
    } finally {
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      if (stateDir === undefined) delete process.env.EKHO_STATE_DIR; else process.env.EKHO_STATE_DIR = stateDir;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

/**
 * `openclaw plugins build` and `openclaw plugins validate` do not call
 * register(): they read the entry's authoring metadata, which the old
 * defineToolPlugin attached as a non-enumerable property keyed by a GLOBAL
 * symbol (host getToolPluginMetadata, openclaw 2026.11.10
 * dist/tool-plugin-Dml-gUYB.mjs). Without it both commands stop at "plugin
 * entry does not expose tool or feature authoring metadata".
 *
 * tests/fixtures/tool-plugin-metadata.golden.json is that metadata as the REAL
 * host helper produced it for the previous code: the last commit that still
 * used defineToolPlugin (75f237d) was bundled and imported under OpenClaw
 * 2026.11.10's own `defineToolPlugin`, and the symbol's value was written out
 * as JSON. The plugin's default export must carry exactly that.
 *
 * Sabotage check (26 Nov 2026): with the Object.defineProperty line removed
 * from defineToolEntry, five of the six tests below fail (metadata undefined;
 * only the symbol-identity one survives) and the real host's `openclaw plugins
 * validate` goes back to refusing the entry; with just `activation` dropped
 * from the metadata object, four fail, the golden comparison among them.
 * Restored after.
 */
describe("the entry carries the authoring metadata defineToolPlugin attached", () => {
  // Looked up the way the host does: by the global symbol's name, not through
  // anything exported from src/.
  const HOST_KEY = Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata");
  function getToolPluginMetadata(entry: unknown): Record<string, unknown> | undefined {
    if (!entry || typeof entry !== "object") return undefined;
    const metadata = (entry as Record<symbol, unknown>)[HOST_KEY];
    if (!metadata || typeof metadata !== "object") return undefined;
    return metadata as Record<string, unknown>;
  }
  const golden = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "tool-plugin-metadata.golden.json"), "utf8")
  ) as {
    id: string;
    name: string;
    description: string;
    activation: unknown;
    configSchema: unknown;
    tools: Array<{ name: string; label: string; description: string; parameters: unknown }>;
  };
  const registered = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "registered-tools.golden.json"), "utf8")
  ) as { configSchema: unknown; tools: Array<{ name: string; label: string; description: string; parameters: unknown }> };
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

  async function loadPlugin() {
    vi.resetModules();
    return (await import("../src/index.js")).default;
  }

  it("uses the host's global symbol as the key", () => {
    expect(TOOL_PLUGIN_METADATA).toBe(HOST_KEY);
  });

  it("exposes on the plugin's default export exactly what the real defineToolPlugin produced", async () => {
    const metadata = getToolPluginMetadata(await loadPlugin());
    expect(metadata, "plugin entry does not expose tool authoring metadata").toBeDefined();
    expect(plain(metadata)).toEqual(golden);
    // Key order too: the host's build writes these straight into the manifest.
    expect(JSON.stringify(metadata, null, 2)).toBe(JSON.stringify(golden, null, 2));
  });

  it("keeps it non-enumerable, so it never shows up in the entry the gateway spreads or serialises", async () => {
    const plugin = await loadPlugin();
    const descriptor = Object.getOwnPropertyDescriptor(plugin, HOST_KEY);
    expect(descriptor).toMatchObject({ enumerable: false, writable: false, configurable: false });
    expect(Object.getOwnPropertySymbols({ ...plugin })).toEqual([]);
    expect(Object.keys(plugin)).not.toContain(String(HOST_KEY));
  });

  it("describes the same tools and config schema the plugin actually registers", async () => {
    const metadata = getToolPluginMetadata(await loadPlugin()) as typeof golden;
    expect(metadata.activation).toEqual({ onStartup: true });
    expect(metadata.tools.map((t) => t.name)).toEqual(["ekho_send", "ekho_open_room", "ekho_inbox"]);
    expect(plain(metadata.configSchema)).toEqual(registered.configSchema);
    metadata.tools.forEach((tool, i) => {
      const want = registered.tools[i];
      expect(Object.keys(tool)).toEqual(["name", "label", "description", "parameters"]);
      expect(tool.name).toBe(want.name);
      expect(tool.label).toBe(want.label);
      expect(tool.description).toBe(want.description);
      expect(plain(tool.parameters)).toEqual(want.parameters);
    });
  });

  it("defaults activation to { onStartup: true } and labels to the tool name, as the helper did", () => {
    const entry = defineToolEntry({
      id: "m",
      name: "M",
      description: "metadata defaults",
      configSchema: Type.Object({ a: Type.Optional(Type.String()) }),
      tools: (tool) => [
        tool({ name: "one", description: "d1", parameters: Type.Object({}), execute: () => "x" }),
        tool({ name: "two", label: "Two", description: "d2", parameters: Type.Object({}), factory: () => ({}) })
      ]
    });
    const metadata = getToolPluginMetadata(entry) as typeof golden;
    expect(Object.keys(metadata)).toEqual(["id", "name", "description", "activation", "configSchema", "tools"]);
    expect(metadata).toMatchObject({ id: "m", name: "M", description: "metadata defaults", activation: { onStartup: true } });
    // The wrapped schema's jsonSchema, not the raw typebox object.
    expect(metadata.configSchema).toBe((entry.configSchema as { jsonSchema?: unknown }).jsonSchema);
    expect(metadata.tools.map((t) => [t.name, t.label])).toEqual([["one", "one"], ["two", "Two"]]);
  });

  it("passes an explicit activation through", () => {
    const entry = defineToolEntry({
      id: "a",
      name: "A",
      description: "explicit activation",
      activation: { onStartup: false },
      configSchema: Type.Object({}),
      tools: () => []
    });
    expect(getToolPluginMetadata(entry)?.activation).toEqual({ onStartup: false });
  });
});

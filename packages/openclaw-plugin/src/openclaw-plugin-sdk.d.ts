// Ambient declaration for the slice of OpenClaw's plugin-entry SDK this package
// builds against. The real types ship inside `openclaw` — an optional peer the
// host gateway provides at runtime. Declaring the surface here lets the plugin
// type-check and build from a clean clone without installing the multi-thousand-
// file OpenClaw CLI as a dev dependency. build.mjs marks `openclaw` external, so
// none of this is bundled or shipped; it mirrors openclaw's own
// dist/plugin-sdk/plugin-entry.d.ts (same export names: definePluginEntry,
// buildJsonPluginConfigSchema, OpenClawPluginApi, OpenClawPluginToolContext, ...).
//
// This is the only host module the plugin imports at runtime. It used to be
// the SDK's `tool-plugin` subpath (defineToolPlugin), which OpenClaw
// 2026.11.10 marks deprecated; src/tool-entry.ts now does that helper's job on
// top of definePluginEntry + api.registerTool.
declare module "openclaw/plugin-sdk/plugin-entry" {
  // The session slice of the host's OpenClawPluginToolContext. Only `factory`
  // tools ever see this — the `execute` wrapper's context carries no session
  // identity (ekho#17). Everything is optional and read defensively: a host that
  // predates these fields just yields undefined.
  export interface OpenClawPluginToolContext {
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    [key: string]: unknown;
  }

  // What the host calls back for a registered tool: the wrapped result is
  // `{ content: [{ type: "text", text }], details }`.
  export interface AnyAgentTool {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: unknown) => unknown;
    [key: string]: unknown;
  }

  export type OpenClawPluginToolFactory = (ctx: OpenClawPluginToolContext) => unknown;

  export interface PluginLogger {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
  }

  // The slice of OpenClawPluginApi the register() wrapper touches at startup.
  // `runtime` / `session` are host-internal surfaces the auto-reply loop
  // feature-detects at runtime — typed optional/loose on purpose so runtime
  // detection (not the compiler) stays the source of truth. Nothing here is a
  // contract; absence is handled gracefully (loop logs and skips).
  export interface OpenClawPluginApi {
    pluginConfig?: Record<string, unknown>;
    // Tool registration. Two forms, both present on every supported host
    // (checked against 2026.5.18 and 2026.11.10): a tool object, or a factory
    // the host calls with its per-session tool context. Required, as in the
    // host's own type: a host without it cannot load a tool plugin at all.
    registerTool: (
      tool: AnyAgentTool | OpenClawPluginToolFactory,
      opts?: { name?: string; names?: string[]; optional?: boolean }
    ) => void;
    logger?: PluginLogger;
    // Resolved OpenClaw config (host-internal shape; read defensively).
    config?: unknown;
    // Host hook registration. `on` is the TYPED hook API (model_call_started /
    // model_call_ended are typed hooks and only run through it); `registerHook`
    // is the internal bus, kept as a fallback for hosts that lack `on`.
    // Both feature-detected at runtime.
    on?: (hookName: string, handler: (event: unknown, ctx?: unknown) => unknown, opts?: unknown) => void;
    registerHook?: (
      events: string | string[],
      handler: (event: unknown, ctx?: unknown) => void,
      opts?: unknown
    ) => void;
    // Per-instance lifecycle (openclaw src/plugins/plugin-instance.types.ts).
    // `signal` aborts and `onDispose` callbacks run when the host disposes this
    // plugin instance — on a reload/update swap as well as on gateway shutdown.
    // Optional in the host's own type, and absent on older hosts.
    lifecycle?: {
      readonly signal?: AbortSignal;
      onDispose?: (dispose: () => void | Promise<void>) => () => void;
      [key: string]: unknown;
    };
    runtime?: {
      agent?: {
        runEmbeddedAgent?: (...args: unknown[]) => unknown;
        session?: Record<string, (...args: unknown[]) => unknown>;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    session?: {
      workflow?: {
        scheduleSessionTurn?: (...args: unknown[]) => unknown;
        enqueueNextTurnInjection?: (...args: unknown[]) => unknown;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  // What buildJsonPluginConfigSchema returns and definePluginEntry accepts.
  export interface OpenClawPluginConfigSchema {
    safeParse?: (value: unknown) => unknown;
    uiHints?: Record<string, unknown>;
    jsonSchema?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export function buildJsonPluginConfigSchema(
    schema: Record<string, unknown>,
    options?: { safeParse?: (value: unknown) => unknown; cacheKey?: string; uiHints?: Record<string, unknown> }
  ): OpenClawPluginConfigSchema;

  // The host calls the returned entry's register(api) at load. The return type
  // is deliberately unnamed: the real SDK exports no name for it, and a name
  // declared only here would leak into the published dist/*.d.ts as an import
  // the real module cannot satisfy. Take it as ReturnType<typeof
  // definePluginEntry> (src/tool-entry.ts ToolPluginEntry).
  export function definePluginEntry(options: {
    id: string;
    name: string;
    description: string;
    configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
    register: (api: OpenClawPluginApi) => void;
  }): {
    id: string;
    name: string;
    description: string;
    readonly configSchema: OpenClawPluginConfigSchema;
    register: (api: OpenClawPluginApi) => void;
  };
}

// OpenClaw's state-root resolver. Mirrors openclaw/dist/plugin-sdk/state-paths.d.ts
// (resolveStateDir: OPENCLAW_STATE_DIR, else ~/.openclaw or a legacy dir that
// already exists). Used for its type only: state-dir.ts loads it with a guarded
// require so a host without this module falls back instead of failing to load.
declare module "openclaw/plugin-sdk/state-paths" {
  export function resolveStateDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
  export const STATE_DIR: string;
}

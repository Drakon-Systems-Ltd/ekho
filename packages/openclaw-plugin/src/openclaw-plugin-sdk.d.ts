// Ambient declaration for the slice of OpenClaw's tool-plugin SDK this package
// builds against. The real types ship inside `openclaw` — an optional peer the
// host gateway provides at runtime. Declaring the surface here lets the plugin
// type-check and build from a clean clone without installing the multi-thousand-
// file OpenClaw CLI as a dev dependency. build.mjs marks `openclaw` external, so
// none of this is bundled or shipped; it mirrors openclaw's own
// dist/plugin-sdk/tool-plugin.d.ts.
declare module "openclaw/plugin-sdk/tool-plugin" {
  import type { Static, TSchema } from "typebox";

  type ToolPluginConfig<TConfigSchema extends TSchema | undefined> =
    TConfigSchema extends TSchema ? Static<TConfigSchema> : Record<string, never>;

  interface ToolExecutionContext {
    toolCallId: string;
    signal?: AbortSignal;
    [key: string]: unknown;
  }

  interface ToolDefinition<TConfig, TParamsSchema extends TSchema> {
    name: string;
    label?: string;
    description: string;
    parameters: TParamsSchema;
    optional?: boolean;
    execute: (
      params: Static<TParamsSchema>,
      config: TConfig,
      context: ToolExecutionContext
    ) => unknown;
  }

  type ToolFactory<TConfig> = <TParamsSchema extends TSchema>(
    definition: ToolDefinition<TConfig, TParamsSchema>
  ) => unknown;

  interface DefineToolPluginOptions<TConfigSchema extends TSchema | undefined = undefined> {
    id: string;
    name: string;
    description: string;
    activation?: { onStartup?: boolean };
    configSchema?: TConfigSchema;
    tools: (tool: ToolFactory<ToolPluginConfig<TConfigSchema>>) => readonly unknown[];
  }

  interface PluginLogger {
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
  interface PluginApi {
    pluginConfig?: Record<string, unknown>;
    logger?: PluginLogger;
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

  // defineToolPlugin returns a plugin entry whose register(api) the host calls
  // at load. We wrap that register to add a startup connect, so it must be typed
  // as a callable (and mutable) property.
  interface DefinedToolPluginEntry {
    id: string;
    name: string;
    description: string;
    register: (api: PluginApi) => void;
    [key: string]: unknown;
  }

  export function defineToolPlugin<TConfigSchema extends TSchema | undefined = undefined>(
    definition: DefineToolPluginOptions<TConfigSchema>
  ): DefinedToolPluginEntry;
}

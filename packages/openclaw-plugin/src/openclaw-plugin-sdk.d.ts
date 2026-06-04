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

  export function defineToolPlugin<TConfigSchema extends TSchema | undefined = undefined>(
    definition: DefineToolPluginOptions<TConfigSchema>
  ): unknown;
}

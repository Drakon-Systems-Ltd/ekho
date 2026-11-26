import type { Static, TSchema } from "typebox";
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext
} from "openclaw/plugin-sdk/plugin-entry";

/**
 * Tool registration on the host's canonical entry helper.
 *
 * The plugin used to be built with `defineToolPlugin`, from the plugin SDK's
 * `tool-plugin` subpath. OpenClaw 2026.11.10 marks that subpath
 * deprecated (`openclaw doctor`: "Uses older OpenClaw APIs"), so this does what
 * that helper did, on the two things it was itself built from:
 * `definePluginEntry` + `buildJsonPluginConfigSchema` (both exported from
 * `openclaw/plugin-sdk/plugin-entry` on 2026.5.18 and on 2026.11.10) and
 * `api.registerTool`.
 *
 * It follows the host's own implementation step for step (openclaw 2026.11.10
 * dist/tool-plugin-Dml-gUYB.mjs; 2026.5.18 dist/tool-plugin-BSUfExpZ.js is the
 * same registration), so what the gateway is handed does not change:
 *
 *   - the config schema goes through buildJsonPluginConfigSchema and the
 *     wrapped `{ safeParse, jsonSchema }` object is the entry's configSchema;
 *   - `config` is `api.pluginConfig ?? {}`, read once per register();
 *   - a `factory` tool is registered as a function of the host's tool context,
 *     with `{ name }` as its options, and wraps its own result;
 *   - an `execute` tool is registered as a tool object whose execute is called
 *     as (toolCallId, params, signal, onUpdate) and whose return value is
 *     wrapped by wrapToolResult below. No options: none of ours is optional.
 *
 *   - the entry carries the helper's non-enumerable authoring metadata, under
 *     the same global symbol (see TOOL_PLUGIN_METADATA below). The gateway does
 *     not read it; `openclaw plugins build` / `plugins validate` do.
 *
 * Left out on purpose: the outputSchema / optional / workspaceAccess
 * pass-throughs, which no tool here sets.
 */

/**
 * The key the host's authoring CLI looks the entry's metadata up by
 * (getToolPluginMetadata, in the same host file). It is a GLOBAL symbol, so the
 * key is reproduced here by name and nothing is imported from the deprecated
 * subpath that used to attach it. Without it `openclaw plugins build` and
 * `openclaw plugins validate` stop at "plugin entry does not expose tool or
 * feature authoring metadata".
 */
export const TOOL_PLUGIN_METADATA = Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata");

/** What the host's helper stored under that key, field for field. */
export interface ToolPluginMetadata {
  id: string;
  name: string;
  description: string;
  activation: Record<string, unknown>;
  configSchema: Record<string, unknown>;
  tools: Array<{ name: string; label: string; description: string; parameters: TSchema }>;
}

/**
 * The entry as the host's own definePluginEntry types it. The SDK exports no
 * name for that type, so it is taken from the function.
 */
export type ToolPluginEntry = ReturnType<typeof definePluginEntry>;

export type ToolPluginConfig<TConfigSchema extends TSchema | undefined> =
  TConfigSchema extends TSchema ? Static<TConfigSchema> : Record<string, never>;

export interface ToolExecutionContext {
  api: OpenClawPluginApi;
  toolCallId: string;
  signal?: AbortSignal;
  onUpdate?: unknown;
}

interface ToolDefinitionBase<TParamsSchema extends TSchema> {
  name: string;
  label?: string;
  description: string;
  parameters: TParamsSchema;
}

// A tool declares EITHER execute (params/config/result are wrapped for it) OR
// factory (it is handed the host's tool context; the returned tool is
// registered as-is, so it wraps its own result).
export type ToolDefinition<TConfig, TParamsSchema extends TSchema> = ToolDefinitionBase<TParamsSchema> &
  (
    | {
        execute: (params: Static<TParamsSchema>, config: TConfig, context: ToolExecutionContext) => unknown;
        factory?: never;
      }
    | {
        factory: (context: {
          api: OpenClawPluginApi;
          config: TConfig;
          toolContext: OpenClawPluginToolContext;
        }) => unknown;
        execute?: never;
      }
  );

interface CollectedTool {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute?: (params: never, config: never, context: ToolExecutionContext) => unknown;
  factory?: (context: { api: OpenClawPluginApi; config: never; toolContext: OpenClawPluginToolContext }) => unknown;
}

type ToolBuilder<TConfig> = <TParamsSchema extends TSchema>(
  definition: ToolDefinition<TConfig, TParamsSchema>
) => CollectedTool;

export interface ToolEntryOptions<TConfigSchema extends TSchema> {
  id: string;
  name: string;
  description: string;
  configSchema: TConfigSchema;
  /** Authoring metadata only (the generated manifest's `activation`). Default: `{ onStartup: true }`. */
  activation?: Record<string, unknown>;
  tools: (tool: ToolBuilder<ToolPluginConfig<TConfigSchema>>) => readonly CollectedTool[];
}

/**
 * The result shape the host hands the model: `{ content: [{ type: "text",
 * text }], details }` — the host's textResult(text, details).
 */
export function textToolResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * ekho_send's own result: the payload as JSON text indented by two, and the
 * payload itself as `details`. ekho_send is a factory tool and has always
 * wrapped its own result this way; unchanged.
 */
export function jsonToolResult(payload: unknown) {
  return textToolResult(JSON.stringify(payload, null, 2), payload);
}

/**
 * The host's wrapToolPluginResult for execute tools (ekho_open_room,
 * ekho_inbox): a string is its own text, anything else is compact JSON text
 * with the value as `details`.
 *
 * Compact matches the current host, OpenClaw 2026.11.10
 * (dist/tool-results-BkLNMSCi.mjs jsonResult: `JSON.stringify(e)`), which is
 * what these two tools return on the fleet today. Older hosts indented by two
 * (2026.5.18 dist/common-Co_iMEX5.js); with the wrapping done here, one bundle
 * now gives the same text on every host. Compact also keeps ekho_inbox output
 * smaller in the model's context.
 */
export function wrapToolResult(result: unknown) {
  if (typeof result === "string") return textToolResult(result, result);
  return textToolResult(JSON.stringify(result), result);
}

export function defineToolEntry<TConfigSchema extends TSchema>(
  definition: ToolEntryOptions<TConfigSchema>
): ToolPluginEntry {
  const pluginConfigSchema = buildJsonPluginConfigSchema(definition.configSchema as unknown as Record<string, unknown>);
  const collect = ((d: CollectedTool & { label?: string }) => ({
    name: d.name,
    label: d.label ?? d.name,
    description: d.description,
    parameters: d.parameters,
    execute: d.execute,
    factory: d.factory
  })) as unknown as ToolBuilder<ToolPluginConfig<TConfigSchema>>;
  const tools = [...definition.tools(collect)];
  const metadata: ToolPluginMetadata = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    activation: definition.activation ?? { onStartup: true },
    configSchema: pluginConfigSchema.jsonSchema ?? (definition.configSchema as unknown as Record<string, unknown>),
    tools: tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters
    }))
  };

  const entry = definePluginEntry({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    configSchema: pluginConfigSchema,
    register(api) {
      const config = (api.pluginConfig ?? {}) as never;
      for (const tool of tools) {
        if (tool.factory) {
          api.registerTool((toolContext) => tool.factory?.({ api, config, toolContext }), { name: tool.name });
          continue;
        }
        const execute = tool.execute;
        if (!execute) throw new Error(`tool plugin tool ${tool.name} must define execute or factory`);
        api.registerTool({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: tool.parameters,
          execute: async (toolCallId: string, params: never, signal?: AbortSignal, onUpdate?: unknown) =>
            wrapToolResult(await execute(params, config, { api, signal, toolCallId, onUpdate }))
        });
      }
    }
  });
  Object.defineProperty(entry, TOOL_PLUGIN_METADATA, { value: metadata, enumerable: false });
  return entry;
}

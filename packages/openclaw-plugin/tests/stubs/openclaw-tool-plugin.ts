/**
 * Test stand-in for `openclaw/plugin-sdk/tool-plugin`.
 *
 * `openclaw` is an optional peer the host gateway provides at runtime, so it is
 * not installed in this repo and src/index.ts cannot otherwise be imported by a
 * test. This mirrors the registration half of the real host implementation
 * (openclaw 2026.7.1-2, dist/tool-plugin-SyJ7vXLf.js) line for line, so a test
 * exercises the same two shapes the gateway does:
 *
 *   - `execute` tools: registered as a plain tool whose context is
 *     `{ api, signal, toolCallId, onUpdate }` — note there is NO session
 *     identity in it, which is the whole reason ekho_send uses a factory (#17).
 *   - `factory` tools: registered as a FUNCTION of the host's toolContext, which
 *     is where `sessionKey` / `sessionId` live.
 *
 * vitest.config.ts aliases the module specifier here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function wrapToolPluginResult(result: unknown) {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text }], details: result };
}

export function defineToolPlugin(definition: Any): Any {
  const toolFactory = (d: Any) => ({
    name: d.name,
    label: d.label ?? d.name,
    description: d.description,
    parameters: d.parameters,
    optional: d.optional === true,
    execute: d.execute,
    factory: d.factory
  });
  const tools = [...definition.tools(toolFactory)];

  return {
    ...definition,
    id: definition.id,
    name: definition.name,
    description: definition.description,
    // The collected tool definitions, as bundle-identity.test.ts's own staged
    // stub exposes them (that test loads a real built bundle and reads
    // `plugin.tools` directly).
    tools,
    register(api: Any) {
      const config = api.pluginConfig ?? {};
      for (const tool of tools) {
        const opts = { name: tool.name, ...(tool.optional ? { optional: true } : {}) };
        if (tool.factory) {
          // Optional call (the host's is not): a fake api that only cares about
          // startup logging, like bundle-identity.test.ts's, has no registerTool.
          api.registerTool?.((toolContext: Any) => tool.factory({ api, config, toolContext }), opts);
          continue;
        }
        if (!tool.execute) {
          throw new Error(`tool plugin tool ${tool.name} must define execute or factory`);
        }
        api.registerTool?.(
          {
            name: tool.name,
            label: tool.label,
            description: tool.description,
            parameters: tool.parameters,
            execute: async (toolCallId: string, params: Any, signal?: Any, onUpdate?: Any) =>
              wrapToolPluginResult(await tool.execute(params, config, { api, signal, toolCallId, onUpdate }))
          },
          tool.optional ? { optional: true } : undefined
        );
      }
    }
  };
}

/**
 * Test stand-in for `openclaw/plugin-sdk/plugin-entry`.
 *
 * `openclaw` is an optional peer the host gateway provides at runtime, so it is
 * not installed in this repo and src/index.ts cannot otherwise be imported by a
 * test. This mirrors the two functions the plugin imports from the real host
 * (openclaw 2026.11.10, dist/plugin-entry-DhKiQ4Uu.mjs and
 * dist/config-schema-BQYgWf1D.mjs, re-exported by dist/plugin-sdk/plugin-entry.js;
 * 2026.5.18's dist/plugin-entry-DeJmv1px.js and dist/config-schema-Dayx1z5k.js
 * are the same code) line for line:
 *
 *   - `definePluginEntry` returns `{ id, name, description, configSchema (a
 *     lazily resolved getter), register }` — register is the function it was
 *     given, untouched. It registers nothing itself: tools reach the host only
 *     through the plugin's own `api.registerTool(...)` calls (src/tool-entry.ts),
 *     so a test's fake api sees exactly what a gateway would.
 *   - `buildJsonPluginConfigSchema` returns `{ safeParse, jsonSchema }`.
 *
 * vitest.config.ts aliases the module specifier here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// src/plugin-sdk/lazy-value.ts
function createCachedLazyValueGetter(value: Any, fallback?: Any) {
  let resolved = false;
  let cached: Any;
  return () => {
    if (!resolved) {
      cached = (typeof value === "function" ? value() : value) ?? fallback;
      resolved = true;
    }
    return cached;
  };
}

// src/plugins/config-schema.ts
function error(message: string) {
  return { success: false, error: { issues: [{ path: [], message }] } };
}

function normalizeJsonSchema(schema: Any): Any {
  if (Array.isArray(schema)) return schema.map((item) => normalizeJsonSchema(item));
  if (!schema || typeof schema !== "object") return schema;
  const record = { ...schema };
  delete record.$schema;
  for (const [key, value] of Object.entries(record)) record[key] = normalizeJsonSchema(value);
  const propertyNames = record.propertyNames;
  if (propertyNames && typeof propertyNames === "object" && !Array.isArray(propertyNames) && propertyNames.type === "string") {
    delete record.propertyNames;
  }
  if (Array.isArray(record.required) && record.required.length === 0) delete record.required;
  return record;
}

export function buildJsonPluginConfigSchema(schema: Any, options?: Any): Any {
  return {
    // The one departure from the host: its default safeParse runs the host's
    // internal JSON-schema validator (validateJsonSchemaValue), which is not
    // available here. The plugin never calls safeParse — the gateway does,
    // before register() — so the stand-in accepts whatever it is given.
    safeParse: options?.safeParse ?? ((value: Any) => ({ success: true, data: value })),
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    jsonSchema: normalizeJsonSchema(schema)
  };
}

export function emptyPluginConfigSchema(): Any {
  return {
    safeParse(value: Any) {
      if (value === undefined) return { success: true, data: undefined };
      if (!value || typeof value !== "object" || Array.isArray(value)) return error("expected config object");
      if (Object.keys(value).length > 0) return error("config must be empty");
      return { success: true, data: value };
    },
    jsonSchema: { type: "object", additionalProperties: false, properties: {} }
  };
}

// src/plugin-sdk/plugin-entry.ts
export function definePluginEntry({
  id,
  name,
  description,
  kind,
  configSchema = emptyPluginConfigSchema,
  reload,
  nodeHostCommands,
  securityAuditCollectors,
  register
}: Any): Any {
  const getConfigSchema = createCachedLazyValueGetter(configSchema);
  return {
    id,
    name,
    description,
    ...(kind ? { kind } : {}),
    ...(reload ? { reload } : {}),
    ...(nodeHostCommands ? { nodeHostCommands } : {}),
    ...(securityAuditCollectors ? { securityAuditCollectors } : {}),
    get configSchema() {
      return getConfigSchema();
    },
    register
  };
}

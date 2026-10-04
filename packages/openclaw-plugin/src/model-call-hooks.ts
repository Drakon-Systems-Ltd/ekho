/**
 * Model-call telemetry hook wiring for the OpenClaw host.
 *
 * `model_call_started` / `model_call_ended` are TYPED plugin hooks (OpenClaw's
 * PLUGIN_HOOK_NAMES). The host's typed runner only invokes handlers registered
 * with `api.on(...)`. `api.registerHook(...)` is the separate *internal* hook
 * bus: OpenClaw's docs/plugins/hooks.md says registering an underscore name
 * there "produces a warning, and the typed runner never invokes that
 * registration". Registering through it alone left the operator board's live
 * model and turn-health silently stale on current hosts.
 *
 * Rule: prefer `api.on`. Fall back to `registerHook` ONLY when the host has no
 * `api.on` (older hosts), never both — on a host that honoured both, each call
 * would be counted twice in the turn-health window.
 */

export type ModelCallHookApi = {
  on?: (hookName: string, handler: (event: unknown, ctx?: unknown) => unknown, opts?: unknown) => void;
  registerHook?: (events: string | string[], handler: (event: unknown, ctx?: unknown) => void, opts?: unknown) => void;
  logger?: { debug?: (msg: string) => void };
};

export type ModelCallHandlers = {
  onStarted: (model?: string, provider?: string) => void;
  onEnded: (outcome?: string, category?: string) => void;
};

export type ModelCallHookRoute = "typed" | "legacy" | "none";

export function registerModelCallHooks(api: ModelCallHookApi, handlers: ModelCallHandlers): ModelCallHookRoute {
  const started = (event: unknown): void => {
    const e = event as { model?: string; provider?: string } | undefined;
    handlers.onStarted(e?.model, e?.provider);
  };
  const ended = (event: unknown): void => {
    const e = event as { outcome?: string; errorCategory?: string; failureKind?: string } | undefined;
    handlers.onEnded(e?.outcome, e?.errorCategory ?? e?.failureKind);
  };

  if (typeof api.on === "function") {
    let wired = 0;
    for (const [name, handler] of [
      ["model_call_started", started],
      ["model_call_ended", ended]
    ] as const) {
      try {
        api.on(name, handler);
        wired += 1;
      } catch (err) {
        api.logger?.debug?.(`[ekho-adapter] ${name} typed hook unavailable: ${String(err)}`);
      }
    }
    // A host that exposes api.on but rejects both names is not silently
    // downgraded to the internal bus: that bus does not run typed hooks either.
    return wired > 0 ? "typed" : "none";
  }

  if (typeof api.registerHook === "function") {
    let wired = 0;
    for (const [name, handler] of [
      ["model_call_started", started],
      ["model_call_ended", ended]
    ] as const) {
      try {
        api.registerHook(name, handler);
        wired += 1;
      } catch (err) {
        api.logger?.debug?.(`[ekho-adapter] ${name} hook unavailable: ${String(err)}`);
      }
    }
    return wired > 0 ? "legacy" : "none";
  }

  return "none";
}

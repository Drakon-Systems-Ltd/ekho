import { describe, it, expect, vi } from "vitest";
import { registerModelCallHooks, type ModelCallHookApi } from "../src/model-call-hooks";

// OpenClaw's typed runner only invokes handlers registered via api.on; the
// internal registerHook bus never runs typed hooks like model_call_started.
// These tests model that host behaviour: only the bus the host actually runs
// gets events.

function typedHost() {
  const handlers = new Map<string, (e: unknown) => unknown>();
  const internal: string[] = [];
  const api: ModelCallHookApi = {
    on: (name, h) => { handlers.set(name, h); },
    registerHook: (events) => { internal.push(...([] as string[]).concat(events)); }
  };
  return { api, handlers, internal };
}

describe("registerModelCallHooks", () => {
  it("wires both hooks through the typed api.on when the host has it", () => {
    const { api, handlers, internal } = typedHost();
    const onStarted = vi.fn();
    const onEnded = vi.fn();
    expect(registerModelCallHooks(api, { onStarted, onEnded })).toBe("typed");
    expect([...handlers.keys()].sort()).toEqual(["model_call_ended", "model_call_started"]);
    // never ALSO on the internal bus: a host honouring both would double-count
    expect(internal).toEqual([]);

    handlers.get("model_call_started")!({ model: "gpt-6", provider: "openai-codex", runId: "r", callId: "c" });
    handlers.get("model_call_ended")!({ outcome: "error", failureKind: "timeout", durationMs: 9 });
    handlers.get("model_call_ended")!({ outcome: "error", errorCategory: "not_found", failureKind: "timeout" });
    expect(onStarted).toHaveBeenCalledWith("gpt-6", "openai-codex");
    expect(onEnded).toHaveBeenNthCalledWith(1, "error", "timeout");
    // errorCategory wins over failureKind, as before
    expect(onEnded).toHaveBeenNthCalledWith(2, "error", "not_found");
  });

  it("regression: a typed-only host delivers events that registerHook alone never saw", () => {
    // The pre-fix plugin called only registerHook. On this host that registration
    // exists but is never run, so the health board stayed stale.
    const { api, handlers } = typedHost();
    const legacyOnly: ModelCallHookApi = { registerHook: api.registerHook };
    const stale = vi.fn();
    registerModelCallHooks(legacyOnly, { onStarted: stale, onEnded: stale });
    expect(handlers.size).toBe(0);

    const live = vi.fn();
    registerModelCallHooks(api, { onStarted: live, onEnded: vi.fn() });
    handlers.get("model_call_started")!({ model: "m", provider: "p" });
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("falls back to registerHook only on a host without api.on", () => {
    const seen: string[] = [];
    const api: ModelCallHookApi = { registerHook: (events) => { seen.push(...([] as string[]).concat(events)); } };
    expect(registerModelCallHooks(api, { onStarted: vi.fn(), onEnded: vi.fn() })).toBe("legacy");
    expect(seen.sort()).toEqual(["model_call_ended", "model_call_started"]);
  });

  it("does not downgrade to the internal bus when api.on throws, and never breaks startup", () => {
    const internal: string[] = [];
    const debug = vi.fn();
    const api: ModelCallHookApi = {
      on: () => { throw new Error("unknown hook"); },
      registerHook: (events) => { internal.push(...([] as string[]).concat(events)); },
      logger: { debug }
    };
    expect(registerModelCallHooks(api, { onStarted: vi.fn(), onEnded: vi.fn() })).toBe("none");
    expect(internal).toEqual([]);
    expect(debug).toHaveBeenCalledTimes(2);
  });

  it("reports none on a host with neither surface", () => {
    expect(registerModelCallHooks({}, { onStarted: vi.fn(), onEnded: vi.fn() })).toBe("none");
  });
});

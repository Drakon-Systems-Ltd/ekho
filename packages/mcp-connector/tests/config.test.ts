import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError, MIN_WAKE_DEBOUNCE_MS } from "../src/config";

const BASE = {
  EKHO_RELAY_BASE_URL: "http://127.0.0.1:4000/",
  EKHO_MCP_AUTH: "bearer",
  EKHO_MCP_BEARER: "b".repeat(40)
};

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const c = loadConfig(BASE);
    expect(c.relayBaseUrl).toBe("http://127.0.0.1:4000");
    expect(c.displayName).toBe("Grok");
    expect(c.mcpPath).toBe("/ekho-mcp");
    expect(c.port).toBe(4100);
    expect(c.host).toBe("127.0.0.1");
    expect(c.requireSigned).toBe("warn");
    expect(c.rateLimitPerMinute).toBe(60);
    expect(c.bodyCapBytes).toBe(64 * 1024);
    expect(c.wakeWebhookUrl).toBeUndefined();
    expect(c.trustProxy).toBe(false);
  });

  it("defaults to oauth mode and then requires a password and a public URL", () => {
    expect(() => loadConfig({ EKHO_RELAY_BASE_URL: "http://r" })).toThrow(ConfigError);
    expect(() => loadConfig({ EKHO_RELAY_BASE_URL: "http://r", EKHO_MCP_OAUTH_PASSWORD: "p".repeat(12) })).toThrow(/EKHO_MCP_PUBLIC_URL/);
    const c = loadConfig({ EKHO_RELAY_BASE_URL: "http://r", EKHO_MCP_OAUTH_PASSWORD: "p".repeat(12), EKHO_MCP_PUBLIC_URL: "https://box.example.ts.net/" });
    expect(c.auth).toBe("oauth");
    expect(c.publicUrl).toBe("https://box.example.ts.net");
  });

  it("bearer mode requires a 32+ character token", () => {
    expect(() => loadConfig({ ...BASE, EKHO_MCP_BEARER: "short" })).toThrow(/32/);
  });

  it("refuses an unknown auth mode and an out-of-range port", () => {
    expect(() => loadConfig({ ...BASE, EKHO_MCP_AUTH: "none" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE, EKHO_MCP_PORT: "70000" })).toThrow(ConfigError);
  });

  it("a wake webhook needs a secret, and the debounce never drops below 30 s", () => {
    expect(() => loadConfig({ ...BASE, EKHO_MCP_WAKE_WEBHOOK_URL: "https://h/x" })).toThrow(/SECRET/);
    const c = loadConfig({ ...BASE, EKHO_MCP_WAKE_WEBHOOK_URL: "https://h/x", EKHO_MCP_WAKE_WEBHOOK_SECRET: "whsec_x", EKHO_MCP_WAKE_DEBOUNCE_MS: "5" });
    expect(c.wakeDebounceMs).toBe(MIN_WAKE_DEBOUNCE_MS);
  });

  it("normalises the MCP path", () => {
    expect(loadConfig({ ...BASE, EKHO_MCP_PATH: "grok/" }).mcpPath).toBe("/grok");
  });
});

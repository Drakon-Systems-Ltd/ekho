import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadCredentials, saveCredentials, type EkhoCredentials } from "../src/credentials";
import { splitModelRef, pickModelMetrics } from "../src/connection";

describe("@ekho/openclaw-plugin", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-oc-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    tmpDirs.length = 0;
  });

  describe("model reporting", () => {
    it("splits a provider/model ref, tolerating bare ids and whitespace", () => {
      expect(splitModelRef("anthropic/claude-opus-4-8")).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
      expect(splitModelRef("  openai/gpt-5.4  ")).toEqual({ provider: "openai", model: "gpt-5.4" });
      expect(splitModelRef("claude-opus-4-8")).toEqual({ provider: "", model: "claude-opus-4-8" });
      expect(splitModelRef("")).toEqual({ provider: "", model: "" });
      // only the FIRST slash separates provider from model id (model ids can contain slashes)
      expect(splitModelRef("openrouter/meta/llama-3")).toEqual({ provider: "openrouter", model: "meta/llama-3" });
    });

    it("resolves metrics with precedence env > observed(live) > config(seed)", () => {
      // explicit env override wins over everything
      expect(pickModelMetrics({ envModel: "E", observedModel: "O", configModel: "C", envProvider: "ep", observedProvider: "op", configProvider: "cp" }))
        .toEqual({ model: "E", provider: "ep" });
      // live observed beats the configured seed when no env override
      expect(pickModelMetrics({ observedModel: "O", configModel: "C", observedProvider: "op", configProvider: "cp" }))
        .toEqual({ model: "O", provider: "op" });
      // configured seed is the last resort
      expect(pickModelMetrics({ configModel: "C", configProvider: "cp" })).toEqual({ model: "C", provider: "cp" });
      // model and provider resolve independently
      expect(pickModelMetrics({ envModel: "E", observedProvider: "op" })).toEqual({ model: "E", provider: "op" });
      // nothing set -> empty object (so the heartbeat carries no model keys, as today)
      expect(pickModelMetrics({})).toEqual({});
      // whitespace-only is treated as unset
      expect(pickModelMetrics({ envModel: "   ", observedModel: "O" })).toEqual({ model: "O" });
    });
  });

  describe("credentials", () => {
    it("saves and loads credentials", () => {
      const dir = makeTmpDir();
      const creds: EkhoCredentials = {
        agentId: "agent_test123",
        secret: "secret_abc",
        relayBaseUrl: "http://localhost:4000",
        fleetId: "flt_test"
      };

      saveCredentials(dir, creds);
      const loaded = loadCredentials(dir);
      expect(loaded).toEqual(creds);
    });

    it("returns null when no credentials file exists", () => {
      const dir = makeTmpDir();
      expect(loadCredentials(dir)).toBeNull();
    });

    it("returns null on corrupt credentials file", () => {
      const dir = makeTmpDir();
      fs.writeFileSync(path.join(dir, ".ekho-credentials.json"), "not json");
      expect(loadCredentials(dir)).toBeNull();
    });
  });

});

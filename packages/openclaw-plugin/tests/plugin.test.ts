import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadCredentials, saveCredentials, type EkhoCredentials } from "../src/credentials";
import { InboxPoller } from "../src/poller";

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

  describe("InboxPoller", () => {
    it("constructs with credentials", () => {
      const creds: EkhoCredentials = {
        agentId: "agent_poller",
        secret: "secret_poller",
        relayBaseUrl: "http://localhost:9999",
        fleetId: "flt_poller"
      };

      const poller = new InboxPoller(creds, 5000, {
        onMessage: () => {},
        onControl: () => {},
        onError: () => {}
      });

      expect(poller.agentId).toBe("agent_poller");
      poller.stop();
    });
  });

  describe("plugin export", () => {
    it("exports default plugin with correct shape", async () => {
      const plugin = (await import("../src/index")).default;
      expect(plugin.id).toBe("ekho-adapter");
      expect(plugin.name).toBe("Ekho Relay Adapter");
      expect(plugin.version).toBe("0.1.0");
      expect(typeof plugin.register).toBe("function");
    });
  });
});

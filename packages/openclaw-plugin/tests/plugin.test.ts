import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadCredentials, saveCredentials, type EkhoCredentials } from "../src/credentials";

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

});

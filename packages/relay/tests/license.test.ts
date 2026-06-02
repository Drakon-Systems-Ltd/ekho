import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Generate a test keypair and install the public key before importing license module
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

// Point the license module at a temp public key — never touch the bundled
// (tracked) src/license-public-key.pem, which must stay pristine in git.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-license-"));
const publicKeyPath = path.join(tmpDir, "license-public-key.pem");
fs.writeFileSync(publicKeyPath, publicKey);
process.env.EKHO_LICENSE_PUBLIC_KEY_PATH = publicKeyPath;

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createTestJwt(payload: Record<string, unknown>): string {
  const header = base64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64urlEncode(JSON.stringify(payload));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  const signature = base64urlEncode(signer.sign(privateKey));
  return `${header}.${body}.${signature}`;
}

// Clean up after all tests
afterEach(() => {
  delete process.env.EKHO_LICENSE_KEY;
  delete process.env.EKHO_LICENSE_PATH;
});

// Clean up the temp key directory on exit.
process.on("exit", () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("License system", () => {
  describe("loadLicense", () => {
    it("returns OSS when no license is configured", async () => {
      delete process.env.EKHO_LICENSE_KEY;
      delete process.env.EKHO_LICENSE_PATH;
      // Dynamic import to pick up env changes
      const { loadLicense } = await import("../src/license");
      const license = loadLicense();
      expect(license.tier).toBe("oss");
      expect(license.org).toBe("community");
      expect(license.max_fleets).toBe(1);
    });

    it("decodes a valid JWT from EKHO_LICENSE_KEY", async () => {
      const token = createTestJwt({
        tier: "pro",
        org: "Drakon Systems",
        max_fleets: 10,
        features: ["multi_fleet", "advanced_policies", "analytics"],
        issued_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2099-12-31T23:59:59.000Z"
      });
      process.env.EKHO_LICENSE_KEY = token;

      const { loadLicense } = await import("../src/license");
      const license = loadLicense();
      expect(license.tier).toBe("pro");
      expect(license.org).toBe("Drakon Systems");
      expect(license.max_fleets).toBe(10);
      expect(license.features).toContain("multi_fleet");
    });

    it("falls back to OSS on expired JWT", async () => {
      const token = createTestJwt({
        tier: "pro",
        org: "Expired Corp",
        max_fleets: 5,
        features: [],
        issued_at: "2020-01-01T00:00:00.000Z",
        expires_at: "2021-01-01T00:00:00.000Z"
      });
      process.env.EKHO_LICENSE_KEY = token;

      const { loadLicense } = await import("../src/license");
      const license = loadLicense();
      expect(license.tier).toBe("oss");
    });

    it("falls back to OSS on bad signature", async () => {
      const token = createTestJwt({
        tier: "pro",
        org: "Tampered",
        max_fleets: 99,
        features: [],
        expires_at: "2099-12-31T23:59:59.000Z"
      });
      // Corrupt the signature
      process.env.EKHO_LICENSE_KEY = token.slice(0, -5) + "XXXXX";

      const { loadLicense } = await import("../src/license");
      const license = loadLicense();
      expect(license.tier).toBe("oss");
    });

    it("reads license from file path", async () => {
      const tmpFile = path.join(os.tmpdir(), `ekho-license-test-${Date.now()}.jwt`);
      const token = createTestJwt({
        tier: "pro",
        org: "File Corp",
        max_fleets: 3,
        features: ["analytics"],
        expires_at: "2099-12-31T23:59:59.000Z"
      });
      fs.writeFileSync(tmpFile, token);
      process.env.EKHO_LICENSE_PATH = tmpFile;

      const { loadLicense } = await import("../src/license");
      const license = loadLicense();
      expect(license.tier).toBe("pro");
      expect(license.org).toBe("File Corp");

      fs.unlinkSync(tmpFile);
    });
  });

  describe("assertFleetCreationAllowed", () => {
    it("allows first fleet on OSS", async () => {
      delete process.env.EKHO_LICENSE_KEY;
      const { loadLicense, assertFleetCreationAllowed } = await import("../src/license");
      loadLicense();
      expect(() => assertFleetCreationAllowed(0)).not.toThrow();
    });

    it("rejects second fleet on OSS", async () => {
      delete process.env.EKHO_LICENSE_KEY;
      const { loadLicense, assertFleetCreationAllowed } = await import("../src/license");
      loadLicense();
      expect(() => assertFleetCreationAllowed(1)).toThrow("Upgrade to Pro");
    });

    it("allows multiple fleets on Pro", async () => {
      const token = createTestJwt({
        tier: "pro",
        org: "Multi Corp",
        max_fleets: 10,
        features: ["multi_fleet"],
        expires_at: "2099-12-31T23:59:59.000Z"
      });
      process.env.EKHO_LICENSE_KEY = token;
      const { loadLicense, assertFleetCreationAllowed } = await import("../src/license");
      loadLicense();
      expect(() => assertFleetCreationAllowed(5)).not.toThrow();
    });
  });

  describe("Extension registry", () => {
    it("registers and lists extensions", async () => {
      const { registerExtension, getExtensions } = await import("../src/license");
      registerExtension({ name: "test-ext" });
      const exts = getExtensions();
      expect(exts.some((e) => e.name === "test-ext")).toBe(true);
    });
  });
});

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildHttpsOptions } from "../src/tls";

describe("TLS options", () => {
  let dir: string;
  let certPath: string;
  let keyPath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-tls-"));
    certPath = path.join(dir, "cert.pem");
    keyPath = path.join(dir, "key.pem");
    fs.writeFileSync(certPath, "CERT-CONTENT");
    fs.writeFileSync(keyPath, "KEY-CONTENT");
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("returns null when no TLS paths are configured", () => {
    expect(buildHttpsOptions(undefined, undefined)).toBeNull();
  });

  test("throws when only one of cert/key is provided", () => {
    expect(() => buildHttpsOptions(certPath, undefined)).toThrow();
    expect(() => buildHttpsOptions(undefined, keyPath)).toThrow();
  });

  test("reads cert and key when both paths are provided", () => {
    const opts = buildHttpsOptions(certPath, keyPath);
    expect(opts).not.toBeNull();
    expect(opts!.cert.toString()).toBe("CERT-CONTENT");
    expect(opts!.key.toString()).toBe("KEY-CONTENT");
  });
});

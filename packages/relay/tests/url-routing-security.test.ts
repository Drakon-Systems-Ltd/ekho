import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { registerUiRoutes } from "../src/ui-routes";

describe("malformed URL routing and static files", () => {
  let relay: TestRelay;
  let fixture: string;

  beforeAll(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-ui-routing-"));
    fs.writeFileSync(path.join(fixture, "index.html"), "<html>console fixture</html>");
    fs.writeFileSync(path.join(fixture, "asset.txt"), "public asset");
    fs.writeFileSync(path.join(fixture, "..", `${path.basename(fixture)}-secret.txt`), "private fixture");
    relay = await createTestRelay();
    await registerUiRoutes(relay.app, fixture);
  });

  afterAll(async () => {
    await relay.app.close();
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(path.join(fixture, "..", `${path.basename(fixture)}-secret.txt`), { force: true });
  });

  it("keeps exact authenticated routes behind their auth guards", async () => {
    for (const url of ["/v1/operator/profile", "/v1/inbox"]) {
      const res = await relay.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("never treats malformed API paths or the not-found handler as authenticated responses", async () => {
    const urls = [
      "//v1/operator/profile",
      "/v1/%2e%2e/operator/profile",
      "/v1/operator/%2e%2e/profile",
      "/v1/operator\\profile",
      "/%00",
      "http://example.test/v1/operator/profile"
    ];
    for (const url of urls) {
      const res = await relay.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain("console fixture");
    }

    const missingProtectedRoute = await relay.app.inject({ method: "GET", url: "/v1/operator/unknown" });
    expect(missingProtectedRoute.statusCode).toBe(404);
    expect(missingProtectedRoute.json().message).toContain("not found");
  });

  it("serves a normal UI asset but never escapes its static root", async () => {
    const asset = await relay.app.inject({ method: "GET", url: "/ui/asset.txt" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("public asset");

    for (const url of [
      `/ui/../${path.basename(fixture)}-secret.txt`,
      `/ui/%2e%2e/${path.basename(fixture)}-secret.txt`,
      `/ui/%2e%2e%2f${path.basename(fixture)}-secret.txt`,
      `/ui/..%5c${path.basename(fixture)}-secret.txt`
    ]) {
      const res = await relay.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain("private fixture");
    }
  });
});

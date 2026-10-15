import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp-client";

describe("McpClient launch failures", () => {
  const originalPath = process.env.PATH;
  const emptyPath = mkdtempSync(join(tmpdir(), "ekho-mcp-path-"));

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  afterAll(() => {
    rmSync(emptyPath, { recursive: true, force: true });
  });

  it("rejects with ENOENT and retries a failed node launch", async () => {
    process.env.PATH = emptyPath;
    const client = new McpClient(join(emptyPath, "missing-script.js"));

    try {
      const firstError = await client.callTool("test", {}).catch((error: NodeJS.ErrnoException) => error);
      expect(firstError).toBeInstanceOf(Error);
      expect(firstError.code).toBe("ENOENT");

      const secondError = await client.callTool("test", {}).catch((error: NodeJS.ErrnoException) => error);
      expect(secondError).toBeInstanceOf(Error);
      expect(secondError.code).toBe("ENOENT");
      expect(secondError).not.toBe(firstError);
    } finally {
      client.close();
    }
  });

  it("preserves the process-exited error when node starts but the script is missing", async () => {
    process.env.PATH = dirname(process.execPath);
    const client = new McpClient(join(emptyPath, "missing-script.js"));

    try {
      await expect(client.callTool("test", {})).rejects.toThrow("MCP process exited");
    } finally {
      client.close();
    }
  });
});

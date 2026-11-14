import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp-client";

// Minimal newline-delimited MCP server (the MCP stdio framing): answers
// initialize, answers tools/call unless arguments.hang is true (then it never
// replies, leaving the request pending).
const FIXTURE = `
let buf = "";
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  for (;;) {
    const end = buf.indexOf("\\n");
    if (end === -1) return;
    const line = buf.slice(0, end);
    buf = buf.slice(end + 1);
    if (line.trim() === "") continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: {} });
    else if (msg.method === "tools/call" && !(msg.params.arguments && msg.params.arguments.hang)) {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok:" + process.pid }] } });
    }
  }
});
`;

describe("McpClient close()", () => {
  const originalPath = process.env.PATH;
  const dir = mkdtempSync(join(tmpdir(), "ekho-mcp-close-"));
  const server = join(dir, "server.cjs");
  writeFileSync(server, FIXTURE);

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a pending call promptly and reconnects on the next call", async () => {
    process.env.PATH = `${dirname(process.execPath)}:${originalPath ?? ""}`;
    const client = new McpClient(server);

    try {
      const first = await client.callTool("test", {});
      expect(first.content[0].text).toMatch(/^ok:\d+$/);

      const pending = client.callTool("test", { hang: true }).catch((error: Error) => error);
      // Let the request reach the child before closing.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const started = Date.now();
      client.close();
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("MCP process exited");
      expect(Date.now() - started).toBeLessThan(1_000);

      const second = await client.callTool("test", {});
      expect(second.content[0].text).toMatch(/^ok:\d+$/);
      // A fresh child was spawned, not the closed one.
      expect(second.content[0].text).not.toBe(first.content[0].text);
    } finally {
      client.close();
    }
  }, 15_000);
});

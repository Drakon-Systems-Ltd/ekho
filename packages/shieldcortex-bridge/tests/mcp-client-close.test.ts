import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp-client";

// Minimal framed MCP server: answers initialize, answers tools/call unless
// arguments.hang is true (then it never replies, leaving the request pending).
const FIXTURE = `
let buf = "";
function send(obj) {
  const body = JSON.stringify(obj);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  for (;;) {
    const end = buf.indexOf("\\r\\n\\r\\n");
    if (end === -1) return;
    const m = buf.slice(0, end).match(/Content-Length:\\s*(\\d+)/i);
    const len = m ? parseInt(m[1], 10) : 0;
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.slice(end + 4, end + 4 + len));
    buf = buf.slice(end + 4 + len);
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

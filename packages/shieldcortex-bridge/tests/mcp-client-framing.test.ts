import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/mcp-client";

// A fake child process whose stdin records every write, so a test can assert
// the exact bytes the client puts on the wire and feed back replies as the
// MCP stdio transport would: one JSON object per line.
type FakeChild = EventEmitter & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; written: string[] };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

const children = vi.hoisted(() => [] as FakeChild[]);

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: vi.fn(() => {
      const written: string[] = [];
      const stdin = Object.assign(new EventEmitter(), {
        written,
        write: vi.fn((data: string) => {
          written.push(data);
          return true;
        })
      });
      const child = Object.assign(new EventEmitter(), {
        stdin,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(() => true)
      });
      children.push(child);
      return child;
    })
  };
});

type Frame = { jsonrpc: string; id?: string; method: string; params?: unknown };

function frames(child: FakeChild): Frame[] {
  return child.stdin.written.flatMap((data) =>
    data.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Frame)
  );
}

function answer(child: FakeChild, id: string, result: unknown) {
  child.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"));
}

async function settle() {
  // Let promise continuations run without advancing any timers.
  await vi.advanceTimersByTimeAsync(0);
}

describe("McpClient stdio framing", () => {
  beforeEach(() => {
    children.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes newline-delimited JSON-RPC with no Content-Length header, initialize first", async () => {
    const client = new McpClient("/fake/server.js");
    const call = client.callTool("iron_dome_scan", { text: "hello" });
    await settle();

    expect(children).toHaveLength(1);
    const written = children[0].stdin.written;
    expect(written).toHaveLength(1);
    expect(written[0]).not.toMatch(/Content-Length/i);
    expect(written[0].endsWith("\n")).toBe(true);
    expect(written[0].slice(0, -1)).not.toContain("\n");
    const init = JSON.parse(written[0]) as Frame;
    expect(init).toMatchObject({ jsonrpc: "2.0", method: "initialize" });
    expect(typeof init.id).toBe("string");

    // Nothing else goes out until initialize is answered.
    answer(children[0], init.id!, { protocolVersion: "2024-11-05", capabilities: {} });
    await settle();
    const sent = frames(children[0]);
    expect(sent.map((f) => f.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(sent[1].id).toBeUndefined();
    expect(sent[2].params).toEqual({ name: "iron_dome_scan", arguments: { text: "hello" } });

    answer(children[0], sent[2].id!, { content: [{ type: "text", text: "ok" }] });
    await expect(call).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    client.close();
  });

  it("shares one handshake between concurrent calls: one child, one initialize, no tools/call before the reply", async () => {
    const client = new McpClient("/fake/server.js");
    const first = client.callTool("a", {});
    const second = client.callTool("b", {});
    await settle();

    expect(children).toHaveLength(1);
    let sent = frames(children[0]);
    expect(sent.map((f) => f.method)).toEqual(["initialize"]);

    answer(children[0], sent[0].id!, {});
    await settle();
    sent = frames(children[0]);
    expect(sent.map((f) => f.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
    expect(sent.filter((f) => f.method === "initialize")).toHaveLength(1);

    answer(children[0], sent[2].id!, { content: [{ type: "text", text: "A" }] });
    answer(children[0], sent[3].id!, { content: [{ type: "text", text: "B" }] });
    expect((await first).content[0].text).toBe("A");
    expect((await second).content[0].text).toBe("B");
    expect(children).toHaveLength(1);
    client.close();
  });

  it("reassembles a reply split across chunks and handles several replies in one chunk", async () => {
    const client = new McpClient("/fake/server.js");
    const a = client.callTool("a", {});
    const b = client.callTool("b", {});
    await settle();
    const init = frames(children[0])[0];
    answer(children[0], init.id!, {});
    await settle();
    const [, , callA, callB] = frames(children[0]);

    const replyA = JSON.stringify({ jsonrpc: "2.0", id: callA.id, result: { content: [{ type: "text", text: "split" }] } }) + "\n";
    children[0].stdout.emit("data", Buffer.from(replyA.slice(0, 20)));
    await settle();
    children[0].stdout.emit("data", Buffer.from(replyA.slice(20)));
    expect((await a).content[0].text).toBe("split");

    const replyB = JSON.stringify({ jsonrpc: "2.0", id: callB.id, result: { content: [{ type: "text", text: "batched" }] } });
    const unrelated = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
    children[0].stdout.emit("data", Buffer.from(`${unrelated}\r\n\n not json \n${replyB}\n`));
    expect((await b).content[0].text).toBe("batched");
    client.close();
  });

  it("reads a multi-byte character whole when its bytes arrive in two chunks", async () => {
    const client = new McpClient("/fake/server.js");
    const call = client.callTool("a", {});
    await settle();
    answer(children[0], frames(children[0])[0].id!, {});
    await settle();
    const [, , callA] = frames(children[0]);

    const reply = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: callA.id, result: { content: [{ type: "text", text: "approved — ok" }] } }) + "\n");
    const cut = reply.indexOf(Buffer.from("—")) + 1;
    children[0].stdout.emit("data", reply.subarray(0, cut));
    await settle();
    children[0].stdout.emit("data", reply.subarray(cut));
    expect((await call).content[0].text).toBe("approved — ok");
    client.close();
  });

  it("rejects a call with the server's JSON-RPC error message", async () => {
    const client = new McpClient("/fake/server.js");
    const call = client.callTool("iron_dome_scan", { content: "wrong argument name" }).catch((e: Error) => e);
    await settle();
    const init = frames(children[0])[0];
    answer(children[0], init.id!, {});
    await settle();
    const callFrame = frames(children[0])[2];
    children[0].stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: callFrame.id, error: { code: -32602, message: "Invalid arguments for tool iron_dome_scan: text: Required" } }) + "\n")
    );
    const error = await call;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Invalid arguments for tool iron_dome_scan: text: Required");
    client.close();
  });

  it("listTools returns the advertised tool names", async () => {
    const client = new McpClient("/fake/server.js");
    const list = client.listTools();
    await settle();
    const init = frames(children[0])[0];
    answer(children[0], init.id!, {});
    await settle();
    const listFrame = frames(children[0])[2];
    expect(listFrame.method).toBe("tools/list");
    answer(children[0], listFrame.id!, { tools: [{ name: "iron_dome_scan" }, { name: "iron_dome_check" }, { name: "remember" }] });
    expect(await list).toEqual(["iron_dome_scan", "iron_dome_check", "remember"]);
    client.close();
  });

  it("an unanswered initialize times out, kills that child, and the next call starts a fresh one", async () => {
    const client = new McpClient("/fake/server.js");
    const call = client.callTool("a", {}).catch((e: Error) => e);
    await settle();
    expect(children).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    const error = await call;
    expect((error as Error).message).toBe("MCP request timed out: initialize");
    expect(children[0].kill).toHaveBeenCalled();

    const next = client.callTool("b", {});
    await settle();
    expect(children).toHaveLength(2);
    const init = frames(children[1])[0];
    expect(init.method).toBe("initialize");
    answer(children[1], init.id!, {});
    await settle();
    const callFrame = frames(children[1])[2];
    answer(children[1], callFrame.id!, { content: [{ type: "text", text: "fresh" }] });
    expect((await next).content[0].text).toBe("fresh");
    client.close();
  });
});

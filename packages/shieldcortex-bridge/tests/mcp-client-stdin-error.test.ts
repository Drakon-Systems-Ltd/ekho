import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/mcp-client";

// A fake child process: stdin is an emitter whose writes go nowhere, so a test
// decides exactly which stdin, error and exit events the client sees (#139).
type FakeChild = EventEmitter & {
  stdin: EventEmitter & { write: () => boolean };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

const children = vi.hoisted(() => [] as FakeChild[]);

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), { write: () => true }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(() => true)
      });
      children.push(child);
      return child;
    })
  };
});

const errnoError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("McpClient stdin errors", () => {
  beforeEach(() => {
    children.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects the pending request at once with a non-EPIPE stdin error, and the next call starts a new child", async () => {
    const client = new McpClient("/fake/server.js");
    let settled: Error | undefined;
    void client.callTool("test", {}).catch((error: Error) => {
      settled = error;
    });
    expect(children).toHaveLength(1);

    children[0].stdin.emit("error", errnoError("EIO", "write EIO"));
    // 1 s of fake time, well under the 10 s request timeout.
    await vi.advanceTimersByTimeAsync(1_000);
    const error = settled;
    expect(error, "still pending 1 s after the stdin error").toBeInstanceOf(Error);
    expect((error as Error).message).toBe("write EIO");
    expect((error as NodeJS.ErrnoException).code).toBe("EIO");
    expect(children[0].kill).toHaveBeenCalled();

    // The old child's later exit is stale and must not reset the new one.
    const next = client.callTool("test", {}).catch((e: Error) => e);
    expect(children).toHaveLength(2);
    children[0].emit("exit", 1);
    children[0].stdin.emit("error", errnoError("EIO", "write EIO"));
    children[1].stdin.emit("error", errnoError("ECONNRESET", "write ECONNRESET"));
    expect(((await next) as Error).message).toBe("write ECONNRESET");
    client.close();
  });

  it("ignores EPIPE on stdin: the request is rejected by the child's exit, not by the EPIPE", async () => {
    const client = new McpClient("/fake/server.js");
    let settled: Error | undefined;
    const pending = client.callTool("test", {}).catch((error: Error) => {
      settled = error;
      return error;
    });

    children[0].stdin.emit("error", errnoError("EPIPE", "write EPIPE"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBeUndefined();
    expect(children[0].kill).not.toHaveBeenCalled();

    children[0].emit("exit", 1);
    expect(((await pending) as Error).message).toBe("MCP process exited");
    client.close();
  });
});

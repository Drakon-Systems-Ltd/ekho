import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Minimal MCP client over stdio.
 *
 * Framing is newline-delimited JSON-RPC 2.0: one JSON object per line, each
 * request and notification written as `JSON.stringify(message) + "\n"`, and
 * the server's stdout split on `\n`. This is the MCP stdio transport as the
 * `@modelcontextprotocol/sdk` `StdioServerTransport` implements it (its read
 * buffer splits on `\n`), which is what the ShieldCortex server uses.
 */
export class McpClient {
  private process: ChildProcess | null = null;
  private buffer = "";
  // Decodes stdout as one UTF-8 stream, so a character split across two chunks is read whole.
  private decoder = new StringDecoder("utf8");
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private initialized = false;
  private connecting: Promise<void> | null = null;

  constructor(private readonly binaryPath: string) {}

  /**
   * Start the server process and complete the MCP handshake. Concurrent
   * callers share one in-flight handshake, so a second tool call made while
   * the first is still initialising neither spawns a second process nor
   * writes its request before `initialize` has been answered.
   */
  connect(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.startChild().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async startChild(): Promise<void> {
    const child = spawn("node", [this.binaryPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env }
    });
    this.process = child;

    // EPIPE means the child is gone (it exited, or never started): its exit or
    // error handler rejects the pending requests, so that error is ignored here.
    // Any other stdin error fails this child's pending requests at once with the
    // real cause instead of leaving them to the request timeout.
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || this.process !== child) return;
      this.releaseChild(child, error);
      child.kill();
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.process !== child) return;
      this.buffer += this.decoder.write(chunk);
      this.processBuffer();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      // ShieldCortex logs to stderr — ignore for now
    });

    child.on("error", (error) => {
      this.releaseChild(child, error);
    });

    child.on("exit", () => {
      this.releaseChild(child, new Error("MCP process exited"));
    });

    // Send initialize request. A handshake that fails (no answer within the
    // request timeout, a server error, an exit) leaves no half-started child
    // behind: it is released and killed so the next call starts a fresh one.
    try {
      await this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ekho-shieldcortex-bridge", version: "0.1.0" }
      });
      if (this.process !== child) {
        // The child was released while initialising (its exit raced the reply).
        throw new Error("MCP process exited");
      }
    } catch (error) {
      this.releaseChild(child, error instanceof Error ? error : new Error(String(error)));
      child.kill();
      throw error;
    }

    // Send initialized notification
    this.sendNotification("notifications/initialized", {});
    this.initialized = true;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.initialized) await this.connect();
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    return result as McpToolResult;
  }

  /** Names of the tools the server advertises (`tools/list`). */
  async listTools(): Promise<string[]> {
    if (!this.initialized) await this.connect();
    const result = (await this.sendRequest("tools/list", {})) as { tools?: Array<{ name?: unknown }> } | null;
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.map((tool) => tool?.name).filter((name): name is string => typeof name === "string");
  }

  close() {
    const child = this.process;
    if (!child) return;
    // Tear down while this client still owns the child: the stale-child guard
    // makes the later exit event a no-op, so close() must do the cleanup itself.
    this.releaseChild(child, new Error("MCP process exited"));
    child.kill();
  }

  /** Release the current child and fail its pending requests. No-op for a stale child. */
  private releaseChild(child: ChildProcess, error: Error) {
    if (this.process !== child) return;
    this.process = null;
    this.initialized = false;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const req of pending) {
      req.reject(error);
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, 10_000);
      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  private sendNotification(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** One JSON object per line: the MCP stdio framing. */
  private write(message: Record<string, unknown>) {
    this.process?.stdin?.write(JSON.stringify(message) + "\n");
  }

  private processBuffer() {
    while (true) {
      const lineEnd = this.buffer.indexOf("\n");
      if (lineEnd === -1) break;

      const line = this.buffer.slice(0, lineEnd).replace(/\r$/, "");
      this.buffer = this.buffer.slice(lineEnd + 1);
      if (line.trim() === "") continue;

      try {
        const msg = JSON.parse(line) as { id?: string; result?: unknown; error?: { message: string } };
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const req = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            req.reject(new Error(msg.error.message));
          } else {
            req.resolve(msg.result);
          }
        }
      } catch {
        // Not a JSON-RPC line — skip
      }
    }
  }
}

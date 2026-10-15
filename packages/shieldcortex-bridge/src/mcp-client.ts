import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class McpClient {
  private process: ChildProcess | null = null;
  private buffer = "";
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private initialized = false;

  constructor(private readonly binaryPath: string) {}

  async connect(): Promise<void> {
    if (this.process) return;

    const child = spawn("node", [this.binaryPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env }
    });
    this.process = child;

    // A failed spawn can also emit an error on stdin after a write.
    child.stdin?.on("error", () => {});

    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      // ShieldCortex logs to stderr — ignore for now
    });

    child.on("error", (error) => {
      if (this.process !== child) return;
      this.process = null;
      this.initialized = false;
      for (const req of this.pendingRequests.values()) {
        req.reject(error);
      }
      this.pendingRequests.clear();
    });

    child.on("exit", () => {
      if (this.process !== child) return;
      this.process = null;
      this.initialized = false;
      for (const req of this.pendingRequests.values()) {
        req.reject(new Error("MCP process exited"));
      }
      this.pendingRequests.clear();
    });

    // Send initialize request
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ekho-shieldcortex-bridge", version: "0.1.0" }
    });

    // Send initialized notification
    this.sendNotification("notifications/initialized", {});
    this.initialized = true;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.initialized) await this.connect();
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    return result as McpToolResult;
  }

  close() {
    if (this.process) {
      this.process.kill();
      this.process = null;
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
        const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        this.process?.stdin?.write(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
      } catch (error) {
        this.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  private sendNotification(method: string, params: unknown) {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.process?.stdin?.write(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  }

  private processBuffer() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body) as { id?: string; result?: unknown; error?: { message: string } };
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
        // Malformed JSON — skip
      }
    }
  }
}

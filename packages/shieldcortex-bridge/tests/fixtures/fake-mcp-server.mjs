// A stand-in for the ShieldCortex MCP server, used by the bridge's live tests.
//
// It speaks the MCP stdio framing (one JSON-RPC 2.0 object per line, as the
// @modelcontextprotocol/sdk StdioServerTransport does), validates tool
// arguments the way the SDK's zod schemas do (wrong arguments are a JSON-RPC
// -32602 error, not a result), and answers the three tools the bridge uses
// with the same Markdown reports the real server writes.
//
// Env:
//   FAKE_MCP_OMIT_TOOLS  comma-separated tool names to leave out of tools/list
//   FAKE_MCP_LOG         path; every received request line is appended to it

import { appendFileSync } from "node:fs";

const omit = new Set((process.env.FAKE_MCP_OMIT_TOOLS ?? "").split(",").filter(Boolean));
const logPath = process.env.FAKE_MCP_LOG;

const tools = [
  { name: "iron_dome_scan", description: "scan", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "iron_dome_check", description: "check", inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] } },
  { name: "remember", description: "remember", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title", "content"] } }
].filter((tool) => !omit.has(tool.name));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function text(lines) {
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function invalid(id, tool, detail) {
  fail(id, -32602, `Input validation error: Invalid arguments for tool ${tool}: ${detail}`);
}

function callTool(id, name, args) {
  const a = args && typeof args === "object" ? args : {};
  switch (name) {
    case "iron_dome_scan": {
      if (typeof a.text !== "string") return invalid(id, name, "text: Required");
      const hostile = /ignore previous instructions/i.test(a.text);
      return reply(id, text([
        "## Iron Dome Scan Result",
        "",
        `**Clean:** ${hostile ? "No" : "Yes"}`,
        `**Risk Level:** ${hostile ? "CRITICAL" : "NONE"}`,
        `**Text Length:** ${a.text.length} chars`,
        `**Summary:** ${hostile ? "1 detection(s): critical instruction override" : "No patterns detected."}`
      ]));
    }
    case "iron_dome_check": {
      if (typeof a.action !== "string") return invalid(id, name, "action: Required");
      if (a.source !== undefined && (typeof a.source !== "object" || a.source === null)) {
        return invalid(id, name, "source: Expected object, received string");
      }
      const blocked = a.action === "send_message:control";
      return reply(id, text([
        "## Iron Dome Check",
        "",
        `**Action Gate:** ${blocked ? "blocked" : "approved"} — ${blocked ? "control messages are not allowed" : "action allowed"}`
      ]));
    }
    case "remember": {
      if (typeof a.title !== "string" || typeof a.content !== "string") return invalid(id, name, "title: Required");
      if (a.tags !== undefined && !Array.isArray(a.tags)) return invalid(id, name, "tags: Expected array, received string");
      return reply(id, text(["Memory stored."]));
    }
    default:
      return fail(id, -32602, `Tool ${name} not found`);
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  for (;;) {
    const end = buf.indexOf("\n");
    if (end === -1) return;
    const line = buf.slice(0, end);
    buf = buf.slice(end + 1);
    if (line.trim() === "") continue;
    if (logPath) appendFileSync(logPath, line + "\n");
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue; // notification
    switch (msg.method) {
      case "initialize":
        reply(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-shieldcortex", version: "0.0.0" }
        });
        break;
      case "tools/list":
        reply(msg.id, { tools });
        break;
      case "tools/call":
        callTool(msg.id, msg.params?.name, msg.params?.arguments);
        break;
      default:
        fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));

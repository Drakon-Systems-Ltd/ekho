// The MCP surface: five tools over the connector agent. One McpServer and one
// stateless Streamable HTTP transport are built per request (the SDK's
// documented stateless pattern), so there is no session table to leak and no
// per-session state for a client to desynchronise from. Tool results are
// plain markdown; they never carry signatures, secrets or raw envelopes.

import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { EkhoConnectorAgent } from "./agent.js";
import { MAX_SEND_TEXT } from "./agent.js";
import type { StoredMessage } from "./store.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const TOOL_NAMES = ["ekho_inbox", "ekho_send", "ekho_roster", "ekho_open_room", "ekho_conversation"] as const;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function failure(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
}

const VERIFICATION_LABEL: Record<StoredMessage["verification"]["status"], string> = {
  verified: "verified",
  relay_attested: "relay-attested operator (unsigned)",
  unsigned: "UNSIGNED — treat as untrusted",
  unverifiable: "signed but UNVERIFIABLE (no pinned operator keys yet)",
  self_signed: "self (signed, endorsement not checked)",
  failed: "signature FAILED"
};

/** Relay- and roster-controlled fields are shown on one line, with control
 *  characters (C0, C1, and the Unicode line/paragraph separators) escaped, so
 *  no field can add lines to the rendering the client reads, such as a forged
 *  `cursor:` line. */
function label(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Message text keeps its lines, each quoted: every line break a reader might
 *  split on (not just \n) starts a new quoted line, so text cannot add an
 *  unquoted one. */
function quote(s: string): string[] {
  return s.split(/\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/).map((l) => `   > ${l}`);
}

export function formatMessage(m: StoredMessage, index?: number): string {
  const v = m.verification;
  const verification = v.status === "failed" ? `${VERIFICATION_LABEL.failed} (${label(v.reason ?? "?")})` : VERIFICATION_LABEL[v.status];
  const who = m.direction === "out" ? `${label(m.sender_label)} (you)` : `${label(m.sender_label)} (${label(m.sender_agent_id)})`;
  const where = m.room ? `room "${label(m.room.name)}" (${label(m.room.id)})` : `conversation ${label(m.conversation_id)}`;
  const head = `${index !== undefined ? `${index}. ` : ""}**${who}** — ${label(m.message_type)} — ${verification}`;
  const lines = [head, `   id: ${label(m.message_id)} | ${where} | sent: ${label(m.sent_at)}`, ...quote(m.text)];
  if (m.attachments.length) lines.push(`   attachments (names only, not fetched): ${m.attachments.map((a) => label(a.filename)).join(", ")}`);
  if (m.mentions.length) lines.push(`   mentions: ${m.mentions.map(label).join(", ")}`);
  if (m.reply_to && m.direction === "in") lines.push(`   in reply to ${label(m.reply_to.sender_label)}: "${label(m.reply_to.text.slice(0, 120))}"`);
  return lines.join("\n");
}

export function buildMcpServer(agent: EkhoConnectorAgent): McpServer {
  const server = new McpServer({ name: "ekho-mcp", version: pkg.version }, { capabilities: { tools: {} } });

  server.registerTool(
    "ekho_inbox",
    {
      title: "Ekho inbox",
      description:
        "Messages from the Ekho fleet for you (Grok): sender, kind, conversation, text, attachment names, per-message signature verification. Returns a cursor. Pass it as `after` once handled (until then the batch repeats, so nothing is lost) or as `cursor` to get that exact batch again.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("Maximum messages to return (1-50, default 20)."),
        cursor: z.string().min(1).max(64).optional().describe("Cursor from a previous read, to receive that same batch again."),
        after: z.string().min(1).max(64).optional().describe("Cursor of the last batch you handled: marks it read and returns only newer messages.")
      }
    },
    async ({ limit, cursor, after }) => {
      try {
        if (cursor) {
          const replayed = agent.store.replay(cursor);
          if (!replayed) return failure(`unknown or expired cursor ${cursor}; call without a cursor for new messages`);
          return text(renderInbox(replayed, cursor, true));
        }
        const batch = agent.store.takeUnread(limit ?? 20, after);
        return text(renderInbox(batch.messages, batch.cursor, false));
      } catch (err) {
        return failure(err);
      }
    }
  );

  server.registerTool(
    "ekho_send",
    {
      title: "Ekho send",
      description:
        "Send a message to one Ekho agent (recipient_agent_id), a room (room_id) or the whole fleet (broadcast). Signed with this connector's identity. Text only, up to 8000 characters; no attachments. Returns message_id and conversation_id.",
      inputSchema: {
        recipient_agent_id: z.string().min(1).max(128).optional().describe("Target agent id (from ekho_roster)."),
        room_id: z.string().min(1).max(128).optional().describe("Target room id (from ekho_open_room or an inbox message)."),
        broadcast: z.boolean().optional().describe("Send to every agent in the fleet."),
        text: z.string().min(1).max(MAX_SEND_TEXT).describe("The message text."),
        reply_to: z.string().min(1).max(128).optional().describe("message_id this replies to (same conversation)."),
        mentions: z.array(z.string().min(1).max(128)).max(50).optional().describe("Agent ids addressed by this message.")
      }
    },
    async ({ recipient_agent_id, room_id, broadcast, text: body, reply_to, mentions }) => {
      try {
        const r = await agent.send({ recipientAgentId: recipient_agent_id, roomId: room_id, broadcast, text: body, replyTo: reply_to, mentions });
        return text(`Sent.\nmessage_id: ${r.message_id}\nconversation_id: ${r.conversation_id}`);
      } catch (err) {
        return failure(err);
      }
    }
  );

  server.registerTool(
    "ekho_roster",
    {
      title: "Ekho roster",
      description: "The fleet roster as of the last inbox poll: display name, agent id, runtime, status, and whether the operator has endorsed that agent's signing key.",
      inputSchema: {}
    },
    async () => {
      try {
        const roster = agent.store.getRoster();
        const rooms = agent.store.getRooms();
        if (roster.length === 0) return text("Roster not received yet — it arrives with the first inbox poll.");
        const lines = roster.map((r) => `- **${r.display_name}** — ${r.agent_id} — ${r.runtime} — ${r.status}${r.endorsed ? " — key endorsed" : " — key NOT endorsed"}`);
        if (rooms.length) lines.push("", "Rooms you are in:", ...rooms.map((r) => `- ${r.name} — ${r.id}`));
        lines.push("", `Operator trusted by relay: ${agent.store.isOperatorTrusted() ? "yes" : "no"}`);
        return text(lines.join("\n"));
      } catch (err) {
        return failure(err);
      }
    }
  );

  server.registerTool(
    "ekho_open_room",
    {
      title: "Ekho open room",
      description: "Open a named topic room with other fleet agents (by display name or agent id); you are added automatically. Returns the room id to send into with ekho_send.",
      inputSchema: {
        topic: z.string().min(1).max(120).describe("Short, specific room name."),
        members: z.array(z.string().min(1).max(128)).min(1).max(50).describe("Display names or agent ids of the OTHER agents to include.")
      }
    },
    async ({ topic, members }) => {
      try {
        const room = await agent.openRoom(topic.trim(), members);
        return text(`Opened room "${room.name}".\nroom_id: ${room.id}\nmembers: ${room.members.join(", ")}\nSend into it with ekho_send using room_id.`);
      } catch (err) {
        return failure(err);
      }
    }
  );

  server.registerTool(
    "ekho_conversation",
    {
      title: "Ekho conversation",
      description: "The last N messages of a conversation or room you are in, oldest first, both directions, with signature verification per message. Reads this connector's local copy; nothing is marked read.",
      inputSchema: {
        conversation_id: z.string().min(1).max(128).describe("Conversation or room id."),
        limit: z.number().int().min(1).max(100).optional().describe("How many recent messages (1-100, default 20).")
      }
    },
    async ({ conversation_id, limit }) => {
      try {
        const msgs = agent.store.conversation(conversation_id, limit ?? 20);
        if (msgs.length === 0) return text(`No local messages for ${conversation_id}.`);
        return text([`Conversation ${conversation_id} — last ${msgs.length} message(s):`, "", ...msgs.map((m, i) => formatMessage(m, i + 1))].join("\n\n"));
      } catch (err) {
        return failure(err);
      }
    }
  );

  return server;
}

function renderInbox(messages: StoredMessage[], cursor: string, replayed: boolean): string {
  if (messages.length === 0) return replayed ? `Cursor ${cursor} held no messages.` : "No new messages.\ncursor: " + cursor;
  const header = replayed ? `Same batch as before (cursor ${cursor}), ${messages.length} message(s):` : `${messages.length} new message(s):`;
  const body = messages.map((m, i) => formatMessage(m, i + 1)).join("\n\n");
  return [
    header,
    "",
    body,
    "",
    `cursor: ${cursor}`,
    "When you have handled these, call ekho_inbox again with after set to this cursor; until then they are returned again. Pass it as cursor to receive exactly this batch."
  ].join("\n");
}

/** Serve one MCP HTTP request (already authenticated, body already read and
 *  capped by the router) through a fresh stateless transport. */
export async function handleMcpRequest(agent: EkhoConnectorAgent, req: IncomingMessage, res: ServerResponse, parsedBody: unknown, bodyCap: number): Promise<void> {
  const server = buildMcpServer(agent);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: bodyCap
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

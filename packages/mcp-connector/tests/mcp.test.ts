import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { verifyInbound } from "../../openclaw-plugin/src/verify";
import { TOOL_NAMES } from "../src/mcp";
import { startRelay, connectAgent, startServer, TEST_BEARER, type LiveRelay, type RunningServer } from "./helpers";

const relays: LiveRelay[] = [];
const servers: RunningServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const s of servers.splice(0)) await s.close();
  for (const r of relays.splice(0)) await r.close();
});

async function up() {
  const relay = await startRelay();
  relays.push(relay);
  const agent = await connectAgent(relay);
  const server = await startServer(agent, { auth: "bearer" });
  servers.push(server);
  const client = new Client({ name: "grok-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${TEST_BEARER}` } }
  });
  await client.connect(transport);
  clients.push(client);
  return { relay, agent, server, client };
}

const textOf = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");

describe("MCP over Streamable HTTP", () => {
  it("initialize + tools/list: exactly the five tools, valid names, bounded descriptions, object schemas", async () => {
    const { client } = await up();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(t.description!.length, t.name).toBeLessThanOrEqual(300);
      expect(t.inputSchema.type).toBe("object");
    }
    const send = tools.find((t) => t.name === "ekho_send")!;
    expect((send.inputSchema as { required?: string[] }).required).toEqual(["text"]);
  });

  it("end to end: signed peer message → ekho_inbox (verified, cursor) → idempotent retry → ekho_send verifies at the peer", async () => {
    const { relay, agent, client } = await up();
    const peer = await relay.enrollEndorsedPeer("Jarvis");
    await peer.sendSigned({ to: agent.agentId!, text: "Grok, can you summarise the thread?" });
    await agent.pollOnce();

    const first = await client.callTool({ name: "ekho_inbox", arguments: { limit: 10 } });
    const text1 = textOf(first);
    expect(text1).toContain("1 new message(s)");
    expect(text1).toContain("**Jarvis (");
    expect(text1).toContain("— verified");
    expect(text1).toContain("Grok, can you summarise the thread?");
    expect(text1).not.toMatch(/agent_sig|sig_canonical|seedHex/);
    const cursor = /cursor: (\S+)/.exec(text1)![1];

    // Retry with the cursor: the same batch; without: nothing new.
    const again = textOf(await client.callTool({ name: "ekho_inbox", arguments: { cursor } }));
    expect(again).toContain("Same batch as before");
    expect(again).toContain("Grok, can you summarise the thread?");
    expect(textOf(await client.callTool({ name: "ekho_inbox", arguments: {} }))).toContain("No new messages");
    const stale = await client.callTool({ name: "ekho_inbox", arguments: { cursor: "cur_nope" } });
    expect(stale.isError).toBe(true);

    // Endorse the connector's key so the peer can root-verify the reply.
    const { signCanonical, agentKeyEndorsementPayload, keyId, fromB64url } = await import("@drakon-systems/ekho-sdk/identity");
    const myPub = agent.identityPublicKeyB64url!;
    const myKid = keyId(fromB64url(myPub));
    relay.db.endorseAgentKey(relay.fleetId, agent.agentId!, myKid, {
      endorsedByKeyId: relay.root.id,
      signature: signCanonical(agentKeyEndorsementPayload(relay.fleetId, agent.agentId!, myKid, myPub), relay.root.seed)
    });
    const sent = await client.callTool({ name: "ekho_send", arguments: { recipient_agent_id: peer.agent_id, text: "Summary: all green." } });
    expect(sent.isError).toBeFalsy();
    const sentText = textOf(sent);
    const messageId = /message_id: (\S+)/.exec(sentText)![1];
    const conversationId = /conversation_id: (\S+)/.exec(sentText)![1];

    const inbox = (await peer.inbox()) as { fleet_id: string; roster: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> };
    const m = inbox.messages.find((x) => x.message_id === messageId)!;
    expect(m).toBeTruthy();
    expect(m.conversation_id).toBe(conversationId);
    const rosterByAgent: Record<string, Record<string, unknown>> = {};
    for (const e of inbox.roster) rosterByAgent[String(e.agent_id)] = e;
    const verdict = verifyInbound(m as never, {
      selfAgentId: peer.agent_id,
      fleetId: inbox.fleet_id,
      operatorKeys: { [relay.root.id]: relay.root.pubB64 },
      rosterByAgent: rosterByAgent as never,
      seenNonces: new Set(),
      now: new Date()
    });
    expect(verdict).toEqual({ verified: true, kind: "peer", reason: null, keyId: myKid });

    // The local conversation view shows both sides.
    const conv = textOf(await client.callTool({ name: "ekho_conversation", arguments: { conversation_id: conversationId } }));
    expect(conv).toContain("Grok (you)");
    expect(conv).toContain("Summary: all green.");
  });

  it("ekho_roster, ekho_open_room and refusal of an empty send", async () => {
    const { relay, agent, client } = await up();
    const peer = await relay.enrollEndorsedPeer("Case");
    await peer.sendSigned({ to: agent.agentId!, text: "roster please" });
    await agent.pollOnce();
    const roster = textOf(await client.callTool({ name: "ekho_roster", arguments: {} }));
    expect(roster).toContain("**Case**");
    expect(roster).toContain(peer.agent_id);
    expect(roster).toContain("key endorsed");

    const room = await client.callTool({ name: "ekho_open_room", arguments: { topic: "Invoice sync rollout", members: ["Case"] } });
    expect(room.isError).toBeFalsy();
    const roomId = /room_id: (\S+)/.exec(textOf(room))![1];
    const posted = await client.callTool({ name: "ekho_send", arguments: { room_id: roomId, text: "hello room" } });
    expect(textOf(posted)).toContain(`conversation_id: ${roomId}`);

    const empty = await client.callTool({ name: "ekho_send", arguments: { recipient_agent_id: peer.agent_id, text: "   " } });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toMatch(/empty/);
  });

  it("GET on the MCP path is a 405 in stateless mode, DELETE too, both still behind auth", async () => {
    const { server } = await up();
    expect((await fetch(server.mcpUrl)).status).toBe(401);
    expect((await fetch(server.mcpUrl, { headers: { authorization: `Bearer ${TEST_BEARER}`, accept: "text/event-stream" } })).status).toBe(405);
    expect((await fetch(server.mcpUrl, { method: "DELETE", headers: { authorization: `Bearer ${TEST_BEARER}` } })).status).toBe(405);
  });
});

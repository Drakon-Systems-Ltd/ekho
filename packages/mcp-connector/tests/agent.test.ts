import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { verifyInbound } from "../../openclaw-plugin/src/verify";
import { DEAD_LETTER_FILE } from "../src/dead-letter";
import { EKHO_ORIGIN_STAMP, classify } from "../src/agent";
import { startRelay, connectAgent, tmpDir, type LiveRelay } from "./helpers";

const relays: LiveRelay[] = [];
afterEach(async () => {
  for (const r of relays.splice(0)) await r.close();
});
async function relay() {
  const r = await startRelay();
  relays.push(r);
  return r;
}

describe("inbound pipeline", () => {
  it("a signed message from an endorsed peer is stored as verified; its nonce is burned", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    const peer = await r.enrollEndorsedPeer("Jarvis");
    const sent = await peer.sendSigned({ to: agent.agentId!, text: "hello Grok" });
    expect(sent.status).toBe(200);
    const stored = await agent.pollOnce();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      text: "hello Grok",
      sender_label: "Jarvis",
      sender_kind: "agent",
      verification: { status: "verified", reason: null, key_id: peer.keyId }
    });
    expect(agent.store.seenNonceSet().size).toBe(1);
    // Acked: a second poll is empty, and nothing is double-stored.
    expect(await agent.pollOnce()).toHaveLength(0);
    expect(agent.store.unreadCount()).toBe(1);
  });

  it("warn mode keeps an unsigned peer message, labelled unsigned", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    const peer = await r.enrollEndorsedPeer("Loose");
    await peer.sendUnsigned({ to: agent.agentId!, text: "no sig" });
    const stored = await agent.pollOnce();
    expect(stored[0].verification).toEqual({ status: "unsigned", reason: null, key_id: null });
  });

  it("require mode dead-letters unsigned peers and keeps verified ones", async () => {
    const r = await relay();
    const dir = tmpDir();
    const agent = await connectAgent(r, dir, { requireSigned: "require" });
    const peer = await r.enrollEndorsedPeer("Strict");
    await peer.sendUnsigned({ to: agent.agentId!, text: "dropped" });
    await peer.sendSigned({ to: agent.agentId!, text: "kept" });
    const stored = await agent.pollOnce();
    expect(stored.map((m) => m.text)).toEqual(["kept"]);
    const dl = fs.readFileSync(path.join(dir, DEAD_LETTER_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ reason: "unsigned", kind: "peer" });
    expect(dl[0].message.body.text).toBe("dropped");
  });

  it("a signed message whose body was altered in transit fails and is dead-lettered even in warn mode", async () => {
    const r = await relay();
    const dir = tmpDir();
    const agent = await connectAgent(r, dir);
    const peer = await r.enrollEndorsedPeer("Tampered");
    await peer.sendSigned({ to: agent.agentId!, text: "original" });
    // Simulate a relay that relabels the message under the still-valid signature.
    const batch = (await r.agentRequest(agent.agentId!, (agent as unknown as { credentials: { secret: string } }).credentials.secret, "GET", "/v1/inbox?limit=25")).body;
    batch.messages[0].body.text = "altered";
    const stored = agent.ingest(batch, r.fleetId);
    expect(stored).toHaveLength(0);
    const dl = fs.readFileSync(path.join(dir, DEAD_LETTER_FILE), "utf8");
    expect(dl).toContain('"reason":"body-mismatch"');
  });

  it("an unsigned operator message is relay_attested only when operator_trusted is set", () => {
    const op = { message_id: "m", sender_kind: "operator", sender_agent_id: "op_x" } as const;
    expect(classify(op, null, true).status).toBe("relay_attested");
    expect(classify(op, null, false).status).toBe("unsigned");
    expect(classify({ ...op, operator_sig: "x", key_id: "k", sig_canonical: {} }, null, true).status).toBe("unverifiable");
  });
});

describe("outbound", () => {
  it("ekho send is v2-signed and verifies under the plugin's verifyInbound at the recipient", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    const peer = await r.enrollEndorsedPeer("Receiver");
    // The operator endorses the connector's key so the peer can root-verify it.
    const { signCanonical, agentKeyEndorsementPayload, keyId, fromB64url } = await import("@drakon-systems/ekho-sdk/identity");
    const myPub = agent.identityPublicKeyB64url!;
    const myKid = keyId(fromB64url(myPub));
    r.db.endorseAgentKey(r.fleetId, agent.agentId!, myKid, {
      endorsedByKeyId: r.root.id,
      signature: signCanonical(agentKeyEndorsementPayload(r.fleetId, agent.agentId!, myKid, myPub), r.root.seed)
    });
    const res = await agent.send({ recipientAgentId: peer.agent_id, text: "reply from Grok", replyTo: undefined, mentions: [peer.agent_id] });
    expect(res.message_id).toMatch(/^msg_/);
    const inbox = (await peer.inbox()) as { fleet_id: string; roster: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> };
    const m = inbox.messages.find((x) => (x.body as { text: string }).text === "reply from Grok")!;
    expect(m.metadata).toMatchObject({ ekho_origin: EKHO_ORIGIN_STAMP, mentions: [peer.agent_id] });
    expect(m.mentions).toEqual([peer.agent_id]);
    const rosterByAgent: Record<string, Record<string, unknown>> = {};
    for (const e of inbox.roster) rosterByAgent[String(e.agent_id)] = e;
    const verdict = verifyInbound(m as never, {
      selfAgentId: peer.agent_id,
      fleetId: inbox.fleet_id,
      operatorKeys: { [r.root.id]: r.root.pubB64 },
      rosterByAgent: rosterByAgent as never,
      seenNonces: new Set(),
      now: new Date()
    });
    expect(verdict).toEqual({ verified: true, kind: "peer", reason: null, keyId: myKid });
    // The outbound copy is in the local conversation view.
    expect(agent.store.conversation(res.conversation_id, 10).map((x) => x.direction)).toEqual(["out"]);
  });

  it("refuses empty text, over-long text and ambiguous targets", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    await expect(agent.send({ recipientAgentId: "agent_x", text: "   " })).rejects.toThrow(/empty/);
    await expect(agent.send({ recipientAgentId: "agent_x", text: "x".repeat(8001) })).rejects.toThrow(/8000/);
    await expect(agent.send({ recipientAgentId: "agent_x", roomId: "room_y", text: "hi" })).rejects.toThrow(/exactly one/);
    await expect(agent.send({ text: "hi" })).rejects.toThrow(/exactly one/);
  });

  it("opens a room by member display name and sends into it", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    const peer = await r.enrollEndorsedPeer("Case");
    await peer.sendSigned({ to: agent.agentId!, text: "ping" }); // populates the roster snapshot
    await agent.pollOnce();
    const room = await agent.openRoom("Invoice sync", ["Case"]);
    expect(room.members).toContain(peer.agent_id);
    const sent = await agent.send({ roomId: room.id, text: "room hello" });
    expect(sent.conversation_id).toBe(room.id);
    await expect(agent.openRoom("x", ["Nobody"])).rejects.toThrow(/not an agent id or display name/);
  });
});

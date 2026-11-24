import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { verifyInbound } from "../../openclaw-plugin/src/verify";
import { DEAD_LETTER_FILE } from "../src/dead-letter";
import { EKHO_ORIGIN_STAMP, classify } from "../src/agent";
import { startRelay, connectAgent, tmpDir, type LiveRelay } from "./helpers";
import { SDK_VERSION } from "@drakon-systems/ekho-sdk";

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

describe("backpressure", () => {
  it("stops polling the relay while the unread backlog is at the bound, and resumes once the client confirms", async () => {
    const r = await relay();
    const agent = await connectAgent(r, tmpDir(), { queueMax: 2 });
    const peer = await r.enrollEndorsedPeer("Busy");
    await peer.sendSigned({ to: agent.agentId!, text: "one" });
    await peer.sendSigned({ to: agent.agentId!, text: "two" });
    expect((await agent.pollOnce()).map((m) => m.text)).toEqual(["one", "two"]);
    expect(agent.store.hasRoom()).toBe(false);
    await peer.sendSigned({ to: agent.agentId!, text: "three" });
    // Not fetched, so not acked: the relay still holds it.
    expect(await agent.pollOnce()).toEqual([]);
    expect(agent.store.unreadCount()).toBe(2);
    const read = agent.store.takeUnread(10);
    expect(read.messages.map((m) => m.text)).toEqual(["one", "two"]);
    agent.store.confirm(read.cursor);
    expect((await agent.pollOnce()).map((m) => m.text)).toEqual(["three"]);
    expect(agent.store.takeUnread(10, read.cursor).messages.map((m) => m.text)).toEqual(["three"]);
  });
});

describe("heartbeat identity (#97)", () => {
  it("reports the connector, its own package version, the SDK and Node", async () => {
    const r = await relay();
    const agent = await connectAgent(r, tmpDir());
    await agent.heartbeatOnce();
    const row = (await r.operatorRequest("GET", "/v1/operator/fleet-health")).body.agents.find(
      (a: { id: string }) => a.id === agent.agentId
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(row.identity).toMatchObject({
      adapter: "mcp-connector",
      adapter_version: pkg.version,
      sdk_version: SDK_VERSION,
      host_runtime: "node",
      host_runtime_version: process.versions.node,
      outdated: false
    });
    expect(row.identity.instance_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("operator controls (#208)", () => {
  const LOCAL_REFUSAL = /paused or quarantined by the operator/;

  async function control(r: LiveRelay, agentId: string, action: "pause" | "resume" | "quarantine") {
    const res = await r.operatorRequest("POST", `/v1/operator/agents/${agentId}/${action}`, { reason: `test ${action}` });
    expect(res.status).toBe(200);
  }
  /** Drive the real heartbeat-timeout auto-quarantine (as sweep-quarantine.test.ts does). */
  function goStale(r: LiveRelay, agentId: string) {
    const stale = new Date(Date.now() - 30_000).toISOString();
    r.db.raw().prepare("UPDATE agents SET status = 'healthy', last_seen_at = ? WHERE id = ?").run(stale, agentId);
    expect(r.db.sweepHeartbeatLiveness()).toBeGreaterThanOrEqual(1);
  }
  function lastHeartbeat(r: LiveRelay, agentId: string) {
    const row = r.db.raw().prepare("SELECT status, metrics_json FROM heartbeats WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1").get(agentId) as
      | { status: string; metrics_json: string }
      | undefined;
    return row ? { status: row.status, metrics: JSON.parse(row.metrics_json) as Record<string, unknown> } : undefined;
  }

  it("recovers on its own after heartbeat auto-unquarantine, with no operator action", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    const peer = await r.enrollEndorsedPeer("Peer");
    goStale(r, agent.agentId!);
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");
    await expect(agent.send({ recipientAgentId: peer.agent_id, text: "while quarantined" })).rejects.toThrow(LOCAL_REFUSAL);

    await agent.heartbeatOnce(); // the real auto-unquarantine path; reports degraded because still paused locally
    await agent.pollOnce();
    expect(agent.health().status).toBe("connected");
    const sent = await agent.send({ recipientAgentId: peer.agent_id, text: "back online" });
    expect(sent.message_id).toMatch(/^msg_/);
  });

  it("a pause issued inside the one-hour resume TTL still pauses locally (newest control must win)", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    const peer = await r.enrollEndorsedPeer("Peer");
    await control(r, agent.agentId!, "resume");
    await new Promise((res) => setTimeout(res, 20)); // distinct created_at: the inbox orders controls newest-first
    await control(r, agent.agentId!, "pause");
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");
    // Local refusal, not merely the relay's 403.
    await expect(agent.send({ recipientAgentId: peer.agent_id, text: "x" })).rejects.toThrow(LOCAL_REFUSAL);
  });

  it("heartbeat reports healthy and paused:false once the quarantine has cleared", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    goStale(r, agent.agentId!);
    await agent.pollOnce();
    await agent.heartbeatOnce();
    await agent.pollOnce();
    await agent.heartbeatOnce();
    expect(lastHeartbeat(r, agent.agentId!)).toMatchObject({ status: "healthy", metrics: { metrics: { paused: false } } });
  });

  it("guard: an operator pause holds across polls with no resume, and an operator resume clears it", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    await control(r, agent.agentId!, "pause");
    for (let i = 0; i < 3; i++) {
      await agent.pollOnce();
      expect(agent.health().status).toBe("paused");
    }
    await control(r, agent.agentId!, "resume");
    await agent.pollOnce();
    expect(agent.health().status).toBe("connected");
  });

  it("guard: a heartbeat does not clear an operator quarantine", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    await control(r, agent.agentId!, "quarantine");
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");
    await agent.heartbeatOnce();
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");
  });

  it("guard: a failed poll and a batch without a controls array leave a paused agent paused", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    await control(r, agent.agentId!, "pause");
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");

    const client = (agent as unknown as { client: { getInbox: (n: number) => Promise<unknown> } }).client;
    const real = client.getInbox.bind(client);

    client.getInbox = async () => {
      throw new Error("relay unreachable");
    };
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");

    client.getInbox = async () => ({ fleet_id: r.fleetId, messages: [] }); // controls missing
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");

    client.getInbox = async () => ({ fleet_id: r.fleetId, messages: [], controls: "oops" }); // controls not an array
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");

    client.getInbox = real;
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");
  });

  it("guard: a snapshot with a malformed control entry keeps the prior state, never throws, and keeps polling", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    const client = (agent as unknown as { client: { getInbox: (n: number) => Promise<unknown> } }).client;
    const real = client.getInbox.bind(client);
    const malformed: unknown[][] = [
      [{}],
      [null],
      [undefined],
      ["pause"],
      [42],
      [{ action: 5 }],
      [{ action: null }],
      [{ action: ["pause"] }],
      [{ action: "resume" }, null], // valid entry first: the later bad entry must still void the snapshot
      [null, { action: "pause", reason: "x" }], // bad entry first: order must not matter
      [{ action: "pause", reason: "x" }, { reason: "no action" }]
    ];

    // Unpaused agent: a malformed snapshot must not pause it, even when it also carries a valid stop.
    for (const controls of malformed) {
      client.getInbox = async () => ({ fleet_id: r.fleetId, messages: [], controls });
      await expect(agent.pollOnce()).resolves.toEqual([]);
      expect(agent.health().status).toBe("connected");
      expect(agent.health().error).toBeNull();
    }

    // Paused agent: a malformed snapshot with no recognisable stop must not clear the standing pause.
    client.getInbox = real;
    await control(r, agent.agentId!, "pause");
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");
    for (const controls of malformed) {
      client.getInbox = async () => ({ fleet_id: r.fleetId, messages: [], controls });
      await expect(agent.pollOnce()).resolves.toEqual([]);
      expect(agent.health().status).toBe("paused");
      expect(agent.health().error).toBeNull();
    }
  });

  it("guard: a malformed control entry does not stop the batch being acknowledged", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    const client = (agent as unknown as { client: { getInbox: (n: number) => Promise<unknown>; ackMessages: (a: unknown[]) => Promise<unknown> } }).client;
    const acked: unknown[][] = [];
    client.ackMessages = async (a) => {
      acked.push(a);
      return {};
    };
    client.getInbox = async () => ({
      fleet_id: r.fleetId,
      messages: [{ message_id: "msg_malformed_controls_probe" }],
      controls: [null]
    });
    await expect(agent.pollOnce()).resolves.toBeDefined();
    expect(acked).toHaveLength(1);
    expect(acked[0]).toMatchObject([{ message_id: "msg_malformed_controls_probe", status: "received" }]);
  });

  it("logs a string reason verbatim and a fixed placeholder for an omitted or non-string reason; pause is unaffected (#213)", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    const warnings: string[] = [];
    (agent as unknown as { log: { warn: (m: string) => void } }).log = { warn: (m) => warnings.push(m) };
    const client = (agent as unknown as { client: { getInbox: (n: number) => Promise<unknown> } }).client;

    const cases: Array<[unknown[], string]> = [
      [[{ action: "pause", reason: "maintenance window" }], "(maintenance window)"],
      [[{ action: "pause" }], "(no reason given)"],
      [[{ action: "pause", reason: 42 }], "(no reason given)"]
    ];
    for (const [controls, expected] of cases) {
      client.getInbox = async () => ({ fleet_id: r.fleetId, messages: [], controls: [] });
      await agent.pollOnce(); // back to resumed so the next stop logs again
      warnings.length = 0;
      client.getInbox = async () => ({ fleet_id: r.fleetId, messages: [], controls });
      await agent.pollOnce();
      expect(agent.health().status).toBe("paused");
      expect(warnings.some((w) => w.includes("operator control: pause") && w.includes(expected))).toBe(true);
    }
  });

  it("guard: unknown string actions are tolerated and a valid snapshot without a stop still resumes", async () => {
    const r = await relay();
    const agent = await connectAgent(r);
    const client = (agent as unknown as { client: { getInbox: (n: number) => Promise<unknown> } }).client;
    const real = client.getInbox.bind(client);
    await control(r, agent.agentId!, "pause");
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");

    client.getInbox = async () => ({ fleet_id: r.fleetId, messages: [], controls: [{ action: "future-action", reason: "x" }] });
    await agent.pollOnce();
    expect(agent.health().status).toBe("connected");

    client.getInbox = async () => ({ fleet_id: r.fleetId, messages: [], controls: [{ action: "future-action" }, { action: "quarantine", reason: "q" }] });
    await agent.pollOnce();
    expect(agent.health().status).toBe("paused");
    client.getInbox = real;
  });
});

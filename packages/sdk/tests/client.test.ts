import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EkhoAgentClient, EkhoAgentAdapter, INSTANCE_ID, SDK_VERSION, withHeartbeatIdentity } from "../src/index";
import { createTestRelayForSdk } from "./setup";
import http from "node:http";
import { DEAD_LETTER_REASONS } from "../src/index";
import { deadLetterReasons } from "../../relay/src/types";

describe("@drakon-systems/ekho-sdk", () => {
  let relay: Awaited<ReturnType<typeof createTestRelayForSdk>>;

  beforeAll(async () => { relay = await createTestRelayForSdk(); });
  afterAll(() => relay.cleanup());

  describe("EkhoAgentClient", () => {
    it("sends a message and retrieves from inbox", async () => {
      const senderCreds = await relay.enrollAgent("sdk-sender");
      const receiverCreds = await relay.enrollAgent("sdk-receiver");

      const sender = new EkhoAgentClient({
        agentId: senderCreds.agent_id,
        secret: senderCreds.secret,
        relayBaseUrl: senderCreds.relayBaseUrl
      });

      const receiver = new EkhoAgentClient({
        agentId: receiverCreds.agent_id,
        secret: receiverCreds.secret,
        relayBaseUrl: receiverCreds.relayBaseUrl
      });

      const sent = await sender.sendMessage({
        recipient: { kind: "agent", id: receiverCreds.agent_id },
        message_type: "direct",
        body: { text: "sdk test" },
        conversation_id: "sdk-conv-1",
        correlation_id: "sdk-corr-1"
      });
      expect(sent.message_id).toBeTruthy();

      const inbox = await receiver.getInbox();
      expect(inbox.messages).toHaveLength(1);

      const ackResult = await receiver.ackMessages([
        { message_id: sent.message_id, status: "received", received_at: new Date().toISOString() }
      ]);
      expect(ackResult.updated).toBe(1);
    });

    it("opens a topic room and sends into it via a group recipient", async () => {
      const aCreds = await relay.enrollAgent("sdk-room-a");
      const bCreds = await relay.enrollAgent("sdk-room-b");

      const a = new EkhoAgentClient({
        agentId: aCreds.agent_id, secret: aCreds.secret, relayBaseUrl: aCreds.relayBaseUrl
      });
      const b = new EkhoAgentClient({
        agentId: bCreds.agent_id, secret: bCreds.secret, relayBaseUrl: bCreds.relayBaseUrl
      });

      const room = await a.createRoom({ name: "SDK Topic", member_agent_ids: [bCreds.agent_id] });
      expect(room.id).toMatch(/^room_/);
      expect(room.name).toBe("SDK Topic");
      // Creator is auto-added alongside the named member.
      expect(room.members.sort()).toEqual([aCreds.agent_id, bCreds.agent_id].sort());

      await a.sendMessage({
        recipient: { kind: "group", id: room.id },
        message_type: "direct",
        body: { text: "into the room" },
        conversation_id: room.id,
        correlation_id: "sdk-room-corr"
      });

      const inboxB = await b.getInbox();
      expect(inboxB.messages.some((m) => m.body.text === "into the room")).toBe(true);
      expect(inboxB.rooms?.some((r) => r.id === room.id && r.name === "SDK Topic")).toBe(true);
    });

    it("sends heartbeat", async () => {
      const creds = await relay.enrollAgent("sdk-hb");
      const client = new EkhoAgentClient({
        agentId: creds.agent_id,
        secret: creds.secret,
        relayBaseUrl: creds.relayBaseUrl
      });
      const result = await client.heartbeat({ status: "healthy" });
      expect(result.ok).toBe(true);
    });

    // #97: the relay shows what each agent runs.
    it("reports the SDK, its version, Node and a per-process instance id on every heartbeat", async () => {
      const creds = await relay.enrollAgent("sdk-hb-identity");
      const client = new EkhoAgentClient({ agentId: creds.agent_id, secret: creds.secret, relayBaseUrl: creds.relayBaseUrl });
      await client.heartbeat({ status: "healthy" });
      const row = relay.fleetHealth().find((a) => a.id === creds.agent_id)!;
      expect(row.identity).toMatchObject({
        adapter: "sdk",
        adapter_version: SDK_VERSION,
        sdk_version: SDK_VERSION,
        host_runtime: "node",
        host_runtime_version: process.versions.node,
        instance_id: INSTANCE_ID,
        outdated: false
      });
    });

    it("lets a plugin name itself as the adapter without inheriting the SDK's adapter or Node defaults", async () => {
      const creds = await relay.enrollAgent("sdk-hb-plugin");
      const client = new EkhoAgentClient({ agentId: creds.agent_id, secret: creds.secret, relayBaseUrl: creds.relayBaseUrl });
      await client.heartbeat({ status: "healthy", adapter: "openclaw-plugin", adapter_version: "0.8.0" });
      const row = relay.fleetHealth().find((a) => a.id === creds.agent_id)!;
      expect(row.identity).toMatchObject({
        adapter: "openclaw-plugin",
        adapter_version: "0.8.0",
        sdk_version: SDK_VERSION,
        host_runtime: null,
        host_runtime_version: null,
        instance_id: INSTANCE_ID,
        outdated: true
      });
    });

    it("keeps one instance id per loaded SDK and lets the caller override any field", () => {
      expect(INSTANCE_ID).toMatch(/^[0-9a-f-]{36}$/);
      expect(withHeartbeatIdentity({ status: "idle" }).instance_id).toBe(withHeartbeatIdentity({ status: "busy" }).instance_id);
      expect(withHeartbeatIdentity({ status: "idle", sdk_version: "x", instance_id: "mine-12345" })).toMatchObject({
        sdk_version: "x",
        instance_id: "mine-12345"
      });
    });

    it("treats an explicitly undefined identity field as absent", () => {
      const body = withHeartbeatIdentity({ status: "idle", adapter: undefined, adapter_version: undefined, sdk_version: undefined, instance_id: undefined });
      expect(body).toMatchObject({
        status: "idle",
        adapter: "sdk",
        adapter_version: SDK_VERSION,
        sdk_version: SDK_VERSION,
        host_runtime: "node",
        instance_id: INSTANCE_ID
      });
      expect(Object.values(body)).not.toContain(undefined);
    });

    it("raises a stall notice and dedups idempotently", async () => {
      const creds = await relay.enrollAgent("sdk-notice");
      const client = new EkhoAgentClient({
        agentId: creds.agent_id,
        secret: creds.secret,
        relayBaseUrl: creds.relayBaseUrl
      });
      const first = await client.raiseNotice({
        conversation_id: "sdk-stall-conv",
        pending_count: 2,
        budget: 6
      });
      expect(first).toEqual({ ok: true, recorded: true });
      // A repeat for the same conversation is a no-op (still 200).
      const second = await client.raiseNotice({ conversation_id: "sdk-stall-conv" });
      expect(second).toEqual({ ok: true, recorded: false });
    });

    it("rejects invalid credentials", async () => {
      const client = new EkhoAgentClient({
        agentId: "fake-agent",
        secret: "fake-secret",
        relayBaseUrl: relay.baseUrl
      });
      await expect(client.heartbeat({ status: "healthy" })).rejects.toThrow("401");
    });

    it("uploads and downloads an attachment, then binds it to a message", async () => {
      const senderCreds = await relay.enrollAgent("sdk-att-sender");
      const receiverCreds = await relay.enrollAgent("sdk-att-receiver");

      const sender = new EkhoAgentClient({
        agentId: senderCreds.agent_id,
        secret: senderCreds.secret,
        relayBaseUrl: senderCreds.relayBaseUrl
      });
      const receiver = new EkhoAgentClient({
        agentId: receiverCreds.agent_id,
        secret: receiverCreds.secret,
        relayBaseUrl: receiverCreds.relayBaseUrl
      });

      // 1x1 PNG (passes the relay's magic-byte sniff).
      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgAAACAAFUok+eAAAAAElFTkSuQmCC";

      const up = await sender.uploadAttachment({
        filename: "sdk.png",
        mime: "image/png",
        dataBase64: pngB64
      });
      expect(up.id).toMatch(/^att_/);
      expect(up.size_bytes).toBe(Buffer.from(pngB64, "base64").length);

      // Download round-trips the exact bytes.
      const dl = await sender.downloadAttachment(up.id);
      expect(dl.bytes.toString("base64")).toBe(pngB64);
      expect(dl.mime).toContain("image/png");
      expect(dl.filename).toBe("sdk.png");

      // Bind it into a message body and confirm the recipient sees the metadata.
      await sender.sendMessage({
        recipient: { kind: "agent", id: receiverCreds.agent_id },
        message_type: "direct",
        body: { text: "with attachment", attachments: [up.id] },
        conversation_id: "sdk-att-conv",
        correlation_id: "sdk-att-corr"
      });

      const inbox = await receiver.getInbox();
      expect(inbox.messages).toHaveLength(1);
      expect(inbox.messages[0].attachments).toHaveLength(1);
      expect(inbox.messages[0].attachments?.[0]).toMatchObject({
        id: up.id, filename: "sdk.png", mime: "image/png"
      });
    });
  });

  describe("EkhoAgentAdapter", () => {
    it("receives messages via onMessage hook", async () => {
      const senderCreds = await relay.enrollAgent("adapter-sender");
      const receiverCreds = await relay.enrollAgent("adapter-receiver");

      const received: Array<Record<string, unknown>> = [];

      const adapter = new EkhoAgentAdapter(
        {
          agentId: receiverCreds.agent_id,
          secret: receiverCreds.secret,
          relayBaseUrl: receiverCreds.relayBaseUrl,
          pollIntervalSeconds: 1,
          heartbeatIntervalSeconds: 60
        },
        { async onMessage(msg) { received.push(msg as unknown as Record<string, unknown>); } }
      );

      await adapter.start();

      const sender = new EkhoAgentClient({
        agentId: senderCreds.agent_id,
        secret: senderCreds.secret,
        relayBaseUrl: senderCreds.relayBaseUrl
      });

      await sender.sendMessage({
        recipient: { kind: "agent", id: receiverCreds.agent_id },
        message_type: "direct",
        body: { text: "adapter test" },
        conversation_id: "adapter-conv",
        correlation_id: "adapter-corr"
      });

      // Wait for poll + processing
      await new Promise((r) => setTimeout(r, 3000));
      adapter.stop();

      expect(received).toHaveLength(1);
      expect((received[0] as { body: { text: string } }).body.text).toBe("adapter test");
    });
  });
});

describe("EkhoAgentClient.reportDeliveryPhases (#111 S1)", () => {
  let relay: Awaited<ReturnType<typeof createTestRelayForSdk>>;
  beforeAll(async () => { relay = await createTestRelayForSdk(); });
  afterAll(() => relay.cleanup());

  async function pair(tag: string) {
    const s = await relay.enrollAgent(`${tag}-sender`);
    const r = await relay.enrollAgent(`${tag}-recipient`);
    const mk = (c: typeof s) => new EkhoAgentClient({ agentId: c.agent_id, secret: c.secret, relayBaseUrl: c.relayBaseUrl });
    const sender = mk(s);
    const recipient = mk(r);
    const sent = await sender.sendMessage({
      recipient: { kind: "agent", id: r.agent_id },
      message_type: "direct",
      body: { text: "phase test" },
      conversation_id: `${tag}-conv`,
      correlation_id: `${tag}-corr`
    });
    const inbox = await recipient.getInbox();
    expect(inbox.messages).toHaveLength(1);
    return { sender, recipient, messageId: sent.message_id };
  }

  const at = () => new Date().toISOString();

  it("T1: a recipient reports dead_lettered with withheld_by_recipient and gets the counts", async () => {
    const { recipient, messageId } = await pair("t1");
    const res = await recipient.reportDeliveryPhases([
      { message_id: messageId, phase: "dead_lettered", at: at(), reason: "withheld_by_recipient" }
    ]);
    expect(res).toEqual({ recorded: 1, refused: 0 });
  });

  it("T2: optional turn fields reach the relay unchanged", async () => {
    const { recipient, messageId } = await pair("t2");
    const res = await recipient.reportDeliveryPhases([
      { message_id: messageId, phase: "turn_started", at: at(), turn_id: "turn-1", attempt: 1 },
      { message_id: messageId, phase: "turn_ended", at: at(), turn_id: "turn-1", attempt: 1, outcome: "completed" }
    ]);
    expect(res.recorded).toBe(2);
  });

  it("T3: a report for an unknown message id resolves with refused: 1", async () => {
    const { recipient } = await pair("t3");
    const res = await recipient.reportDeliveryPhases([
      { message_id: "no-such-message", phase: "dead_lettered", at: at(), reason: "deadline_passed" }
    ]);
    expect(res).toEqual({ recorded: 0, refused: 1 });
  });

  it("T4: an entry outside the closed set, and an empty list, reject with 400", async () => {
    const { recipient, messageId } = await pair("t4");
    await expect(recipient.reportDeliveryPhases([
      { message_id: messageId, phase: "dead_lettered", at: at(), reason: "not_a_reason" as never }
    ])).rejects.toThrow(/400/);
    await expect(recipient.reportDeliveryPhases([])).rejects.toThrow(/400/);
  });

  it("T5: a relay without the route rejects with 404", async () => {
    const server = http.createServer((_req, res) => { res.statusCode = 404; res.end("not found"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address() as { port: number };
      const client = new EkhoAgentClient({ agentId: "a", secret: "s", relayBaseUrl: `http://127.0.0.1:${addr.port}` });
      await expect(client.reportDeliveryPhases([
        { message_id: "m", phase: "floor_granted", at: at() }
      ])).rejects.toThrow(/404/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("T6: DEAD_LETTER_REASONS equals the relay's deadLetterReasons", () => {
    expect([...DEAD_LETTER_REASONS]).toEqual([...deadLetterReasons]);
  });

  it("R1 (retained): a report by another agent for that delivery is refused, not thrown", async () => {
    const { sender, messageId } = await pair("r1");
    const res = await sender.reportDeliveryPhases([
      { message_id: messageId, phase: "dead_lettered", at: at(), reason: "deadline_passed" }
    ]);
    expect(res).toEqual({ recorded: 0, refused: 1 });
  });
});

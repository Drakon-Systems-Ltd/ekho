import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EkhoAgentClient, EkhoAgentAdapter } from "../src/index";
import { createTestRelayForSdk } from "./setup";

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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// Minimal valid 1x1 PNG (passes the magic-byte sniff).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgAAACAAFUok+eAAAAAElFTkSuQmCC";
const TXT_B64 = Buffer.from("hello world", "utf8").toString("base64");

describe("Attachments", () => {
  let relay: TestRelay;

  beforeEach(async () => { relay = await createTestRelay(); });
  afterEach(() => relay.cleanup());

  describe("agent upload", () => {
    it("uploads a valid PNG and returns metadata (happy path)", async () => {
      const agent = await relay.enrollAgent("att-uploader");
      const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/attachments", {
        filename: "diagram.png",
        mime: "image/png",
        size_bytes: Buffer.from(PNG_B64, "base64").length,
        data_base64: PNG_B64
      });
      expect(res.status).toBe(201);
      expect(res.body.id).toMatch(/^att_/);
      expect(res.body.filename).toBe("diagram.png");
      expect(res.body.mime).toBe("image/png");
      expect(res.body.size_bytes).toBe(Buffer.from(PNG_B64, "base64").length);
      expect(res.body.created_at).toBeTruthy();
    });

    it("uploads a text doc (not byte-sniffed)", async () => {
      const agent = await relay.enrollAgent("att-doc");
      const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/attachments", {
        filename: "notes.txt",
        mime: "text/plain",
        size_bytes: Buffer.from(TXT_B64, "base64").length,
        data_base64: TXT_B64
      });
      expect(res.status).toBe(201);
      expect(res.body.mime).toBe("text/plain");
    });

    it("sanitizes a path-traversal filename", async () => {
      const agent = await relay.enrollAgent("att-traversal");
      const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/attachments", {
        filename: "../../etc/passwd",
        mime: "text/plain",
        size_bytes: Buffer.from(TXT_B64, "base64").length,
        data_base64: TXT_B64
      });
      expect(res.status).toBe(201);
      // basename strips the dir; leading dots removed → "passwd".
      expect(res.body.filename).toBe("passwd");
      expect(res.body.filename).not.toContain("/");
      expect(res.body.filename).not.toContain("..");
    });

    it("rejects a disallowed mime with 415", async () => {
      const agent = await relay.enrollAgent("att-badmime");
      const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/attachments", {
        filename: "evil.exe",
        mime: "application/x-msdownload",
        size_bytes: Buffer.from(TXT_B64, "base64").length,
        data_base64: TXT_B64
      });
      expect(res.status).toBe(415);
    });

    it("rejects an oversize declared size with 413", async () => {
      const agent = await relay.enrollAgent("att-bigdeclared");
      const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/attachments", {
        filename: "huge.png",
        mime: "image/png",
        size_bytes: 26 * 1024 * 1024, // over the 25 MiB cap
        data_base64: PNG_B64
      });
      expect(res.status).toBe(413);
    });

    it("rejects bytes that don't match the declared image type with 415", async () => {
      const agent = await relay.enrollAgent("att-sniff");
      const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/attachments", {
        filename: "fake.png",
        mime: "image/png",
        size_bytes: Buffer.from(TXT_B64, "base64").length,
        data_base64: TXT_B64 // "hello world" is not a PNG
      });
      expect(res.status).toBe(415);
    });

    it("rejects malformed base64 with 400", async () => {
      const agent = await relay.enrollAgent("att-badb64");
      const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/attachments", {
        filename: "x.txt",
        mime: "text/plain",
        size_bytes: 4,
        data_base64: "!!!not base64!!!"
      });
      expect(res.status).toBe(400);
    });
  });

  describe("agent download + fleet isolation", () => {
    it("round-trips an uploaded attachment's bytes", async () => {
      const agent = await relay.enrollAgent("att-rt");
      const up = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/attachments", {
        filename: "rt.png",
        mime: "image/png",
        size_bytes: Buffer.from(PNG_B64, "base64").length,
        data_base64: PNG_B64
      });
      const id = up.body.id;

      const dl = await relay.app.inject({
        method: "GET",
        url: `/v1/attachments/${id}`,
        headers: relaySignedAgentHeaders(agent.agent_id, agent.secret, `/v1/attachments/${id}`)
      });
      expect(dl.statusCode).toBe(200);
      expect(dl.headers["content-type"]).toContain("image/png");
      expect(dl.headers["content-disposition"]).toContain("attachment");
      expect(dl.headers["x-content-type-options"]).toBe("nosniff");
      // Bytes match.
      expect(Buffer.from(dl.rawPayload).toString("base64")).toBe(PNG_B64);
    });

    it("blocks cross-fleet download with 404 (never 403)", async () => {
      // Fleet A uploads.
      const agentA = await relay.enrollAgent("att-fleetA");
      const up = await relay.agentRequest(agentA.agent_id, agentA.secret, "POST", "/v1/attachments", {
        filename: "secret.txt",
        mime: "text/plain",
        size_bytes: Buffer.from(TXT_B64, "base64").length,
        data_base64: TXT_B64
      });
      const id = up.body.id;

      // A second fleet with its own agent.
      const other = await createTestRelay();
      try {
        const agentB = await other.enrollAgent("att-fleetB");
        const dl = await other.app.inject({
          method: "GET",
          url: `/v1/attachments/${id}`,
          headers: relaySignedAgentHeaders(agentB.agent_id, agentB.secret, `/v1/attachments/${id}`)
        });
        expect(dl.statusCode).toBe(404);
      } finally {
        other.cleanup();
      }
    });

    it("404s an unknown attachment id", async () => {
      const agent = await relay.enrollAgent("att-missing");
      const dl = await relay.app.inject({
        method: "GET",
        url: "/v1/attachments/att_does_not_exist",
        headers: relaySignedAgentHeaders(agent.agent_id, agent.secret, "/v1/attachments/att_does_not_exist")
      });
      expect(dl.statusCode).toBe(404);
    });
  });

  describe("message binding + surfacing", () => {
    it("agent: upload → bind in body.attachments → surfaced in recipient inbox", async () => {
      const sender = await relay.enrollAgent("bind-sender");
      const receiver = await relay.enrollAgent("bind-receiver");

      const up = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/attachments", {
        filename: "shared.png",
        mime: "image/png",
        size_bytes: Buffer.from(PNG_B64, "base64").length,
        data_base64: PNG_B64
      });
      const attId = up.body.id;

      const send = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "here is a file", attachments: [attId] },
        conversation_id: "conv-att",
        correlation_id: "corr-att"
      });
      expect(send.status).toBe(200);

      const inbox = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
      expect(inbox.body.messages).toHaveLength(1);
      const msg = inbox.body.messages[0];
      expect(msg.body.attachments).toEqual([attId]);
      // Resolved metadata array — never bytes.
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0]).toMatchObject({ id: attId, filename: "shared.png", mime: "image/png" });
      expect(msg.attachments[0]).not.toHaveProperty("data_base64");
      expect(msg.attachments[0]).not.toHaveProperty("storage_path");
    });

    it("rejects binding an attachment the sender does not own (404)", async () => {
      const owner = await relay.enrollAgent("owner");
      const thief = await relay.enrollAgent("thief");
      const receiver = await relay.enrollAgent("bind-recv2");

      const up = await relay.agentRequest(owner.agent_id, owner.secret, "POST", "/v1/attachments", {
        filename: "owned.txt",
        mime: "text/plain",
        size_bytes: Buffer.from(TXT_B64, "base64").length,
        data_base64: TXT_B64
      });

      // Thief tries to attach the owner's attachment id.
      const send = await relay.agentRequest(thief.agent_id, thief.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "stolen", attachments: [up.body.id] },
        conversation_id: "conv-steal",
        correlation_id: "corr-steal"
      });
      expect(send.status).toBe(404);
    });

    it("operator: upload → message with attachment_ids → surfaced in conversation", async () => {
      const receiver = await relay.enrollAgent("op-att-recv");

      const up = await relay.operatorRequest("POST", "/v1/operator/attachments", {
        filename: "report.pdf",
        mime: "application/pdf",
        size_bytes: Buffer.from(TXT_B64, "base64").length,
        data_base64: TXT_B64 // pdf is not byte-sniffed
      });
      expect(up.status).toBe(201);
      const attId = up.body.id;

      const msg = await relay.operatorRequest("POST", "/v1/operator/messages", {
        recipient_agent_id: receiver.agent_id,
        text: "see attached",
        attachment_ids: [attId]
      });
      expect(msg.status).toBe(201);
      const conversationId = msg.body.conversation_id;

      // Recipient sees the metadata in its inbox.
      const inbox = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
      expect(inbox.body.messages[0].attachments[0]).toMatchObject({ id: attId, filename: "report.pdf", mime: "application/pdf" });

      // Conversation timeline carries message_attachments on the message event.
      const convo = await relay.operatorRequest("GET", `/v1/operator/conversations/${conversationId}`);
      const withAtt = convo.body.events.find((e: Record<string, unknown>) => Array.isArray(e.message_attachments));
      expect(withAtt).toBeTruthy();
      expect((withAtt.message_attachments as Array<Record<string, unknown>>)[0]).toMatchObject({ id: attId, filename: "report.pdf" });
    });

    it("operator: 404 when binding an attachment not owned by the operator", async () => {
      const agent = await relay.enrollAgent("agent-owns-it");
      const receiver = await relay.enrollAgent("op-recv-3");
      // Agent uploads (uploader_id = agent, not operator).
      const up = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/attachments", {
        filename: "agentfile.txt",
        mime: "text/plain",
        size_bytes: Buffer.from(TXT_B64, "base64").length,
        data_base64: TXT_B64
      });
      const res = await relay.operatorRequest("POST", "/v1/operator/messages", {
        recipient_agent_id: receiver.agent_id,
        text: "trying to attach agent's file",
        attachment_ids: [up.body.id]
      });
      expect(res.status).toBe(404);
    });
  });
});

// Build agent auth headers for a raw app.inject GET (download routes return
// raw bytes, so we can't use the JSON-parsing agentRequest helper).
function relaySignedAgentHeaders(agentId: string, secret: string, urlPath: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const sha256 = (input: string) => crypto.createHash("sha256").update(input).digest("hex");
  const payload = `GET\n${urlPath}\n${timestamp}\n${nonce}\n${sha256("")}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return {
    "content-type": "application/json",
    "x-ekho-agent-id": agentId,
    "x-ekho-agent-secret": secret,
    "x-ekho-timestamp": timestamp,
    "x-ekho-nonce": nonce,
    "x-ekho-signature": signature
  };
}

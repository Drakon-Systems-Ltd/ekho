import { describe, it, expect } from "vitest";
import { createTestRelay } from "./setup";

describe("delivered attachment recovery (#113)", () => {
  it("reads an acked delivered message and its bytes without consuming another inbox row, scoped to the recipient", async () => {
    const relay = await createTestRelay();
    try {
      const sender = await relay.enrollAgent("sender");
      const recipient = await relay.enrollAgent("recipient");
      const stranger = await relay.enrollAgent("stranger");
      const bytes = Buffer.from("cold attachment");
      const up = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/attachments", {
        filename: "evidence.txt", mime: "text/plain", size_bytes: bytes.length, data_base64: bytes.toString("base64")
      });
      const send = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: recipient.agent_id }, message_type: "direct",
        body: { text: "please inspect", attachments: [up.body.id] },
        conversation_id: "conv-recovery", correlation_id: "corr-recovery"
      });
      expect(send.status).toBe(200);
      const id = send.body.message_id;
      const messagePath = `/v1/delivered-messages/${id}`;
      const filePath = `${messagePath}/attachments/${up.body.id}`;
      expect((await relay.agentRequest(recipient.agent_id, recipient.secret, "GET", messagePath)).status).toBe(404);
      expect((await relay.agentRequest(recipient.agent_id, recipient.secret, "GET", "/v1/inbox")).body.messages).toHaveLength(1);
      const ack = await relay.agentRequest(recipient.agent_id, recipient.secret, "POST", "/v1/acks", {
        acks: [{ message_id: id, status: "received", received_at: new Date().toISOString() }]
      });
      expect(ack.status).toBe(200);
      const recovered = await relay.agentRequest(recipient.agent_id, recipient.secret, "GET", messagePath);
      expect(recovered.status).toBe(200);
      expect(recovered.body.message).toMatchObject({ message_id: id, body: { attachments: [up.body.id] }, attachments: [{ id: up.body.id }] });
      const file = await relay.app.inject({ method: "GET", url: filePath, headers: relay.signedHeaders(recipient.agent_id, recipient.secret, "GET", filePath, "") });
      expect(file.statusCode).toBe(200);
      expect(file.rawPayload).toEqual(bytes);
      expect((await relay.agentRequest(stranger.agent_id, stranger.secret, "GET", messagePath)).status).toBe(404);
      const foreignFile = await relay.app.inject({ method: "GET", url: filePath, headers: relay.signedHeaders(stranger.agent_id, stranger.secret, "GET", filePath, "") });
      expect(foreignFile.statusCode).toBe(404);
      const { fleetId, operatorId } = relay.db.createBootstrap(`other-recovery-${Date.now()}`, "other-recovery@example.test", "testpassword1");
      const token = relay.db.issueEnrollmentToken(fleetId, operatorId);
      const otherResponse = await relay.app.inject({ method: "POST", url: "/v1/enroll", payload: { fleet_id: fleetId, token, display_name: "other-fleet", runtime: "custom" } });
      expect(otherResponse.statusCode).toBe(200);
      const other = otherResponse.json() as { agent_id: string; secret: string };
      expect((await relay.agentRequest(other.agent_id, other.secret, "GET", messagePath)).status).toBe(404);
      const otherFile = await relay.app.inject({ method: "GET", url: filePath, headers: relay.signedHeaders(other.agent_id, other.secret, "GET", filePath, "") });
      expect(otherFile.statusCode).toBe(404);
      const wrongFilePath = `${messagePath}/attachments/att_not_bound`;
      const wrongFile = await relay.app.inject({ method: "GET", url: wrongFilePath, headers: relay.signedHeaders(recipient.agent_id, recipient.secret, "GET", wrongFilePath, "") });
      expect(wrongFile.statusCode).toBe(404);
      expect((await relay.agentRequest(recipient.agent_id, recipient.secret, "GET", "/v1/inbox")).body.messages).toHaveLength(0);
    } finally { relay.cleanup(); }
  });

  it("does not treat an old room delivery as permission to recover after membership ends", async () => {
    const relay = await createTestRelay();
    try {
      const member = await relay.enrollAgent("member");
      const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
        name: "Recovery room", member_agent_ids: [member.agent_id]
      })).body as { id: string };
      const sent = await relay.operatorRequest("POST", "/v1/operator/messages", {
        room_id: room.id, text: "room handoff"
      });
      expect(sent.status).toBe(201);
      const id = sent.body.message_id as string;
      expect((await relay.agentRequest(member.agent_id, member.secret, "GET", "/v1/inbox")).body.messages).toHaveLength(1);
      expect((await relay.agentRequest(member.agent_id, member.secret, "GET", `/v1/delivered-messages/${id}`)).status).toBe(200);
      relay.db.raw().prepare("DELETE FROM room_members WHERE room_id = ? AND agent_id = ?").run(room.id, member.agent_id);
      expect((await relay.agentRequest(member.agent_id, member.secret, "GET", `/v1/delivered-messages/${id}`)).status).toBe(404);
    } finally { relay.cleanup(); }
  });
});

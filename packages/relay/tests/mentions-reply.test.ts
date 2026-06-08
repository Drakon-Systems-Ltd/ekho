import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// Phase 1 of "multi-agent room clarity": the relay carries @mentions + reply-to
// on messages and serves recent room history, so agents stop answering for each
// other and stop saying "I don't have that in this message context".
describe("mentions, reply-to, and room history", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  it("carries operator @mentions through to the inbox message", async () => {
    const a = await relay.enrollAgent("m-a");
    const b = await relay.enrollAgent("m-b");
    const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
      name: "M",
      member_agent_ids: [a.agent_id, b.agent_id]
    })).body;

    await relay.operatorRequest("POST", "/v1/operator/messages", {
      room_id: room.id,
      text: "where did you get to?",
      mentions: [a.agent_id]
    });

    const inboxA = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
    const msg = inboxA.body.messages.find((m: { body: { text: string } }) => m.body.text.includes("where did you get to"));
    expect(msg).toBeTruthy();
    expect(msg.mentions).toEqual([a.agent_id]);

    // The non-mentioned member still receives it, also carrying the mentions list
    // (so its plugin can choose to defer to the addressed agent).
    const inboxB = await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
    const msgB = inboxB.body.messages.find((m: { body: { text: string } }) => m.body.text.includes("where did you get to"));
    expect(msgB.mentions).toEqual([a.agent_id]);
  });

  it("defaults mentions to an empty array when none are given", async () => {
    const a = await relay.enrollAgent("m0-a");
    await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: a.agent_id, text: "plain" });
    const inbox = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
    expect(inbox.body.messages[0].mentions).toEqual([]);
  });

  it("resolves reply_to into a quoted snapshot of the referenced message", async () => {
    const a = await relay.enrollAgent("r-a");
    const first = (await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: a.agent_id,
      text: "original question"
    })).body;

    await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: a.agent_id,
      text: "follow-up",
      reply_to: first.message_id
    });

    const inbox = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
    const reply = inbox.body.messages.find((m: { body: { text: string } }) => m.body.text === "follow-up");
    expect(reply.reply_to).toBeTruthy();
    expect(reply.reply_to.message_id).toBe(first.message_id);
    expect(reply.reply_to.text).toBe("original question");
    expect(reply.reply_to.sender_kind).toBe("operator");

    // A message without reply_to surfaces null, not a dangling object.
    const plain = inbox.body.messages.find((m: { body: { text: string } }) => m.body.text === "original question");
    expect(plain.reply_to).toBeNull();
  });

  it("serves recent room conversation_history so agents see the thread", async () => {
    const a = await relay.enrollAgent("h-a");
    const b = await relay.enrollAgent("h-b");
    const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
      name: "H",
      member_agent_ids: [a.agent_id, b.agent_id]
    })).body;

    await relay.operatorRequest("POST", "/v1/operator/messages", { room_id: room.id, text: "first" });
    await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: a.agent_id },
      message_type: "direct",
      body: { text: "b reply" },
      conversation_id: room.id,
      correlation_id: "h-c1"
    });
    await relay.operatorRequest("POST", "/v1/operator/messages", { room_id: room.id, text: "second" });

    const inboxA = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
    const history = inboxA.body.conversation_history?.[room.id];
    expect(history).toBeTruthy();
    const texts = history.map((h: { text: string }) => h.text);
    expect(texts).toContain("first");
    expect(texts).toContain("b reply");
    expect(texts).toContain("second");
    // History is chronological and tags who said what.
    const bEntry = history.find((h: { text: string }) => h.text === "b reply");
    expect(bEntry.sender_kind).toBe("agent");
    expect(bEntry.sender_agent_id).toBe(b.agent_id);
  });

  it("omits conversation_history for non-room (direct) conversations", async () => {
    const a = await relay.enrollAgent("d-a");
    await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: a.agent_id, text: "direct only" });
    const inbox = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
    expect(inbox.body.conversation_history).toEqual({});
  });
});

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
      text: "original question",
      conversation_id: "conv-thread"
    })).body;

    // A reply lives in the SAME conversation/thread as the message it answers.
    await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: a.agent_id,
      text: "follow-up",
      conversation_id: "conv-thread",
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

  it("never leaks a reply_to snapshot from another conversation (IDOR guard)", async () => {
    const a = await relay.enrollAgent("leak-a");
    const b = await relay.enrollAgent("leak-b");
    // A private operator→A thread B is not part of.
    const secret = (await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: a.agent_id,
      text: "secret meant only for A",
      conversation_id: "private-A"
    })).body;
    // Operator messages B, referencing the private message from a DIFFERENT thread.
    await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: b.agent_id,
      text: "to B",
      conversation_id: "thread-B",
      reply_to: secret.message_id
    });

    const inboxB = await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
    const msg = inboxB.body.messages.find((m: { body: { text: string } }) => m.body.text === "to B");
    // Cross-conversation reference resolves to null — B never sees A's secret.
    expect(msg.reply_to).toBeNull();
    expect(JSON.stringify(inboxB.body)).not.toContain("secret meant only for A");
  });

  it("serves recent room conversation_history so agents see the thread", async () => {
    const a = await relay.enrollAgent("h-a");
    const b = await relay.enrollAgent("h-b");
    const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
      name: "H",
      member_agent_ids: [a.agent_id, b.agent_id]
    })).body;

    await relay.operatorRequest("POST", "/v1/operator/messages", { room_id: room.id, text: "first" });
    // Addressed to the room, not to A — an agent-addressed send under a room
    // conversation_id is refused since #12 (it would reach members whose
    // verifiers reject it).
    await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/messages", {
      recipient: { kind: "group", id: room.id },
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
    // #20 leftover: snapshots now carry the same signature fields as inbox
    // deliveries, so a plugin can verify history instead of only labelling it
    // [unverified]. Unsigned rows still have the keys, with null values.
    expect(bEntry).toHaveProperty("operator_sig");
    expect(bEntry).toHaveProperty("agent_sig");
    expect(bEntry).toHaveProperty("key_id");
    expect(bEntry).toHaveProperty("sig_canonical");
  });

  it("never serves room history to a non-member (history IDOR guard)", async () => {
    const member = await relay.enrollAgent("hm-member");
    const out1 = await relay.enrollAgent("hm-out1");
    const out2 = await relay.enrollAgent("hm-out2");
    const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
      name: "HM",
      member_agent_ids: [member.agent_id]
    })).body;
    await relay.operatorRequest("POST", "/v1/operator/messages", { room_id: room.id, text: "room-only secret" });

    // out1 (not a member) sends out2 (not a member) a message tagged with the
    // room's conversation_id, trying to make out2's inbox cough up the room thread.
    await relay.agentRequest(out1.agent_id, out1.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: out2.agent_id },
      message_type: "direct",
      body: { text: "probe" },
      conversation_id: room.id,
      correlation_id: "hm-probe"
    });

    const inboxOut = await relay.agentRequest(out2.agent_id, out2.secret, "GET", "/v1/inbox");
    expect(inboxOut.body.conversation_history[room.id]).toBeUndefined();
    expect(JSON.stringify(inboxOut.body)).not.toContain("room-only secret");
  });

  it("omits conversation_history for non-room (direct) conversations", async () => {
    const a = await relay.enrollAgent("d-a");
    await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: a.agent_id, text: "direct only" });
    const inbox = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
    expect(inbox.body.conversation_history).toEqual({});
  });
});

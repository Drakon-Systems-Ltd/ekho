import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// Bounded delegation already escalates a budget-stalled thread as a
// `conversation.stalled` event. These lock in the OPERATOR half of the loop:
// one-click resume (a relay-minted nudge that re-opens every participant's
// latch and re-arms the stall escalation), and project mode — a higher
// per-room budget for designated working rooms, off by default.
describe("resume + project mode", () => {
  let relay: TestRelay;
  let a: { agent_id: string; secret: string };
  let b: { agent_id: string; secret: string };
  let roomId: string;

  beforeEach(async () => {
    relay = await createTestRelay();
    a = await relay.enrollAgent("Alpha");
    b = await relay.enrollAgent("Beta");
    const res = await relay.operatorRequest("POST", "/v1/operator/rooms", {
      name: "warroom",
      member_agent_ids: [a.agent_id, b.agent_id]
    });
    roomId = res.body.id as string;
  });

  describe("resume", () => {
    it("resumes a room: every member gets an operator nudge in the same conversation", async () => {
      const res = await relay.operatorRequest("POST", `/v1/operator/conversations/${roomId}/resume`, {});
      expect(res.status).toBe(201);
      expect(res.body.conversation_id).toBe(roomId);

      for (const agent of [a, b]) {
        const inbox = await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox");
        const nudge = (inbox.body.messages as Array<Record<string, unknown>>).find(
          (m) => m.conversation_id === roomId && m.sender_kind === "operator"
        );
        expect(nudge).toBeTruthy();
        expect(String((nudge!.body as Record<string, unknown>).text)).toMatch(/resum/i);
      }

      const conv = relay.db.getConversation(relay.fleetId, roomId, { limit: 50, offset: 0 });
      expect(conv.items.some((i: Record<string, unknown>) => i.event_type === "conversation.resumed")).toBe(true);
    });

    it("resumes an agent↔agent thread: both participants get the nudge", async () => {
      await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: b.agent_id },
        message_type: "direct",
        body: { text: "let's plan the upgrade" },
        conversation_id: "conv-project-1",
        correlation_id: "corr-project-1"
      });

      const res = await relay.operatorRequest("POST", "/v1/operator/conversations/conv-project-1/resume", {});
      expect(res.status).toBe(201);
      expect(res.body.conversation_id).toBe("conv-project-1");

      for (const agent of [a, b]) {
        const inbox = await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox");
        const nudge = (inbox.body.messages as Array<Record<string, unknown>>).find(
          (m) => m.conversation_id === "conv-project-1" && m.sender_kind === "operator"
        );
        expect(nudge).toBeTruthy();
      }
    });

    it("404s on a conversation nobody participates in", async () => {
      const res = await relay.operatorRequest("POST", "/v1/operator/conversations/conv-ghost/resume", {});
      expect(res.status).toBe(404);
    });

    it("re-arms the once-per-close stall escalation (operator-engagement boundary)", async () => {
      // The boundary compare is strict (>) on ms-precision timestamps; in real
      // use stalls trail operator activity by minutes. Separate the beats here.
      const tick = () => new Promise((r) => setTimeout(r, 10));

      // First stall records; a repeat while still closed is deduped.
      await tick(); // clear of the room.created operator event
      expect(relay.db.recordConversationStall(relay.fleetId, a.agent_id, roomId, { reason: "peer_budget_exhausted", pending_count: 1, budget: 6 }).recorded).toBe(true);
      expect(relay.db.recordConversationStall(relay.fleetId, a.agent_id, roomId, { reason: "peer_budget_exhausted", pending_count: 2, budget: 6 }).recorded).toBe(false);

      // Resume = operator engagement in the conversation -> boundary moves...
      const res = await relay.operatorRequest("POST", `/v1/operator/conversations/${roomId}/resume`, {});
      expect(res.status).toBe(201);

      // ...so a later stall of the SAME conversation escalates again.
      await tick();
      expect(relay.db.recordConversationStall(relay.fleetId, a.agent_id, roomId, { reason: "peer_budget_exhausted", pending_count: 1, budget: 6 }).recorded).toBe(true);
    });
  });

  describe("project mode", () => {
    it("defaults OFF (budget 100) and toggles via the operator endpoint", async () => {
      let rooms = (await relay.operatorRequest("GET", "/v1/operator/rooms")).body.rooms as Array<Record<string, unknown>>;
      let room = rooms.find((r) => r.id === roomId)!;
      expect(room.project_mode).toBe(false);
      expect(room.project_turn_budget).toBe(100);

      const res = await relay.operatorRequest("POST", `/v1/operator/rooms/${roomId}/project-mode`, {
        enabled: true,
        budget: 150
      });
      expect(res.status).toBe(200);
      expect(res.body.project_mode).toBe(true);
      expect(res.body.project_turn_budget).toBe(150);

      rooms = (await relay.operatorRequest("GET", "/v1/operator/rooms")).body.rooms as Array<Record<string, unknown>>;
      room = rooms.find((r) => r.id === roomId)!;
      expect(room.project_mode).toBe(true);
      expect(room.project_turn_budget).toBe(150);
    });

    it("delivers conversation_budgets to members only, and clears when disabled", async () => {
      await relay.operatorRequest("POST", `/v1/operator/rooms/${roomId}/project-mode`, { enabled: true, budget: 150 });

      const memberInbox = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      expect(memberInbox.body.conversation_budgets).toEqual({ [roomId]: 150 });

      const c = await relay.enrollAgent("Gamma"); // not a member
      const outsiderInbox = await relay.agentRequest(c.agent_id, c.secret, "GET", "/v1/inbox");
      expect(outsiderInbox.body.conversation_budgets ?? {}).toEqual({});

      await relay.operatorRequest("POST", `/v1/operator/rooms/${roomId}/project-mode`, { enabled: false });
      const after = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      expect(after.body.conversation_budgets ?? {}).toEqual({});
    });

    it("enables with the 100 default when budget is omitted; rejects invalid budgets and unknown rooms", async () => {
      const res = await relay.operatorRequest("POST", `/v1/operator/rooms/${roomId}/project-mode`, { enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.project_turn_budget).toBe(100);

      const bad = await relay.operatorRequest("POST", `/v1/operator/rooms/${roomId}/project-mode`, {
        enabled: true,
        budget: 0
      });
      expect(bad.status).toBe(400);

      const missing = await relay.operatorRequest("POST", "/v1/operator/rooms/room_nope/project-mode", { enabled: true });
      expect(missing.status).toBe(404);
    });
  });

  describe("default peer budget", () => {
    it("newly enrolled agents start with a 25-turn peer budget", async () => {
      const inbox = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      expect(inbox.body.peer_turn_budget).toBe(25);
    });
  });
});

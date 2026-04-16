import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

describe("A2A protocol integration", () => {
  let relay: TestRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  describe("agent cards", () => {
    it("serves fleet-level agent card at /.well-known/agent-card.json", async () => {
      // Enroll at least one agent so the fleet card has a skill
      await relay.enrollAgent("fleet-card-agent");

      const res = await relay.app.inject({ method: "GET", url: "/.well-known/agent-card.json" });
      expect(res.statusCode).toBe(200);
      const card = JSON.parse(res.body);
      expect(card.protocolVersion).toBe("0.3.0");
      expect(card.preferredTransport).toBe("JSONRPC");
      expect(card.capabilities.streaming).toBe(true);
      expect(Array.isArray(card.skills)).toBe(true);
      expect(card.skills.length).toBeGreaterThan(0);
    });

    it("serves per-agent card at /agents/{id}/.well-known/agent-card.json", async () => {
      const agent = await relay.enrollAgent("per-agent-card");
      const res = await relay.app.inject({
        method: "GET",
        url: `/agents/${agent.agent_id}/.well-known/agent-card.json`,
      });
      expect(res.statusCode).toBe(200);
      const card = JSON.parse(res.body);
      expect(card.url).toContain(`/agents/${agent.agent_id}/a2a`);
      expect(card.skills[0].id).toBe("message");
    });

    it("returns 404 for unknown agent card", async () => {
      const res = await relay.app.inject({
        method: "GET",
        url: "/agents/agent_nonexistent/.well-known/agent-card.json",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("message/send", () => {
    it("creates a task when sending to a per-agent endpoint", async () => {
      const sender = await relay.enrollAgent("a2a-sender");
      const receiver = await relay.enrollAgent("a2a-receiver");

      const res = await relay.agentRequest(
        sender.agent_id,
        sender.secret,
        "POST",
        `/agents/${receiver.agent_id}/a2a`,
        {
          jsonrpc: "2.0",
          id: "r1",
          method: "message/send",
          params: {
            message: {
              messageId: "msg_abc",
              role: "user",
              parts: [{ kind: "text", text: "hello a2a" }],
              kind: "message",
            },
          },
        }
      );

      expect(res.status).toBe(200);
      expect(res.body.jsonrpc).toBe("2.0");
      expect(res.body.id).toBe("r1");
      expect(res.body.result.kind).toBe("task");
      expect(res.body.result.status.state).toBe("submitted");
      expect(res.body.result.id).toMatch(/^task_/);
    });

    it("links A2A task to underlying Ekho message (inbox delivery)", async () => {
      const sender = await relay.enrollAgent("a2a-link-sender");
      const receiver = await relay.enrollAgent("a2a-link-receiver");

      await relay.agentRequest(
        sender.agent_id,
        sender.secret,
        "POST",
        `/agents/${receiver.agent_id}/a2a`,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "message/send",
          params: {
            message: {
              messageId: "msg_link",
              role: "user",
              parts: [{ kind: "text", text: "delivered via ekho" }],
              kind: "message",
            },
          },
        }
      );

      const inbox = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
      expect(inbox.body.messages).toHaveLength(1);
      expect(inbox.body.messages[0].message_type).toBe("a2a.message");
      expect(inbox.body.messages[0].body.a2a).toBe(true);
    });

    it("rejects unknown method with JSON-RPC error code -32601", async () => {
      const agent = await relay.enrollAgent("rpc-method-miss");
      const res = await relay.agentRequest(
        agent.agent_id,
        agent.secret,
        "POST",
        `/agents/${agent.agent_id}/a2a`,
        {
          jsonrpc: "2.0",
          id: 99,
          method: "not/a/method",
          params: {},
        }
      );
      expect(res.status).toBe(200);
      expect(res.body.error.code).toBe(-32601);
    });
  });

  describe("tasks/get, tasks/list, tasks/cancel", () => {
    it("retrieves, lists and cancels tasks", async () => {
      const sender = await relay.enrollAgent("tg-sender");
      const receiver = await relay.enrollAgent("tg-receiver");

      const sendRes = await relay.agentRequest(
        sender.agent_id,
        sender.secret,
        "POST",
        `/agents/${receiver.agent_id}/a2a`,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "message/send",
          params: {
            message: {
              messageId: "msg_1",
              role: "user",
              parts: [{ kind: "text", text: "first" }],
              kind: "message",
            },
          },
        }
      );
      const taskId = sendRes.body.result.id;
      expect(taskId).toMatch(/^task_/);

      // tasks/get
      const getRes = await relay.agentRequest(
        sender.agent_id,
        sender.secret,
        "POST",
        `/agents/${receiver.agent_id}/a2a`,
        { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: taskId } }
      );
      expect(getRes.body.result.id).toBe(taskId);
      expect(getRes.body.result.history.length).toBeGreaterThan(0);

      // tasks/list
      const listRes = await relay.agentRequest(
        sender.agent_id,
        sender.secret,
        "POST",
        `/agents/${receiver.agent_id}/a2a`,
        { jsonrpc: "2.0", id: 3, method: "tasks/list", params: { limit: 10 } }
      );
      expect(listRes.body.result.total).toBeGreaterThan(0);
      expect(listRes.body.result.tasks[0].id).toBe(taskId);

      // tasks/cancel
      const cancelRes = await relay.agentRequest(
        sender.agent_id,
        sender.secret,
        "POST",
        `/agents/${receiver.agent_id}/a2a`,
        { jsonrpc: "2.0", id: 4, method: "tasks/cancel", params: { id: taskId } }
      );
      expect(cancelRes.body.result.status.state).toBe("canceled");

      // Second cancel fails with A2A code
      const cancelAgain = await relay.agentRequest(
        sender.agent_id,
        sender.secret,
        "POST",
        `/agents/${receiver.agent_id}/a2a`,
        { jsonrpc: "2.0", id: 5, method: "tasks/cancel", params: { id: taskId } }
      );
      expect(cancelAgain.body.error.code).toBe(-32002);
    });
  });

  describe("JSON-RPC validation", () => {
    it("rejects non-2.0 jsonrpc version", async () => {
      const agent = await relay.enrollAgent("jsonrpc-validate");
      const res = await relay.agentRequest(
        agent.agent_id,
        agent.secret,
        "POST",
        `/agents/${agent.agent_id}/a2a`,
        { jsonrpc: "1.0", method: "message/send", params: {} }
      );
      expect(res.body.error.code).toBe(-32600);
    });
  });
});

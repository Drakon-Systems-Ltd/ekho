import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

describe("Relay integration", () => {
  let relay: TestRelay;

  beforeEach(async () => { relay = await createTestRelay(); });
  afterEach(() => relay.cleanup());

  describe("enrollment", () => {
    it("enrolls an agent with a valid token", async () => {
      const agent = await relay.enrollAgent("test-agent");
      expect(agent.agent_id).toMatch(/^agent_/);
      expect(agent.secret).toBeTruthy();
    });

    it("rejects invalid token", async () => {
      const res = await relay.app.inject({
        method: "POST",
        url: "/v1/enroll",
        payload: { fleet_id: relay.fleetId, token: "bad-token", display_name: "bad", runtime: "custom" }
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("message lifecycle", () => {
    it("sends and delivers a message", async () => {
      const sender = await relay.enrollAgent("sender");
      const receiver = await relay.enrollAgent("receiver");

      const sendRes = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        priority: "normal",
        body: { text: "hello" },
        conversation_id: "conv-1",
        correlation_id: "corr-1"
      });
      expect(sendRes.status).toBe(200);
      expect(sendRes.body.message_id).toMatch(/^msg_/);

      const inboxRes = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
      expect(inboxRes.status).toBe(200);
      expect(inboxRes.body.messages).toHaveLength(1);
      expect(inboxRes.body.messages[0].body.text).toBe("hello");
    });

    it("acks a message", async () => {
      const sender = await relay.enrollAgent("sender");
      const receiver = await relay.enrollAgent("receiver");

      const sendRes = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "ack me" },
        conversation_id: "conv-ack",
        correlation_id: "corr-ack"
      });

      await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");

      const ackRes = await relay.agentRequest(receiver.agent_id, receiver.secret, "POST", "/v1/acks", {
        acks: [{ message_id: sendRes.body.message_id, status: "received", received_at: new Date().toISOString() }]
      });
      expect(ackRes.status).toBe(200);
      expect(ackRes.body.updated).toBe(1);
    });

    it("does not deliver to wrong agent", async () => {
      const sender = await relay.enrollAgent("sender");
      const receiver = await relay.enrollAgent("receiver");
      const other = await relay.enrollAgent("other");

      await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "private" },
        conversation_id: "conv-private",
        correlation_id: "corr-private"
      });

      const otherInbox = await relay.agentRequest(other.agent_id, other.secret, "GET", "/v1/inbox");
      expect(otherInbox.body.messages).toHaveLength(0);
    });
  });

  describe("heartbeat", () => {
    it("records heartbeat", async () => {
      const agent = await relay.enrollAgent("hb-agent");
      const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/heartbeats", {
        status: "healthy",
        active_conversation_ids: [],
        metrics: {}
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("rate limiting", () => {
    it("returns 429 after exceeding limit", async () => {
      const sender = await relay.enrollAgent("rate-sender");
      const receiver = await relay.enrollAgent("rate-receiver");

      for (let i = 0; i < 5; i++) {
        const res = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
          recipient: { kind: "agent", id: receiver.agent_id },
          message_type: "direct",
          body: { i },
          conversation_id: `conv-rate-${i}`,
          correlation_id: `corr-rate-${i}`
        });
        expect(res.status).toBe(200);
      }

      const blocked = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "over limit" },
        conversation_id: "conv-rate-blocked",
        correlation_id: "corr-rate-blocked"
      });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toBe("rate limit exceeded");
    });
  });

  describe("policy engine", () => {
    it("blocks message with deny policy", async () => {
      const sender = await relay.enrollAgent("policy-sender");
      const receiver = await relay.enrollAgent("policy-receiver");

      await relay.operatorRequest("POST", "/v1/operator/policies", {
        name: "block-sender",
        scope_kind: "fleet",
        rule: { action: "deny", conditions: { sender_agent_id: sender.agent_id } },
        enabled: true
      });

      const res = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "blocked" },
        conversation_id: "conv-pol",
        correlation_id: "corr-pol"
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("blocked by policy");
    });

    it("allows message when no deny policy matches", async () => {
      const sender = await relay.enrollAgent("allowed-sender");
      const receiver = await relay.enrollAgent("allowed-receiver");

      await relay.operatorRequest("POST", "/v1/operator/policies", {
        name: "block-other",
        scope_kind: "fleet",
        rule: { action: "deny", conditions: { sender_agent_id: "some-other-agent" } },
        enabled: true
      });

      const res = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "allowed" },
        conversation_id: "conv-allow",
        correlation_id: "corr-allow"
      });
      expect(res.status).toBe(200);
    });
  });

  describe("operator", () => {
    it("returns fleet overview with new fields", async () => {
      await relay.enrollAgent("overview-agent");
      const res = await relay.operatorRequest("GET", "/v1/operator/overview");
      expect(res.status).toBe(200);
      expect(res.body.agents.length).toBeGreaterThan(0);
      expect(res.body).toHaveProperty("deadLetterCount");
      expect(res.body).toHaveProperty("quarantinedAgentCount");
      expect(res.body).toHaveProperty("rateLimitViolationsLast24h");
    });

    it("manages policies via CRUD", async () => {
      const createRes = await relay.operatorRequest("POST", "/v1/operator/policies", {
        name: "crud-policy",
        scope_kind: "fleet",
        rule: { action: "deny", conditions: { message_type: "broadcast" } },
        enabled: true
      });
      expect(createRes.status).toBe(201);
      expect(createRes.body.policyId).toBeTruthy();

      const listRes = await relay.operatorRequest("GET", "/v1/operator/policies");
      expect(listRes.body.policies.length).toBeGreaterThan(0);

      const deleteRes = await relay.app.inject({
        method: "DELETE",
        url: `/v1/operator/policies/${createRes.body.policyId}`,
        headers: { authorization: `Bearer ${relay.operatorToken}` }
      });
      expect(deleteRes.statusCode).toBe(200);
    });

    it("quarantines and resumes agent", async () => {
      const agent = await relay.enrollAgent("q-agent");

      const qRes = await relay.operatorRequest("POST", `/v1/operator/agents/${agent.agent_id}/quarantine`, {
        reason: "test"
      });
      expect(qRes.status).toBe(200);

      const blocked = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: agent.agent_id },
        message_type: "direct",
        body: { text: "fail" },
        conversation_id: "conv-q",
        correlation_id: "corr-q"
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toBe("agent is quarantined");

      await relay.operatorRequest("POST", `/v1/operator/agents/${agent.agent_id}/resume`, { reason: "test" });

      const allowed = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: agent.agent_id },
        message_type: "direct",
        body: { text: "ok" },
        conversation_id: "conv-q2",
        correlation_id: "corr-q2"
      });
      expect(allowed.status).toBe(200);
    });
  });
});

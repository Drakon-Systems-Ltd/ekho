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

    it("exposes operator_trusted, roster, and sender_kind in the inbox", async () => {
      const receiver = await relay.enrollAgent("inbox-receiver");
      const peer = await relay.enrollAgent("inbox-peer");

      // Peer-agent message → sender_kind "agent".
      await relay.agentRequest(peer.agent_id, peer.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "from peer" },
        conversation_id: "conv-inbox",
        correlation_id: "corr-inbox"
      });

      // Operator message via the console → sender_kind "operator".
      await relay.operatorRequest("POST", "/v1/operator/messages", {
        recipient_agent_id: receiver.agent_id,
        text: "from operator"
      });

      // Trust the receiver so operator_trusted flips to true.
      await relay.operatorRequest("POST", `/v1/operator/agents/${receiver.agent_id}/trust`, { trusted: true });

      const inbox = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
      expect(inbox.status).toBe(200);
      expect(inbox.body.operator_trusted).toBe(true);

      const kinds = inbox.body.messages.map((m: { sender_kind: string }) => m.sender_kind).sort();
      expect(kinds).toEqual(["agent", "operator"]);

      // Roster lists the peer, excludes the operator identity and self.
      const rosterIds = inbox.body.roster.map((r: { agent_id: string }) => r.agent_id);
      expect(rosterIds).toContain(peer.agent_id);
      expect(rosterIds).not.toContain(receiver.agent_id);
      expect(rosterIds.some((id: string) => id.startsWith("op_"))).toBe(false);
    });

    it("fans a broadcast out to every other agent in the fleet", async () => {
      const sender = await relay.enrollAgent("bcast-sender");
      const r1 = await relay.enrollAgent("bcast-r1");
      const r2 = await relay.enrollAgent("bcast-r2");

      const sendRes = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "broadcast" },
        message_type: "broadcast",
        body: { text: "all hands" },
        conversation_id: "conv-bcast",
        correlation_id: "corr-bcast"
      });
      expect(sendRes.status).toBe(200);
      const messageId = sendRes.body.message_id;

      // Both recipients receive it, tagged as a broadcast.
      for (const r of [r1, r2]) {
        const inbox = await relay.agentRequest(r.agent_id, r.secret, "GET", "/v1/inbox");
        expect(inbox.body.messages).toHaveLength(1);
        expect(inbox.body.messages[0].message_id).toBe(messageId);
        expect(inbox.body.messages[0].message_type).toBe("broadcast");
        expect(inbox.body.messages[0].body.text).toBe("all hands");
      }

      // The sender never receives its own broadcast.
      const senderInbox = await relay.agentRequest(sender.agent_id, sender.secret, "GET", "/v1/inbox");
      expect(senderInbox.body.messages).toHaveLength(0);

      // Each recipient acks only its own delivery row.
      const ack1 = await relay.agentRequest(r1.agent_id, r1.secret, "POST", "/v1/acks", {
        acks: [{ message_id: messageId, status: "received", received_at: new Date().toISOString() }]
      });
      expect(ack1.body.updated).toBe(1);
    });

    it("fans an operator broadcast out to every agent in the fleet", async () => {
      const r1 = await relay.enrollAgent("op-bcast-r1");
      const r2 = await relay.enrollAgent("op-bcast-r2");

      const opRes = await relay.operatorRequest("POST", "/v1/operator/messages", {
        recipient_agent_id: "broadcast",
        text: "operator all-hands"
      });
      expect(opRes.status).toBe(201);
      const messageId = opRes.body.message_id;

      for (const r of [r1, r2]) {
        const inbox = await relay.agentRequest(r.agent_id, r.secret, "GET", "/v1/inbox");
        expect(inbox.body.messages).toHaveLength(1);
        expect(inbox.body.messages[0].message_id).toBe(messageId);
        expect(inbox.body.messages[0].message_type).toBe("broadcast");
        expect(inbox.body.messages[0].sender_kind).toBe("operator");
        expect(inbox.body.messages[0].body.text).toBe("operator all-hands");
      }
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

    it("toggles the operator-trusted channel flag", async () => {
      const agent = await relay.enrollAgent("trust-agent");

      // Defaults to untrusted.
      const list = await relay.operatorRequest("GET", "/v1/operator/agents");
      const row = list.body.agents.find((a: { id: string }) => a.id === agent.agent_id);
      expect(row.operator_trusted).toBe(false);

      const on = await relay.operatorRequest("POST", `/v1/operator/agents/${agent.agent_id}/trust`, { trusted: true });
      expect(on.status).toBe(200);
      expect(on.body).toEqual({ agent_id: agent.agent_id, operator_trusted: true });

      const list2 = await relay.operatorRequest("GET", "/v1/operator/agents");
      const row2 = list2.body.agents.find((a: { id: string }) => a.id === agent.agent_id);
      expect(row2.operator_trusted).toBe(true);

      const off = await relay.operatorRequest("POST", `/v1/operator/agents/${agent.agent_id}/trust`, { trusted: false });
      expect(off.body.operator_trusted).toBe(false);
    });

    it("404s trust toggle for an unknown agent", async () => {
      const res = await relay.operatorRequest("POST", "/v1/operator/agents/agent_does_not_exist/trust", { trusted: true });
      expect(res.status).toBe(404);
    });

    it("400s trust toggle with an invalid body", async () => {
      const agent = await relay.enrollAgent("trust-bad-body");
      const res = await relay.operatorRequest("POST", `/v1/operator/agents/${agent.agent_id}/trust`, { trusted: "yes" });
      expect(res.status).toBe(400);
    });

    it("toggles per-agent peer-autoreply + budget, live on the inbox", async () => {
      const agent = await relay.enrollAgent("peer-agent");

      // Defaults: off, budget 6 — both in the agent list and the agent's inbox.
      const list = await relay.operatorRequest("GET", "/v1/operator/agents");
      const row = list.body.agents.find((a: { id: string }) => a.id === agent.agent_id);
      expect(row.peer_autoreply).toBe(false);
      expect(row.peer_turn_budget).toBe(6);

      const inbox0 = await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox");
      expect(inbox0.body.peer_autoreply).toBe(false);
      expect(inbox0.body.peer_turn_budget).toBe(6);

      // Enable with a custom budget.
      const on = await relay.operatorRequest("POST", `/v1/operator/agents/${agent.agent_id}/peer-autoreply`, {
        autoreply: true,
        budget: 8
      });
      expect(on.status).toBe(200);
      expect(on.body).toEqual({ agent_id: agent.agent_id, peer_autoreply: true, peer_turn_budget: 8 });

      // The agent sees it live on its next poll — no restart.
      const inbox1 = await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox");
      expect(inbox1.body.peer_autoreply).toBe(true);
      expect(inbox1.body.peer_turn_budget).toBe(8);

      // Disabling leaves the budget untouched.
      const off = await relay.operatorRequest("POST", `/v1/operator/agents/${agent.agent_id}/peer-autoreply`, {
        autoreply: false
      });
      expect(off.body.peer_autoreply).toBe(false);
      expect(off.body.peer_turn_budget).toBe(8);
    });

    it("404s peer-autoreply for an unknown agent", async () => {
      const res = await relay.operatorRequest("POST", "/v1/operator/agents/agent_nope/peer-autoreply", { autoreply: true });
      expect(res.status).toBe(404);
    });

    it("400s peer-autoreply with an invalid body", async () => {
      const agent = await relay.enrollAgent("peer-bad-body");
      const res = await relay.operatorRequest("POST", `/v1/operator/agents/${agent.agent_id}/peer-autoreply`, { autoreply: "yes" });
      expect(res.status).toBe(400);
    });

    it("creates a room with members and lists it", async () => {
      const a = await relay.enrollAgent("room-a");
      const b = await relay.enrollAgent("room-b");
      const create = await relay.operatorRequest("POST", "/v1/operator/rooms", {
        name: "API Project",
        member_agent_ids: [a.agent_id, b.agent_id]
      });
      expect(create.status).toBe(201);
      expect(create.body.id).toMatch(/^room_/);
      expect(create.body.name).toBe("API Project");

      const list = await relay.operatorRequest("GET", "/v1/operator/rooms");
      const room = list.body.rooms.find((r: { id: string }) => r.id === create.body.id);
      expect(room).toBeTruthy();
      expect(room.members.map((m: { agent_id: string }) => m.agent_id).sort())
        .toEqual([a.agent_id, b.agent_id].sort());
    });

    it("fans an operator room message out to members only", async () => {
      const a = await relay.enrollAgent("rm-a");
      const b = await relay.enrollAgent("rm-b");
      const outsider = await relay.enrollAgent("rm-out");
      const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
        name: "P", member_agent_ids: [a.agent_id, b.agent_id]
      })).body;

      await relay.operatorRequest("POST", "/v1/operator/messages", { room_id: room.id, text: "team kickoff" });

      const inboxA = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      const inboxB = await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
      const inboxOut = await relay.agentRequest(outsider.agent_id, outsider.secret, "GET", "/v1/inbox");

      expect(inboxA.body.messages.some((m: { body: { text: string } }) => m.body.text === "team kickoff")).toBe(true);
      expect(inboxB.body.messages.some((m: { body: { text: string } }) => m.body.text === "team kickoff")).toBe(true);
      expect(inboxOut.body.messages.length).toBe(0);
      expect(inboxA.body.messages[0].conversation_id).toBe(room.id);
    });

    it("fans an agent room reply out to other members (not sender, not outsiders)", async () => {
      const a = await relay.enrollAgent("rr-a");
      const b = await relay.enrollAgent("rr-b");
      const outsider = await relay.enrollAgent("rr-out");
      const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
        name: "P2", member_agent_ids: [a.agent_id, b.agent_id]
      })).body;

      // A posts into the room. Its stated recipient is B, but room membership
      // (keyed on the room conversation_id) drives delivery.
      await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: b.agent_id },
        message_type: "direct",
        body: { text: "hi team from a" },
        conversation_id: room.id,
        correlation_id: "rr-c1"
      });

      const inboxB = await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
      const inboxA = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      const inboxOut = await relay.agentRequest(outsider.agent_id, outsider.secret, "GET", "/v1/inbox");

      expect(inboxB.body.messages.some((m: { body: { text: string } }) => m.body.text === "hi team from a")).toBe(true);
      expect(inboxA.body.messages.length).toBe(0); // sender excluded
      expect(inboxOut.body.messages.length).toBe(0); // not a member
    });

    it("does not let a non-member fan a message into a room", async () => {
      const m1 = await relay.enrollAgent("idor-m1");
      const m2 = await relay.enrollAgent("idor-m2");
      const intruder = await relay.enrollAgent("idor-intruder");
      const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
        name: "Private", member_agent_ids: [m1.agent_id, m2.agent_id]
      })).body;

      // The intruder (NOT a member) knows the room id and posts into it,
      // addressing m1. If membership weren't enforced this would fan out to the
      // whole room and m2 would receive it too.
      await relay.agentRequest(intruder.agent_id, intruder.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: m1.agent_id },
        message_type: "direct",
        body: { text: "intruder injection" },
        conversation_id: room.id,
        correlation_id: "idor-c1"
      });

      // Delivered only to the stated recipient (m1), NOT fanned out to the room.
      const inboxM2 = await relay.agentRequest(m2.agent_id, m2.secret, "GET", "/v1/inbox");
      expect(inboxM2.body.messages.some((m: { body: { text: string } }) => m.body.text === "intruder injection")).toBe(false);
    });

    it("returns a filterable fleet activity stream with resolved names", async () => {
      const a = await relay.enrollAgent("act-a");
      const b = await relay.enrollAgent("act-b");
      await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: a.agent_id, text: "hello a" });
      await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: b.agent_id },
        message_type: "direct",
        body: { text: "hi b" },
        conversation_id: "c1",
        correlation_id: "cor1"
      });

      const res = await relay.operatorRequest("GET", "/v1/operator/activity?limit=40");
      expect(res.status).toBe(200);
      const msgs = res.body.events.filter((e: { event_type: string }) => e.event_type === "message.queued");
      expect(msgs.length).toBeGreaterThanOrEqual(2);
      // Operator message carries its text in the payload.
      expect(msgs.some((e: { payload: { text?: string } }) => e.payload?.text === "hello a")).toBe(true);
      // Agent actor id resolves to a display name.
      const aEvent = msgs.find((e: { actor_id: string }) => e.actor_id === a.agent_id);
      expect(aEvent.actor_name).toBe("act-a");

      // Type filter (prefix).
      const filtered = await relay.operatorRequest("GET", "/v1/operator/activity?type=message");
      expect(filtered.body.events.length).toBeGreaterThan(0);
      expect(filtered.body.events.every((e: { event_type: string }) => e.event_type.startsWith("message"))).toBe(true);
    });

    it("seeds a feed on first poll, then delivers only new items to subscribers (dedup, non-waking)", async () => {
      const a = await relay.enrollAgent("feed-a");
      const outsider = await relay.enrollAgent("feed-out");
      const feed = (await relay.operatorRequest("POST", "/v1/operator/feeds", {
        name: "News", url: "https://example.com/rss.xml", subscriber_agent_ids: [a.agent_id]
      })).body;
      expect(feed.id).toMatch(/^feed_/);

      const rss = (items: string) => `<rss><channel>${items}</channel></rss>`;
      const item = (g: string, t: string) => `<item><title>${t}</title><link>https://x/${g}</link><guid>${g}</guid></item>`;

      // First poll = seed the baseline (mark current items seen, deliver none).
      const r1 = await relay.db.pollFeed(feed.id, async () => rss(item("g1", "One")));
      expect(r1.delivered).toBe(0);
      let inboxA = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      expect(inboxA.body.messages.length).toBe(0);

      // Second poll with a NEW item -> delivered to the subscriber as a 'feed' msg.
      const r2 = await relay.db.pollFeed(feed.id, async () => rss(item("g1", "One") + item("g2", "Two")));
      expect(r2.delivered).toBe(1);
      inboxA = await relay.agentRequest(a.agent_id, a.secret, "GET", "/v1/inbox");
      const feedMsgs = inboxA.body.messages.filter((m: { message_type: string }) => m.message_type === "feed");
      expect(feedMsgs.length).toBe(1);
      expect(feedMsgs[0].body.text).toContain("Two");
      // Non-subscriber gets nothing.
      const inboxOut = await relay.agentRequest(outsider.agent_id, outsider.secret, "GET", "/v1/inbox");
      expect(inboxOut.body.messages.length).toBe(0);

      // Third poll, same items -> deduped, nothing new.
      const r3 = await relay.db.pollFeed(feed.id, async () => rss(item("g1", "One") + item("g2", "Two")));
      expect(r3.delivered).toBe(0);

      // Recent items list shows both (g1 seeded + g2 delivered).
      const items = await relay.operatorRequest("GET", `/v1/operator/feeds/${feed.id}/items`);
      expect(items.body.items.length).toBe(2);
    });

    it("rejects a feed URL pointing at a private/loopback address", async () => {
      const res = await relay.operatorRequest("POST", "/v1/operator/feeds", {
        name: "evil", url: "http://169.254.169.254/latest/meta-data/"
      });
      expect(res.status).toBe(400);
    });

    it("reports fleet health with latest metrics + throughput", async () => {
      const a = await relay.enrollAgent("health-a");
      const b = await relay.enrollAgent("health-b");

      // a reports a heartbeat carrying model/provider + an active conversation.
      await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/heartbeats", {
        status: "healthy",
        active_conversation_ids: ["conv-x"],
        metrics: { model: "claude-opus-4-8", provider: "anthropic" }
      });
      // a sends b a message (throughput: a sent 1, b received 1).
      await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: b.agent_id },
        message_type: "direct",
        body: { text: "hi" },
        conversation_id: "c1",
        correlation_id: "cor1"
      });

      const res = await relay.operatorRequest("GET", "/v1/operator/fleet-health");
      expect(res.status).toBe(200);
      const ha = res.body.agents.find((x: { id: string }) => x.id === a.agent_id);
      expect(ha.metrics.model).toBe("claude-opus-4-8");
      expect(ha.metrics.provider).toBe("anthropic");
      expect(ha.active_conversations).toContain("conv-x");
      expect(ha.last_heartbeat_at).toBeTruthy();
      expect(ha.sent_1h).toBe(1);
      const hb = res.body.agents.find((x: { id: string }) => x.id === b.agent_id);
      expect(hb.received_1h).toBe(1);
      expect(hb.metrics).toEqual({}); // no heartbeat metrics reported yet
    });

    it("maps fleet topology — nodes + undirected collaboration edges", async () => {
      const a = await relay.enrollAgent("topo-a");
      const b = await relay.enrollAgent("topo-b");
      const c = await relay.enrollAgent("topo-c"); // isolated — no traffic

      // a -> b twice, b -> a once: one undirected edge with combined weight 3.
      const send = (from: { agent_id: string; secret: string }, to: string, conv: string) =>
        relay.agentRequest(from.agent_id, from.secret, "POST", "/v1/messages", {
          recipient: { kind: "agent", id: to },
          message_type: "direct",
          body: { text: "x" },
          conversation_id: conv,
          correlation_id: `cor-${conv}`
        });
      await send(a, b.agent_id, "tc1");
      await send(a, b.agent_id, "tc2");
      await send(b, a.agent_id, "tc3");

      const res = await relay.operatorRequest("GET", "/v1/operator/topology");
      expect(res.status).toBe(200);
      expect(res.body.generated_at).toBeTruthy();
      expect(res.body.window_minutes).toBeGreaterThan(0);

      // All three enrolled agents are nodes; the operator pseudo-agent is not.
      const ids = res.body.nodes.map((n: { id: string }) => n.id);
      expect(ids).toContain(a.agent_id);
      expect(ids).toContain(b.agent_id);
      expect(ids).toContain(c.agent_id);
      expect(res.body.nodes.every((n: { runtime: string }) => n.runtime !== "operator")).toBe(true);

      // a<->b folds both directions into one weighted edge; c has none.
      const ab = res.body.edges.find(
        (e: { source: string; target: string }) =>
          (e.source === a.agent_id && e.target === b.agent_id) ||
          (e.source === b.agent_id && e.target === a.agent_id)
      );
      expect(ab).toBeTruthy();
      expect(ab.count).toBe(3);
      expect(
        res.body.edges.some((e: { source: string; target: string }) => e.source === c.agent_id || e.target === c.agent_id)
      ).toBe(false);
    });

    it("deletes a room", async () => {
      const room = (await relay.operatorRequest("POST", "/v1/operator/rooms", {
        name: "tmp", member_agent_ids: []
      })).body;
      const del = await relay.operatorRequest("DELETE", `/v1/operator/rooms/${room.id}`);
      expect(del.status).toBe(200);
      const list = await relay.operatorRequest("GET", "/v1/operator/rooms");
      expect(list.body.rooms.find((r: { id: string }) => r.id === room.id)).toBeUndefined();
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

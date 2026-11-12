import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

describe("concrete fan-out policy enforcement", () => {
  let relay: TestRelay;
  beforeEach(async () => { relay = await createTestRelay(); });
  afterEach(() => relay.cleanup());

  for (const kind of ["broadcast", "group"] as const) {
    for (const scopeKind of ["fleet", "agent"] as const) {
      it(kind + " rejects the entire send for a " + scopeKind + " recipient deny", async () => {
        const sender = await relay.enrollAgent("sender");
        const allowed = await relay.enrollAgent("allowed");
        const denied = await relay.enrollAgent("denied");
        const room = relay.db.createRoom(relay.fleetId, { kind: "agent", id: sender.agent_id }, "synthetic", [allowed.agent_id, denied.agent_id]);
        relay.db.createPolicy(relay.fleetId, {
          name: "recipient denial", scopeKind, scopeId: scopeKind === "agent" ? denied.agent_id : undefined,
          enabled: true, rule: { action: "deny", conditions: { recipient_agent_id: denied.agent_id } }
        });
        const recipient = kind === "group" ? { kind, id: room.id } : { kind };
        const result = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
          recipient, message_type: "direct", body: { text: "synthetic denied payload" },
          conversation_id: "synthetic-conversation", correlation_id: "synthetic-correlation"
        });
        expect(result.status).toBe(403);
        expect(result.body).toEqual({ error: "blocked by policy", policy: "recipient denial" });
        expect(relay.db.db.prepare("SELECT id FROM messages WHERE fleet_id = ?").all(relay.fleetId)).toEqual([]);
        expect(relay.db.db.prepare("SELECT id FROM events WHERE fleet_id = ? AND event_type = 'message.queued'").all(relay.fleetId)).toEqual([]);
        for (const agent of [allowed, denied]) {
          const inbox = await relay.agentRequest(agent.agent_id, agent.secret, "GET", "/v1/inbox");
          expect(inbox.body.messages).toEqual([]);
        }
      });
    }
    it(kind + " allows unaffected recipients and ignores non-recipient scoped denial", async () => {
      const sender = await relay.enrollAgent("sender");
      const target = await relay.enrollAgent("target");
      const excluded = await relay.enrollAgent("excluded");
      relay.db.db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), excluded.agent_id);
      const room = relay.db.createRoom(relay.fleetId, { kind: "agent", id: sender.agent_id }, "synthetic", [target.agent_id]);
      relay.db.createPolicy(relay.fleetId, { name: "excluded denial", scopeKind: "agent", scopeId: excluded.agent_id, enabled: true, rule: { action: "deny", conditions: {} } });
      const result = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: kind === "group" ? { kind, id: room.id } : { kind }, message_type: "direct", body: { text: "synthetic allowed payload" },
        conversation_id: "synthetic-conversation", correlation_id: "synthetic-correlation"
      });
      expect(result.status).toBe(200);
      const rows = relay.db.db.prepare("SELECT recipient_agent_id FROM message_deliveries WHERE message_id = ?").all(result.body.message_id);
      expect(rows).toEqual([{ recipient_agent_id: target.agent_id }]);
    });
  }
});

describe("concrete fan-out denial audit durability", () => {
  let relay: TestRelay;
  beforeEach(async () => { relay = await createTestRelay(); });
  afterEach(() => relay.cleanup());

  const denialEvents = (r: TestRelay) => r.db.db.prepare(
    "SELECT resource_kind, resource_id, actor_kind, payload_json FROM events WHERE fleet_id = ? AND event_type = 'message.policy_denied' ORDER BY created_at"
  ).all(r.fleetId) as Array<{ resource_kind: string; resource_id: string; actor_kind: string; payload_json: string }>;

  for (const kind of ["broadcast", "group"] as const) {
    it(kind + " recipient denial persists exactly one message.policy_denied event and nothing else", async () => {
      const sender = await relay.enrollAgent("sender");
      const allowed = await relay.enrollAgent("allowed");
      const denied = await relay.enrollAgent("denied");
      const room = relay.db.createRoom(relay.fleetId, { kind: "agent", id: sender.agent_id }, "synthetic", [allowed.agent_id, denied.agent_id]);
      const { policyId } = relay.db.createPolicy(relay.fleetId, {
        name: "recipient denial", scopeKind: "agent", scopeId: denied.agent_id,
        enabled: true, rule: { action: "deny", conditions: { recipient_agent_id: denied.agent_id } }
      });
      const upload = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/attachments", {
        filename: "synthetic.txt", mime: "text/plain", size_bytes: 5, data_base64: "aGVsbG8="
      });
      expect(upload.status).toBe(201);
      expect(denialEvents(relay)).toEqual([]);

      const result = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: kind === "group" ? { kind, id: room.id } : { kind }, message_type: "direct",
        body: { text: "synthetic denied payload", attachments: [upload.body.id] },
        conversation_id: "synthetic-conversation", correlation_id: "synthetic-correlation"
      });
      expect(result.status).toBe(403);
      expect(result.body).toEqual({ error: "blocked by policy", policy: "recipient denial" });

      // Exactly one durable denial event, carrying the denied policy and the concrete denied recipient.
      const events = denialEvents(relay);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ resource_kind: "policy", resource_id: policyId, actor_kind: "system" });
      expect(JSON.parse(events[0].payload_json)).toMatchObject({
        policy_name: "recipient denial", sender: sender.agent_id, recipient: denied.agent_id,
        message_type: "direct", recipient_kind: kind, conversation_id: kind === "group" ? room.id : "synthetic-conversation"
      });

      // The rejected send itself leaves nothing behind: no message, delivery, queued event or attachment binding.
      expect(relay.db.db.prepare("SELECT id FROM messages WHERE fleet_id = ?").all(relay.fleetId)).toEqual([]);
      expect(relay.db.db.prepare("SELECT id FROM message_deliveries WHERE recipient_agent_id IN (?, ?)").all(allowed.agent_id, denied.agent_id)).toEqual([]);
      expect(relay.db.db.prepare("SELECT id FROM events WHERE fleet_id = ? AND event_type = 'message.queued'").all(relay.fleetId)).toEqual([]);
      expect(relay.db.db.prepare("SELECT bound_message_id, bound_at FROM attachments WHERE id = ?").get(upload.body.id)).toEqual({ bound_message_id: null, bound_at: null });

      // Parity with the direct path: the same denied recipient addressed directly adds exactly one more event.
      const direct = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: denied.agent_id }, message_type: "direct", body: { text: "synthetic denied payload" },
        conversation_id: "synthetic-conversation", correlation_id: "synthetic-correlation"
      });
      expect(direct.status).toBe(403);
      expect(denialEvents(relay)).toHaveLength(2);
    });
  }

  for (const kind of ["broadcast", "group"] as const) {
    it(kind + " denial is still returned as the policy 403 when the denial event cannot be written", async () => {
      const sender = await relay.enrollAgent("sender");
      const allowed = await relay.enrollAgent("allowed");
      const denied = await relay.enrollAgent("denied");
      const room = relay.db.createRoom(relay.fleetId, { kind: "agent", id: sender.agent_id }, "synthetic", [allowed.agent_id, denied.agent_id]);
      relay.db.createPolicy(relay.fleetId, {
        name: "recipient denial", scopeKind: "agent", scopeId: denied.agent_id,
        enabled: true, rule: { action: "deny", conditions: { recipient_agent_id: denied.agent_id } }
      });
      // Fail only the post-rollback write (the one carrying recipient_kind);
      // every other event, including the in-transaction one, behaves normally.
      const real = relay.db.recordEvent.bind(relay.db);
      let failedWrites = 0;
      const spy = vi.spyOn(relay.db, "recordEvent").mockImplementation(((...args: Parameters<typeof real>) => {
        const payload = args[7] as Record<string, unknown> | undefined;
        if (args[1] === "message.policy_denied" && payload && "recipient_kind" in payload) {
          failedWrites += 1;
          throw new Error("synthetic storage failure");
        }
        return real(...args);
      }) as typeof real);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
          recipient: kind === "group" ? { kind, id: room.id } : { kind }, message_type: "direct", body: { text: "synthetic denied payload" },
          conversation_id: "synthetic-conversation", correlation_id: "synthetic-correlation"
        });
        expect(failedWrites).toBe(1);
        expect(result.status).toBe(403);
        expect(result.body).toEqual({ error: "blocked by policy", policy: "recipient denial" });
        expect(errSpy).toHaveBeenCalledTimes(1);
        // The failed write is reported without the message text.
        expect(JSON.stringify(errSpy.mock.calls[0])).not.toContain("synthetic denied payload");
      } finally {
        spy.mockRestore();
        errSpy.mockRestore();
      }
      // Still nothing delivered or stored, and no event (its write is what failed).
      expect(relay.db.db.prepare("SELECT id FROM messages WHERE fleet_id = ?").all(relay.fleetId)).toEqual([]);
      expect(relay.db.db.prepare("SELECT id FROM message_deliveries WHERE recipient_agent_id IN (?, ?)").all(allowed.agent_id, denied.agent_id)).toEqual([]);
      expect(denialEvents(relay)).toEqual([]);
    });
  }

  it("an allowed fan-out records no denial event", async () => {
    const sender = await relay.enrollAgent("sender");
    const target = await relay.enrollAgent("target");
    const result = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
      recipient: { kind: "broadcast" }, message_type: "direct", body: { text: "synthetic allowed payload" },
      conversation_id: "synthetic-conversation", correlation_id: "synthetic-correlation"
    });
    expect(result.status).toBe(200);
    expect(denialEvents(relay)).toEqual([]);
    expect(relay.db.db.prepare("SELECT recipient_agent_id FROM message_deliveries WHERE message_id = ?").all(result.body.message_id)).toEqual([{ recipient_agent_id: target.agent_id }]);
  });
});

// The reserved dm- namespace rule and the concrete fan-out policy check sit in
// the same send path. These pin how the two compose, so neither can be lost in
// a later merge of that path.
describe("fan-out policy alongside the reserved dm- namespace rule", () => {
  let relay: TestRelay;
  beforeEach(async () => { relay = await createTestRelay(); });
  afterEach(() => relay.cleanup());

  const count = (r: TestRelay, eventType: string) => (r.db.db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE fleet_id = ? AND event_type = ?"
  ).get(r.fleetId, eventType) as { n: number }).n;

  for (const owner of ["own", "peer"] as const) {
    it("a broadcast threaded under the sender's " + owner + " canonical DM is refused by the namespace rule before any recipient policy runs", async () => {
      const sender = await relay.enrollAgent("sender");
      const allowed = await relay.enrollAgent("allowed");
      const denied = await relay.enrollAgent("denied");
      relay.db.createPolicy(relay.fleetId, {
        name: "recipient denial", scopeKind: "agent", scopeId: denied.agent_id,
        enabled: true, rule: { action: "deny", conditions: { recipient_agent_id: denied.agent_id } }
      });
      const dmOwner = owner === "own" ? sender.agent_id : allowed.agent_id;
      const result = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "broadcast" }, message_type: "direct", body: { text: "synthetic payload" },
        conversation_id: "dm-" + relay.fleetId + "-" + dmOwner, correlation_id: "synthetic-correlation"
      });
      expect(result.status).toBe(403);
      expect(String(result.body.error)).toMatch(/^conversation not permitted/);
      expect(result.body.policy).toBeUndefined();
      // Refused before the transaction: nothing stored, and no policy verdict recorded.
      expect(relay.db.db.prepare("SELECT id FROM messages WHERE fleet_id = ?").all(relay.fleetId)).toEqual([]);
      expect(relay.db.db.prepare("SELECT id FROM message_deliveries WHERE recipient_agent_id IN (?, ?)").all(allowed.agent_id, denied.agent_id)).toEqual([]);
      expect(count(relay, "message.policy_denied")).toBe(0);
      expect(count(relay, "message.queued")).toBe(0);
    });
  }

  it("a room send that names a dm- conversation id still normalizes to the room and is still policy-checked per member", async () => {
    const sender = await relay.enrollAgent("sender");
    const allowed = await relay.enrollAgent("allowed");
    const denied = await relay.enrollAgent("denied");
    const room = relay.db.createRoom(relay.fleetId, { kind: "agent", id: sender.agent_id }, "synthetic", [allowed.agent_id, denied.agent_id]);
    const { policyId } = relay.db.createPolicy(relay.fleetId, {
      name: "recipient denial", scopeKind: "agent", scopeId: denied.agent_id,
      enabled: true, rule: { action: "deny", conditions: { recipient_agent_id: denied.agent_id } }
    });
    const send = () => relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
      recipient: { kind: "group", id: room.id }, message_type: "direct", body: { text: "synthetic payload" },
      conversation_id: "dm-" + relay.fleetId + "-" + allowed.agent_id, correlation_id: "synthetic-correlation"
    });
    const refused = await send();
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "blocked by policy", policy: "recipient denial" });
    expect(relay.db.db.prepare("SELECT id FROM messages WHERE fleet_id = ?").all(relay.fleetId)).toEqual([]);
    expect(count(relay, "message.policy_denied")).toBe(1);

    // With the policy off, the same request is a normal room post under the ROOM id, not the dm- id.
    relay.db.db.prepare("UPDATE policies SET enabled = 0 WHERE id = ?").run(policyId);
    const accepted = await send();
    expect(accepted.status).toBe(200);
    expect(relay.db.db.prepare("SELECT conversation_id FROM messages WHERE id = ?").get(accepted.body.message_id)).toEqual({ conversation_id: room.id });
    expect((relay.db.db.prepare("SELECT recipient_agent_id FROM message_deliveries WHERE message_id = ? ORDER BY recipient_agent_id").all(accepted.body.message_id) as Array<{ recipient_agent_id: string }>).map((r) => r.recipient_agent_id).sort())
      .toEqual([allowed.agent_id, denied.agent_id].sort());
  });
});

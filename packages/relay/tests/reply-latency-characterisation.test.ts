import "./setup"; // sets a temp EKHO_DB_PATH before db.ts's singleton is created
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { config } from "../src/config";

// #155: characterisation tests for reply latency (relay side).
//
// These PIN TODAY'S behaviour; they do not endorse it. The floor is cooperative
// turn-taking that the adapters ask for. It never gates relay transport.
// "acked" is the last state the relay records, and it means "received", not
// "answered". Fleet health is heartbeat-based and blind to the inbox. Tests
// marked "FLIPS" are the ones the #155 implementation is expected to change. That
// PR must update the test and docs/plans/2026-11-01-155-reply-latency-design.md
// together.
describe("#155 reply latency: relay transport vs floor vs health (characterises current behaviour)", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  async function broadcast(text: string): Promise<string> {
    const res = await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: "broadcast", text });
    expect(res.status).toBe(201);
    expect(res.body.conversation_id).toMatch(/^op-/); // a broadcast gets its own op- conversation
    return res.body.conversation_id as string;
  }

  function floor(agent: { agent_id: string; secret: string }, conv: string, body: Record<string, unknown> = {}) {
    return relay.agentRequest(agent.agent_id, agent.secret, "POST", `/v1/conversations/${conv}/floor`, body);
  }

  function deliveryStatus(messageId: string, recipientId: string): string {
    const row = relay.db
      .raw()
      .prepare("SELECT status FROM message_deliveries WHERE message_id = ? AND recipient_agent_id = ?")
      .get(messageId, recipientId) as { status: string } | undefined;
    return String(row?.status);
  }

  it("delivers and acks a direct on a floor-held broadcast conversation, while the recipient's own floor acquire is refused", async () => {
    const a = await relay.enrollAgent("lat-a"); // holds the floor (mid peer-triggered turn)
    const b = await relay.enrollAgent("lat-b"); // the recipient of an unrelated direct
    const c = await relay.enrollAgent("lat-c"); // the sender of that direct
    const shared = await broadcast("fleet: status please");

    expect((await floor(a, shared)).body.granted).toBe(true);

    // C reuses the broadcast's conversation id for its own direct to B. This is
    // the path every adapter prompt and ekho_send default leads to.
    const sent = await relay.agentRequest(c.agent_id, c.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: b.agent_id },
      message_type: "direct",
      body: { text: "B, what is your build status?" },
      conversation_id: shared,
      correlation_id: "cor-155-1"
    });
    expect(sent.status).toBe(200);
    const directId = sent.body.message_id as string;

    // Transport is not floor-gated: B's poll gets the direct immediately.
    const inbox = await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
    const direct = inbox.body.messages.find((m: { message_id: string }) => m.message_id === directId);
    expect(direct).toBeTruthy();
    expect(direct.conversation_id).toBe(shared);
    expect(deliveryStatus(directId, b.agent_id)).toBe("delivered");

    const ack = await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/acks", {
      acks: [{ message_id: directId, status: "received", received_at: new Date().toISOString() }]
    });
    expect(ack.body.updated).toBe(1);

    // ...but B, which has to reply, is refused the floor while A holds it.
    const refused = await floor(b, shared);
    expect(refused.body.granted).toBe(false);
    expect(refused.body.holder_agent_id).toBe(a.agent_id);

    // As soon as A releases, B is granted the floor.
    const rel = await relay.agentRequest(a.agent_id, a.secret, "DELETE", `/v1/conversations/${shared}/floor`);
    expect(rel.body.released).toBe(true);
    expect((await floor(b, shared)).body.granted).toBe(true);
  });

  it("records acked as the last delivery state; no field says the message was answered (EXTENDED under #155)", async () => {
    const b = await relay.enrollAgent("lat-ack-b");
    const c = await relay.enrollAgent("lat-ack-c");
    const sent = await relay.agentRequest(c.agent_id, c.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: b.agent_id },
      message_type: "direct",
      body: { text: "please run the migration" },
      conversation_id: "work-155-ack",
      correlation_id: "cor-155-2"
    });
    const id = sent.body.message_id as string;
    await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
    await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/acks", {
      acks: [{ message_id: id, status: "received", received_at: new Date().toISOString() }]
    });

    // B never replied. The sender's read-back still shows the whole message as acked.
    const status = await relay.agentRequest(c.agent_id, c.secret, "GET", `/v1/messages/${id}/status`);
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("acked");
    const [d] = status.body.deliveries;
    expect(d.status).toBe("acked");
    expect(d.queued_at && d.delivered_at && d.acked_at).toBeTruthy();
    // Phase 1a (#155) added ack_recorded_at: the RELAY time the ack arrived,
    // next to the adapter-supplied acked_at. It is still only "received".
    // Nothing here records floor waiting, turn start, first reply or
    // completion. Later #155 phases add those.
    expect(Object.keys(d).sort()).toEqual([
      "ack_recorded_at", "acked_at", "dead_letter_reason", "dead_lettered_at", "delivered_at", "delivery_attempts",
      "last_failure_reason", "queued_at", "recipient_agent_id", "retry_count", "status"
    ]);
    expect(d.ack_recorded_at).toBeTruthy();
    for (const k of Object.keys(d)) {
      expect(k).not.toMatch(/reply|answer|turn|floor|complet/);
    }
  });

  it("clamps the floor lease to floorTtlMaxSeconds (the adapters ask for 960 s)", async () => {
    const a = await relay.enrollAgent("lat-ttl-a");
    const shared = await broadcast("long job");
    const before = Date.now();
    const res = await floor(a, shared, { ttl_seconds: 960 }); // adapter FLOOR_TTL_SECONDS at the 900 s default turn timeout
    expect(res.body.granted).toBe(true);
    const leaseSeconds = (Date.parse(res.body.expires_at) - before) / 1000;
    expect(Math.abs(leaseSeconds - config.floorTtlMaxSeconds)).toBeLessThan(5);
    if (process.env.EKHO_FLOOR_TTL_MAX_SECONDS === undefined) expect(config.floorTtlMaxSeconds).toBe(600);
  });

  it("frees an expired floor to the next agent, and the original holder then has nothing to release", async () => {
    const a = await relay.enrollAgent("lat-exp-a");
    const b = await relay.enrollAgent("lat-exp-b");
    const shared = await broadcast("expiry");
    expect((await floor(a, shared, { ttl_seconds: 0 })).body.granted).toBe(true); // expires immediately

    const taken = await floor(b, shared);
    expect(taken.body.granted).toBe(true);
    expect(taken.body.holder_agent_id).toBe(b.agent_id);
    // A's turn may still be running, but it lost the floor without being told.
    const late = await relay.agentRequest(a.agent_id, a.secret, "DELETE", `/v1/conversations/${shared}/floor`);
    expect(late.body.released).toBe(false);
  });

  it("lets independent recipients hold floors on DIFFERENT conversation ids at the same time", async () => {
    const a = await relay.enrollAgent("lat-ind-a");
    const b = await relay.enrollAgent("lat-ind-b");
    const convX = await broadcast("job x");
    const convY = await broadcast("job y");
    expect(convX).not.toBe(convY);
    expect((await floor(a, convX)).body.granted).toBe(true);
    const onY = await floor(b, convY);
    expect(onY.body.granted).toBe(true);
    expect(onY.body.holder_agent_id).toBe(b.agent_id);
    // Each floor is still exclusive on its own id.
    expect((await floor(b, convX)).body.granted).toBe(false);
  });

  it("reports an inbox that heartbeats but never fetches as healthy (FLIPS under #155: unresponsive inbox)", async () => {
    const live = await relay.enrollAgent("lat-live");
    const hb = await relay.agentRequest(live.agent_id, live.secret, "POST", "/v1/heartbeats", { status: "healthy", metrics: {} });
    expect(hb.status).toBe(200);
    const res = await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: "broadcast", text: "anyone there?" });
    const messageId = res.body.message_id as string;
    // The agent keeps heartbeating but never calls /v1/inbox.
    await relay.agentRequest(live.agent_id, live.secret, "POST", "/v1/heartbeats", { status: "healthy", metrics: {} });

    expect(deliveryStatus(messageId, live.agent_id)).toBe("queued");

    const health = await relay.operatorRequest("GET", "/v1/operator/fleet-health");
    const row = health.body.agents.find((x: { id: string }) => x.id === live.agent_id);
    expect(row.health.level).toBe("ok");
    expect(row.health.reason).toBe("connected (no turn data yet)");
    // "recv" counts the delivery row as soon as it is queued, before any fetch,
    // and no field reports queue depth or the oldest unfetched delivery.
    expect(row.received_1h).toBe(1);
    expect(Object.keys(row)).not.toContain("queued");
    expect(Object.keys(row)).not.toContain("oldest_queued_at");
    // Phase 1a (#155): the relay now records the agent's last /v1/inbox poll,
    // and this agent never polled. Phase 2 turns this into inbox.state.
    expect(row.last_inbox_poll_at).toBeNull();

    // Nothing in the Needs-You queue either.
    const attention = await relay.operatorRequest("GET", "/v1/operator/attention");
    expect(attention.body.items.filter((i: { agentId?: string }) => i.agentId === live.agent_id)).toEqual([]);
  });
});

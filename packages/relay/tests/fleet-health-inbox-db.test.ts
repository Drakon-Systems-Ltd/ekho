import "./setup"; // sets a temp EKHO_DB_PATH before db.ts's singleton is created
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// #186 (follow-up to #185, part of #155): DB-backed regression tests for the
// per-agent `inbox` aggregate in GET /v1/operator/fleet-health. The aggregate
// is one SQL statement over message_deliveries; deriveInboxState is unit-tested
// on its own, so these pin the SQL through the real poll / ack / phase routes.
describe("#186 fleet-health inbox aggregate (DB-backed)", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(() => relay.cleanup());

  async function sendDirect(from: { agent_id: string; secret: string }, to: { agent_id: string }, text: string): Promise<string> {
    const res = await relay.agentRequest(from.agent_id, from.secret, "POST", "/v1/messages", {
      recipient: { kind: "agent", id: to.agent_id },
      message_type: "direct",
      body: { text },
      conversation_id: `conv-186-${text}`,
      correlation_id: `cor-186-${text}`
    });
    expect(res.status).toBe(200);
    return res.body.message_id as string;
  }

  async function inboxOf(agentId: string) {
    const health = await relay.operatorRequest("GET", "/v1/operator/fleet-health");
    expect(health.status).toBe(200);
    return health.body.agents.find((x: { id: string }) => x.id === agentId).inbox;
  }

  function phase(agent: { agent_id: string; secret: string }, entry: Record<string, unknown>) {
    return relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/delivery-phases", { phases: [entry] });
  }

  it("delivered_unacked follows the real poll and ack: queued -> delivered (unacked) -> acked", async () => {
    const a = await relay.enrollAgent("ib-a");
    const b = await relay.enrollAgent("ib-b");
    const id = await sendDirect(a, b, "one");

    let inbox = await inboxOf(b.agent_id);
    expect(inbox.queued).toBe(1);
    expect(inbox.delivered_unacked).toBe(0);

    const polled = await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
    expect(polled.body.messages).toHaveLength(1);
    inbox = await inboxOf(b.agent_id);
    expect(inbox.queued).toBe(0);
    expect(inbox.oldest_queued_at).toBeNull();
    expect(inbox.delivered_unacked).toBe(1);

    const ack = await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/acks", {
      acks: [{ message_id: id, status: "received", received_at: new Date().toISOString() }]
    });
    expect(ack.status).toBe(200);
    inbox = await inboxOf(b.agent_id);
    expect(inbox.queued).toBe(0);
    expect(inbox.delivered_unacked).toBe(0);
    expect(inbox.state).toBe("idle");
  });

  it("counts only the recipient's own rows", async () => {
    const a = await relay.enrollAgent("ib-own-a");
    const b = await relay.enrollAgent("ib-own-b");
    await sendDirect(a, b, "own");
    await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
    expect((await inboxOf(b.agent_id)).delivered_unacked).toBe(1);
    expect((await inboxOf(a.agent_id)).delivered_unacked).toBe(0);
  });

  it("floor_wait counts a QUEUED row: a fresh queued delivery with a floor wait reads floor_wait, not queued", async () => {
    const a = await relay.enrollAgent("ib-fq-a");
    const b = await relay.enrollAgent("ib-fq-b");
    const id = await sendDirect(a, b, "fq");
    expect((await inboxOf(b.agent_id)).state).toBe("queued");

    const rep = await phase(b, { message_id: id, phase: "floor_wait", at: new Date().toISOString(), holder_agent_id: a.agent_id });
    expect(rep.status).toBe(200);

    const inbox = await inboxOf(b.agent_id);
    expect(inbox.queued).toBe(1);
    expect(inbox.state).toBe("floor_wait");
  });

  it("floor_wait counts a DELIVERED row: nothing queued, delivered row with a floor wait reads floor_wait", async () => {
    const a = await relay.enrollAgent("ib-fd-a");
    const b = await relay.enrollAgent("ib-fd-b");
    const id = await sendDirect(a, b, "fd");
    await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
    expect((await inboxOf(b.agent_id)).state).toBe("idle");

    await phase(b, { message_id: id, phase: "floor_wait", at: new Date().toISOString(), holder_agent_id: a.agent_id });

    const inbox = await inboxOf(b.agent_id);
    expect(inbox.queued).toBe(0);
    expect(inbox.delivered_unacked).toBe(1);
    expect(inbox.state).toBe("floor_wait");
  });

  it("a floor wait stops counting once the floor is granted, overrun, or a turn attempt is reported", async () => {
    const a = await relay.enrollAgent("ib-fe-a");
    const b = await relay.enrollAgent("ib-fe-b");
    const now = () => new Date().toISOString();
    const ids = [await sendDirect(a, b, "g"), await sendDirect(a, b, "o"), await sendDirect(a, b, "t")];
    await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
    for (const id of ids) await phase(b, { message_id: id, phase: "floor_wait", at: now(), holder_agent_id: a.agent_id });
    expect((await inboxOf(b.agent_id)).state).toBe("floor_wait");

    await phase(b, { message_id: ids[0], phase: "floor_granted", at: now() });
    await phase(b, { message_id: ids[1], phase: "floor_overrun", at: now() });
    expect((await inboxOf(b.agent_id)).state).toBe("floor_wait"); // the third still waits

    await phase(b, { message_id: ids[2], phase: "turn_started", at: now(), turn_id: "t186", attempt: 1 });
    const inbox = await inboxOf(b.agent_id);
    expect(inbox.state).toBe("idle");
    expect(inbox.delivered_unacked).toBe(3); // still unacked; only the floor wait ended
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// Floor control: at most one agent holds a conversation's floor at a time, so
// agents take turns instead of replying over each other. The floor carries a
// fresh catch-up tail so the holder never reasons over stale state.
describe("conversation floor control", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  async function room(members: string[]) {
    return (await relay.operatorRequest("POST", "/v1/operator/rooms", { name: "F", member_agent_ids: members })).body;
  }

  it("grants the floor to the first agent and denies a second", async () => {
    const a = await relay.enrollAgent("floor-a");
    const b = await relay.enrollAgent("floor-b");
    const r = await room([a.agent_id, b.agent_id]);

    const acqA = await relay.agentRequest(a.agent_id, a.secret, "POST", `/v1/conversations/${r.id}/floor`, {});
    expect(acqA.status).toBe(200);
    expect(acqA.body.granted).toBe(true);
    expect(acqA.body.holder_agent_id).toBe(a.agent_id);

    const acqB = await relay.agentRequest(b.agent_id, b.secret, "POST", `/v1/conversations/${r.id}/floor`, {});
    expect(acqB.body.granted).toBe(false);
    expect(acqB.body.holder_agent_id).toBe(a.agent_id);
  });

  it("re-grants to the current holder (idempotent re-acquire)", async () => {
    const a = await relay.enrollAgent("floor-re-a");
    const r = await room([a.agent_id]);
    expect((await relay.agentRequest(a.agent_id, a.secret, "POST", `/v1/conversations/${r.id}/floor`, {})).body.granted).toBe(true);
    expect((await relay.agentRequest(a.agent_id, a.secret, "POST", `/v1/conversations/${r.id}/floor`, {})).body.granted).toBe(true);
  });

  it("lets another agent take the floor after release", async () => {
    const a = await relay.enrollAgent("floor-rel-a");
    const b = await relay.enrollAgent("floor-rel-b");
    const r = await room([a.agent_id, b.agent_id]);

    await relay.agentRequest(a.agent_id, a.secret, "POST", `/v1/conversations/${r.id}/floor`, {});
    const rel = await relay.agentRequest(a.agent_id, a.secret, "DELETE", `/v1/conversations/${r.id}/floor`);
    expect(rel.body.released).toBe(true);

    const acqB = await relay.agentRequest(b.agent_id, b.secret, "POST", `/v1/conversations/${r.id}/floor`, {});
    expect(acqB.body.granted).toBe(true);
    expect(acqB.body.holder_agent_id).toBe(b.agent_id);
  });

  it("only the holder can release the floor", async () => {
    const a = await relay.enrollAgent("floor-own-a");
    const b = await relay.enrollAgent("floor-own-b");
    const r = await room([a.agent_id, b.agent_id]);
    await relay.agentRequest(a.agent_id, a.secret, "POST", `/v1/conversations/${r.id}/floor`, {});
    // b tries to release a's floor -> no-op
    expect((await relay.agentRequest(b.agent_id, b.secret, "DELETE", `/v1/conversations/${r.id}/floor`)).body.released).toBe(false);
    // a still holds it
    expect((await relay.agentRequest(b.agent_id, b.secret, "POST", `/v1/conversations/${r.id}/floor`, {})).body.granted).toBe(false);
  });

  it("lets another agent take an expired floor (ttl_seconds: 0)", async () => {
    const a = await relay.enrollAgent("floor-exp-a");
    const b = await relay.enrollAgent("floor-exp-b");
    const r = await room([a.agent_id, b.agent_id]);
    // a acquires with an immediately-expiring floor
    expect((await relay.agentRequest(a.agent_id, a.secret, "POST", `/v1/conversations/${r.id}/floor`, { ttl_seconds: 0 })).body.granted).toBe(true);
    // b can take it since a's floor is already expired
    expect((await relay.agentRequest(b.agent_id, b.secret, "POST", `/v1/conversations/${r.id}/floor`, {})).body.granted).toBe(true);
  });

  it("hands the floor holder a fresh conversation tail (catch-up)", async () => {
    const a = await relay.enrollAgent("floor-tail-a");
    const r = await room([a.agent_id]);
    await relay.operatorRequest("POST", "/v1/operator/messages", { room_id: r.id, text: "first thing" });
    await relay.operatorRequest("POST", "/v1/operator/messages", { room_id: r.id, text: "second thing" });

    const acq = await relay.agentRequest(a.agent_id, a.secret, "POST", `/v1/conversations/${r.id}/floor`, {});
    const tail = acq.body.conversation_tail;
    expect(Array.isArray(tail)).toBe(true);
    const texts = tail.map((t: { text: string }) => t.text);
    expect(texts).toContain("first thing");
    expect(texts).toContain("second thing");
    expect(tail[0].sender_kind).toBe("operator");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// Regression tests for the audit's correctness/security findings.
describe("relay hardening", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  it("does not let an agent read or complete another agent's approval (IDOR)", async () => {
    const a = await relay.enrollAgent("apr-a");
    const b = await relay.enrollAgent("apr-b");
    const prop = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/actions/propose", {
      conversation_id: "c", action_type: "shell", risk_level: "high", summary: "danger", payload: {}
    });
    const approvalId = prop.body.approval_id;
    expect(approvalId).toBeTruthy();

    // b (a different agent) can neither read nor complete a's approval
    const read = await relay.agentRequest(b.agent_id, b.secret, "GET", `/v1/actions/${approvalId}`);
    expect(read.status).toBe(404);
    const done = await relay.agentRequest(b.agent_id, b.secret, "POST", "/v1/actions/result", {
      approval_id: approvalId, result: "executed", completed_at: "2026-06-09T00:00:00.000Z", output: {}
    });
    expect(done.body.ok).toBe(false);

    // a CAN read its own approval
    expect((await relay.agentRequest(a.agent_id, a.secret, "GET", `/v1/actions/${approvalId}`)).status).toBe(200);
  });

  it("rejects a 'group' message instead of silently dropping it (no delivery)", async () => {
    const a = await relay.enrollAgent("grp-a");
    const b = await relay.enrollAgent("grp-b");
    const res = await relay.agentRequest(a.agent_id, a.secret, "POST", "/v1/messages", {
      recipient: { kind: "group", id: "some-group" },
      message_type: "direct",
      body: { text: "hi group" },
      conversation_id: "g1",
      correlation_id: "gc1"
    });
    expect(res.status).toBe(400);
    // and nobody silently received it
    const inbox = await relay.agentRequest(b.agent_id, b.secret, "GET", "/v1/inbox");
    expect(inbox.body.messages.length).toBe(0);
  });
});

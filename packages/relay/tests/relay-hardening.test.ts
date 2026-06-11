import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// Regression tests for the audit's correctness/security findings.
describe("relay hardening", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
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

import { describe, it, expect, beforeEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";

// Adversarial: approveOrReject must be scoped to the operator's own fleet and
// only ever resolve a PENDING approval. Prior to the fix it selected the row by
// id alone, so an operator authenticated to fleet A could approve/reject fleet
// B's pending agent action (cross-tenant IDOR of the approval control plane),
// and any already-decided approval could be re-resolved.
describe("approveOrReject fleet scoping + pending gate", () => {
  let relay: TestRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });

  // Stand up a pending high-risk approval owned by a SECOND fleet. Names/emails
  // are unique per call — the test relay reuses one physical DB across cases.
  let seq = 0;
  function pendingApprovalInOtherFleet() {
    const tag = `b${++seq}-${process.hrtime.bigint()}`;
    const other = relay.db.createBootstrap(`fleet-${tag}`, `admin-${tag}@test.com`, "testpassword1");
    const token = relay.db.issueEnrollmentToken(other.fleetId, other.operatorId);
    const agent = relay.db.createAgentFromEnrollment({
      fleetId: other.fleetId, token, displayName: "b-agent", runtime: "custom"
    })!;
    const res = relay.db.proposeAction({
      agentId: agent.agentId,
      conversationId: "conv-b",
      actionType: "shell",
      summary: "rm -rf /",
      riskLevel: "critical",
      payload: {}
    });
    expect(res.decision).toBe("pending_approval");
    return { ...other, approvalId: res.approvalId! };
  }

  const statusOf = (id: string) =>
    (relay.db.raw().prepare("SELECT status, resolved_by_operator_id FROM approvals WHERE id = ?").get(id) as
      { status: string; resolved_by_operator_id: string | null } | undefined);

  it("rejects a cross-fleet operator and leaves the approval pending", () => {
    const b = pendingApprovalInOtherFleet();
    // relay.operatorId belongs to the DEFAULT fleet (relay.fleetId), not fleet B.
    const ok = relay.db.approveOrReject(b.approvalId, relay.fleetId, relay.operatorId, "approved");
    expect(ok).toBe(false);
    const row = statusOf(b.approvalId);
    expect(row?.status).toBe("pending");
    expect(row?.resolved_by_operator_id).toBeNull();
  });

  it("allows the owning-fleet operator to resolve it once", () => {
    const b = pendingApprovalInOtherFleet();
    const ok = relay.db.approveOrReject(b.approvalId, b.fleetId, b.operatorId, "approved");
    expect(ok).toBe(true);
    expect(statusOf(b.approvalId)?.status).toBe("approved");

    // Pending gate: a second decision on an already-resolved approval is a no-op.
    const again = relay.db.approveOrReject(b.approvalId, b.fleetId, b.operatorId, "rejected");
    expect(again).toBe(false);
    expect(statusOf(b.approvalId)?.status).toBe("approved");
  });

  it("HTTP: a foreign operator token cannot resolve another fleet's approval", async () => {
    const b = pendingApprovalInOtherFleet();
    // relay.operatorRequest uses the DEFAULT fleet's operator token.
    const res = await relay.operatorRequest("POST", `/v1/operator/approvals/${b.approvalId}/approve`);
    // Route returns ok:false (nothing resolved) and the row stays pending.
    expect(res.body.ok).toBe(false);
    expect(statusOf(b.approvalId)?.status).toBe("pending");
  });
});

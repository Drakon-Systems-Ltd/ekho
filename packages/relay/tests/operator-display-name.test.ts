import { describe, it, expect } from "vitest";
import { createTestRelay } from "./setup";

// The operator can set a display name so the TEAM (agents) sees who they're
// talking to. It must be server-side: stamped into the message sender_label
// agents receive, and reflected on the synthetic operator node in topology/
// health. A local console preference would not tell the team anything.
describe("operator display name (team-visible)", () => {
  it("defaults to no display name; operator sends still label as 'Operator'", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("Recip");

    const prof = await relay.operatorRequest("GET", "/v1/operator/profile");
    expect(prof.status).toBe(200);
    expect(String(prof.body.email)).toContain("@");
    expect(prof.body.display_name ?? null).toBe(null);

    const send = await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: agent_id, text: "hi" });
    expect(send.status).toBe(201);
    const conv = await relay.operatorRequest("GET", `/v1/operator/conversations/${send.body.conversation_id}`);
    const labels = (conv.body.events as Array<{ payload_json?: string }>)
      .map((e) => { try { return JSON.parse(e.payload_json || "{}").sender_label as string | undefined; } catch { return undefined; } })
      .filter(Boolean);
    expect(labels).toContain("Operator");
  });

  it("PATCH sets the name → agents receive it as sender_label, and the operator node is relabelled", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("Recip");

    const patch = await relay.operatorRequest("PATCH", "/v1/operator/profile", { display_name: "Michael" });
    expect(patch.status).toBe(200);
    expect(patch.body.display_name).toBe("Michael");

    const send = await relay.operatorRequest("POST", "/v1/operator/messages", { recipient_agent_id: agent_id, text: "do you read me" });
    expect(send.status).toBe(201);
    const conv = await relay.operatorRequest("GET", `/v1/operator/conversations/${send.body.conversation_id}`);
    const labels = (conv.body.events as Array<{ payload_json?: string }>)
      .map((e) => { try { return JSON.parse(e.payload_json || "{}").sender_label as string | undefined; } catch { return undefined; } })
      .filter(Boolean);
    expect(labels).toContain("Michael");
    expect(labels).not.toContain("Operator");

    // Node relabel (topology/health/roster read the agent display_name).
    const node = relay.db.raw().prepare("SELECT display_name FROM agents WHERE id = ?").get(`op_${relay.fleetId}`) as { display_name: string };
    expect(node.display_name).toBe("Michael");

    // Survives reload: GET /profile still reports it.
    const prof = await relay.operatorRequest("GET", "/v1/operator/profile");
    expect(prof.body.display_name).toBe("Michael");
  });

  it("rejects an empty or over-long name", async () => {
    const relay = await createTestRelay();
    const empty = await relay.operatorRequest("PATCH", "/v1/operator/profile", { display_name: "   " });
    expect(empty.status).toBe(400);
    const long = await relay.operatorRequest("PATCH", "/v1/operator/profile", { display_name: "x".repeat(41) });
    expect(long.status).toBe(400);
  });
});

import { describe, it, expect } from "vitest";
import { createTestRelay } from "./setup";

// Wire "Channels" redesign — the relay gives every agent ONE stable DM
// conversation (dm-<fleetId>-<agentId>, keyed by the agent since op_<fleetId>
// is a shared singleton) so 1:1 traffic stops scattering across op-/oc- ids.
// A canonical id is minted only for a FRESH 1:1 send (no conversation_id); an
// explicitly-passed id — the open DM, a group, or a room reply — is honored, so
// group/room replies are never hijacked into a DM.
describe("Wire channels — canonical per-agent DM (operator send)", () => {
  it("threads fresh operator→agent 1:1 sends into one dm-<fleet>-<agent>", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("Case");

    const r1 = relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: agent_id, text: "one" });
    const r2 = relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: agent_id, text: "two" });

    expect(r1.conversationId).toBe(`dm-${relay.fleetId}-${agent_id}`);
    expect(r2.conversationId).toBe(r1.conversationId);
  });

  it("honors an explicitly passed conversation_id (a group/room reply stays put)", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("Case");

    const r = relay.db.createOperatorMessage({
      fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: agent_id,
      conversationId: "grp-legacy-abc", text: "reply in the group",
    });
    expect(r.conversationId).toBe("grp-legacy-abc");
  });

  it("leaves broadcast sends on their own conversation, never a dm-", async () => {
    const relay = await createTestRelay();
    await relay.enrollAgent("Case");

    const r = relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: "broadcast", text: "all hands" });
    expect(r.conversationId.startsWith("dm-")).toBe(false);
  });
});

describe("Wire channels — agent→operator reply folds into the DM", () => {
  it("normalizes a plugin-minted id to the sender's canonical DM", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("Case");
    // Seed the DM from the operator side so op_<fleet> exists as a recipient.
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: agent_id, text: "ping" });

    relay.db.createMessage({
      fleetId: relay.fleetId, senderAgentId: agent_id, recipientKind: "agent", recipientId: `op_${relay.fleetId}`,
      messageType: "direct", priority: "normal", ttlSeconds: 900, requiresApproval: false,
      body: { text: "pong" }, conversationId: "oc-legacy-999", correlationId: "cor-x",
    });

    const dm = `dm-${relay.fleetId}-${agent_id}`;
    const reply = relay.db.raw().prepare(
      "SELECT conversation_id FROM messages WHERE sender_agent_id = ? AND recipient_id = ?"
    ).get(agent_id, `op_${relay.fleetId}`) as { conversation_id: string };
    expect(reply.conversation_id).toBe(dm);

    // The plugin-minted id was never used — the reply folded into the DM.
    const stray = relay.db.raw().prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = 'oc-legacy-999'").get() as { n: number };
    expect(stray.n).toBe(0);
  });

  it("an agent cannot inject into another agent's DM (id derives from the sender)", async () => {
    const relay = await createTestRelay();
    const { agent_id: a } = await relay.enrollAgent("Case");
    const { agent_id: b } = await relay.enrollAgent("Jarvis");
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: b, text: "seed b" });

    // Agent A replies to the operator but NAMES agent B's DM id.
    relay.db.createMessage({
      fleetId: relay.fleetId, senderAgentId: a, recipientKind: "agent", recipientId: `op_${relay.fleetId}`,
      messageType: "direct", priority: "normal", ttlSeconds: 900, requiresApproval: false,
      body: { text: "sneaky" }, conversationId: `dm-${relay.fleetId}-${b}`, correlationId: "cor-z",
    });

    const row = relay.db.raw().prepare(
      "SELECT conversation_id FROM messages WHERE sender_agent_id = ? AND recipient_id = ?"
    ).get(a, `op_${relay.fleetId}`) as { conversation_id: string };
    expect(row.conversation_id).toBe(`dm-${relay.fleetId}-${a}`); // A's own DM, not B's
  });
});

describe("Wire channels — read-time DM merge", () => {
  const qtext = (items: Array<Record<string, unknown>>) =>
    items
      .filter((e) => e.event_type === "message.queued")
      .map((e) => {
        try { return JSON.parse(String(e.payload_json)).text || JSON.parse(String(e.message_body_json || "{}")).text; } catch { return ""; }
      });

  it("merges an agent's full 1:1 history across legacy ids under the canonical dm id", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("Case");
    const dm = `dm-${relay.fleetId}-${agent_id}`;

    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: agent_id, text: "op-one" });
    // a legacy scattered 1:1 (pre-redesign history under its own op- id)
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: agent_id, conversationId: "op-legacy-1", text: "op-legacy" });
    relay.db.createMessage({ fleetId: relay.fleetId, senderAgentId: agent_id, recipientKind: "agent", recipientId: `op_${relay.fleetId}`, messageType: "direct", priority: "normal", ttlSeconds: 900, requiresApproval: false, body: { text: "agent-back" }, conversationId: "oc-1", correlationId: "c1" });

    const conv = relay.db.getConversation(relay.fleetId, dm, { sortOrder: "asc", limit: 100 });
    const texts = qtext(conv.items as Array<Record<string, unknown>>);
    expect(texts).toContain("op-one");
    expect(texts).toContain("op-legacy"); // legacy scattered 1:1 folds into the DM
    expect(texts).toContain("agent-back");
  });

  it("does not bleed another agent's messages from a shared legacy thread", async () => {
    const relay = await createTestRelay();
    const { agent_id: a } = await relay.enrollAgent("Case");
    const { agent_id: b } = await relay.enrollAgent("Jarvis");
    // one legacy conversation carrying BOTH op→A and op→B messages
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: a, conversationId: "mixed-1", text: "to-A" });
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: b, conversationId: "mixed-1", text: "to-B" });

    const convA = relay.db.getConversation(relay.fleetId, `dm-${relay.fleetId}-${a}`, { sortOrder: "asc", limit: 100 });
    const textsA = qtext(convA.items as Array<Record<string, unknown>>);
    expect(textsA).toContain("to-A");
    expect(textsA).not.toContain("to-B"); // message-level predicate → no bleed
  });
});

describe("Wire channels — overview channel_key + feed exclusion", () => {
  it("emits channel_key per row, excludes feeds, and exposes fleetId", async () => {
    const relay = await createTestRelay();
    const { agent_id: a } = await relay.enrollAgent("Case");
    const { agent_id: b } = await relay.enrollAgent("Jarvis");
    // a canonical DM with Case
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: a, text: "dm" });
    // an ad-hoc group thread (op→A and op→B under one id) → participants {A,B}
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: a, conversationId: "grpc", text: "to a" });
    relay.db.createOperatorMessage({ fleetId: relay.fleetId, operatorId: relay.operatorId, recipientId: b, conversationId: "grpc", text: "to b" });
    // a feed conversation (raw insert; only sender_agent_id carries an FK)
    relay.db.raw().prepare(
      `INSERT INTO messages (id, fleet_id, conversation_id, correlation_id, sender_agent_id, recipient_kind, recipient_id, message_type, priority, requires_approval, body_json, metadata_json, ttl_seconds, created_at, expires_at, status)
       VALUES ('m-feed-1', ?, 'feed-test', 'cor-f', ?, 'broadcast', NULL, 'feed', 'normal', 0, '{"text":"headline"}', '{}', 900, '2026-07-19T00:00:00.000Z', '2026-07-19T00:15:00.000Z', 'queued')`
    ).run(relay.fleetId, a);

    const ov = relay.db.getFleetOverview(relay.fleetId) as { fleetId?: string; recentConversations: Array<Record<string, unknown>> };
    expect(ov.fleetId).toBe(relay.fleetId);

    const rc = ov.recentConversations;
    expect(rc.some((c) => String(c.conversation_id).startsWith("feed-"))).toBe(false);

    const dmRow = rc.find((c) => c.channel_key === `dm-${relay.fleetId}-${a}`);
    expect(dmRow).toBeTruthy();
    expect(dmRow!.kind).toBe("dm");

    const grpRow = rc.find((c) => c.kind === "group");
    expect(grpRow!.channel_key).toBe(`grp-${relay.fleetId}-${[a, b].sort().join(".")}`);
  });
});

describe("Wire channels — operator route guards canonical ids", () => {
  it("rejects a dm- id that does not match the addressed agent", async () => {
    const relay = await createTestRelay();
    const { agent_id } = await relay.enrollAgent("Case");
    const { agent_id: other } = await relay.enrollAgent("Jarvis");

    const bad = await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: agent_id, text: "x", conversation_id: `dm-${relay.fleetId}-${other}`,
    });
    expect(bad.status).toBe(400);

    const ok = await relay.operatorRequest("POST", "/v1/operator/messages", {
      recipient_agent_id: agent_id, text: "y", conversation_id: `dm-${relay.fleetId}-${agent_id}`,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.conversation_id).toBe(`dm-${relay.fleetId}-${agent_id}`);
  });
});

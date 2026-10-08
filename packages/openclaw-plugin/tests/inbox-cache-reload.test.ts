import { afterEach, describe, expect, it, vi } from "vitest";
import { getCachedInbox, recordBatch, recordVerifications, resetCachedInboxForTest } from "../src/autoreply";

const agentId = "reload-cache-test-agent";

afterEach(() => resetCachedInboxForTest(agentId));

describe("inbox cache across module reloads (#115)", () => {
  it("keeps delivered room attachments visible to another module copy after an empty poll", async () => {
    recordBatch({
      messages: [{
        message_id: "room-evidence", conversation_id: "room-1", sender_agent_id: "peer",
        message_type: "room", body: { text: "evidence" },
        attachments: [{ id: "att-1", filename: "evidence.json", mime: "application/json", size_bytes: 12 }]
      }]
    }, {}, agentId);
    recordVerifications({ "room-evidence": { verified: false, kind: "peer", reason: "invalid-signature", keyId: "peer-key" } }, [], undefined, agentId);
    recordBatch({ messages: [] }, {}, agentId);

    vi.resetModules();
    const reloaded = await import("../src/autoreply");
    expect(reloaded.getCachedInbox(agentId).messages).toEqual(getCachedInbox(agentId).messages);
    expect(reloaded.getCachedInbox(agentId).messages[0].attachments).toEqual([
      { id: "att-1", filename: "evidence.json", mime: "application/json", size_bytes: 12 }
    ]);
    expect(reloaded.getCachedInbox(agentId).entries[0].verification?.reason).toBe("invalid-signature");
    expect(reloaded.getCachedInbox("another-agent").messages).toEqual([]);
  });

  it("shares the latest roster and advances its timestamp on an empty poll", async () => {
    expect(getCachedInbox(agentId).recorded_at).toBeNull();
    recordBatch({ messages: [], roster: [{ agent_id: "peer", status: "quarantined", quarantine_reason: "heartbeat_timeout" }] }, {}, agentId);
    const first = getCachedInbox(agentId).recorded_at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    recordBatch({ messages: [], roster: [{ agent_id: "peer", status: "healthy", quarantine_reason: null }] }, {}, agentId);
    vi.resetModules();
    const reloaded = await import("../src/autoreply");
    expect(reloaded.getCachedInbox(agentId).roster).toEqual([{ agent_id: "peer", status: "healthy", quarantine_reason: null }]);
    expect(Date.parse(reloaded.getCachedInbox(agentId).recorded_at!)).toBeGreaterThan(Date.parse(first!));
  });
});

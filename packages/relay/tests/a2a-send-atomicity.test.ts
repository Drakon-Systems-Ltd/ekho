import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { canonicalDmId } from "../src/db";
import { A2ATaskStore } from "../src/a2a/task-store";

describe("A2A send persistence atomicity", () => {
  let relay: TestRelay;
  beforeEach(async () => { relay = await createTestRelay(); });
  afterEach(() => relay.cleanup());

  function snapshot() {
    const db = relay.db.raw();
    return {
      tasks: db.prepare("SELECT * FROM a2a_tasks WHERE fleet_id = ? ORDER BY id").all(relay.fleetId),
      messages: db.prepare("SELECT * FROM messages WHERE fleet_id = ? ORDER BY id").all(relay.fleetId),
      links: db.prepare("SELECT l.* FROM a2a_task_messages l JOIN a2a_tasks t ON t.id = l.task_id WHERE t.fleet_id = ? ORDER BY l.message_id").all(relay.fleetId),
      deliveries: db.prepare("SELECT d.* FROM message_deliveries d JOIN messages m ON m.id = d.message_id WHERE m.fleet_id = ? ORDER BY d.id").all(relay.fleetId),
    };
  }

  for (const existing of [false, true]) {
    it(existing ? "rejected continuation leaves existing history and timestamps unchanged" : "rejected new send leaves no phantom task", async () => {
      const owner = await relay.enrollAgent("atomic-owner");
      const peer = await relay.enrollAgent("atomic-peer");
      const contextId = canonicalDmId(relay.fleetId, owner.agent_id);
      // Fixture: a task created directly in the store with the owner's canonical DM as context.
      const task = existing ? new A2ATaskStore(relay.db.raw()).createTask({
        fleetId: relay.fleetId, agentId: peer.agent_id, senderAgentId: owner.agent_id,
        contextId, initialMessage: { messageId: "original", role: "user", kind: "message", parts: [{ kind: "text", text: "original history" }] },
      }) : undefined;
      const before = snapshot();
      const response = await relay.agentRequest(owner.agent_id, owner.secret, "POST", "/agents/" + peer.agent_id + "/a2a", {
        jsonrpc: "2.0", id: 1, method: "message/send",
        params: { message: { messageId: "rejected", role: "user", parts: [{ kind: "text", text: "must not persist" }], contextId, ...(task ? { taskId: task.id } : {}) } },
      });
      expect(response.body.result).toBeUndefined();
      expect(response.body.error.message).toContain("conversation not permitted");
      expect(snapshot()).toEqual(before);
    });
  }
});

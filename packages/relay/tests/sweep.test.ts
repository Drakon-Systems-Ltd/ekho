import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestRelay, type TestRelay } from "./setup";
import { id, nowIso, addSeconds } from "../src/utils";

describe("Delivery sweep: retry, dead-letter, expiry", () => {
  let relay: TestRelay;
  let senderId: string;
  let recipientId: string;

  beforeAll(async () => {
    relay = await createTestRelay();
    senderId = (await relay.enrollAgent("sweep-sender")).agent_id;
    recipientId = (await relay.enrollAgent("sweep-recipient")).agent_id;
  });

  // Isolate each test: sweep return values are global counts, so leftover
  // messages/deliveries from a prior test must not leak into the next.
  beforeEach(() => {
    const raw = relay.db.raw();
    raw.prepare("DELETE FROM dead_letters").run();
    raw.prepare("DELETE FROM message_deliveries").run();
    raw.prepare("DELETE FROM messages").run();
  });

  afterAll(() => relay.cleanup());

  function newDelivery(): { messageId: string; deliveryId: string } {
    const { messageId } = relay.db.createMessage({
      fleetId: relay.fleetId,
      senderAgentId: senderId,
      recipientKind: "agent",
      recipientId,
      messageType: "task",
      priority: "normal",
      ttlSeconds: 3600,
      requiresApproval: false,
      body: { hello: "world" },
      conversationId: id("conv"),
      correlationId: id("corr")
    });
    const row = relay.db
      .raw()
      .prepare("SELECT id FROM message_deliveries WHERE message_id = ?")
      .get(messageId) as { id: string };
    return { messageId, deliveryId: row.id };
  }

  function setDelivery(deliveryId: string, fields: Record<string, unknown>) {
    const keys = Object.keys(fields);
    const setClause = keys.map((k) => `${k} = ?`).join(", ");
    relay.db
      .raw()
      .prepare(`UPDATE message_deliveries SET ${setClause} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), deliveryId);
  }

  function delivery(deliveryId: string) {
    return relay.db.raw().prepare("SELECT * FROM message_deliveries WHERE id = ?").get(deliveryId) as Record<string, unknown>;
  }

  test("requeues a delivered-but-unacked message past the delivery timeout", () => {
    const { deliveryId } = newDelivery();
    setDelivery(deliveryId, { status: "delivered", delivered_at: addSeconds(nowIso(), -1000), retry_count: 0 });

    const result = relay.db.sweepRetryDeliveries();
    expect(result).toEqual({ retried: 1, deadLettered: 0 });

    const row = delivery(deliveryId);
    expect(row.status).toBe("queued");
    expect(row.retry_count).toBe(1);
    expect(row.next_retry_at).not.toBeNull();
  });

  test("dead-letters a delivery once max retries are exceeded", () => {
    const { messageId, deliveryId } = newDelivery();
    setDelivery(deliveryId, { status: "delivered", delivered_at: addSeconds(nowIso(), -1000), retry_count: 5 });

    const result = relay.db.sweepRetryDeliveries();
    expect(result).toEqual({ retried: 0, deadLettered: 1 });

    expect(delivery(deliveryId).status).toBe("dead_lettered");
    const dl = relay.db
      .raw()
      .prepare("SELECT * FROM dead_letters WHERE original_message_id = ?")
      .get(messageId) as Record<string, unknown>;
    expect(dl).toBeDefined();
    expect(dl.failure_reason).toBe("max_retries_exceeded");
    const message = relay.db.raw().prepare("SELECT status FROM messages WHERE id = ?").get(messageId) as { status: string };
    expect(message.status).toBe("dead_lettered");
  });

  test("does not touch acked deliveries", () => {
    const { deliveryId } = newDelivery();
    setDelivery(deliveryId, { status: "acked", delivered_at: addSeconds(nowIso(), -1000), retry_count: 0 });

    const result = relay.db.sweepRetryDeliveries();
    expect(result).toEqual({ retried: 0, deadLettered: 0 });
    expect(delivery(deliveryId).status).toBe("acked");
  });

  test("expires messages past their TTL", () => {
    const { messageId, deliveryId } = newDelivery();
    relay.db.raw().prepare("UPDATE messages SET expires_at = ? WHERE id = ?").run(addSeconds(nowIso(), -10), messageId);

    const expired = relay.db.sweepExpiredMessages();
    expect(expired).toBe(1);
    expect(delivery(deliveryId).status).toBe("expired");
    const message = relay.db.raw().prepare("SELECT status FROM messages WHERE id = ?").get(messageId) as { status: string };
    expect(message.status).toBe("expired");
  });
});

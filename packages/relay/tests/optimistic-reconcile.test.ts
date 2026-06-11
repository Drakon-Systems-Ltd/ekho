import { describe, it, expect } from "vitest";
// Pure reconciliation of pending (optimistic) operator messages against the
// server-echoed timeline. No React, so it unit-tests cleanly.
import { reconcileOptimistic } from "../frontend/src/optimistic.js";

const optim = (id: string, conversationId: string, text: string, messageId?: string) => ({
  id,
  conversationId,
  text,
  messageId,
  createdAt: "2026-06-11T00:00:00.000Z",
});

describe("reconcileOptimistic", () => {
  it("drops a bound optimistic item once the server echoes its message id", () => {
    const items = [optim("optim-1", "c1", "hello", "msg_abc")];
    const events = [{ resource_id: "msg_abc", resource_kind: "message", actor_kind: "operator" }];
    expect(reconcileOptimistic(items, events, "c1")).toEqual([]);
  });

  it("reconciles two identical-text messages independently (the text-collision bug)", () => {
    // Operator sent "ok" twice. The server has echoed only the first so far.
    // Text-only dedup would drop BOTH; binding by id drops only the echoed one.
    const items = [optim("optim-1", "c1", "ok", "msg_1"), optim("optim-2", "c1", "ok", "msg_2")];
    const events = [{ resource_id: "msg_1", resource_kind: "message", actor_kind: "operator" }];
    const kept = reconcileOptimistic(items, events, "c1");
    expect(kept.map((o) => o.id)).toEqual(["optim-2"]);
  });

  it("never touches optimistic items belonging to a different conversation", () => {
    const items = [optim("optim-1", "other", "hi", "msg_x")];
    // Even if msg_x somehow appears in c1's events, the item is in another thread.
    const events = [{ resource_id: "msg_x", resource_kind: "message", actor_kind: "operator" }];
    expect(reconcileOptimistic(items, events, "c1")).toEqual(items);
  });

  it("keeps an unbound item (send still in flight) until it has a real message id", () => {
    const items = [optim("optim-1", "c1", "pending")]; // no messageId yet
    const events = [{ resource_id: "msg_other", resource_kind: "message", actor_kind: "operator" }];
    expect(reconcileOptimistic(items, events, "c1")).toEqual(items);
  });

  it("tolerates missing/empty events without dropping anything", () => {
    const items = [optim("optim-1", "c1", "hello", "msg_abc")];
    expect(reconcileOptimistic(items, [], "c1")).toEqual(items);
    expect(reconcileOptimistic(items, undefined as never, "c1")).toEqual(items);
  });
});

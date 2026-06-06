import { describe, it, expect } from "vitest";
import {
  isRealInbound,
  peerLatchOpen,
  consumePeerLatch,
  resetPeerLatch,
  buildPrompt,
  createAutoReplyState,
  effectivePeerSettings,
  DEFAULT_PEER_TURN_BUDGET
} from "../src/autoreply";

// Loose factory — the autoreply functions read these fields structurally.
function msg(over: Record<string, unknown> = {}): any {
  return {
    message_id: "m1",
    conversation_id: "c1",
    sender_agent_id: "op",
    sender_kind: "operator",
    message_type: "direct",
    body: { text: "hi" },
    ...over
  };
}

describe("bounded peer delegation", () => {
  it("allows a teammate when peer delegation is enabled", () => {
    const m = msg({ sender_kind: "agent", sender_agent_id: "jarvis" });
    expect(isRealInbound(m, "self", createAutoReplyState(), false, true)).toBe(true);
  });

  it("rejects a teammate when peer delegation is disabled (operator-only default)", () => {
    const m = msg({ sender_kind: "agent", sender_agent_id: "jarvis" });
    expect(isRealInbound(m, "self", createAutoReplyState(), true, false)).toBe(false);
  });

  it("keeps the operator trust gate independent of peer delegation", () => {
    expect(isRealInbound(msg(), "self", createAutoReplyState(), false, true)).toBe(false);
    expect(isRealInbound(msg(), "self", createAutoReplyState(), true, true)).toBe(true);
  });

  it("never reacts to its own outbound", () => {
    const own = msg({ sender_kind: "agent", sender_agent_id: "self" });
    expect(isRealInbound(own, "self", createAutoReplyState(), true, true)).toBe(false);
  });

  it("latch opens until the budget is reached, then closes", () => {
    const s = createAutoReplyState();
    expect(peerLatchOpen(s, "c", 2)).toBe(true);
    consumePeerLatch(s, "c");
    expect(peerLatchOpen(s, "c", 2)).toBe(true);
    consumePeerLatch(s, "c");
    expect(peerLatchOpen(s, "c", 2)).toBe(false);
  });

  it("an operator message re-opens a closed latch", () => {
    const s = createAutoReplyState();
    consumePeerLatch(s, "c");
    consumePeerLatch(s, "c");
    expect(peerLatchOpen(s, "c", 2)).toBe(false);
    resetPeerLatch(s, "c");
    expect(peerLatchOpen(s, "c", 2)).toBe(true);
  });

  it("frames a teammate by display name with the productivity gate", () => {
    const m = msg({
      sender_kind: "agent",
      sender_agent_id: "agent_jarvis",
      body: { text: "can you take the API task?" }
    });
    const batch: any = {
      messages: [m],
      operator_trusted: false,
      roster: [{ agent_id: "agent_jarvis", display_name: "Jarvis" }]
    };
    const p = buildPrompt([m], batch);
    expect(p).toContain("Jarvis"); // display name, not raw id
    expect(p).toContain('recipient_agent_id="agent_jarvis"');
    expect(p).toContain("materially advances the work");
    expect(p).toContain("acknowledge");
  });

  it("does not hardcode an operator name", () => {
    const p = buildPrompt([msg()], { messages: [msg()], operator_trusted: true, roster: [] } as any);
    expect(p).not.toContain("Michael");
  });

  it("defaults the per-conversation budget to 6", () => {
    expect(DEFAULT_PEER_TURN_BUDGET).toBe(6);
  });

  it("relay value overrides the bootstrap default (live console control)", () => {
    expect(effectivePeerSettings({ peer_autoreply: true }, { peerEnabled: false, peerTurnBudget: 6 }))
      .toEqual({ peerEnabled: true, peerTurnBudget: 6 });
    expect(effectivePeerSettings({ peer_autoreply: false }, { peerEnabled: true, peerTurnBudget: 6 }))
      .toEqual({ peerEnabled: false, peerTurnBudget: 6 });
  });

  it("falls back to the bootstrap default when the relay omits the field", () => {
    expect(effectivePeerSettings({}, { peerEnabled: true, peerTurnBudget: 6 }))
      .toEqual({ peerEnabled: true, peerTurnBudget: 6 });
  });

  it("relay budget overrides the bootstrap budget", () => {
    expect(effectivePeerSettings({ peer_autoreply: true, peer_turn_budget: 3 }, { peerEnabled: true, peerTurnBudget: 99 }))
      .toEqual({ peerEnabled: true, peerTurnBudget: 3 });
  });
});

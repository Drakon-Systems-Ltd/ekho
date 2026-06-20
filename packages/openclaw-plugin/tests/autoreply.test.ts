import { describe, it, expect } from "vitest";
import {
  isRealInbound,
  peerLatchOpen,
  consumePeerLatch,
  resetPeerLatch,
  buildPrompt,
  planFloorTurn,
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

  it("frames a cryptographically-verified operator message (even with relay flag off)", () => {
    const m = msg({ message_id: "mop" });
    const batch = { messages: [m], operator_trusted: false, roster: [] } as any;
    const verifications = { mop: { verified: true, kind: "operator", reason: null, keyId: "anz_x" } } as any;
    const p = buildPrompt([m], batch, verifications);
    expect(p).toContain("CRYPTOGRAPHICALLY VERIFIED");
    expect(p).toContain("anz_x");
  });

  it("flags the agent as the intended responder when @addressed", () => {
    const m = msg({ mentions: ["self"], body: { text: "where did you get to?" } });
    const batch = { messages: [m], operator_trusted: true, roster: [] } as any;
    const p = buildPrompt([m], batch, undefined, "self");
    expect(p).toContain("intended responder");
  });

  it("tells the agent to defer when a teammate is @addressed and it is not", () => {
    const m = msg({ mentions: ["agent_jarvis"], body: { text: "status?" } });
    const batch = {
      messages: [m],
      operator_trusted: true,
      roster: [{ agent_id: "agent_jarvis", display_name: "Jarvis" }]
    } as any;
    const p = buildPrompt([m], batch, undefined, "self");
    expect(p).toContain("not you");
    expect(p).toContain("Jarvis");
  });

  it("quotes the replied-to message", () => {
    const m = msg({
      body: { text: "follow-up" },
      reply_to: {
        message_id: "m0",
        sender_agent_id: "op",
        sender_kind: "operator",
        sender_label: "Operator",
        text: "the original question",
        created_at: "t"
      }
    });
    const batch = { messages: [m], operator_trusted: true, roster: [] } as any;
    const p = buildPrompt([m], batch, undefined, "self");
    expect(p.toLowerCase()).toContain("in reply to");
    expect(p).toContain("the original question");
  });

  it("marks quoted/thread context as data, not instructions", () => {
    const m = msg({ conversation_id: "room_1" });
    const batch = {
      messages: [m],
      operator_trusted: true,
      roster: [],
      conversation_history: {
        room_1: [{ message_id: "h1", sender_agent_id: "op", sender_kind: "operator", sender_label: "Tars", text: "hello", created_at: "t" }]
      }
    } as any;
    const p = buildPrompt([m], batch, undefined, "self");
    expect(p).toContain("DATA");
  });

  it("labels an unknown reply-to sender rather than rendering a blank speaker", () => {
    const m = msg({ body: { text: "follow-up" }, reply_to: { text: "earlier", message_id: "m0", created_at: "t" } });
    const batch = { messages: [m], operator_trusted: true, roster: [] } as any;
    const p = buildPrompt([m], batch, undefined, "self");
    expect(p).toContain('in reply to someone: "earlier"');
  });

  it("includes the recent room thread as context", () => {
    const m = msg({ conversation_id: "room_1", body: { text: "what's next?" } });
    const batch = {
      messages: [m],
      operator_trusted: true,
      roster: [],
      conversation_history: {
        room_1: [
          { message_id: "h1", sender_agent_id: "op", sender_kind: "operator", sender_label: "Operator", text: "kickoff brief", created_at: "t0" },
          { message_id: "h2", sender_agent_id: "agent_tars", sender_kind: "agent", sender_label: "Tars", text: "on it", created_at: "t1" }
        ]
      }
    } as any;
    const p = buildPrompt([m], batch, undefined, "self");
    expect(p).toContain("kickoff brief");
    expect(p).toContain("on it");
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

describe("floor planning (turn-taking)", () => {
  // Peer (agent→agent) message — the floor exists to serialize THESE.
  function amsg(conv: string, sender = "jarvis"): any {
    return { message_id: "a-" + conv, conversation_id: conv, sender_agent_id: sender, sender_kind: "agent", message_type: "direct", body: { text: "hi" } };
  }
  // Operator-addressed message — must bypass the floor so every member responds.
  function omsg(conv: string): any {
    return { message_id: "o-" + conv, conversation_id: conv, sender_agent_id: "op", sender_kind: "operator", message_type: "direct", body: { text: "hi" } };
  }

  it("agent→agent: responds only where the floor was granted; defers the rest", async () => {
    const kept = [amsg("c1"), amsg("c2")];
    const acquire = async (conv: string) =>
      conv === "c1" ? { granted: true, conversation_tail: [] } : { granted: false, holder_agent_id: "other" };
    const plan = await planFloorTurn(kept, acquire);
    expect(plan.floored.map((m: any) => m.conversation_id)).toEqual(["c1"]);
    expect(plan.toRelease).toEqual(["c1"]);
  });

  it("agent→agent: carries the fresh catch-up tail from the acquire response", async () => {
    const kept = [amsg("c1")];
    const acquire = async () => ({
      granted: true,
      conversation_tail: [{ message_id: "h1", sender_agent_id: "x", sender_kind: "agent", sender_label: "X", text: "earlier", created_at: "t" }]
    });
    const plan = await planFloorTurn(kept, acquire);
    expect(plan.tails["c1"][0].text).toBe("earlier");
  });

  it("agent→agent: degrades to responding without a floor when the relay lacks the endpoint", async () => {
    const kept = [amsg("c1")];
    const acquire = async () => { throw new Error("404 not found"); };
    const plan = await planFloorTurn(kept, acquire);
    expect(plan.floored).toHaveLength(1);   // still responds (back-compat)
    expect(plan.toRelease).toEqual([]);     // nothing acquired -> nothing to release
  });

  it("agent→agent: spawns no turn when every conversation is deferred", async () => {
    const kept = [amsg("c1"), amsg("c2")];
    const acquire = async () => ({ granted: false, holder_agent_id: "other" });
    const plan = await planFloorTurn(kept, acquire);
    expect(plan.floored).toEqual([]);
  });

  it("operator→ messages bypass the floor — every member responds without contending", async () => {
    // The operator addressing a room/broadcast: each member should respond
    // independently, so we must NOT contend for (or defer on) the shared floor.
    const kept = [omsg("room1"), omsg("bcast")];
    let acquired = 0;
    const acquire = async () => { acquired++; return { granted: false, holder_agent_id: "other" }; };
    const plan = await planFloorTurn(kept, acquire);
    expect(acquired).toBe(0); // never contends for an operator turn
    expect(plan.floored.map((m: any) => m.conversation_id)).toEqual(["room1", "bcast"]);
    expect(plan.toRelease).toEqual([]);
  });

  it("still contends for the floor when a peer message shares the conversation", async () => {
    const kept = [omsg("room1"), amsg("room1", "tars")]; // operator + peer in the same room
    let acquired = 0;
    const acquire = async () => { acquired++; return { granted: true, conversation_tail: [] }; };
    const plan = await planFloorTurn(kept, acquire);
    expect(acquired).toBe(1);
    expect(plan.toRelease).toEqual(["room1"]);
  });
});

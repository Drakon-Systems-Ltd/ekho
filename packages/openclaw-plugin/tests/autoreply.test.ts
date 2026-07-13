import { describe, it, expect } from "vitest";
import {
  isRealInbound,
  peerLatchOpen,
  consumePeerLatch,
  resetPeerLatch,
  refreshBudgetForProgressSignals,
  markConversationEscalated,
  buildPrompt,
  planFloorTurn,
  createAutoReplyState,
  effectivePeerSettings,
  effectiveConversationBudget,
  recordPeerUsage,
  getCachedInbox,
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

  it("a peer handoff/claim/complete refreshes the budget on a closed latch (F1)", () => {
    const s = createAutoReplyState();
    consumePeerLatch(s, "c");
    consumePeerLatch(s, "c");
    expect(peerLatchOpen(s, "c", 2)).toBe(false); // exhausted
    const refreshed = refreshBudgetForProgressSignals(
      s,
      [msg({ conversation_id: "c", sender_kind: "agent", sender_agent_id: "jarvis", message_type: "handoff" })],
      "self"
    );
    expect(refreshed.has("c")).toBe(true);
    expect(peerLatchOpen(s, "c", 2)).toBe(true); // budget refreshed
  });

  it("a complete (non-trigger) still refreshes the budget (F1)", () => {
    const s = createAutoReplyState();
    consumePeerLatch(s, "c");
    expect(peerLatchOpen(s, "c", 1)).toBe(false);
    refreshBudgetForProgressSignals(
      s,
      [msg({ conversation_id: "c", sender_kind: "agent", sender_agent_id: "jarvis", message_type: "complete" })],
      "self"
    );
    expect(peerLatchOpen(s, "c", 1)).toBe(true);
  });

  it("plain direct/broadcast chatter does NOT refresh the budget (F1)", () => {
    const s = createAutoReplyState();
    consumePeerLatch(s, "c");
    consumePeerLatch(s, "c");
    expect(peerLatchOpen(s, "c", 2)).toBe(false);
    const refreshed = refreshBudgetForProgressSignals(
      s,
      [
        msg({ conversation_id: "c", sender_kind: "agent", sender_agent_id: "jarvis", message_type: "direct" }),
        msg({ conversation_id: "c", sender_kind: "agent", sender_agent_id: "jarvis", message_type: "broadcast" })
      ],
      "self"
    );
    expect(refreshed.size).toBe(0);
    expect(peerLatchOpen(s, "c", 2)).toBe(false); // still closed
  });

  it("a progress signal from the operator or self does NOT refresh (F1)", () => {
    const s = createAutoReplyState();
    consumePeerLatch(s, "c");
    refreshBudgetForProgressSignals(
      s,
      [
        msg({ conversation_id: "c", sender_kind: "operator", sender_agent_id: "op", message_type: "handoff" }),
        msg({ conversation_id: "c", sender_kind: "agent", sender_agent_id: "self", message_type: "handoff" })
      ],
      "self"
    );
    expect(peerLatchOpen(s, "c", 1)).toBe(false); // neither path counts
  });

  it("escalates a closed conversation at most once until reset (F3)", () => {
    const s = createAutoReplyState();
    expect(markConversationEscalated(s, "c")).toBe(true); // first close -> escalate
    expect(markConversationEscalated(s, "c")).toBe(false); // deduped
    expect(markConversationEscalated(s, "c")).toBe(false);
    // A reset (operator engagement / progress signal) re-arms the escalation.
    resetPeerLatch(s, "c");
    expect(markConversationEscalated(s, "c")).toBe(true);
  });

  it("tracks escalation per conversation independently (F3)", () => {
    const s = createAutoReplyState();
    expect(markConversationEscalated(s, "a")).toBe(true);
    expect(markConversationEscalated(s, "b")).toBe(true);
    expect(markConversationEscalated(s, "a")).toBe(false);
    resetPeerLatch(s, "a");
    expect(markConversationEscalated(s, "a")).toBe(true);
    expect(markConversationEscalated(s, "b")).toBe(false); // b unaffected by a's reset
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

  it("frames a room message as a reply to the whole room via room_id", () => {
    const m = msg({
      sender_kind: "agent",
      sender_agent_id: "agent_jarvis",
      conversation_id: "room_42",
      body: { text: "shipping the migration now" }
    });
    const batch: any = {
      messages: [m],
      operator_trusted: false,
      roster: [{ agent_id: "agent_jarvis", display_name: "Jarvis" }],
      rooms: [{ id: "room_42", name: "Migration rollout" }]
    };
    const p = buildPrompt([m], batch);
    expect(p).toContain('room_id="room_42"');
    expect(p).toContain("Migration rollout");
    expect(p).toContain("goes to every member");
    // It should NOT fall back to the 1:1 recipient framing for a room message.
    expect(p).not.toContain('recipient_agent_id="agent_jarvis"');
  });

  it("surfaces the open-a-room doctrine line when teammates are present", () => {
    const m = msg({ sender_kind: "agent", sender_agent_id: "agent_jarvis", body: { text: "let's keep going" } });
    const batch: any = { messages: [m], operator_trusted: false, roster: [] };
    const p = buildPrompt([m], batch);
    expect(p).toContain("ekho_open_room");
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

  it("defaults the per-conversation budget to 25", () => {
    expect(DEFAULT_PEER_TURN_BUDGET).toBe(25);
  });

  it("a project room's budget overrides the per-agent budget for that conversation only", () => {
    const batch: any = { conversation_budgets: { room_x: 100 } };
    expect(effectiveConversationBudget(batch, "room_x", 25)).toBe(100);
    expect(effectiveConversationBudget(batch, "other-conv", 25)).toBe(25);
    expect(effectiveConversationBudget({} as any, "room_x", 25)).toBe(25); // older relay: field absent
    expect(effectiveConversationBudget({ conversation_budgets: { room_x: 0 } } as any, "room_x", 25)).toBe(25); // nonsense ignored
  });

  it("budget line uses the project room's own cap for the turn arithmetic", () => {
    const m = msg({ sender_kind: "agent", sender_agent_id: "jarvis", conversation_id: "room-proj" });
    const batch = {
      messages: [m], operator_trusted: false, roster: [],
      conversation_budgets: { "room-proj": 100 }
    } as any;
    const p = buildPrompt([m], batch, undefined, "self", 6, { "room-proj": 99 });
    expect(p).toContain("peer turn 1 of 100");
    expect(p).toContain("99 wake(s) left");
  });

  it("tells a peer-woken agent how much turn budget remains", () => {
    const m = msg({ sender_kind: "agent", sender_agent_id: "jarvis", conversation_id: "proj-1" });
    const batch = { messages: [m], operator_trusted: false, roster: [] } as any;
    const p = buildPrompt([m], batch, undefined, "self", 6, { "proj-1": 5 });
    expect(p).toContain("Bounded delegation: peer turn 1 of 6 in this conversation");
    expect(p).toContain("5 wake(s) left");
    expect(p).toContain("front-load");
  });

  it("counts the budget line down as turns are consumed", () => {
    const m = msg({ sender_kind: "agent", sender_agent_id: "jarvis", conversation_id: "proj-1" });
    const batch = { messages: [m], operator_trusted: false, roster: [] } as any;
    const p = buildPrompt([m], batch, undefined, "self", 6, { "proj-1": 2 });
    expect(p).toContain("peer turn 4 of 6");
    expect(p).toContain("2 wake(s) left");
  });

  it("omits the budget line when no remaining map is passed", () => {
    const p = buildPrompt([msg()], { messages: [msg()], operator_trusted: true, roster: [] } as any);
    expect(p).not.toContain("Bounded delegation");
  });

  it("says the budget was re-energised when an operator shares the conversation", () => {
    const op = msg({ message_id: "o1", conversation_id: "proj-1" });
    const peer = msg({ message_id: "p1", sender_kind: "agent", sender_agent_id: "jarvis", conversation_id: "proj-1" });
    const batch = { messages: [op, peer], operator_trusted: true, roster: [] } as any;
    const p = buildPrompt([op, peer], batch, undefined, "self", 6, { "proj-1": 5 });
    expect(p).toContain("re-energising this conversation's peer budget");
    expect(p).toContain("peer turn 1 of 6");
  });

  it("emits a single budget line per conversation", () => {
    const p1 = msg({ message_id: "p1", sender_kind: "agent", sender_agent_id: "jarvis", conversation_id: "proj-1" });
    const p2 = msg({ message_id: "p2", sender_kind: "agent", sender_agent_id: "jarvis", conversation_id: "proj-1" });
    const batch = { messages: [p1, p2], operator_trusted: false, roster: [] } as any;
    const p = buildPrompt([p1, p2], batch, undefined, "self", 6, { "proj-1": 4 });
    expect(p.split("Bounded delegation:").length - 1).toBe(1);
  });

  it("emits the graceful last-turn line when remaining-after is 0 (F2)", () => {
    const m = msg({ sender_kind: "agent", sender_agent_id: "jarvis", conversation_id: "proj-1" });
    const batch = { messages: [m], operator_trusted: false, roster: [] } as any;
    const p = buildPrompt([m], batch, undefined, "self", 6, { "proj-1": 0 });
    expect(p).toContain("LAST auto-wake in this thread before it pauses");
    expect(p).toContain("do NOT stop mid-task");
    expect(p).toContain("peer turn 6 of 6");
    // The normal countdown line is replaced, not also shown.
    expect(p).not.toContain("wake(s) left before it auto-pauses");
  });

  it("keeps the normal budget line when remaining-after is positive (F2)", () => {
    const m = msg({ sender_kind: "agent", sender_agent_id: "jarvis", conversation_id: "proj-1" });
    const batch = { messages: [m], operator_trusted: false, roster: [] } as any;
    const p = buildPrompt([m], batch, undefined, "self", 6, { "proj-1": 3 });
    expect(p).not.toContain("LAST auto-wake");
    expect(p).toContain("3 wake(s) left");
  });

  it("the bootstrap default is now peer-ON (relay omits the field)", () => {
    // Mirrors connection.ts `config?.peerAutoreply ?? true`: with no console
    // override and the new ON default, the agent lands peer-enabled.
    expect(effectivePeerSettings({}, { peerEnabled: true, peerTurnBudget: 6 }))
      .toEqual({ peerEnabled: true, peerTurnBudget: 6 });
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

describe("ekho_inbox budget surfacing", () => {
  it("snapshots per-conversation peer usage for a manual inbox read", () => {
    recordPeerUsage(new Map([["proj-1", 2], ["proj-2", 5]]));
    const cached = getCachedInbox();
    expect(cached.peer_turns_used["proj-1"]).toBe(2);
    expect(cached.peer_turns_used["proj-2"]).toBe(5);
  });

  it("the snapshot is isolated — later state mutations don't leak in", () => {
    const live = new Map([["c1", 2]]);
    recordPeerUsage(live);
    live.set("c1", 99);
    expect(getCachedInbox().peer_turns_used["c1"]).toBe(2);
  });
});

"""#155 — characterisation tests for reply latency (Hermes adapter).

These tests PIN TODAY'S behaviour, they do not endorse it. Issue #155 asks to
tell apart "the relay was slow", "the conversation floor was held", "the adapter
was busy with another turn" and "the agent was working". Each test names the
waiting state it pins. The #155 implementation will flip some of these (look for
"FLIPS") and extend the rest. Every test here must keep passing until a PR
deliberately changes the behaviour it pins, and that PR must update the test
and the design doc
(docs/plans/2026-11-01-155-reply-latency-design.md) together.

Everything is deterministic: the relay client and the turn spawn are injected
fakes, no thread or real process is started, and time is passed in explicitly
(``now=``).
"""

import os

import pytest

from ekho import InboxMessage, InboxResponse

from ekho_hermes import autoreply
from ekho_hermes.autoreply import (
    DEFERRED_RETRY_TTL_S,
    FLOOR_TTL_SECONDS,
    TURN_TIMEOUT_S,
    AutoReplyState,
    plan_floor_turn,
    process_inbox_once,
    reset_cache,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    reset_cache()
    yield
    reset_cache()


def _msg(**kw):
    base = {
        "message_id": "m1",
        "conversation_id": "c1",
        "correlation_id": "x1",
        "sender_agent_id": "op",
        "message_type": "direct",
        "priority": "normal",
        "body": {"text": "hello team"},
        "metadata": {},
        "created_at": "2026-11-01T11:30:00.000Z",
        "deadline_at": "2026-11-01T12:30:00.000Z",
        "sender_kind": "operator",
    }
    base.update(kw)
    return InboxMessage.from_dict(base)


def _operator(mid, conv, text="operator ask"):
    return _msg(message_id=mid, conversation_id=conv, body={"text": text})


def _peer(mid, conv, sender="agent_a", text="peer status request"):
    return _msg(
        message_id=mid,
        conversation_id=conv,
        sender_kind="agent",
        sender_agent_id=sender,
        message_type="direct",
        body={"text": text},
    )


def _inbox(*messages, operator_trusted=True):
    return InboxResponse(
        messages=list(messages), controls=[], operator_trusted=operator_trusted, roster=[]
    )


class RecordingClient:
    """A relay client that records every call the tick makes, in order.

    ``batches`` are served one per ``get_inbox`` call, then empty inboxes.
    ``floors`` is a shared ``{conversation_id: holder_agent_id}`` table, so two
    agents built on the same table contend for the same floor the way two real
    agents contend at the relay (``acquireFloor``: granted when the floor is
    free or already ours, ``db.ts`` acquireFloor).
    """

    def __init__(self, agent_id, batches=(), floors=None):
        self.agent_id = agent_id
        self._batches = list(batches)
        self.floors = floors if floors is not None else {}
        self.calls = []  # ("get_inbox",) / ("ack", [ids]) / ("acquire", conv) / ("release", conv)

    def get_inbox(self, limit=25):
        self.calls.append(("get_inbox",))
        return self._batches.pop(0) if self._batches else _inbox()

    def ack_messages(self, acks):
        self.calls.append(("ack", [a["message_id"] for a in acks]))
        return {"updated": len(acks)}

    def acquire_floor(self, conversation_id, ttl_seconds=None):
        self.calls.append(("acquire", conversation_id))
        holder = self.floors.get(conversation_id)
        if holder is None or holder == self.agent_id:
            self.floors[conversation_id] = self.agent_id
            return {"granted": True, "holder_agent_id": self.agent_id, "conversation_tail": []}
        return {"granted": False, "holder_agent_id": holder}

    def release_floor(self, conversation_id):
        self.calls.append(("release", conversation_id))
        if self.floors.get(conversation_id) == self.agent_id:
            del self.floors[conversation_id]
            return {"released": True}
        return {"released": False}

    def kinds(self):
        return [c[0] for c in self.calls]

    def acked_ids(self):
        return [mid for c in self.calls if c[0] == "ack" for mid in c[1]]


def _tick(client, state, spawn, now, **kw):
    kw.setdefault("peer_enabled", True)
    return process_inbox_once(client, client.agent_id, state, spawn=spawn, now=now, **kw)


def _spawn_into(prompts):
    def spawn(cmd, env):
        prompts.append(cmd[-1])  # the one-shot prompt is the last argv entry

    return spawn


# --- Busy adapter: waiting on the ACTIVE TURN, not on a floor ---------------


def test_busy_adapter_tick_neither_fetches_nor_acks_while_in_flight_characterises_current_behaviour_155():
    """While ``state.in_flight`` is set, ``process_inbox_once`` returns
    immediately (autoreply.py ``if state.in_flight: return``). It does not poll,
    so the relay keeps the recipient's deliveries ``queued``: this busy-turn wait
    is indistinguishable at the relay from a dead inbox. It also does not ack
    or touch any floor. #155 adds an adapter-side "waiting on active turn"
    phase. This test pins that the wait happens BEFORE the fetch."""
    client = RecordingClient("agent_b", batches=[_inbox(_operator("op1", "dm-f-agent_b"))])
    state = AutoReplyState()
    state.in_flight = True
    prompts = []

    summary = _tick(client, state, _spawn_into(prompts), now=0.0)

    assert summary == {"polled": 0, "real": 0, "kept": 0, "spawned": 0, "acked": 0}
    assert client.calls == []  # no get_inbox, no ack, no floor acquire
    assert prompts == []


def test_busy_adapter_message_arriving_mid_turn_waits_for_the_whole_turn_characterises_current_behaviour_155():
    """A turn holds ``in_flight`` from just before the spawn until the spawn
    returns. ``_default_spawn`` returns only once the one-shot child exits
    (``proc.communicate(timeout=TURN_TIMEOUT_S)``). So a message arriving
    mid-turn is not fetched until the whole first turn finishes, and in
    production the loop thread itself is blocked inside the spawn. This
    re-enters the tick from inside the spawn, as a second loop thread would."""
    state = AutoReplyState()
    second = RecordingClient("agent_b", batches=[_inbox(_operator("op2", "dm-f-agent_b", "second ask"))])
    reentrant = {}
    prompts = []

    def spawn(cmd, env):
        prompts.append(cmd[-1])
        if len(prompts) == 1:
            # The first turn is "running", so a tick now is a no-op. (Recorded,
            # not asserted: the tick swallows exceptions raised by a spawn.)
            reentrant["in_flight"] = state.in_flight
            reentrant["summary"] = _tick(second, state, _spawn_into(prompts), now=1.0)

    first = RecordingClient("agent_b", batches=[_inbox(_operator("op1", "dm-f-agent_b", "first ask"))])
    s1 = _tick(first, state, spawn, now=0.0)

    assert s1["spawned"] == 1
    assert reentrant["in_flight"] is True
    assert reentrant["summary"]["polled"] == 0 and reentrant["summary"]["spawned"] == 0
    assert second.calls == []  # op2 is still queued at the relay: never fetched mid-turn
    assert state.in_flight is False  # cleared in the tick's ``finally``

    # Only the NEXT tick after the turn returns picks the waiting message up.
    s2 = _tick(second, state, _spawn_into(prompts), now=2.0)
    assert s2["spawned"] == 1
    assert second.kinds() == ["get_inbox", "ack"]
    assert "second ask" in prompts[-1]


# --- Waiting on the FLOOR: a direct on a shared conversation ---------------


SHARED = "op-1730460616088-bcast001"  # an operator broadcast's conversation id


def test_direct_on_a_held_floor_is_acked_at_once_but_not_woken_until_the_floor_frees_characterises_current_behaviour_155():
    """A peer DIRECT message reuses the operator broadcast's conversation id,
    whose floor another agent (agent_c) holds. The message is ACKED on the first
    tick ("received"), but no turn starts until a LATER tick finds the floor
    free. Between those ticks the relay reads ``acked`` while the agent has not
    started: received is not answered. FLIPS under #155 option A, which
    sends independent directs to a per-pair work lane."""
    floors = {SHARED: "agent_c"}
    state = AutoReplyState()
    prompts = []
    b = RecordingClient("agent_b", batches=[_inbox(_peer("p1", SHARED), operator_trusted=False)], floors=floors)

    s1 = _tick(b, state, _spawn_into(prompts), now=0.0)
    assert s1["spawned"] == 0
    assert b.acked_ids() == ["p1"]  # acked BEFORE any turn (at-most-once)
    assert ("acquire", SHARED) in b.calls
    assert SHARED in state.deferred_by_conversation  # held back, in memory only

    # Still held a minute later (the peer-reported ~1 min floor wait): no wake.
    s2 = _tick(b, state, _spawn_into(prompts), now=60.0)
    assert s2["spawned"] == 0 and prompts == []
    assert SHARED in state.deferred_by_conversation

    # The holder finishes its turn and releases. The next tick runs the held-back turn.
    del floors[SHARED]
    s3 = _tick(b, state, _spawn_into(prompts), now=65.0)
    assert s3["spawned"] == 1
    assert "peer status request" in prompts[0]
    assert SHARED not in state.deferred_by_conversation
    assert b.calls[-1] == ("release", SHARED)  # the retry turn took and returned the floor


def test_direct_on_a_floor_that_never_frees_runs_late_without_the_floor_after_expiry_characterises_current_behaviour_155():
    """Floor expiry on the adapter side. The deferred stash is retried until
    ``DEFERRED_RETRY_TTL_S`` (FLOOR_TTL_SECONDS + 120 s grace). Past that it is
    delivered LATE, WITHOUT the floor, and is never binned. The worst-case floor
    wait for a deferred direct is therefore DEFERRED_RETRY_TTL_S plus one poll
    interval."""
    floors = {SHARED: "agent_c"}  # the holder never lets go
    state = AutoReplyState()
    prompts = []
    b = RecordingClient("agent_b", batches=[_inbox(_peer("p1", SHARED), operator_trusted=False)], floors=floors)

    assert _tick(b, state, _spawn_into(prompts), now=0.0)["spawned"] == 0
    assert _tick(b, state, _spawn_into(prompts), now=DEFERRED_RETRY_TTL_S - 1.0)["spawned"] == 0
    assert prompts == []

    s = _tick(b, state, _spawn_into(prompts), now=DEFERRED_RETRY_TTL_S + 1.0)
    assert s["spawned"] == 1
    assert "WITHOUT the floor" in prompts[0]
    assert SHARED not in state.deferred_by_conversation
    assert floors == {SHARED: "agent_c"}  # the overrun turn never took the floor


def test_adapter_floor_lease_request_exceeds_the_relay_cap_characterises_current_behaviour_155():
    """The adapter asks for a floor lease of TURN_TIMEOUT_S + 60 s (960 s at the
    default 900 s turn timeout). The relay clamps it to
    ``EKHO_FLOOR_TTL_MAX_SECONDS`` (600 s default, pinned in the relay #155
    test). That cap is the "ten-minute lease" seen live, and it means a long turn
    can outlive its own floor."""
    assert FLOOR_TTL_SECONDS == int(TURN_TIMEOUT_S) + 60
    assert DEFERRED_RETRY_TTL_S == FLOOR_TTL_SECONDS + 120
    if "EKHO_AUTOREPLY_TURN_TIMEOUT_SECONDS" not in os.environ:
        assert FLOOR_TTL_SECONDS == 960 > 600


# --- Operator-only turns bypass the floor ----------------------------------


def test_operator_only_messages_bypass_the_floor_characterises_current_behaviour_155():
    """``plan_floor_turn`` contends for a floor only when a PEER message is in
    that conversation's slice of the batch. An operator-only slice (broadcast,
    room post or DM) responds at once, even while another agent holds that very
    floor: no acquire, nothing to release, nothing deferred."""
    acquires = []

    def acquire(conv):
        acquires.append(conv)
        return {"granted": False, "holder_agent_id": "agent_c"}

    kept = [_operator("op1", SHARED), _operator("op2", "room-ops")]
    floored, to_release, tails, deferred = plan_floor_turn(kept, acquire)

    assert acquires == []
    assert [m.message_id for m in floored] == ["op1", "op2"]
    assert to_release == [] and tails == {} and deferred == {}


def test_operator_broadcast_wakes_at_once_while_a_peer_holds_its_floor_characterises_current_behaviour_155():
    """The same bypass seen through the tick: an operator broadcast spawns on
    the first tick with no floor call, although agent_c holds the broadcast
    conversation's floor."""
    floors = {SHARED: "agent_c"}
    prompts = []
    b = RecordingClient("agent_b", batches=[_inbox(_operator("op1", SHARED, "fleet status?"))], floors=floors)

    s = _tick(b, AutoReplyState(), _spawn_into(prompts), now=0.0)

    assert s["spawned"] == 1
    assert b.kinds() == ["get_inbox", "ack"]  # no acquire, no release
    assert "fleet status?" in prompts[0]


# --- Mixed operator/peer batches -------------------------------------------


def test_mixed_batch_same_conversation_defers_the_operator_message_with_the_peer_characterises_current_behaviour_155():
    """If ONE batch carries an operator message and a peer message on the SAME
    conversation, the slice contends as a whole. When the floor is held, the
    operator's message is deferred together with the peer's. The operator bypass
    covers operator-only slices only. FLIPS under #155: an operator message
    should never wait on a peer floor."""

    def acquire(conv):
        return {"granted": False, "holder_agent_id": "agent_c"}

    kept = [_operator("op1", SHARED), _peer("p1", SHARED)]
    floored, to_release, _tails, deferred = plan_floor_turn(kept, acquire)

    assert floored == [] and to_release == []
    assert [m.message_id for m in deferred[SHARED]] == ["op1", "p1"]


def test_mixed_batch_across_conversations_lets_the_operator_slice_through_characterises_current_behaviour_155():
    """With the operator message on a DIFFERENT conversation from the floored
    peer message, only the peer slice waits. Each conversation id has its own
    floor, so the batch splits cleanly."""

    def acquire(conv):
        return {"granted": False, "holder_agent_id": "agent_c"}

    kept = [_operator("op1", "dm-f-agent_b"), _peer("p1", SHARED)]
    floored, to_release, _tails, deferred = plan_floor_turn(kept, acquire)

    assert [m.message_id for m in floored] == ["op1"]
    assert to_release == []
    assert list(deferred) == [SHARED]


def test_operator_turn_absorbs_a_peer_message_stashed_behind_another_agents_floor_characterises_current_behaviour_155():
    """The next-tick covering turn (``merge_covered_stashes``, #78) picks
    stashes by conversation id, not by the floor the turn holds. agent_c holds
    SHARED's floor, so agent_b's peer message on SHARED is refused and stashed.
    On B's next tick an operator message on SHARED takes no floor, and its turn
    absorbs the stashed peer message: B answers that peer while C still holds
    the floor. FLIPS under #155 Phase 7a: a covering turn absorbs only stashes
    whose exact (conversation, lane) floor it holds, so the operator message
    runs alone and the peer message stays stashed for its floor retry."""
    floors = {SHARED: "agent_c"}  # C is mid-turn on SHARED and never lets go here
    state = AutoReplyState()
    prompts = []
    b = RecordingClient(
        "agent_b",
        batches=[
            _inbox(_peer("p1", SHARED), operator_trusted=False),
            _inbox(_operator("op1", SHARED, "fleet status?")),
        ],
        floors=floors,
    )

    s1 = _tick(b, state, _spawn_into(prompts), now=0.0)
    assert s1["spawned"] == 0 and prompts == []
    assert SHARED in state.deferred_by_conversation

    tick1_calls = len(b.calls)
    s2 = _tick(b, state, _spawn_into(prompts), now=5.0)
    assert s2["spawned"] == 1
    assert len(prompts) == 1
    assert "fleet status?" in prompts[0]
    assert "peer status request" in prompts[0]  # the stashed peer message rode along
    assert "HELD BACK" in prompts[0]
    covering_tick = b.calls[tick1_calls:]
    assert ("acquire", SHARED) not in covering_tick  # no floor taken for this turn
    assert ("release", SHARED) not in covering_tick
    assert floors == {SHARED: "agent_c"}  # C still holds the floor throughout
    assert SHARED not in state.deferred_by_conversation  # cleared: delivered by B's turn


# --- Independent recipients ------------------------------------------------


def _two_agents_while_b_is_mid_turn(conv_for_d):
    """agent_b is mid-turn on a peer-triggered conversation ``work-b`` and so
    holds its floor. While B's turn runs, agent_d's tick handles a peer direct
    on ``conv_for_d``. Both agents share one floor table, as they would at the
    relay."""
    floors = {}
    d_state = AutoReplyState()
    d_prompts = []
    d = RecordingClient(
        "agent_d",
        batches=[_inbox(_peer("p-d", conv_for_d, sender="agent_c", text="d's own work"), operator_trusted=False)],
        floors=floors,
    )
    seen_during_b = {}

    def b_spawn(cmd, env):
        seen_during_b["b_holds"] = floors.get("work-b")
        seen_during_b["d_summary"] = _tick(d, d_state, _spawn_into(d_prompts), now=0.0)

    b = RecordingClient(
        "agent_b",
        batches=[_inbox(_peer("p-b", "work-b", sender="agent_a", text="b's own work"), operator_trusted=False)],
        floors=floors,
    )
    s_b = _tick(b, AutoReplyState(), b_spawn, now=0.0)
    return s_b, seen_during_b, d_state, d_prompts, floors


def test_independent_recipients_on_different_conversation_ids_do_not_block_each_other_characterises_current_behaviour_155():
    """Two recipients with unrelated work on DIFFERENT conversation ids. D is
    granted its own floor and woken while B still holds ``work-b``. This is the
    caller-side mitigation #155 recommends defaulting to."""
    s_b, during, d_state, d_prompts, floors = _two_agents_while_b_is_mid_turn("work-d")

    assert s_b["spawned"] == 1
    assert during["b_holds"] == "agent_b"
    assert during["d_summary"]["spawned"] == 1  # D did not wait for B
    assert "d's own work" in d_prompts[0]
    assert d_state.deferred_by_conversation == {}
    assert floors == {}  # both turns returned their floors


def test_independent_recipients_sharing_one_conversation_id_serialise_on_its_floor_characterises_current_behaviour_155():
    """The contrast case, and the #155 failure mode. D's unrelated direct reuses
    ``work-b``, the conversation B is mid-turn on, so D is deferred behind B's
    turn. Nothing about D's work depends on B's. FLIPS under #155 option A."""
    s_b, during, d_state, d_prompts, floors = _two_agents_while_b_is_mid_turn("work-b")

    assert s_b["spawned"] == 1
    assert during["d_summary"]["spawned"] == 0
    assert d_prompts == []
    assert "work-b" in d_state.deferred_by_conversation  # D waits for B's whole turn
    assert floors == {}  # B released after its turn; D retries on its next tick

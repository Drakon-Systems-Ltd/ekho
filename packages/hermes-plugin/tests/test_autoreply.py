"""Tests for the auto-reply loop logic (pure parts + injected side effects).

The auto-reply loop is the Hermes counterpart to the OpenClaw plugin's
``autoreply.ts``: poll the relay, and on a qualifying inbound message from the
*verified operator* wake the agent (spawn a one-shot ``hermes -z`` turn) so it
replies via ``ekho_send``. Everything here is exercised without Hermes, without
a real relay, and without spawning a real process — the SDK client and the
process spawn are injected.
"""

import os
import sys
import threading
import time

import pytest

from ekho import InboxMessage, InboxResponse, RosterEntry

from ekho_hermes import autoreply
from ekho_hermes.autoreply import (
    AutoReplyState,
    apply_peer_rate_gate,
    build_oneshot_command,
    build_prompt,
    consume_peer_latch,
    get_cached_inbox,
    is_real_inbound,
    mark_seen,
    peer_latch_open,
    plan_floor_turn,
    process_inbox_once,
    record_batch,
    record_peer_usage,
    reset_cache,
    reset_peer_latch,
    resolve_python_exe,
    trigger_turn,
)


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
        "created_at": "2026-06-05T00:00:00.000Z",
        "deadline_at": "2026-06-05T01:00:00.000Z",
        "sender_kind": "operator",
    }
    base.update(kw)
    return InboxMessage.from_dict(base)


def _state():
    return AutoReplyState()


@pytest.fixture(autouse=True)
def _clear_cache():
    reset_cache()
    yield
    reset_cache()


# --- is_real_inbound -------------------------------------------------------


def test_real_inbound_operator_trusted_direct():
    assert is_real_inbound(_msg(), "self", _state(), operator_trusted=True) is True


def test_real_inbound_rejects_untrusted_operator():
    assert is_real_inbound(_msg(), "self", _state(), operator_trusted=False) is False


def test_real_inbound_rejects_peer_agent_even_when_operator_trusted():
    # Operator-only is the structural loop-breaker: peers never auto-trigger.
    peer = _msg(sender_kind="agent", sender_agent_id="jarvis")
    assert is_real_inbound(peer, "self", _state(), operator_trusted=True) is False


def test_real_inbound_rejects_own_outbound():
    own = _msg(sender_agent_id="self", sender_kind="operator")
    assert is_real_inbound(own, "self", _state(), operator_trusted=True) is False


def test_real_inbound_rejects_non_trigger_type():
    hb = _msg(message_type="heartbeat")
    assert is_real_inbound(hb, "self", _state(), operator_trusted=True) is False


def test_real_inbound_rejects_empty_body():
    blank = _msg(body={"text": "   "})
    assert is_real_inbound(blank, "self", _state(), operator_trusted=True) is False


def test_real_inbound_dedupes_seen_message():
    state = _state()
    msg = _msg()
    assert is_real_inbound(msg, "self", state, operator_trusted=True) is True
    mark_seen(state, msg.message_id)
    assert is_real_inbound(msg, "self", state, operator_trusted=True) is False


# --- mark_seen FIFO cap ----------------------------------------------------


def test_mark_seen_evicts_oldest_beyond_cap():
    state = _state()
    for i in range(autoreply.SEEN_CAP + 10):
        mark_seen(state, f"id-{i}")
    assert len(state.seen) == autoreply.SEEN_CAP
    assert "id-0" not in state.seen  # oldest evicted
    assert f"id-{autoreply.SEEN_CAP + 9}" in state.seen  # newest kept


# --- peer rate gate (operator exempt) --------------------------------------


def test_peer_rate_gate_operator_never_suppressed():
    state = _state()
    msgs = [_msg(message_id=f"m{i}") for i in range(autoreply.PEER_RATE_MAX + 5)]
    kept = apply_peer_rate_gate(msgs, state, now=0.0)
    assert len(kept) == len(msgs)  # operator is exempt from the gate


def test_peer_rate_gate_suppresses_peer_flood_in_window():
    state = _state()
    peers = [
        _msg(message_id=f"m{i}", sender_kind="agent", sender_agent_id="jarvis")
        for i in range(autoreply.PEER_RATE_MAX + 3)
    ]
    kept = apply_peer_rate_gate(peers, state, now=10.0)
    assert len(kept) == autoreply.PEER_RATE_MAX  # excess suppressed


def test_peer_rate_gate_resets_after_window():
    state = _state()
    first = [
        _msg(message_id=f"a{i}", sender_kind="agent", sender_agent_id="jarvis")
        for i in range(autoreply.PEER_RATE_MAX)
    ]
    apply_peer_rate_gate(first, state, now=0.0)
    later = [_msg(message_id="b0", sender_kind="agent", sender_agent_id="jarvis")]
    kept = apply_peer_rate_gate(
        later, state, now=autoreply.PEER_RATE_WINDOW_S + 1.0
    )
    assert len(kept) == 1  # window elapsed -> fresh budget


# --- batch cache (read by ekho_inbox) --------------------------------------


def test_record_batch_exposes_messages_and_meta():
    roster = [RosterEntry.from_dict({"agent_id": "a1", "display_name": "One"})]
    inbox = InboxResponse(
        messages=[_msg(message_id="m1")],
        controls=[],
        operator_trusted=True,
        roster=roster,
    )
    record_batch(inbox)
    cached = get_cached_inbox()
    assert cached["operator_trusted"] is True
    assert [m.message_id for m in cached["messages"]] == ["m1"]
    assert cached["roster"][0].agent_id == "a1"


def test_record_batch_caps_messages_fifo():
    for i in range(autoreply.LAST_BATCH_CAP + 5):
        record_batch(
            InboxResponse(
                messages=[_msg(message_id=f"m{i}")],
                controls=[],
                operator_trusted=False,
                roster=[],
            )
        )
    cached = get_cached_inbox()
    ids = [m.message_id for m in cached["messages"]]
    assert len(ids) == autoreply.LAST_BATCH_CAP
    assert "m0" not in ids  # oldest evicted
    assert f"m{autoreply.LAST_BATCH_CAP + 4}" in ids


def test_get_cached_inbox_empty_by_default():
    cached = get_cached_inbox()
    assert cached["messages"] == []
    assert cached["operator_trusted"] is False
    assert cached["roster"] == []


# --- build_prompt ----------------------------------------------------------


def test_build_prompt_includes_reply_routing_and_trust():
    prompt = build_prompt([_msg()], operator_trusted=True)
    assert "hello team" in prompt
    assert 'recipient_agent_id="op"' in prompt
    assert 'conversation_id="c1"' in prompt
    assert "ekho_send" in prompt
    assert "fleet operator (your principal)" in prompt


def test_build_prompt_cryptographically_verified_label():
    from types import SimpleNamespace

    m = _msg()
    verdict = SimpleNamespace(verified=True, key_id="abc123")
    prompt = build_prompt(
        [m], operator_trusted=False, verifications={m.message_id: verdict}
    )
    # Verified by signature → strong framing even when the relay flag is off.
    assert "CRYPTOGRAPHICALLY VERIFIED" in prompt
    assert "abc123" in prompt


def test_build_prompt_unverified_operator_label():
    prompt = build_prompt([_msg()], operator_trusted=False)
    assert "UNVERIFIED" in prompt


def test_build_prompt_flags_the_direct_addressee():
    m = _msg(body={"text": "where did you get to?"}, mentions=["self"])
    prompt = build_prompt([m], operator_trusted=True, self_agent_id="self")
    assert "intended responder" in prompt


def test_build_prompt_tells_non_addressee_to_defer():
    m = _msg(body={"text": "where did you get to?"}, mentions=["other"])
    prompt = build_prompt(
        [m], operator_trusted=True, self_agent_id="self",
        roster=[RosterEntry.from_dict({"agent_id": "other", "display_name": "Jarvis",
                                       "runtime": "custom", "status": "healthy"})],
    )
    # Addressed to someone else -> the agent is told to defer, not answer for them.
    assert "not you" in prompt
    assert "Jarvis" in prompt


def test_build_prompt_quotes_the_replied_to_message():
    m = _msg(
        body={"text": "follow-up"},
        reply_to={
            "message_id": "m0",
            "sender_agent_id": "op",
            "sender_kind": "operator",
            "sender_label": "Operator",
            "text": "the original question",
            "created_at": "2026-06-05T00:00:00.000Z",
        },
    )
    prompt = build_prompt([m], operator_trusted=True, self_agent_id="self")
    assert "in reply to" in prompt.lower()
    assert "the original question" in prompt


def test_build_prompt_reply_quote_labels_unknown_sender():
    # A malformed/old snapshot with no sender_label or id -> a readable
    # placeholder, never a blank speaker (parity with the OpenClaw plugin).
    m = _msg(body={"text": "follow-up"},
             reply_to={"text": "earlier", "message_id": "m0", "created_at": "t"})
    prompt = build_prompt([m], operator_trusted=True)
    assert 'in reply to someone: "earlier"' in prompt


def test_build_prompt_history_labels_unknown_sender():
    m = _msg(conversation_id="room_1")
    history = {"room_1": [{"text": "ghost line"}]}
    prompt = build_prompt([m], operator_trusted=True, conversation_history=history)
    assert "?: ghost line" in prompt


def test_build_prompt_marks_quoted_context_as_data():
    # Defence-in-depth: the agent is told quoted/thread text is a record, not
    # instructions — a compromised teammate can't smuggle commands via context.
    m = _msg(conversation_id="room_1")
    history = {"room_1": [{"text": "hello", "sender_label": "Tars"}]}
    prompt = build_prompt([m], operator_trusted=True, conversation_history=history)
    assert "DATA" in prompt


def test_build_prompt_includes_recent_room_thread():
    m = _msg(conversation_id="room_1", body={"text": "what's next?"})
    history = {
        "room_1": [
            {"message_id": "h1", "sender_agent_id": "op", "sender_kind": "operator",
             "sender_label": "Operator", "text": "kickoff brief", "created_at": "t0"},
            {"message_id": "h2", "sender_agent_id": "agent_tars", "sender_kind": "agent",
             "sender_label": "Tars", "text": "on it", "created_at": "t1"},
        ]
    }
    prompt = build_prompt(
        [m], operator_trusted=True, self_agent_id="self", conversation_history=history
    )
    assert "kickoff brief" in prompt
    assert "on it" in prompt


def test_build_prompt_notes_attachments():
    msg = _msg(
        body={"text": "see file"},
        attachments=[
            {"id": "att1", "filename": "report.pdf", "mime": "application/pdf", "size_bytes": 10}
        ],
    )
    prompt = build_prompt([msg], operator_trusted=True)
    assert "ekho_inbox" in prompt  # fallback: told how to fetch the file
    assert "report.pdf" in prompt


def test_build_prompt_uses_local_attachment_paths():
    # When the daemon has already downloaded the attachment, the prompt must
    # point the agent at the local file (NOT tell it to call ekho_inbox, which
    # returns an empty cache inside the spawned one-shot child).
    msg = _msg(body={"text": "see file"})
    local = [
        [
            {
                "id": "att1",
                "filename": "report.pdf",
                "mime": "application/pdf",
                "size_bytes": 10,
                "local_path": "/home/u/.hermes/ekho/attachments/att1__report.pdf",
            }
        ]
    ]
    prompt = build_prompt([msg], operator_trusted=True, local_attachments=local)
    assert "/home/u/.hermes/ekho/attachments/att1__report.pdf" in prompt
    assert "report.pdf" in prompt
    assert "ekho_inbox" not in prompt  # already downloaded — no fetch needed


# --- command construction --------------------------------------------------


def test_build_oneshot_command_shape():
    cmd = build_oneshot_command("do the thing", python_exe="/x/py")
    assert cmd == ["/x/py", "-m", "hermes_cli.main", "-z", "do the thing"]


def test_resolve_python_exe_prefers_virtualenv(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    py = bindir / "python"
    py.write_text("")
    resolved = resolve_python_exe(env={"VIRTUAL_ENV": str(tmp_path)})
    assert resolved == str(py)


def test_resolve_python_exe_falls_back_to_sys_executable():
    assert resolve_python_exe(env={}) == sys.executable


# --- trigger_turn (spawn injected) -----------------------------------------


def test_trigger_turn_spawns_disabled_child_with_prompt():
    calls = []

    def fake_spawn(cmd, env):
        calls.append((cmd, env))

    trigger_turn([_msg()], operator_trusted=True, spawn=fake_spawn)

    assert len(calls) == 1
    cmd, env = calls[0]
    # Loop-breaker: the spawned reply turn must not start its own poll loop.
    assert env["EKHO_AUTOREPLY_DISABLE"] == "1"
    assert cmd[1:4] == ["-m", "hermes_cli.main", "-z"]
    assert "hello team" in cmd[4]


# --- process_inbox_once (the tick) -----------------------------------------


class FakeClient:
    def __init__(self, inbox):
        self._inbox = inbox
        self.acked = []

    def get_inbox(self, limit=25):
        return self._inbox

    def ack_messages(self, acks):
        self.acked.append(list(acks))
        return {"ok": True}


def _spawn_recorder(events):
    def spawn(cmd, env):
        events.append("spawn")

    return spawn


def test_tick_operator_trusted_acks_then_spawns_once():
    events = []
    client = FakeClient(
        InboxResponse(messages=[_msg()], controls=[], operator_trusted=True, roster=[])
    )
    # Wrap ack so we can assert ack-before-spawn ordering.
    orig_ack = client.ack_messages

    def tracked_ack(acks):
        events.append("ack")
        return orig_ack(acks)

    client.ack_messages = tracked_ack

    summary = process_inbox_once(
        client, "self", _state(), spawn=_spawn_recorder(events), now=0.0
    )

    assert summary["spawned"] == 1
    assert events == ["ack", "spawn"]  # ack BEFORE the turn (at-most-once)
    assert client.acked and client.acked[0][0]["message_id"] == "m1"


def test_tick_untrusted_operator_acks_but_does_not_spawn():
    events = []
    client = FakeClient(
        InboxResponse(messages=[_msg()], controls=[], operator_trusted=False, roster=[])
    )
    summary = process_inbox_once(
        client, "self", _state(), spawn=_spawn_recorder(events), now=0.0
    )
    assert summary["spawned"] == 0
    assert "spawn" not in events
    assert client.acked  # still consumed/acked so it won't redeliver


def test_tick_peer_message_acks_but_does_not_spawn():
    events = []
    peer = _msg(sender_kind="agent", sender_agent_id="jarvis")
    client = FakeClient(
        InboxResponse(messages=[peer], controls=[], operator_trusted=True, roster=[])
    )
    summary = process_inbox_once(
        client, "self", _state(), spawn=_spawn_recorder(events), now=0.0
    )
    assert summary["spawned"] == 0
    assert client.acked


def test_tick_empty_inbox_no_spawn_no_ack():
    events = []
    client = FakeClient(
        InboxResponse(messages=[], controls=[], operator_trusted=True, roster=[])
    )
    summary = process_inbox_once(
        client, "self", _state(), spawn=_spawn_recorder(events), now=0.0
    )
    assert summary["spawned"] == 0
    assert client.acked == []  # nothing to ack


def test_tick_dedupes_across_polls():
    events = []
    state = _state()
    inbox = InboxResponse(
        messages=[_msg()], controls=[], operator_trusted=True, roster=[]
    )
    client = FakeClient(inbox)
    process_inbox_once(client, "self", state, spawn=_spawn_recorder(events), now=0.0)
    # Same message redelivered on the next poll -> must NOT spawn again.
    process_inbox_once(client, "self", state, spawn=_spawn_recorder(events), now=1.0)
    assert events.count("spawn") == 1


def test_tick_populates_cache_for_ekho_inbox():
    events = []
    client = FakeClient(
        InboxResponse(messages=[_msg()], controls=[], operator_trusted=True, roster=[])
    )
    process_inbox_once(client, "self", _state(), spawn=_spawn_recorder(events), now=0.0)
    cached = get_cached_inbox()
    assert [m.message_id for m in cached["messages"]] == ["m1"]
    assert cached["operator_trusted"] is True


# --- shutdown / kill-on-stop -----------------------------------------------


def test_default_spawn_tracks_proc_and_kill_unblocks():
    # The loop thread blocks in _default_spawn for the whole turn. stop() must be
    # able to reach the live child and kill it so the loop can observe the stop
    # signal immediately instead of hanging for the full timeout.
    proc_holder = {"proc": None}
    done = threading.Event()

    def run():
        autoreply._default_spawn(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            dict(os.environ),
            proc_holder=proc_holder,
        )
        done.set()

    threading.Thread(target=run, daemon=True).start()
    # Wait for the child to be registered for killing.
    for _ in range(300):
        if proc_holder["proc"] is not None:
            break
        time.sleep(0.01)
    assert proc_holder["proc"] is not None

    proc_holder["proc"].kill()
    assert done.wait(5.0)  # communicate() returns promptly after the kill


def test_start_autoreply_stop_is_prompt_with_no_traffic():
    client = FakeClient(
        InboxResponse(messages=[], controls=[], operator_trusted=False, roster=[])
    )
    stop = autoreply.start_autoreply(
        client=client, self_agent_id="self", poll_interval_s=0.05
    )
    time.sleep(0.12)  # let it poll at least once
    t0 = time.monotonic()
    stop()
    assert time.monotonic() - t0 < 2.0  # stop joins the loop thread quickly


# --- bounded peer delegation -----------------------------------------------


def _peer(i, conversation_id="proj-1", sender="jarvis"):
    return _msg(
        message_id=f"p{i}",
        sender_kind="agent",
        sender_agent_id=sender,
        conversation_id=conversation_id,
        body={"text": f"teammate message {i}"},
    )


def test_real_inbound_allows_peer_when_peer_enabled():
    # With peer delegation ON, a teammate message qualifies (operator_trusted is
    # irrelevant for peers — they're authenticated fleet members).
    assert (
        is_real_inbound(
            _peer(0), "self", _state(), operator_trusted=False, peer_enabled=True
        )
        is True
    )


def test_real_inbound_rejects_peer_when_peer_disabled():
    # Default (peer delegation OFF) keeps the operator-only loop-breaker.
    assert (
        is_real_inbound(
            _peer(0), "self", _state(), operator_trusted=True, peer_enabled=False
        )
        is False
    )


def test_peer_latch_opens_until_budget_then_closes():
    state = _state()
    assert peer_latch_open(state, "c", 2)
    consume_peer_latch(state, "c")
    assert peer_latch_open(state, "c", 2)
    consume_peer_latch(state, "c")
    assert not peer_latch_open(state, "c", 2)  # 2 consumed, budget 2 -> closed


def test_reset_peer_latch_reopens():
    state = _state()
    consume_peer_latch(state, "c")
    consume_peer_latch(state, "c")
    assert not peer_latch_open(state, "c", 2)
    reset_peer_latch(state, "c")
    assert peer_latch_open(state, "c", 2)


def test_tick_peer_enabled_wakes_on_peer_message():
    events = []
    client = FakeClient(
        InboxResponse(messages=[_peer(0)], controls=[], operator_trusted=False, roster=[])
    )
    summary = process_inbox_once(
        client,
        "self",
        _state(),
        spawn=_spawn_recorder(events),
        now=0.0,
        peer_enabled=True,
        peer_turn_budget=6,
    )
    assert summary["spawned"] == 1  # a teammate woke the agent
    assert client.acked


def test_tick_peer_latch_caps_per_conversation():
    events = []
    state = _state()
    spawned = 0
    for i in range(4):
        client = FakeClient(
            InboxResponse(
                messages=[_peer(i)], controls=[], operator_trusted=False, roster=[]
            )
        )
        s = process_inbox_once(
            client,
            "self",
            state,
            spawn=_spawn_recorder(events),
            now=float(i),
            peer_enabled=True,
            peer_turn_budget=2,
        )
        spawned += s["spawned"]
    assert spawned == 2  # budget of 2 caps the conversation; rest latched


def test_tick_operator_message_resets_peer_latch():
    events = []
    state = _state()
    spawn = _spawn_recorder(events)

    # Exhaust a budget-1 latch with one peer message.
    process_inbox_once(
        FakeClient(InboxResponse([_peer(0)], [], False, [])),
        "self", state, spawn=spawn, now=0.0, peer_enabled=True, peer_turn_budget=1,
    )
    # Next peer message in the same conversation is latched (no wake).
    s2 = process_inbox_once(
        FakeClient(InboxResponse([_peer(1)], [], False, [])),
        "self", state, spawn=spawn, now=1.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert s2["spawned"] == 0

    # An operator message in that conversation re-energises the latch.
    op = _msg(message_id="o1", sender_kind="operator", sender_agent_id="op",
              conversation_id="proj-1")
    process_inbox_once(
        FakeClient(InboxResponse([op], [], True, [])),
        "self", state, spawn=spawn, now=2.0, peer_enabled=True, peer_turn_budget=1,
    )
    # A fresh peer message now wakes again.
    s4 = process_inbox_once(
        FakeClient(InboxResponse([_peer(2)], [], False, [])),
        "self", state, spawn=spawn, now=3.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert s4["spawned"] == 1


# --- Feature 1: progress signals refresh the budget -------------------------


def _peer_typed(i, message_type, conversation_id="proj-1", sender="jarvis"):
    return _msg(
        message_id=f"p{i}",
        sender_kind="agent",
        sender_agent_id=sender,
        conversation_id=conversation_id,
        message_type=message_type,
        body={"text": f"{message_type} {i}"},
    )


def test_tick_handoff_on_closed_latch_wakes_and_resets():
    # A handoff arriving on an EXHAUSTED latch refreshes the budget AND wakes the
    # agent — real work can never silently die on a spent budget.
    state = _state()
    spawn = _spawn_recorder([])
    process_inbox_once(
        FakeClient(InboxResponse([_peer(0)], [], False, [])),
        "self", state, spawn=spawn, now=0.0, peer_enabled=True, peer_turn_budget=1,
    )
    # A plain direct on the closed latch would NOT wake (it latches).
    s_closed = process_inbox_once(
        FakeClient(InboxResponse([_peer(1)], [], False, [])),
        "self", state, spawn=spawn, now=1.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert s_closed["spawned"] == 0 and s_closed["latched"] == 1
    # A handoff on the (still) closed latch refreshes the budget AND wakes.
    s_handoff = process_inbox_once(
        FakeClient(InboxResponse([_peer_typed(2, "handoff")], [], False, [])),
        "self", state, spawn=spawn, now=2.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert s_handoff["spawned"] == 1
    assert s_handoff["latched"] == 0
    # Latch is fresh: reset to 0, then this wake consumed exactly one.
    assert state.peer_turns_by_conversation["proj-1"] == 1


def test_tick_complete_on_closed_latch_resets_without_spawn():
    # A complete is NOT a trigger type: it refreshes the budget but spawns no turn.
    state = _state()
    spawn = _spawn_recorder([])
    process_inbox_once(
        FakeClient(InboxResponse([_peer(0)], [], False, [])),
        "self", state, spawn=spawn, now=0.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert not peer_latch_open(state, "proj-1", 1)  # exhausted
    s_complete = process_inbox_once(
        FakeClient(InboxResponse([_peer_typed(1, "complete")], [], False, [])),
        "self", state, spawn=spawn, now=1.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert s_complete["spawned"] == 0
    assert peer_latch_open(state, "proj-1", 1)  # budget refreshed, latch re-opened
    # A following direct now wakes on the fresh budget.
    s_next = process_inbox_once(
        FakeClient(InboxResponse([_peer(2)], [], False, [])),
        "self", state, spawn=spawn, now=2.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert s_next["spawned"] == 1


def test_tick_direct_chatter_still_latches_at_budget():
    # Plain direct ping-pong is still capped at the budget (no refresh).
    state = _state()
    spawn = _spawn_recorder([])
    spawned = 0
    for i in range(4):
        s = process_inbox_once(
            FakeClient(InboxResponse([_peer(i)], [], False, [])),
            "self", state, spawn=spawn, now=float(i),
            peer_enabled=True, peer_turn_budget=2,
        )
        spawned += s["spawned"]
    assert spawned == 2


def test_tick_relay_peer_autoreply_overrides_bootstrap_off():
    # Bootstrap default OFF, but the operator turned delegation ON in the console
    # (relay surfaces peer_autoreply=True) -> the teammate wakes the agent live.
    events = []
    inbox = InboxResponse(
        messages=[_peer(0)], controls=[], operator_trusted=False, roster=[],
        peer_autoreply=True,
    )
    summary = process_inbox_once(
        FakeClient(inbox), "self", _state(),
        spawn=_spawn_recorder(events), now=0.0, peer_enabled=False,
    )
    assert summary["spawned"] == 1


def test_tick_relay_peer_autoreply_off_overrides_bootstrap_on():
    # Bootstrap ON via env, but the operator turned it OFF in the console.
    events = []
    inbox = InboxResponse(
        messages=[_peer(0)], controls=[], operator_trusted=False, roster=[],
        peer_autoreply=False,
    )
    summary = process_inbox_once(
        FakeClient(inbox), "self", _state(),
        spawn=_spawn_recorder(events), now=0.0, peer_enabled=True,
    )
    assert summary["spawned"] == 0  # console disabled it, live


def test_tick_relay_budget_overrides_bootstrap():
    events = []
    state = _state()
    spawned = 0
    for i in range(4):
        inbox = InboxResponse(
            messages=[_peer(i)], controls=[], operator_trusted=False, roster=[],
            peer_autoreply=True, peer_turn_budget=2,
        )
        s = process_inbox_once(
            FakeClient(inbox), "self", state,
            spawn=_spawn_recorder(events), now=float(i),
            peer_enabled=True, peer_turn_budget=99,
        )
        spawned += s["spawned"]
    assert spawned == 2  # relay budget 2 wins over the bootstrap default 99


def test_build_prompt_peer_uses_display_name_and_productivity_gate():
    from ekho import RosterEntry

    peer = _msg(
        sender_kind="agent",
        sender_agent_id="agent_jarvis",
        body={"text": "can you take the API task?"},
    )
    roster = [RosterEntry.from_dict({"agent_id": "agent_jarvis", "display_name": "Jarvis"})]
    prompt = build_prompt([peer], operator_trusted=False, roster=roster)
    assert "Jarvis" in prompt  # display name, not the raw agent id
    assert 'recipient_agent_id="agent_jarvis"' in prompt
    # Productivity gate — don't chatter.
    assert "materially advances the work" in prompt
    assert "acknowledge" in prompt
    # The open-a-room doctrine nudge is surfaced when teammates are present.
    assert "ekho_open_room" in prompt


def test_build_prompt_frames_room_message_as_reply_to_room():
    peer = _msg(
        sender_kind="agent",
        sender_agent_id="agent_jarvis",
        conversation_id="room_42",
        body={"text": "shipping the migration now"},
    )
    prompt = build_prompt(
        [peer],
        operator_trusted=False,
        rooms=[{"id": "room_42", "name": "Migration rollout"}],
    )
    assert 'room_id="room_42"' in prompt
    assert "Migration rollout" in prompt
    assert "goes to every member" in prompt
    # A room message must NOT fall back to the 1:1 recipient framing.
    assert 'recipient_agent_id="agent_jarvis"' not in prompt


def test_plan_floor_turn_agent_responds_only_to_granted_conversations():
    # The floor serializes AGENT-to-agent turns.
    kept = [_msg(conversation_id="c1", sender_kind="agent", sender_agent_id="jarvis"),
            _msg(conversation_id="c2", sender_kind="agent", sender_agent_id="jarvis")]

    def acquire(conv):
        if conv == "c1":
            return {"granted": True, "conversation_tail": []}
        return {"granted": False, "holder_agent_id": "other"}

    floored, to_release, tails = plan_floor_turn(kept, acquire)
    assert [m.conversation_id for m in floored] == ["c1"]
    assert to_release == ["c1"]


def test_plan_floor_turn_carries_fresh_tail():
    kept = [_msg(conversation_id="c1", sender_kind="agent", sender_agent_id="jarvis")]

    def acquire(conv):
        return {"granted": True, "conversation_tail": [
            {"message_id": "h1", "text": "earlier", "sender_kind": "agent",
             "sender_agent_id": "x", "sender_label": "X", "created_at": "t"}]}

    _, _, tails = plan_floor_turn(kept, acquire)
    assert tails["c1"][0]["text"] == "earlier"


def test_plan_floor_turn_degrades_without_floor_endpoint():
    kept = [_msg(conversation_id="c1", sender_kind="agent", sender_agent_id="jarvis")]

    def acquire(conv):
        raise RuntimeError("404 not found")

    floored, to_release, _ = plan_floor_turn(kept, acquire)
    assert len(floored) == 1   # still responds (back-compat)
    assert to_release == []     # nothing acquired -> nothing to release


def test_plan_floor_turn_operator_messages_bypass_floor():
    # The operator addressing a room/broadcast: each member replies independently,
    # so we must NOT contend for (or defer on) the shared floor.
    kept = [_msg(conversation_id="room1"), _msg(conversation_id="bcast")]  # both operator
    calls = {"n": 0}

    def acquire(conv):
        calls["n"] += 1
        return {"granted": False, "holder_agent_id": "other"}

    floored, to_release, _ = plan_floor_turn(kept, acquire)
    assert calls["n"] == 0  # never contends for an operator turn
    assert [m.conversation_id for m in floored] == ["room1", "bcast"]
    assert to_release == []


def test_plan_floor_turn_contends_when_peer_shares_conversation():
    kept = [_msg(conversation_id="room1"),  # operator
            _msg(conversation_id="room1", sender_kind="agent", sender_agent_id="tars")]
    calls = {"n": 0}

    def acquire(conv):
        calls["n"] += 1
        return {"granted": True, "conversation_tail": []}

    _, to_release, _ = plan_floor_turn(kept, acquire)
    assert calls["n"] == 1
    assert to_release == ["room1"]


# --- budget-awareness in the prompt ----------------------------------------


def test_build_prompt_includes_budget_line_with_remaining():
    # The peer-woken agent is told its turn number and how many wakes remain.
    prompt = build_prompt(
        [_peer(0)],
        operator_trusted=False,
        peer_turn_budget=6,
        peer_budget_remaining={"proj-1": 5},
    )
    assert "Bounded delegation: peer turn 1 of 6 in this conversation" in prompt
    assert "5 wake(s) left" in prompt
    assert "front-load" in prompt


def test_build_prompt_budget_line_counts_down():
    # After 4 consumed of 6, this (5th) wake leaves 2.
    prompt = build_prompt(
        [_peer(0)],
        operator_trusted=False,
        peer_turn_budget=6,
        peer_budget_remaining={"proj-1": 2},
    )
    assert "peer turn 4 of 6" in prompt
    assert "2 wake(s) left" in prompt


def test_build_prompt_no_budget_line_without_remaining_map():
    # Operator-only / older callers pass no map -> no budget line at all.
    prompt = build_prompt([_msg()], operator_trusted=True)
    assert "Bounded delegation" not in prompt


def test_build_prompt_budget_line_reenergised_when_operator_in_batch():
    # An operator message in the same conversation re-energises the latch, so the
    # line says so rather than counting down toward an auto-pause.
    op = _msg(message_id="o1", sender_kind="operator", sender_agent_id="op",
              conversation_id="proj-1")
    prompt = build_prompt(
        [op, _peer(0)],
        operator_trusted=True,
        peer_turn_budget=6,
        peer_budget_remaining={"proj-1": 5},
    )
    assert "re-energising this conversation's peer budget" in prompt
    assert "peer turn 1 of 6" in prompt


def test_build_prompt_budget_line_once_per_conversation():
    # Two peer messages in the same conversation -> a single budget line.
    p1 = _peer(0)
    p2 = _peer(1)  # same conversation_id "proj-1"
    prompt = build_prompt(
        [p1, p2],
        operator_trusted=False,
        peer_turn_budget=6,
        peer_budget_remaining={"proj-1": 4},
    )
    assert prompt.count("Bounded delegation:") == 1


# --- Feature 2: graceful last turn ------------------------------------------


def test_build_prompt_last_turn_line_when_remaining_zero():
    # remaining-after == 0 -> this is the last auto-wake before the latch closes,
    # so the agent is told to finish or hand off cleanly, never stop mid-task.
    prompt = build_prompt(
        [_peer(0)],
        operator_trusted=False,
        peer_turn_budget=6,
        peer_budget_remaining={"proj-1": 0},
    )
    assert "LAST auto-wake in this thread before it pauses" in prompt
    assert "do NOT stop mid-task without a word" in prompt
    assert "peer turn 6 of 6" in prompt
    # The normal countdown line is replaced, not also shown.
    assert "wake(s) left before it auto-pauses" not in prompt


def test_build_prompt_normal_budget_line_when_remaining_positive():
    prompt = build_prompt(
        [_peer(0)],
        operator_trusted=False,
        peer_turn_budget=6,
        peer_budget_remaining={"proj-1": 3},
    )
    assert "LAST auto-wake" not in prompt
    assert "3 wake(s) left" in prompt


def _prompt_recorder(captured):
    """A spawn that captures the one-shot prompt argv (cmd[-1])."""
    def spawn(cmd, env):
        captured.append(cmd[-1])
    return spawn


def test_tick_threads_budget_into_spawned_prompt():
    captured = []
    inbox = InboxResponse(
        messages=[_peer(0)], controls=[], operator_trusted=False, roster=[],
        peer_autoreply=True, peer_turn_budget=6,
    )
    summary = process_inbox_once(
        FakeClient(inbox), "self", _state(),
        spawn=_prompt_recorder(captured), now=0.0,
    )
    assert summary["spawned"] == 1
    assert captured, "expected a spawned turn"
    assert "Bounded delegation: peer turn 1 of 6 in this conversation" in captured[0]
    assert "5 wake(s) left" in captured[0]


def test_tick_records_peer_usage_for_ekho_inbox():
    inbox = InboxResponse(
        messages=[_peer(0)], controls=[], operator_trusted=False, roster=[],
        peer_autoreply=True, peer_turn_budget=6,
    )
    process_inbox_once(
        FakeClient(inbox), "self", _state(),
        spawn=_spawn_recorder([]), now=0.0,
    )
    cached = get_cached_inbox()
    assert cached["peer_autoreply"] is True
    assert cached["peer_turn_budget"] == 6
    assert cached["peer_turns_used"].get("proj-1") == 1  # one wake consumed


def test_record_peer_usage_snapshot_is_isolated():
    # The snapshot must be a copy — later state mutations don't leak into the cache.
    live = {"c1": 2}
    record_peer_usage(live)
    live["c1"] = 99
    assert get_cached_inbox()["peer_turns_used"]["c1"] == 2


# --- Feature 3: stall escalation (no silent death) --------------------------


def _notice_client(inbox, notices):
    """A FakeClient that records best-effort raise_notice() escalations."""
    c = FakeClient(inbox)
    c.raise_notice = lambda **kw: (notices.append(kw), {"ok": True, "recorded": True})[1]
    return c


def test_tick_escalates_once_when_a_peer_is_withheld_on_a_closed_latch():
    state = _state()
    notices = []
    spawn = _spawn_recorder([])
    # budget 1: the first peer wakes (consumes the only turn) — nothing withheld.
    process_inbox_once(
        _notice_client(InboxResponse([_peer(0)], [], False, []), notices),
        "self", state, spawn=spawn, now=0.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert notices == []
    # A second peer is withheld (latch closed) -> exactly one escalation.
    process_inbox_once(
        _notice_client(InboxResponse([_peer(1)], [], False, []), notices),
        "self", state, spawn=spawn, now=1.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert len(notices) == 1
    assert notices[0]["conversation_id"] == "proj-1"
    assert notices[0]["reason"] == "peer_turn_budget_exhausted"
    assert notices[0]["pending_count"] == 1
    assert notices[0]["budget"] == 1
    # A third withheld peer does NOT re-escalate (deduped until reset).
    process_inbox_once(
        _notice_client(InboxResponse([_peer(2)], [], False, []), notices),
        "self", state, spawn=spawn, now=2.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert len(notices) == 1


def test_tick_escalation_re_arms_after_operator_reset():
    state = _state()
    notices = []
    spawn = _spawn_recorder([])
    process_inbox_once(
        _notice_client(InboxResponse([_peer(0)], [], False, []), notices),
        "self", state, spawn=spawn, now=0.0, peer_enabled=True, peer_turn_budget=1,
    )
    process_inbox_once(
        _notice_client(InboxResponse([_peer(1)], [], False, []), notices),
        "self", state, spawn=spawn, now=1.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert len(notices) == 1
    # The operator engaging re-opens the latch AND re-arms the escalation.
    op = _msg(message_id="o1", sender_kind="operator", sender_agent_id="op",
              conversation_id="proj-1")
    process_inbox_once(
        _notice_client(InboxResponse([op], [], True, []), notices),
        "self", state, spawn=spawn, now=2.0, peer_enabled=True, peer_turn_budget=1,
    )
    # Fresh budget: a peer wakes, the next is withheld -> a NEW escalation.
    process_inbox_once(
        _notice_client(InboxResponse([_peer(2)], [], False, []), notices),
        "self", state, spawn=spawn, now=3.0, peer_enabled=True, peer_turn_budget=1,
    )
    process_inbox_once(
        _notice_client(InboxResponse([_peer(3)], [], False, []), notices),
        "self", state, spawn=spawn, now=4.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert len(notices) == 2


def test_tick_no_escalation_when_a_progress_signal_refreshes_the_budget():
    # A handoff refreshes the budget and wakes -> never latched -> no escalation.
    state = _state()
    notices = []
    process_inbox_once(
        _notice_client(InboxResponse([_peer_typed(0, "handoff")], [], False, []), notices),
        "self", state, spawn=_spawn_recorder([]), now=0.0,
        peer_enabled=True, peer_turn_budget=1,
    )
    assert notices == []


def test_tick_escalation_failure_never_breaks_the_tick():
    # A raise_notice that raises must not propagate — escalation is best-effort.
    state = _state()
    spawn = _spawn_recorder([])
    process_inbox_once(
        FakeClient(InboxResponse([_peer(0)], [], False, [])),
        "self", state, spawn=spawn, now=0.0, peer_enabled=True, peer_turn_budget=1,
    )
    boom = FakeClient(InboxResponse([_peer(1)], [], False, []))
    def _raise(**kw):
        raise RuntimeError("relay down")
    boom.raise_notice = _raise
    summary = process_inbox_once(
        boom, "self", state, spawn=spawn, now=1.0, peer_enabled=True, peer_turn_budget=1,
    )
    assert summary["latched"] == 1  # tick completed despite the escalation failure

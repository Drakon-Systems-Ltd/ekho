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
    get_cached_inbox,
    is_real_inbound,
    mark_seen,
    process_inbox_once,
    record_batch,
    reset_cache,
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
    assert "verified fleet operator" in prompt


def test_build_prompt_unverified_operator_label():
    prompt = build_prompt([_msg()], operator_trusted=False)
    assert "UNVERIFIED" in prompt


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

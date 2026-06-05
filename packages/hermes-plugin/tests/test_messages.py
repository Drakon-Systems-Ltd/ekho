"""Tests for the pure message/inbox mappers."""

from ekho_hermes.messages import (
    EKHO_ORIGIN_STAMP,
    build_send_input,
    format_inbox,
    iso_now,
)


# --- build_send_input ------------------------------------------------------


def test_build_send_input_agent_recipient():
    payload = build_send_input("agent-123", "hello there")
    assert payload["recipient"] == {"kind": "agent", "id": "agent-123"}
    assert payload["message_type"] == "direct"
    assert payload["body"] == {"text": "hello there"}
    assert payload["metadata"] == {"ekho_origin": EKHO_ORIGIN_STAMP}
    # No conversation_id passed -> key absent.
    assert "conversation_id" not in payload


def test_build_send_input_broadcast():
    payload = build_send_input("broadcast", "all hands")
    assert payload["recipient"] == {"kind": "broadcast"}
    assert "id" not in payload["recipient"]


def test_build_send_input_conversation_id():
    payload = build_send_input("agent-9", "re: task", conversation_id="conv-7")
    assert payload["conversation_id"] == "conv-7"


def test_build_send_input_attachment_ids():
    payload = build_send_input(
        "agent-9", "see files", attachment_ids=["att-1", "att-2"]
    )
    assert payload["body"]["attachments"] == ["att-1", "att-2"]


def test_build_send_input_empty_attachment_ids_omitted():
    payload = build_send_input("agent-9", "no files", attachment_ids=[])
    assert "attachments" not in payload["body"]
    # Falsy ids are filtered out too.
    payload2 = build_send_input("agent-9", "x", attachment_ids=["", None])
    assert "attachments" not in payload2["body"]


# --- iso_now ---------------------------------------------------------------


def test_iso_now_format():
    stamp = iso_now()
    assert stamp.endswith("Z")
    assert stamp[4] == "-" and stamp[10] == "T"
    # Millisecond precision: 23 chars like 2026-06-05T12:34:56.789Z
    assert len(stamp) == 24


# --- format_inbox ----------------------------------------------------------


def _msg(**kw):
    base = {
        "message_type": "direct",
        "body": {"text": "hi"},
        "conversation_id": "c1",
        "created_at": "2026-06-05T00:00:00.000Z",
        "sender_kind": "agent",
        "sender_agent_id": "agent-x",
    }
    base.update(kw)
    return base


def test_format_inbox_agent_message():
    out = format_inbox([_msg()], operator_trusted=False)
    assert out["count"] == 1
    msg = out["messages"][0]
    assert msg["from"] == "agent-x"
    assert msg["from_kind"] == "agent"
    assert msg["type"] == "direct"
    assert msg["body"] == {"text": "hi"}
    assert msg["conversation_id"] == "c1"
    assert msg["sent_at"] == "2026-06-05T00:00:00.000Z"
    assert "trust" not in msg


def test_format_inbox_operator_trusted_label():
    out = format_inbox(
        [_msg(sender_kind="operator", sender_agent_id="op")],
        operator_trusted=True,
    )
    msg = out["messages"][0]
    assert msg["from_kind"] == "operator"
    assert msg["from"] == "Operator (verified fleet operator — your principal)"
    assert msg["trust"] == "verified-operator"
    assert "authorized instruction" in msg["note"]
    assert out["operator_trusted"] is True


def test_format_inbox_operator_untrusted_label():
    out = format_inbox(
        [_msg(sender_kind="operator")],
        operator_trusted=False,
    )
    msg = out["messages"][0]
    assert msg["from"] == "Operator (unverified)"
    assert msg["trust"] == "unverified-operator"
    assert "caution" in msg["note"]
    assert out["operator_trusted"] is False


def test_format_inbox_roster_passthrough():
    roster = [
        {
            "agent_id": "a1",
            "display_name": "Agent One",
            "runtime": "hermes",
            "status": "healthy",
        }
    ]
    out = format_inbox([], operator_trusted=True, roster=roster)
    assert out["roster"] == [
        {
            "agent_id": "a1",
            "display_name": "Agent One",
            "runtime": "hermes",
            "status": "healthy",
        }
    ]


def test_format_inbox_attachment_local_paths_surfaced():
    locals_ = [{"id": "att1", "local_path": "/tmp/att1__file.png"}]
    out = format_inbox(
        [_msg(attachment_local_paths=locals_)], operator_trusted=False
    )
    assert out["messages"][0]["attachments"] == locals_


def test_format_inbox_accepts_sdk_dataclasses():
    from ekho import InboxMessage, RosterEntry

    sdk_msg = InboxMessage.from_dict(
        {
            "message_id": "m1",
            "conversation_id": "c1",
            "correlation_id": "x1",
            "sender_agent_id": "agent-z",
            "message_type": "direct",
            "priority": "normal",
            "body": {"text": "yo"},
            "metadata": {},
            "created_at": "2026-06-05T00:00:00.000Z",
            "deadline_at": "2026-06-05T01:00:00.000Z",
            "sender_kind": "agent",
        }
    )
    roster = [RosterEntry.from_dict({"agent_id": "a2", "display_name": "Two"})]
    out = format_inbox([sdk_msg], operator_trusted=False, roster=roster)
    assert out["messages"][0]["from"] == "agent-z"
    assert out["roster"][0]["agent_id"] == "a2"
    assert out["roster"][0]["display_name"] == "Two"

"""The inbox carries @mention / reply-to / room-history context; the SDK surfaces it."""

from ekho.types import InboxMessage, InboxResponse


def _msg(**over):
    base = {
        "message_id": "m1",
        "conversation_id": "c",
        "correlation_id": "cor",
        "sender_agent_id": "op_x",
        "message_type": "direct",
        "priority": "normal",
        "body": {"text": "hi"},
        "metadata": {},
        "created_at": "t",
        "deadline_at": "t",
    }
    base.update(over)
    return InboxMessage.from_dict(base)


def test_inbox_message_parses_mentions():
    assert _msg(mentions=["agent_a", "agent_b"]).mentions == ["agent_a", "agent_b"]


def test_inbox_message_defaults_mentions_to_empty_list():
    assert _msg().mentions == []


def test_inbox_message_parses_reply_to_snapshot():
    m = _msg(reply_to={
        "message_id": "m0",
        "sender_agent_id": "op_x",
        "sender_kind": "operator",
        "sender_label": "Operator",
        "text": "original question",
        "created_at": "2026-06-05T00:00:00.000Z",
    })
    assert m.reply_to is not None
    assert m.reply_to["message_id"] == "m0"
    assert m.reply_to["text"] == "original question"
    assert m.reply_to["sender_kind"] == "operator"


def test_inbox_message_reply_to_defaults_to_none():
    assert _msg().reply_to is None


def test_inbox_response_parses_conversation_history():
    resp = InboxResponse.from_dict({
        "messages": [],
        "controls": [],
        "conversation_history": {
            "room_123": [
                {"message_id": "m1", "sender_agent_id": "op_x", "sender_kind": "operator",
                 "sender_label": "Operator", "text": "first", "created_at": "2026-06-05T00:00:00.000Z"},
                {"message_id": "m2", "sender_agent_id": "agent_a", "sender_kind": "agent",
                 "sender_label": "Agent A", "text": "reply", "created_at": "2026-06-05T00:00:01.000Z"},
            ]
        },
    })
    assert "room_123" in resp.conversation_history
    assert len(resp.conversation_history["room_123"]) == 2
    assert resp.conversation_history["room_123"][0]["text"] == "first"


def test_inbox_response_defaults_conversation_history_to_empty_dict():
    resp = InboxResponse.from_dict({"messages": [], "controls": []})
    assert resp.conversation_history == {}


def test_inbox_response_fleet_id_still_last_positional():
    # fleet_id must remain the final positional field so positional construction
    # stays stable; conversation_history slots in before it.
    resp = InboxResponse([], [])
    assert resp.fleet_id is None
    assert resp.conversation_history == {}

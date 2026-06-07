"""The inbox carries verifiable-identity fields; the SDK types must surface them."""

from ekho.types import InboxMessage, InboxResponse, RosterEntry


def test_inbox_message_parses_signature_fields():
    m = InboxMessage.from_dict(
        {
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
            "sender_kind": "operator",
            "operator_sig": "SIG",
            "key_id": "K",
            "sig_canonical": {"v": 1},
        }
    )
    assert m.operator_sig == "SIG"
    assert m.key_id == "K"
    assert m.sig_canonical == {"v": 1}
    assert m.agent_sig is None


def test_roster_entry_parses_identity_key_and_endorsement():
    r = RosterEntry.from_dict(
        {
            "agent_id": "a",
            "display_name": "A",
            "runtime": "custom",
            "status": "healthy",
            "identity_public_key": "PUB",
            "key_id": "K",
            "endorsed_by_key_id": "OP",
            "endorsement_sig": "ESIG",
        }
    )
    assert r.identity_public_key == "PUB"
    assert r.key_id == "K"
    assert r.endorsed_by_key_id == "OP"
    assert r.endorsement_sig == "ESIG"


def test_inbox_response_parses_operator_keys():
    resp = InboxResponse.from_dict(
        {
            "messages": [],
            "controls": [],
            "operator_keys": [
                {
                    "key_id": "K",
                    "public_key": "PUB",
                    "revoked": False,
                    "endorsed_by_key_id": None,
                    "endorsement_sig": None,
                }
            ],
        }
    )
    assert len(resp.operator_keys) == 1
    assert resp.operator_keys[0].key_id == "K"
    assert resp.operator_keys[0].public_key == "PUB"
    assert resp.operator_keys[0].revoked is False

"""Agent-side verification wiring: pin sync (endorsement-chained, no relay TOFU),
per-message verdicts, and the graceful execution-authority gate."""

import hashlib
from datetime import datetime, timezone
from types import SimpleNamespace

from ekho import identity
from ekho.types import InboxMessage, InboxResponse, OperatorKeyEntry
from ekho_hermes.autoreply import AutoReplyState, process_inbox_once
from ekho_hermes.credentials import EkhoIdentity
from ekho import verify_canonical
from ekho_hermes.verification import (
    build_signed_send_fields,
    should_autowake,
    sync_pinned_operator_keys,
    verify_batch,
)

FLEET = "flt_v"
OP1_SEED, OP2_SEED = bytes(range(1, 33)), bytes(range(2, 34))
OP1_PUB = identity.public_key_b64url_from_seed(OP1_SEED)
OP2_PUB = identity.public_key_b64url_from_seed(OP2_SEED)
OP1_KID = identity.key_id(OP1_PUB)
OP2_KID = identity.key_id(OP2_PUB)


# --- pin sync ---
def test_sync_does_not_bootstrap_from_an_untrusted_relay():
    ident = EkhoIdentity(seed_hex="00" * 32)  # no pinned keys
    served = [OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET) is False
    assert ident.pinned_operator_keys == {}


def test_sync_adds_a_key_endorsed_by_a_pinned_key():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    esig = identity.sign_canonical(identity.endorsement_payload(FLEET, OP2_KID, OP2_PUB), OP1_SEED)
    served = [
        OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB),
        OperatorKeyEntry(key_id=OP2_KID, public_key=OP2_PUB, endorsed_by_key_id=OP1_KID, endorsement_sig=esig),
    ]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET) is True
    assert ident.pinned_operator_keys[OP2_KID] == OP2_PUB


def test_sync_rejects_an_unendorsed_new_key():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    served = [OperatorKeyEntry(key_id=OP2_KID, public_key=OP2_PUB)]  # no endorsement
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET) is False
    assert OP2_KID not in ident.pinned_operator_keys


def test_sync_drops_a_revoked_key():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    served = [OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB, revoked=True)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET) is True
    assert OP1_KID not in ident.pinned_operator_keys


# --- execution-authority gate (graceful) ---
def _op(verified=None, signed=True):
    v = None if verified is None else SimpleNamespace(verified=verified)
    msg = SimpleNamespace(sender_kind="operator", operator_sig="S" if signed else None, agent_sig=None)
    return msg, v


def _peer(verified=None, signed=True):
    v = None if verified is None else SimpleNamespace(verified=verified)
    msg = SimpleNamespace(sender_kind="agent", agent_sig="S" if signed else None, operator_sig=None)
    return msg, v


def test_gate_operator_verified_acts():
    msg, v = _op(verified=True)
    assert should_autowake(msg, v, operator_trusted=False, peer_enabled=False) is True


def test_gate_operator_signed_but_invalid_is_blocked():
    msg, v = _op(verified=False)
    assert should_autowake(msg, v, operator_trusted=True, peer_enabled=False) is False


def test_gate_operator_unsigned_falls_back_to_relay_trust():
    msg, _ = _op(signed=False)
    assert should_autowake(msg, None, operator_trusted=True, peer_enabled=False) is True
    assert should_autowake(msg, None, operator_trusted=False, peer_enabled=False) is False


def test_gate_peer_verified_acts_when_enabled():
    msg, v = _peer(verified=True)
    assert should_autowake(msg, v, operator_trusted=False, peer_enabled=True) is True
    assert should_autowake(msg, v, operator_trusted=False, peer_enabled=False) is False


def test_gate_peer_signed_but_invalid_is_blocked():
    msg, v = _peer(verified=False)
    assert should_autowake(msg, v, operator_trusted=False, peer_enabled=True) is False


def test_gate_peer_unsigned_legacy_acts_when_enabled():
    msg, _ = _peer(signed=False)
    assert should_autowake(msg, None, operator_trusted=False, peer_enabled=True) is True


# --- batch ---
def test_verify_batch_returns_none_without_pinned_keys():
    ident = EkhoIdentity(seed_hex="00" * 32)
    msg = SimpleNamespace(message_id="m1", sender_kind="operator")
    out = verify_batch(
        [msg], identity_obj=ident, self_agent_id="a", fleet_id=FLEET,
        roster=[], seen_nonces=set(), now=datetime.now(timezone.utc),
    )
    assert out == {"m1": None}


# --- live tick: the "real execution" guarantee ---
class _FakeClient:
    def __init__(self, inbox):
        self._inbox = inbox
        self.acked = []

    def get_inbox(self):
        return self._inbox

    def ack_messages(self, acks):
        self.acked.append(acks)


def _signed_op_msg(text, *, self_id, seed, nonce, sent_at):
    pub = identity.public_key_b64url_from_seed(seed)
    kid = identity.key_id(pub)
    canonical = {
        "v": 1, "fleet_id": FLEET, "operator_id": "op", "key_id": kid,
        "recipient": {"kind": "agent", "id": self_id},
        "conversation_id": "c",
        "body_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "sent_at": sent_at, "nonce": nonce,
    }
    return InboxMessage(
        message_id="opm", conversation_id="c", correlation_id="cor",
        sender_agent_id="op_" + FLEET, message_type="direct", priority="normal",
        body={"text": text}, metadata={}, created_at="t", deadline_at="t",
        sender_kind="operator", operator_sig=identity.sign_canonical(canonical, seed),
        key_id=kid, sig_canonical=canonical,
    )


NOW = datetime(2026, 6, 7, 12, 0, 0, tzinfo=timezone.utc)


def test_tick_verified_operator_executes_even_when_relay_flag_false():
    ident = EkhoIdentity(seed_hex="11" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    msg = _signed_op_msg("do the thing", self_id="self", seed=OP1_SEED, nonce="nz1", sent_at="2026-06-07T12:00:00Z")
    inbox = InboxResponse(
        messages=[msg], controls=[], operator_trusted=False, roster=[],
        operator_keys=[OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB)], fleet_id=FLEET,
    )
    spawned = []
    process_inbox_once(
        _FakeClient(inbox), "self", AutoReplyState(),
        spawn=lambda *a: spawned.append(a), now=0.0, wall_now=NOW, identity_obj=ident,
    )
    # Authority comes from the SIGNATURE, not the relay flag: a verified operator
    # command executes even though operator_trusted is False.
    assert len(spawned) == 1


def test_tick_forged_operator_signature_blocked_even_when_flag_true():
    ident = EkhoIdentity(seed_hex="11" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    msg = _signed_op_msg("do the thing", self_id="self", seed=OP1_SEED, nonce="nz2", sent_at="2026-06-07T12:00:00Z")
    msg.body = {"text": "do something EVIL"}  # tampered after signing
    inbox = InboxResponse(
        messages=[msg], controls=[], operator_trusted=True, roster=[],
        operator_keys=[OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB)], fleet_id=FLEET,
    )
    spawned = []
    process_inbox_once(
        _FakeClient(inbox), "self", AutoReplyState(),
        spawn=lambda *a: spawned.append(a), now=0.0, wall_now=NOW, identity_obj=ident,
    )
    # Signed but invalid → impersonation; blocked despite operator_trusted=True.
    assert len(spawned) == 0


def test_tick_dead_letters_a_signed_but_invalid_message(tmp_path, caplog):
    import json
    import logging

    ident = EkhoIdentity(seed_hex="11" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    msg = _signed_op_msg("do the thing", self_id="self", seed=OP1_SEED, nonce="nz3", sent_at="2026-06-07T12:00:00Z")
    msg.body = {"text": "do something EVIL"}  # tampered after signing
    inbox = InboxResponse(
        messages=[msg], controls=[], operator_trusted=True, roster=[],
        operator_keys=[OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB)], fleet_id=FLEET,
    )
    dl = tmp_path / "dead-letter.jsonl"
    with caplog.at_level(logging.WARNING):
        process_inbox_once(
            _FakeClient(inbox), "self", AutoReplyState(),
            spawn=lambda *a: None, now=0.0, wall_now=NOW, identity_obj=ident,
            dead_letter_path=str(dl),
        )
    # The reject is loud: reason in the log, full message in the dead-letter file.
    assert any("verification FAILED" in r.message and "body-mismatch" in r.getMessage() for r in caplog.records)
    records = [json.loads(line) for line in dl.read_text().splitlines()]
    assert len(records) == 1
    assert records[0]["reason"] == "body-mismatch"
    assert records[0]["kind"] == "operator"
    assert records[0]["message"]["message_id"] == "opm"
    assert records[0]["message"]["body"]["text"] == "do something EVIL"


def test_tick_does_not_dead_letter_verified_or_unsigned_messages(tmp_path):
    ident = EkhoIdentity(seed_hex="11" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    good = _signed_op_msg("do the thing", self_id="self", seed=OP1_SEED, nonce="nz4", sent_at="2026-06-07T12:00:00Z")
    unsigned = InboxMessage(
        message_id="um", conversation_id="c", correlation_id="cor",
        sender_agent_id="op_" + FLEET, message_type="direct", priority="normal",
        body={"text": "plain"}, metadata={}, created_at="t", deadline_at="t",
        sender_kind="operator",
    )
    inbox = InboxResponse(
        messages=[good, unsigned], controls=[], operator_trusted=True, roster=[],
        operator_keys=[OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB)], fleet_id=FLEET,
    )
    dl = tmp_path / "dead-letter.jsonl"
    process_inbox_once(
        _FakeClient(inbox), "self", AutoReplyState(),
        spawn=lambda *a: None, now=0.0, wall_now=NOW, identity_obj=ident,
        dead_letter_path=str(dl),
    )
    assert not dl.exists()


# --- outbound signing (the symmetric half) ---
def test_build_signed_send_fields_round_trips():
    ident = EkhoIdentity(seed_hex="0a" * 32)
    fields = build_signed_send_fields(
        identity_obj=ident, fleet_id="flt", self_agent_id="me",
        recipient={"kind": "agent", "id": "peer"}, conversation_id="c",
        body_text="hello", nonce="n1", sent_at="2026-06-07T00:00:00Z",
    )
    assert fields["key_id"] == identity.key_id(ident.public_key_b64url())
    assert fields["sig_canonical"]["sender_agent_id"] == "me"
    assert fields["sig_canonical"]["body_sha256"] == hashlib.sha256(b"hello").hexdigest()
    # A recipient can verify it against our public key.
    assert verify_canonical(
        fields["sig_canonical"], fields["agent_sig"], ident.public_key_b64url()
    ) is True

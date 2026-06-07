"""The verifier: an agent independently checks an inbound message's signature and
the 7 binding checks — for operator messages (pinned key) and peer messages
(operator-endorsed sender key). This is what turns relay-attested into verified."""

import hashlib
from datetime import datetime, timezone

from ekho import identity
from ekho.types import InboxMessage, RosterEntry
from ekho.verify import verify_inbound

OP_SEED = bytes(range(1, 33))
OP_PUB = identity.public_key_b64url_from_seed(OP_SEED)
OP_KID = identity.key_id(OP_PUB)

PEER_SEED = bytes(range(40, 72))
PEER_PUB = identity.public_key_b64url_from_seed(PEER_SEED)
PEER_KID = identity.key_id(PEER_PUB)

FLEET = "flt_test"
SELF = "agent_self"
PEER_ID = "agent_peer"
NOW = datetime(2026, 6, 7, 0, 0, 0, tzinfo=timezone.utc)


def _bh(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _op_msg(text="do it", recipient_id=SELF, nonce="n1", sent_at="2026-06-07T00:00:00Z", seed=OP_SEED):
    kid = identity.key_id(identity.public_key_b64url_from_seed(seed))
    canonical = {
        "v": 1, "fleet_id": FLEET, "operator_id": "op", "key_id": kid,
        "recipient": {"kind": "agent", "id": recipient_id},
        "conversation_id": "c", "body_sha256": _bh(text), "sent_at": sent_at, "nonce": nonce,
    }
    sig = identity.sign_canonical(canonical, seed)
    return InboxMessage(
        message_id="m", conversation_id="c", correlation_id="cor", sender_agent_id="op_" + FLEET,
        message_type="direct", priority="normal", body={"text": text}, metadata={},
        created_at="t", deadline_at="t", sender_kind="operator",
        operator_sig=sig, key_id=kid, sig_canonical=canonical,
    )


def _peer_msg(text="hi", recipient_id=SELF, nonce="p1", seed=PEER_SEED):
    kid = identity.key_id(identity.public_key_b64url_from_seed(seed))
    canonical = {
        "v": 1, "fleet_id": FLEET, "sender_agent_id": PEER_ID, "key_id": kid,
        "recipient": {"kind": "agent", "id": recipient_id},
        "conversation_id": "c", "body_sha256": _bh(text), "sent_at": "2026-06-07T00:00:00Z", "nonce": nonce,
    }
    sig = identity.sign_canonical(canonical, seed)
    return InboxMessage(
        message_id="m", conversation_id="c", correlation_id="cor", sender_agent_id=PEER_ID,
        message_type="direct", priority="normal", body={"text": text}, metadata={},
        created_at="t", deadline_at="t", sender_kind="agent",
        agent_sig=sig, key_id=kid, sig_canonical=canonical,
    )


def _roster(endorse=True, endorser_seed=OP_SEED):
    endorsement = identity.agent_key_endorsement_payload(FLEET, PEER_ID, PEER_KID, PEER_PUB)
    esig = identity.sign_canonical(endorsement, endorser_seed) if endorse else None
    return {
        PEER_ID: RosterEntry(
            agent_id=PEER_ID, display_name="P", runtime="custom", status="healthy",
            identity_public_key=PEER_PUB, key_id=PEER_KID,
            endorsed_by_key_id=OP_KID if endorse else None, endorsement_sig=esig,
        )
    }


def _verify(msg, *, operator_keys=None, roster=None, seen=None, now=NOW):
    return verify_inbound(
        msg,
        self_agent_id=SELF,
        fleet_id=FLEET,
        operator_keys=operator_keys if operator_keys is not None else {OP_KID: OP_PUB},
        roster_by_agent=roster or {},
        seen_nonces=seen or set(),
        now=now,
    )


# --- operator ---
def test_operator_happy_path():
    r = _verify(_op_msg())
    assert r.verified is True and r.kind == "operator"


def test_operator_unknown_key():
    r = _verify(_op_msg(), operator_keys={})
    assert r.verified is False and r.reason == "unknown-operator-key"


def test_operator_recipient_mismatch():
    r = _verify(_op_msg(recipient_id="someone_else"))
    assert r.verified is False and r.reason == "recipient-mismatch"


def test_operator_body_tamper():
    msg = _op_msg(text="do it")
    msg.body = {"text": "do something evil"}  # body changed after signing
    r = _verify(msg)
    assert r.verified is False and r.reason == "body-mismatch"


def test_operator_stale_timestamp():
    later = datetime(2026, 6, 7, 1, 0, 0, tzinfo=timezone.utc)  # +1h, beyond 5m skew
    r = _verify(_op_msg(), now=later)
    assert r.verified is False and r.reason == "stale"


def test_operator_replay():
    r = _verify(_op_msg(nonce="used"), seen={"used"})
    assert r.verified is False and r.reason == "replay"


def test_operator_unsigned():
    msg = _op_msg()
    msg.operator_sig = None
    r = _verify(msg)
    assert r.verified is False and r.reason == "unsigned"


# --- peer ---
def test_peer_happy_path_endorsed():
    r = _verify(_peer_msg(), roster=_roster(endorse=True))
    assert r.verified is True and r.kind == "peer"


def test_peer_unendorsed_key_rejected():
    r = _verify(_peer_msg(), roster=_roster(endorse=False))
    assert r.verified is False and r.reason == "sender-key-unendorsed"


def test_peer_bad_endorsement_rejected():
    # Endorsement signed by a non-operator key → not rooted at the operator.
    r = _verify(_peer_msg(), roster=_roster(endorse=True, endorser_seed=PEER_SEED))
    assert r.verified is False and r.reason in ("bad-endorsement", "endorser-not-pinned")


def test_peer_unknown_sender_rejected():
    r = _verify(_peer_msg(), roster={})  # sender not in roster
    assert r.verified is False and r.reason == "unknown-sender-key"

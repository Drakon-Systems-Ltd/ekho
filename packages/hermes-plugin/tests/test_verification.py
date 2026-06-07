"""Agent-side verification wiring: pin sync (endorsement-chained, no relay TOFU),
per-message verdicts, and the graceful execution-authority gate."""

from datetime import datetime, timezone
from types import SimpleNamespace

from ekho import identity
from ekho.types import OperatorKeyEntry, RosterEntry
from ekho_hermes.credentials import EkhoIdentity
from ekho_hermes.verification import (
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
    out = verify_batch([msg], identity_obj=ident, self_agent_id="a", fleet_id=FLEET, roster=[], seen_nonces=set(), now=datetime.now(timezone.utc))
    assert out == {"m1": None}

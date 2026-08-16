"""Agent-side verification wiring: pin sync (endorsement-chained, plus the
one-shot TOFU bootstrap), per-message verdicts, and the execution-authority
gate."""

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
ROGUE_SEED = bytes([9]) * 32
OP1_PUB = identity.public_key_b64url_from_seed(OP1_SEED)
OP2_PUB = identity.public_key_b64url_from_seed(OP2_SEED)
OP1_KID = identity.key_id(OP1_PUB)
OP2_KID = identity.key_id(OP2_PUB)
REVOKED_AT = "2026-08-16T00:00:00Z"


def rev_sig(seed, kid, at=REVOKED_AT, fleet=FLEET):
    """A signed revocation of ``kid``, issued by ``seed``."""
    return identity.sign_canonical(identity.revocation_payload(fleet, kid, at), seed)


def unrev_sig(seed, kid, fleet=FLEET):
    """A signed un-revoke of ``kid``, issued by ``seed``."""
    return identity.sign_canonical(identity.unrevoke_payload(fleet, kid), seed)


class CaptureLog:
    """Stand-in for a logging.Logger that keeps what the sync said."""

    def __init__(self):
        self.notes = []

    def warning(self, msg, *args):
        self.notes.append(str(msg) % args if args else str(msg))

    def info(self, msg, *args):
        self.notes.append(str(msg) % args if args else str(msg))

    def text(self):
        return "\n".join(self.notes)


QUIET = CaptureLog()


# --- pin sync ---
# #5: a never-pinned identity TOFUs the relay's key set exactly once —
# "never adopt" left verification dormant on every unconfigured agent.
def test_tofu_adopts_first_key_set_for_never_pinned_identity_and_latches():
    ident = EkhoIdentity(seed_hex="00" * 32)  # no pinned keys
    served = [OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET) is True
    assert ident.pinned_operator_keys[OP1_KID] == OP1_PUB
    assert ident.tofu_at

    # Once latched, an emptied pin set can never be re-seeded by the relay.
    ident.pinned_operator_keys = {}
    served2 = [OperatorKeyEntry(key_id=OP2_KID, public_key=OP2_PUB)]
    assert sync_pinned_operator_keys(ident, served2, fleet_id=FLEET) is False
    assert ident.pinned_operator_keys == {}


def test_tofu_skips_revoked_keys_and_empty_roster_does_not_burn_the_latch():
    ident = EkhoIdentity(seed_hex="00" * 32)
    assert sync_pinned_operator_keys(ident, [], fleet_id=FLEET, log=QUIET) is False
    assert ident.tofu_at is None  # nothing adopted — next contact may still TOFU
    served = [OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB, revoked=True)]
    # #27: an unsigned revoked flag is advisory — nothing is written, so this is
    # a no-op poll. It still blocks adoption, so the latch stays unburned.
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is False
    assert ident.tofu_at is None
    assert ident.pinned_operator_keys == {}
    assert ident.revoked_operator_keys == {}


def test_pre_pinned_identity_never_tofus_unendorsed_keys_still_refused():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    served = [OperatorKeyEntry(key_id=OP2_KID, public_key=OP2_PUB)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET) is False
    assert OP2_KID not in ident.pinned_operator_keys
    assert ident.tofu_at is None


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


def test_tombstoned_key_is_never_re_adopted_by_tofu():
    ident = EkhoIdentity(
        seed_hex="00" * 32,
        revoked_operator_keys={OP1_KID: "2026-08-10T00:00:00Z"},
    )
    served = [OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB)]  # relay no longer flags it
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET) is False
    assert OP1_KID not in ident.pinned_operator_keys
    assert ident.tofu_at is None


def test_tombstoned_key_is_never_re_adopted_by_endorsement_chaining():
    ident = EkhoIdentity(
        seed_hex="00" * 32,
        pinned_operator_keys={OP1_KID: OP1_PUB},
        revoked_operator_keys={OP2_KID: "2026-08-10T00:00:00Z"},
    )
    esig = identity.sign_canonical(identity.endorsement_payload(FLEET, OP2_KID, OP2_PUB), OP1_SEED)
    served = [
        OperatorKeyEntry(key_id=OP2_KID, public_key=OP2_PUB, endorsed_by_key_id=OP1_KID, endorsement_sig=esig),
    ]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET) is False
    assert OP2_KID not in ident.pinned_operator_keys


# --- #27: unsigned `revoked` is ADVISORY ---
# The relay is the transport, not the trust root. Before this, a relay that said
# revoked=True got a permanent tombstone AND the pin deleted with no proof asked
# for — one poll from a compromised relay wiped a fleet's trust root.
UNSIGNED = OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB, revoked=True)


def test_unsigned_revoked_does_not_unpin():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    assert sync_pinned_operator_keys(ident, [UNSIGNED], fleet_id=FLEET, log=QUIET) is False
    assert ident.pinned_operator_keys[OP1_KID] == OP1_PUB


def test_unsigned_revoked_does_not_write_a_tombstone():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP2_KID: OP2_PUB})
    assert sync_pinned_operator_keys(ident, [UNSIGNED], fleet_id=FLEET, log=QUIET) is False
    assert ident.revoked_operator_keys == {}
    # and it is still a no-op on the next poll — nothing accumulates
    assert sync_pinned_operator_keys(ident, [UNSIGNED], fleet_id=FLEET, log=QUIET) is False


def test_unsigned_revoked_still_blocks_tofu_adoption():
    ident = EkhoIdentity(seed_hex="00" * 32)
    served = [UNSIGNED, OperatorKeyEntry(key_id=OP2_KID, public_key=OP2_PUB)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is True
    assert OP1_KID not in ident.pinned_operator_keys
    assert ident.pinned_operator_keys[OP2_KID] == OP2_PUB


def test_unsigned_revoked_still_blocks_chain_adoption():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    esig = identity.sign_canonical(identity.endorsement_payload(FLEET, OP2_KID, OP2_PUB), OP1_SEED)
    served = [
        OperatorKeyEntry(
            key_id=OP2_KID,
            public_key=OP2_PUB,
            revoked=True,
            endorsed_by_key_id=OP1_KID,
            endorsement_sig=esig,
        )
    ]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is False
    assert OP2_KID not in ident.pinned_operator_keys


def test_unsigned_revoked_blocks_adoption_even_if_also_served_unflagged():
    # Split the claim across two entries and a naive per-entry check adopts it.
    ident = EkhoIdentity(seed_hex="00" * 32)
    served = [UNSIGNED, OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is False
    assert OP1_KID not in ident.pinned_operator_keys


def test_unsigned_revoked_is_never_silent():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    log = CaptureLog()
    sync_pinned_operator_keys(ident, [UNSIGNED], fleet_id=FLEET, log=log)
    assert OP1_KID in log.text()
    assert "without a valid revocation signature" in log.text()


def test_revocation_signature_that_does_not_verify_is_treated_as_unsigned():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    # Signed by a key nobody pinned — the classic rogue-relay forgery.
    served = [
        OperatorKeyEntry(
            key_id=OP1_KID,
            public_key=OP1_PUB,
            revoked=True,
            revoked_at=REVOKED_AT,
            revocation_sig=rev_sig(ROGUE_SEED, OP1_KID),
        )
    ]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is False
    assert ident.pinned_operator_keys[OP1_KID] == OP1_PUB
    assert ident.revoked_operator_keys == {}


def test_revocation_signature_is_bound_to_fleet_and_time():
    ident = EkhoIdentity(
        seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB, OP2_KID: OP2_PUB}
    )
    wrong_fleet = [
        OperatorKeyEntry(
            key_id=OP1_KID,
            public_key=OP1_PUB,
            revoked=True,
            revoked_at=REVOKED_AT,
            revocation_sig=rev_sig(OP2_SEED, OP1_KID, fleet="flt_other"),
        )
    ]
    assert sync_pinned_operator_keys(ident, wrong_fleet, fleet_id=FLEET, log=QUIET) is False
    # Right key and fleet, but the relay restated WHEN it happened.
    restated = [
        OperatorKeyEntry(
            key_id=OP1_KID,
            public_key=OP1_PUB,
            revoked=True,
            revoked_at="2020-01-01T00:00:00Z",
            revocation_sig=rev_sig(OP2_SEED, OP1_KID),
        )
    ]
    assert sync_pinned_operator_keys(ident, restated, fleet_id=FLEET, log=QUIET) is False
    assert ident.pinned_operator_keys[OP1_KID] == OP1_PUB


# --- #27: signed revocation is the ONLY thing that mutates the trust root ---
def _signed_revocation(kid, pub, seed, at=REVOKED_AT):
    return OperatorKeyEntry(
        key_id=kid, public_key=pub, revoked=True, revoked_at=at, revocation_sig=rev_sig(seed, kid, at)
    )


def test_signed_revocation_tombstones_and_unpins():
    ident = EkhoIdentity(
        seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB, OP2_KID: OP2_PUB}
    )
    served = [_signed_revocation(OP1_KID, OP1_PUB, OP2_SEED)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is True
    assert OP1_KID not in ident.pinned_operator_keys
    assert ident.pinned_operator_keys[OP2_KID] == OP2_PUB
    assert ident.revoked_operator_keys[OP1_KID] == REVOKED_AT  # the SIGNED time


def test_signed_revocation_accepts_a_key_revoking_itself():
    ident = EkhoIdentity(
        seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB, OP2_KID: OP2_PUB}
    )
    served = [_signed_revocation(OP1_KID, OP1_PUB, OP1_SEED)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is True
    assert OP1_KID not in ident.pinned_operator_keys


def test_signed_revocation_tombstones_a_key_never_pinned_here():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    served = [_signed_revocation(OP2_KID, OP2_PUB, OP1_SEED)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is True
    assert ident.revoked_operator_keys[OP2_KID] == REVOKED_AT
    # Idempotent: the same signed claim again is not a change.
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is False


def test_signed_revocation_of_the_last_pinned_key_is_refused():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    log = CaptureLog()
    served = [_signed_revocation(OP1_KID, OP1_PUB, OP1_SEED)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=log) is False
    assert ident.pinned_operator_keys[OP1_KID] == OP1_PUB  # still the trust root
    assert ident.revoked_operator_keys == {}  # not tombstoned, or it'd be pinned-but-dead
    assert OP1_KID in log.text()


def test_revoking_every_pinned_key_in_one_poll_still_leaves_one():
    ident = EkhoIdentity(
        seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB, OP2_KID: OP2_PUB}
    )
    served = [
        _signed_revocation(OP1_KID, OP1_PUB, OP2_SEED),
        _signed_revocation(OP2_KID, OP2_PUB, OP1_SEED),
    ]
    sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET)
    assert len(ident.pinned_operator_keys) == 1


def test_signed_revocation_cannot_be_relabelled_onto_another_key():
    ident = EkhoIdentity(
        seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB, OP2_KID: OP2_PUB}
    )
    # A genuine revocation of OP2, re-labelled by the relay as revoking OP1.
    served = [
        OperatorKeyEntry(
            key_id=OP1_KID,
            public_key=OP1_PUB,
            revoked=True,
            revoked_at=REVOKED_AT,
            revocation_sig=rev_sig(OP1_SEED, OP2_KID),
        )
    ]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is False
    assert ident.pinned_operator_keys[OP1_KID] == OP1_PUB


# --- #27: signed un-revoke, the escape hatch for a revocation issued in error ---
def _tombstoned():
    return EkhoIdentity(
        seed_hex="00" * 32,
        pinned_operator_keys={OP1_KID: OP1_PUB},
        revoked_operator_keys={OP2_KID: REVOKED_AT},
    )


def test_signed_unrevoke_clears_the_tombstone_without_re_pinning():
    ident = _tombstoned()
    served = [
        OperatorKeyEntry(key_id=OP2_KID, public_key=OP2_PUB, unrevoke_sig=unrev_sig(OP1_SEED, OP2_KID))
    ]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is True
    assert OP2_KID not in ident.revoked_operator_keys
    assert OP2_KID not in ident.pinned_operator_keys  # re-admission costs an endorsement


def test_signed_unrevoke_lets_the_chain_re_admit_the_key():
    ident = _tombstoned()
    esig = identity.sign_canonical(identity.endorsement_payload(FLEET, OP2_KID, OP2_PUB), OP1_SEED)
    served = [
        OperatorKeyEntry(
            key_id=OP2_KID,
            public_key=OP2_PUB,
            unrevoke_sig=unrev_sig(OP1_SEED, OP2_KID),
            endorsed_by_key_id=OP1_KID,
            endorsement_sig=esig,
        )
    ]
    sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET)
    assert ident.pinned_operator_keys[OP2_KID] == OP2_PUB


def test_unsigned_absence_of_revoked_never_clears_a_tombstone():
    # The #14 hole coming back: a relay that simply stops mentioning a dead key.
    ident = _tombstoned()
    served = [OperatorKeyEntry(key_id=OP2_KID, public_key=OP2_PUB)]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET) is False
    assert ident.revoked_operator_keys[OP2_KID] == REVOKED_AT


def test_unrevoke_signed_by_an_unpinned_key_is_refused():
    ident = _tombstoned()
    log = CaptureLog()
    served = [
        OperatorKeyEntry(
            key_id=OP2_KID, public_key=OP2_PUB, unrevoke_sig=unrev_sig(ROGUE_SEED, OP2_KID)
        )
    ]
    assert sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=log) is False
    assert ident.revoked_operator_keys[OP2_KID] == REVOKED_AT
    assert OP2_KID in log.text()


def test_revocation_beats_unrevoke_in_the_same_poll():
    ident = EkhoIdentity(
        seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB, OP2_KID: OP2_PUB}
    )
    served = [
        OperatorKeyEntry(
            key_id=OP2_KID,
            public_key=OP2_PUB,
            revoked=True,
            revoked_at=REVOKED_AT,
            revocation_sig=rev_sig(OP1_SEED, OP2_KID),
            unrevoke_sig=unrev_sig(OP1_SEED, OP2_KID),
        )
    ]
    sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET)
    assert ident.revoked_operator_keys[OP2_KID] == REVOKED_AT
    assert OP2_KID not in ident.pinned_operator_keys


# --- #26: persist the endorsement the gate already verified ---
def test_chain_admission_records_the_endorser_and_signature():
    ident = EkhoIdentity(seed_hex="00" * 32, pinned_operator_keys={OP1_KID: OP1_PUB})
    esig = identity.sign_canonical(identity.endorsement_payload(FLEET, OP2_KID, OP2_PUB), OP1_SEED)
    served = [
        OperatorKeyEntry(
            key_id=OP2_KID, public_key=OP2_PUB, endorsed_by_key_id=OP1_KID, endorsement_sig=esig
        )
    ]
    sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET)
    rec = ident.operator_key_admissions[OP2_KID]
    assert rec["admitted_by"] == "chain"
    assert rec["endorsed_by_key_id"] == OP1_KID
    assert rec["endorsement_sig"] == esig
    assert rec["admitted_at"]
    # The stored evidence is enough to re-verify offline, relay or no relay.
    assert (
        verify_canonical(
            identity.endorsement_payload(FLEET, OP2_KID, OP2_PUB), rec["endorsement_sig"], OP1_PUB
        )
        is True
    )


def test_tofu_admission_records_tofu_with_no_endorser():
    ident = EkhoIdentity(seed_hex="00" * 32)
    served = [OperatorKeyEntry(key_id=OP1_KID, public_key=OP1_PUB)]
    sync_pinned_operator_keys(ident, served, fleet_id=FLEET, log=QUIET)
    rec = ident.operator_key_admissions[OP1_KID]
    assert rec["admitted_by"] == "tofu"
    assert "endorsed_by_key_id" not in rec
    assert "endorsement_sig" not in rec


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


# --- #5: "require" closes the fail-open peer paths ---
def test_require_mode_unsigned_peer_does_not_wake():
    msg, _ = _peer(signed=False)
    # warn: legacy fail-open
    assert should_autowake(msg, None, operator_trusted=False, peer_enabled=True) is True
    assert (
        should_autowake(
            msg, None, operator_trusted=False, peer_enabled=True, require_signed="require"
        )
        is False
    )


def test_require_mode_signed_but_unverifiable_does_not_wake():
    msg, _ = _peer(signed=True)
    # warn: dormant crypto waves it through
    assert should_autowake(msg, None, operator_trusted=False, peer_enabled=True) is True
    assert (
        should_autowake(
            msg, None, operator_trusted=False, peer_enabled=True, require_signed="require"
        )
        is False
    )


def test_require_mode_signed_and_verified_peer_wakes():
    msg, v = _peer(verified=True)
    assert (
        should_autowake(
            msg, v, operator_trusted=False, peer_enabled=True, require_signed="require"
        )
        is True
    )


def test_require_mode_operator_relay_trust_fallback_preserved():
    msg, _ = _op(signed=False)
    assert (
        should_autowake(
            msg, None, operator_trusted=True, peer_enabled=False, require_signed="require"
        )
        is True
    )


def test_parse_require_signed_mode():
    from ekho_hermes.verification import parse_require_signed_mode

    assert parse_require_signed_mode(None) == "warn"
    assert parse_require_signed_mode("") == "warn"
    assert parse_require_signed_mode("nonsense") == "warn"
    assert parse_require_signed_mode(" REQUIRE ") == "require"
    assert parse_require_signed_mode("off") == "off"


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
        message_type="direct", priority="normal",
    )
    assert fields["key_id"] == identity.key_id(ident.public_key_b64url())
    assert fields["sig_canonical"]["sender_agent_id"] == "me"
    assert fields["sig_canonical"]["body_sha256"] == hashlib.sha256(b"hello").hexdigest()
    # A recipient can verify it against our public key.
    assert verify_canonical(
        fields["sig_canonical"], fields["agent_sig"], ident.public_key_b64url()
    ) is True


def test_v2_envelope_binds_type_priority_and_sorted_attachment_ids():
    # #9: the canonical binds what the relay could otherwise relabel/swap.
    ident = EkhoIdentity(seed_hex="0a" * 32)
    fields = build_signed_send_fields(
        identity_obj=ident, fleet_id="flt", self_agent_id="me",
        recipient={"kind": "agent", "id": "peer"}, conversation_id="c",
        body_text="hello", nonce="n2", sent_at="2026-06-07T00:00:00Z",
        message_type="direct", priority="high", attachments=["att_b", "att_a"],
    )
    canonical = fields["sig_canonical"]
    assert canonical["v"] == 2
    assert canonical["message_type"] == "direct"
    assert canonical["priority"] == "high"
    assert canonical["attachments"] == ["att_a", "att_b"]
    assert verify_canonical(
        canonical, fields["agent_sig"], ident.public_key_b64url()
    ) is True

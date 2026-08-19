"""Agent-side verification wiring for the Hermes plugin.

Bridges the SDK verifier (ekho.verify_inbound) to the autoreply loop:
  - sync_pinned_operator_keys: maintain the agent's trust root from the inbox,
    accepting endorsement-chained additions and dropping revoked keys, with a
    one-shot TOFU bootstrap for a never-pinned identity (#5, latched by tofu_at).
  - verify_batch: compute a per-message VerificationResult (or None if the agent
    has no trust root yet — verification simply can't run).
  - should_autowake: the GRACEFUL execution-authority gate. Until the operator
    sets up signing, behavior is unchanged (relay-attested). Once a message is
    signed, the agent acts on it only if it verifies; an invalid signature is
    treated as impersonation and blocked.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from typing import Any, Dict, Optional, Sequence, Set

from ekho import identity as _identity
from ekho import verify_inbound
from ekho.verify import VerificationResult

from .messages import iso_now

# Default sink for the sync's trust-root notes. A relay claiming a revocation it
# cannot prove must never pass in silence, so callers that don't inject a logger
# still get the warning (#27).
logger = logging.getLogger(__name__)


def build_signed_send_fields(
    *,
    identity_obj: Any,
    fleet_id: str,
    self_agent_id: str,
    recipient: Dict[str, Any],
    conversation_id: str,
    body_text: str,
    nonce: str,
    sent_at: str,
    message_type: str,
    priority: str,
    attachments: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Sign an outbound peer message so recipients can verify it came from us.
    Returns {agent_sig, key_id, sig_canonical} to merge into the send payload.

    v2 (#9) extends coverage to message_type, priority and the attachment ids —
    previously a compromised relay could relabel a message (direct → alert) or
    swap its attachments under a still-valid signature. Compatibility is free in
    both directions: verifiers check the signature over the WHOLE canonical and
    only bind the fields they know, so old verifiers accept v2 envelopes and new
    verifiers enforce the extra bindings only when the envelope declares v>=2."""
    public_key = identity_obj.public_key_b64url()
    kid = _identity.key_id(public_key)
    canonical = {
        "v": 2,
        "fleet_id": fleet_id,
        "sender_agent_id": self_agent_id,
        "key_id": kid,
        "recipient": recipient,
        "conversation_id": conversation_id,
        "body_sha256": hashlib.sha256(body_text.encode("utf-8")).hexdigest(),
        "sent_at": sent_at,
        "nonce": nonce,
        "message_type": message_type,
        "priority": priority,
        "attachments": sorted(str(a) for a in (attachments or [])),
    }
    sig = _identity.sign_canonical(canonical, bytes.fromhex(identity_obj.seed_hex))
    return {"agent_sig": sig, "key_id": kid, "sig_canonical": canonical}


def _note_advisory_claim(log: Any, out: Dict[str, Any], key_id: str) -> None:
    """The relay says a key is dead but cannot prove it. Skip the key for NEW
    adoption, write nothing, say so out loud.

    Deleting the pin here is the tempting one-liner and it is wrong twice over:
    it lets whoever controls the relay drop trust unilaterally, AND a deleted pin
    is re-admitted on the very next poll by the same still-valid endorsement.
    Rejecting a key takes a revoked_operator_keys tombstone, not a deletion — and
    a tombstone takes a signature.
    """
    out["advisory"].add(key_id)
    log.warning(
        "[ekho] relay reports operator key %s as REVOKED without a valid revocation "
        "signature. Treating the claim as ADVISORY: the key is NOT unpinned and NOT "
        "tombstoned, but it will not be newly adopted until a signed revocation arrives.",
        key_id,
    )


def _note_last_root_refusal(log: Any, key_id: str) -> None:
    """Last-root protection: honoring this leaves the box with no trust root at
    all, which looks exactly like the failure mode the signature requirement is
    here to prevent. Refuse the claim whole, so we never hold a key that is
    tombstoned (permanent) and still pinned (still trusted).
    """
    log.warning(
        "[ekho] refusing the signed revocation of operator key %s: it is the LAST "
        "pinned operator key, and honoring it would leave this agent with no trust "
        "root at all. Endorse a replacement key first.",
        key_id,
    )


def _honor_revocation(
    *,
    log: Any,
    pinned: Dict[str, str],
    revoked_ledger: Dict[str, str],
    admissions: Dict[str, Dict[str, Any]],
    key_id: str,
    revoked_at: str,
    out: Dict[str, Any],
) -> None:
    """Tombstone the key, then unpin it.

    #14: the tombstone is the durable half. Unpinning alone never made a
    revocation stick — the config seed re-added the key on the very next wake,
    and TOFU/chaining would too.
    """
    if key_id not in revoked_ledger:
        revoked_ledger[key_id] = revoked_at
        out["ledger_changed"] = True
    if key_id in pinned:
        pinned.pop(key_id)
        out["pin_removed"] = True
        log.warning(
            "[ekho] operator key %s is revoked (signed, at %s); it is no longer pinned.",
            key_id,
            revoked_at,
        )
    if key_id in admissions:
        # The admission record answers "why is this key trusted here?" — keep it
        # only while the answer is "it is".
        admissions.pop(key_id)
        out["admissions_changed"] = True


def _apply_signed_revocations(
    operator_keys: Sequence[Any],
    *,
    fleet_id: Optional[str],
    log: Any,
    pinned: Dict[str, str],
    revoked_ledger: Dict[str, str],
    admissions: Dict[str, Dict[str, Any]],
    signed_by_a_pinned_key: Any,
    out: Dict[str, Any],
) -> None:
    """A SIGNED revocation is the only thing that can remove trust. Anything less
    is recorded as advisory: the key is skipped for new adoption, nothing else.
    """
    for k in operator_keys:
        key_id = getattr(k, "key_id", None)
        if not key_id or not getattr(k, "revoked", False):
            continue
        at = getattr(k, "revoked_at", None)
        sig = getattr(k, "revocation_sig", None)
        proven = bool(
            sig
            and at
            and fleet_id
            and signed_by_a_pinned_key(_identity.revocation_payload(fleet_id, key_id, at), sig)
        )
        if not proven:
            _note_advisory_claim(log, out, key_id)
        elif key_id in pinned and len(pinned) == 1:
            _note_last_root_refusal(log, key_id)
        else:
            _honor_revocation(
                log=log,
                pinned=pinned,
                revoked_ledger=revoked_ledger,
                admissions=admissions,
                key_id=key_id,
                revoked_at=at,
                out=out,
            )


def _clear_tombstones_on_signed_unrevoke(
    operator_keys: Sequence[Any],
    *,
    fleet_id: Optional[str],
    log: Any,
    revoked_ledger: Dict[str, str],
    signed_by_a_pinned_key: Any,
    out: Dict[str, Any],
) -> None:
    """A SIGNED un-revoke clears a tombstone so the key can be re-admitted through
    the endorsement chain. It never re-pins by itself — re-admission still costs a
    valid endorsement. Runs before the revocation pass so a valid revocation in
    the same batch still wins (fail closed).

    The unsigned ABSENCE of ``revoked`` must never clear a tombstone: that was the
    #14 hole, where a relay could resurrect a dead key just by not mentioning it.

    #48: the payload now binds revoked_at_being_cleared + issued_at + nonce.
    Missing bind fields refuse the un-revoke (fail closed). The relay still
    does not emit unrevoke_sig.
    """
    for k in operator_keys:
        key_id = getattr(k, "key_id", None)
        sig = getattr(k, "unrevoke_sig", None)
        revoked_at = getattr(k, "unrevoke_revoked_at", None) or (
            k.get("unrevoke_revoked_at") if isinstance(k, dict) else None
        )
        issued_at = getattr(k, "unrevoke_issued_at", None) or (
            k.get("unrevoke_issued_at") if isinstance(k, dict) else None
        )
        nonce = getattr(k, "unrevoke_nonce", None) or (
            k.get("unrevoke_nonce") if isinstance(k, dict) else None
        )
        if not key_id or not sig or key_id not in revoked_ledger:
            continue
        if not revoked_at or not issued_at or not nonce:
            log.warning(
                "[ekho] refusing un-revoke of operator key %s: payload bind "
                "fields missing. The tombstone stands.",
                key_id,
            )
            continue
        if not fleet_id or not signed_by_a_pinned_key(
            _identity.unrevoke_payload(fleet_id, key_id, revoked_at, issued_at, nonce), sig
        ):
            log.warning(
                "[ekho] refusing un-revoke of operator key %s: no currently pinned "
                "operator key signed it. The tombstone stands.",
                key_id,
            )
            continue
        # #52: the compare half of the compare-and-swap. Signing over
        # revoked_at_being_cleared is only worth anything if apply-time checks it
        # against the tombstone actually standing right now — otherwise a valid
        # un-revoke captured for an OLD revocation clears whatever NEWER one has
        # replaced it.
        if revoked_at != revoked_ledger[key_id]:
            log.warning(
                "[ekho] refusing un-revoke of operator key %s: it is bound to a revocation "
                "at %s, but the live tombstone is at %s — a newer revocation this un-revoke "
                "never authorized. The tombstone stands.",
                key_id,
                revoked_at,
                revoked_ledger[key_id],
            )
            continue
        del revoked_ledger[key_id]
        out["ledger_changed"] = True
        log.info(
            "[ekho] operator key %s un-revoked by a signed operator instruction; tombstone "
            "cleared. The key is NOT re-pinned — it has to be re-endorsed by a pinned key.",
            key_id,
        )


def _apply_relay_key_claims(
    operator_keys: Sequence[Any],
    *,
    fleet_id: Optional[str],
    log: Any,
    pinned: Dict[str, str],
    revoked_ledger: Dict[str, str],
    admissions: Dict[str, Dict[str, Any]],
    signed_by_a_pinned_key: Any,
) -> Dict[str, Any]:
    """Apply the relay's revocation / un-revocation claims to the working trust
    root (#27). Mutates ``pinned``, ``revoked_ledger`` and ``admissions`` in
    place; a claim only lands if a currently pinned operator key signed it.

    Returns what it touched, plus ``advisory``: the key ids the relay CLAIMS are
    revoked without proving it. Those are blocked from new adoption this poll and
    nothing about them is written to disk.
    """
    out: Dict[str, Any] = {
        "advisory": set(),
        "pin_removed": False,
        "ledger_changed": False,
        "admissions_changed": False,
    }
    _clear_tombstones_on_signed_unrevoke(
        operator_keys,
        fleet_id=fleet_id,
        log=log,
        revoked_ledger=revoked_ledger,
        signed_by_a_pinned_key=signed_by_a_pinned_key,
        out=out,
    )
    _apply_signed_revocations(
        operator_keys,
        fleet_id=fleet_id,
        log=log,
        pinned=pinned,
        revoked_ledger=revoked_ledger,
        admissions=admissions,
        signed_by_a_pinned_key=signed_by_a_pinned_key,
        out=out,
    )
    return out


def sync_pinned_operator_keys(
    identity_obj: Any,
    operator_keys: Sequence[Any],
    *,
    fleet_id: Optional[str],
    log: Any = None,
) -> bool:
    """Update pinned operator keys from the inbox. Returns True if anything changed.

    Adds a new key ONLY if it is endorsed by an already-pinned key (the
    endorsement chain). Removes one ONLY on a SIGNED revocation.

    Trust mutates in one direction only, and never on the relay's say-so (#27).
    An unsigned ``revoked: True`` is a HINT: the key is skipped for new adoption
    and the claim is logged, but nothing is written and nothing is unpinned.
    Treating it as authoritative (the #14 regression) meant one poll from a
    compromised relay could tombstone and unpin an entire fleet's trust root,
    permanently — the tombstone survives restarts by design, so the damage was
    not even recoverable by restarting against an honest relay.

    One deliberate exception to "no relay TOFU" (#5): an identity that has never
    pinned ANY key can't grow a chain — endorsements need an already-pinned root,
    so verification stayed dormant forever on every agent nobody hand-configured
    (the Aug 2026 silent-drop incident). First contact with an empty pin set
    adopts the relay's current non-revoked keys as the trust root, exactly once
    (tofu_at latches). Enrollment already trusts the relay this much — it accepts
    the shared secret over the same channel. Pre-pinning via config/env skips
    TOFU entirely and stays the stronger option.
    """
    log = log or logger
    pinned: Dict[str, str] = dict(identity_obj.pinned_operator_keys)
    revoked_ledger: Dict[str, str] = dict(getattr(identity_obj, "revoked_operator_keys", None) or {})
    admissions: Dict[str, Dict[str, Any]] = dict(
        getattr(identity_obj, "operator_key_admissions", None) or {}
    )

    # The keys allowed to authorize a trust-root mutation this poll, snapshotted
    # BEFORE any of them are applied. Frozen on purpose: verifying against the
    # live map would make the outcome depend on the order the relay happened to
    # serve its entries in, which is the relay's choice, not ours.
    authorities = dict(identity_obj.pinned_operator_keys)

    def signed_by_a_pinned_key(payload: Any, sig: str) -> bool:
        return any(_identity.verify_canonical(payload, sig, pub) for pub in authorities.values())

    claims = _apply_relay_key_claims(
        operator_keys,
        fleet_id=fleet_id,
        log=log,
        pinned=pinned,
        revoked_ledger=revoked_ledger,
        admissions=admissions,
        signed_by_a_pinned_key=signed_by_a_pinned_key,
    )
    advisory = claims["advisory"]
    changed = claims["pin_removed"]
    admissions_changed = claims["admissions_changed"]
    if claims["ledger_changed"]:
        identity_obj.revoked_operator_keys = revoked_ledger
        changed = True  # must persist, even when the key was never pinned here

    if not pinned and not getattr(identity_obj, "tofu_at", None):
        adopted = False
        at = iso_now()
        for k in operator_keys:
            key_id = getattr(k, "key_id", None)
            public_key = getattr(k, "public_key", None)
            if key_id and public_key and key_id not in advisory and key_id not in revoked_ledger:
                pinned[key_id] = public_key
                admissions[key_id] = {"admitted_by": "tofu", "admitted_at": at}  # #26
                admissions_changed = True
                adopted = True
        if adopted:
            # Latch only when something was adopted — an empty roster now must
            # not burn the one TOFU opportunity of a fresh identity. (Tracked
            # separately from `changed`, which a tombstone alone can now set.)
            identity_obj.tofu_at = at
            identity_obj.pinned_operator_keys = pinned
            identity_obj.operator_key_admissions = admissions
            return True
    for k in operator_keys:
        key_id = getattr(k, "key_id", None)
        if not key_id:
            continue
        if key_id in pinned:
            continue
        if key_id in revoked_ledger:
            continue  # #14: a tombstoned key never comes back
        if key_id in advisory:
            continue  # #27: claimed-revoked → no NEW adoption
        endorser = getattr(k, "endorsed_by_key_id", None)
        esig = getattr(k, "endorsement_sig", None)
        public_key = getattr(k, "public_key", None)
        if endorser and esig and public_key and fleet_id and endorser in pinned:
            payload = _identity.endorsement_payload(fleet_id, key_id, public_key)
            if _identity.verify_canonical(payload, esig, pinned[endorser]):
                pinned[key_id] = public_key
                changed = True
                # #26: keep the endorsement we just verified, so this box can
                # answer "why is this key trusted here?" offline — the relay is
                # exactly the party we would otherwise have to ask.
                admissions[key_id] = {
                    "admitted_by": "chain",
                    "endorsed_by_key_id": endorser,
                    "endorsement_sig": esig,
                    "admitted_at": iso_now(),
                }
                admissions_changed = True
    if changed:
        identity_obj.pinned_operator_keys = pinned
    if admissions_changed:
        identity_obj.operator_key_admissions = admissions
        changed = True
    return changed


def verify_batch(
    messages: Sequence[Any],
    *,
    identity_obj: Any,
    self_agent_id: str,
    fleet_id: Optional[str],
    roster: Sequence[Any],
    seen_nonces: Set[str],
    now: datetime,
) -> Dict[str, Optional[VerificationResult]]:
    """Verdict per message_id, or None when the agent has no trust root / fleet."""
    operator_keys = dict(getattr(identity_obj, "pinned_operator_keys", {}) or {})
    if not operator_keys or not fleet_id:
        return {getattr(m, "message_id", None): None for m in messages}
    roster_by_agent = {getattr(r, "agent_id", None): r for r in roster}
    out: Dict[str, Optional[VerificationResult]] = {}
    for m in messages:
        out[getattr(m, "message_id", None)] = verify_inbound(
            m,
            self_agent_id=self_agent_id,
            fleet_id=fleet_id,
            operator_keys=operator_keys,
            roster_by_agent=roster_by_agent,
            seen_nonces=seen_nonces,
            now=now,
        )
    return out


# How strictly peer messages must prove themselves before waking a turn (#5).
#  - "warn" (default): unsigned/unverifiable peers still wake, but are rendered
#    untrusted — the graceful relay-attested fallback, named for what it is.
#  - "require": a peer message wakes ONLY when signed and verified; anything
#    else is dead-lettered by the tick. Operator messages keep the explicit
#    relay-attested operator_trusted toggle as their unsigned fallback — that
#    flag is operator-set, not relay-implied, so "require" doesn't cut the
#    operator off on consoles that don't sign yet.
#  - "off": same wake behavior as "warn" (kept distinct for config clarity).
REQUIRE_SIGNED_MODES = ("off", "warn", "require")


def parse_require_signed_mode(raw: Optional[str]) -> str:
    """Normalize a raw config/env value to one of REQUIRE_SIGNED_MODES."""
    v = str(raw if raw is not None else "").strip().lower()
    return v if v in ("require", "off") else "warn"


def should_autowake(
    msg: Any,
    verification: Optional[VerificationResult],
    *,
    operator_trusted: bool,
    peer_enabled: bool,
    require_signed: str = "warn",
) -> bool:
    """The execution-authority gate. Signed → act iff verified; signed-but-invalid
    → blocked; unsigned → per ``require_signed`` mode (see above)."""
    is_operator = getattr(msg, "sender_kind", None) == "operator"
    signed = bool(getattr(msg, "operator_sig", None) if is_operator else getattr(msg, "agent_sig", None))

    if is_operator:
        if signed and verification is not None:
            # Signed: act iff cryptographically verified (invalid → impersonation).
            return bool(verification.verified)
        # Unsigned / no trust root yet → relay-attested fallback (unchanged).
        return bool(operator_trusted)

    # Peer (bounded delegation gates first).
    if not peer_enabled:
        return False
    if require_signed == "require":
        # Fail closed: signed AND verified, nothing less. A None verification
        # (no pinned keys yet) is exactly the dormant state this mode refuses
        # to treat as trustworthy.
        return bool(signed and verification is not None and verification.verified)
    if signed and verification is not None:
        return bool(verification.verified)
    return True

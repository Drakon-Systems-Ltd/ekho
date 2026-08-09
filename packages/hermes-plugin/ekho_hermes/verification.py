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
from datetime import datetime
from typing import Any, Dict, Optional, Sequence, Set

from ekho import identity as _identity
from ekho import verify_inbound
from ekho.verify import VerificationResult

from .messages import iso_now


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


def sync_pinned_operator_keys(identity_obj: Any, operator_keys: Sequence[Any], *, fleet_id: Optional[str]) -> bool:
    """Update pinned operator keys from the inbox. Returns True if anything changed.

    Drops revoked keys. Adds a new key ONLY if it is endorsed by an already-pinned
    key (the endorsement chain).

    One deliberate exception to "no relay TOFU" (#5): an identity that has never
    pinned ANY key can't grow a chain — endorsements need an already-pinned root,
    so verification stayed dormant forever on every agent nobody hand-configured
    (the Aug 2026 silent-drop incident). First contact with an empty pin set
    adopts the relay's current non-revoked keys as the trust root, exactly once
    (tofu_at latches). Enrollment already trusts the relay this much — it accepts
    the shared secret over the same channel. Pre-pinning via config/env skips
    TOFU entirely and stays the stronger option.
    """
    pinned: Dict[str, str] = dict(identity_obj.pinned_operator_keys)
    changed = False
    if not pinned and not getattr(identity_obj, "tofu_at", None):
        for k in operator_keys:
            key_id = getattr(k, "key_id", None)
            public_key = getattr(k, "public_key", None)
            if key_id and public_key and not getattr(k, "revoked", False):
                pinned[key_id] = public_key
                changed = True
        if changed:
            # Latch only when something was adopted — an empty roster now must
            # not burn the one TOFU opportunity of a fresh identity.
            identity_obj.tofu_at = iso_now()
            identity_obj.pinned_operator_keys = pinned
            return True
    for k in operator_keys:
        key_id = getattr(k, "key_id", None)
        if not key_id:
            continue
        if getattr(k, "revoked", False):
            if key_id in pinned:
                del pinned[key_id]
                changed = True
            continue
        if key_id in pinned:
            continue
        endorser = getattr(k, "endorsed_by_key_id", None)
        esig = getattr(k, "endorsement_sig", None)
        public_key = getattr(k, "public_key", None)
        if endorser and esig and public_key and fleet_id and endorser in pinned:
            payload = _identity.endorsement_payload(fleet_id, key_id, public_key)
            if _identity.verify_canonical(payload, esig, pinned[endorser]):
                pinned[key_id] = public_key
                changed = True
    if changed:
        identity_obj.pinned_operator_keys = pinned
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

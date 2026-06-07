"""Agent-side verification wiring for the Hermes plugin.

Bridges the SDK verifier (ekho.verify_inbound) to the autoreply loop:
  - sync_pinned_operator_keys: maintain the agent's trust root from the inbox,
    accepting only endorsement-chained additions (never relay TOFU) and dropping
    revoked keys.
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
) -> Dict[str, Any]:
    """Sign an outbound peer message so recipients can verify it came from us.
    Returns {agent_sig, key_id, sig_canonical} to merge into the send payload."""
    public_key = identity_obj.public_key_b64url()
    kid = _identity.key_id(public_key)
    canonical = {
        "v": 1,
        "fleet_id": fleet_id,
        "sender_agent_id": self_agent_id,
        "key_id": kid,
        "recipient": recipient,
        "conversation_id": conversation_id,
        "body_sha256": hashlib.sha256(body_text.encode("utf-8")).hexdigest(),
        "sent_at": sent_at,
        "nonce": nonce,
    }
    sig = _identity.sign_canonical(canonical, bytes.fromhex(identity_obj.seed_hex))
    return {"agent_sig": sig, "key_id": kid, "sig_canonical": canonical}


def sync_pinned_operator_keys(identity_obj: Any, operator_keys: Sequence[Any], *, fleet_id: Optional[str]) -> bool:
    """Update pinned operator keys from the inbox. Returns True if anything changed.

    Drops revoked keys. Adds a new key ONLY if it is endorsed by an already-pinned
    key (the endorsement chain) — a relay cannot inject a rogue operator key. The
    first key is bootstrapped at enrollment, not here.
    """
    pinned: Dict[str, str] = dict(identity_obj.pinned_operator_keys)
    changed = False
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


def should_autowake(
    msg: Any,
    verification: Optional[VerificationResult],
    *,
    operator_trusted: bool,
    peer_enabled: bool,
) -> bool:
    """The execution-authority gate (graceful — see module docstring)."""
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
    if signed and verification is not None:
        return bool(verification.verified)
    return True

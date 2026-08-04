"""Inbound message verification — the agent independently decides whether to trust
a message, rather than trusting the relay's attribution.

Operator messages verify against a pinned operator key. Peer messages verify
against the sender's identity key AND that key's operator endorsement (rooted at a
pinned operator key) — so a peer is trusted because it chains back to the operator,
not because the relay said so.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import AbstractSet, Any, Mapping, Optional

from .identity import agent_key_endorsement_payload, verify_canonical
from .types import InboxMessage, RosterEntry


@dataclass
class VerificationResult:
    verified: bool
    kind: str  # "operator" | "peer"
    reason: Optional[str] = None
    key_id: Optional[str] = None


def _parse_iso(value: Any) -> datetime:
    s = str(value).replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# The past-window must cover the relay's max message TTL (86400s) plus delivery
# slack: the relay legitimately holds a message for its whole TTL while the
# recipient is down (gateway restart, sleeping laptop), and 300s of "staleness"
# was silently discarding every signed peer message delivered 5-15+ min late —
# acked but never waking the recipient. Replay is defended by the nonce burn
# (below) and the relay's own server-side replay_nonces, not by this window.
# The future-window stays tight: a sent_at ahead of our clock is only ever
# clock skew, never queueing delay.
MAX_PAST_SKEW_SECONDS = 86400 + 300
MAX_FUTURE_SKEW_SECONDS = 300


def verify_inbound(
    msg: InboxMessage,
    *,
    self_agent_id: str,
    fleet_id: str,
    operator_keys: Mapping[str, str],
    roster_by_agent: Mapping[str, RosterEntry],
    seen_nonces: AbstractSet[str],
    now: datetime,
    max_skew_seconds: int = MAX_PAST_SKEW_SECONDS,
    max_future_skew_seconds: int = MAX_FUTURE_SKEW_SECONDS,
) -> VerificationResult:
    is_operator = msg.sender_kind == "operator"
    kind = "operator" if is_operator else "peer"
    canonical = msg.sig_canonical
    sig = msg.operator_sig if is_operator else msg.agent_sig

    if not sig or not canonical or not msg.key_id:
        return VerificationResult(False, kind, "unsigned", msg.key_id)

    # 1. Resolve the signer's public key (and, for peers, verify it's operator-rooted).
    if is_operator:
        signer_pub = operator_keys.get(msg.key_id)
        if not signer_pub:
            return VerificationResult(False, kind, "unknown-operator-key", msg.key_id)
    else:
        entry = roster_by_agent.get(msg.sender_agent_id)
        if not entry or not entry.identity_public_key or entry.key_id != msg.key_id:
            return VerificationResult(False, kind, "unknown-sender-key", msg.key_id)
        if not entry.endorsed_by_key_id or not entry.endorsement_sig:
            return VerificationResult(False, kind, "sender-key-unendorsed", msg.key_id)
        endorser_pub = operator_keys.get(entry.endorsed_by_key_id)
        if not endorser_pub:
            return VerificationResult(False, kind, "endorser-not-pinned", msg.key_id)
        endorsement = agent_key_endorsement_payload(
            fleet_id, msg.sender_agent_id, entry.key_id, entry.identity_public_key
        )
        if not verify_canonical(endorsement, entry.endorsement_sig, endorser_pub):
            return VerificationResult(False, kind, "bad-endorsement", msg.key_id)
        signer_pub = entry.identity_public_key

    # 2. The signature itself must verify over the canonical payload.
    if not verify_canonical(canonical, sig, signer_pub):
        return VerificationResult(False, kind, "bad-signature", msg.key_id)

    # 3-7. The signed payload must bind to THIS message.
    if canonical.get("key_id") != msg.key_id:
        return VerificationResult(False, kind, "key-id-mismatch", msg.key_id)
    if canonical.get("fleet_id") != fleet_id:
        return VerificationResult(False, kind, "fleet-mismatch", msg.key_id)
    if not is_operator and canonical.get("sender_agent_id") != msg.sender_agent_id:
        return VerificationResult(False, kind, "sender-mismatch", msg.key_id)

    recipient = canonical.get("recipient") or {}
    if recipient.get("kind") == "agent" and recipient.get("id") != self_agent_id:
        return VerificationResult(False, kind, "recipient-mismatch", msg.key_id)

    text = msg.body.get("text") if isinstance(msg.body, dict) else None
    if canonical.get("body_sha256") != hashlib.sha256((text or "").encode("utf-8")).hexdigest():
        return VerificationResult(False, kind, "body-mismatch", msg.key_id)

    try:
        sent = _parse_iso(canonical.get("sent_at"))
    except Exception:
        return VerificationResult(False, kind, "bad-timestamp", msg.key_id)
    age = (now - sent).total_seconds()
    if age > max_skew_seconds or -age > max_future_skew_seconds:
        return VerificationResult(False, kind, "stale", msg.key_id)

    nonce = canonical.get("nonce")
    if not nonce or nonce in seen_nonces:
        return VerificationResult(False, kind, "replay", msg.key_id)

    return VerificationResult(True, kind, None, msg.key_id)

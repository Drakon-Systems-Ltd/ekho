"""Verifiable identity core (operator + agent) — pure crypto, no I/O.

The canonical serialization here MUST match the TS relay/console and the OpenClaw
plugin byte-for-byte; the frozen interop vector
(packages/relay/tests/fixtures/operator-identity-vector.json) pins that contract.

An operator signs each operator->agent message with a portable Ed25519 key; agents
pin the operator's public key at enrollment and verify signatures themselves. Agents
also hold their own identity key (peer trust), operator-endorsed, so peers can verify
each other without trusting the relay.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def canonicalize(value: Any) -> str:
    """Deterministic JSON: keys sorted, no insignificant whitespace, UTF-8.

    This is the exact byte sequence that gets signed and verified everywhere.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def key_id(public_key_b64url: str) -> str:
    """base64url(sha256(pub))[:16] — stable short id for a public key."""
    return _b64url_encode(hashlib.sha256(_b64url_decode(public_key_b64url)).digest())[:16]


def public_key_b64url_from_seed(secret_seed: bytes) -> str:
    """Derive the base64url public key from a 32-byte Ed25519 seed."""
    raw = (
        Ed25519PrivateKey.from_private_bytes(secret_seed)
        .public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    )
    return _b64url_encode(raw)


def sign_canonical(payload: Any, secret_seed: bytes) -> str:
    """Sign the canonical form of `payload` with a 32-byte Ed25519 seed."""
    sig = Ed25519PrivateKey.from_private_bytes(secret_seed).sign(
        canonicalize(payload).encode("utf-8")
    )
    return _b64url_encode(sig)


def verify_canonical(payload: Any, sig_b64url: str, public_key_b64url: str) -> bool:
    """Verify `sig` over the canonical form of `payload`. Never raises."""
    try:
        Ed25519PublicKey.from_public_bytes(_b64url_decode(public_key_b64url)).verify(
            _b64url_decode(sig_b64url), canonicalize(payload).encode("utf-8")
        )
        return True
    except Exception:
        return False


def endorsement_payload(fleet_id: str, new_key_id: str, new_public_key_b64url: str) -> dict:
    """Structure an existing operator key signs to endorse a NEW operator key."""
    return {
        "v": 1,
        "t": "op-key-endorsement",
        "fleet_id": fleet_id,
        "key_id": new_key_id,
        "public_key": new_public_key_b64url,
    }


def revocation_payload(fleet_id: str, revoked_key_id: str, revoked_at: str) -> dict:
    """Structure an operator key signs to REVOKE an operator key (#27).

    Revocation mutates the trust root exactly as adoption does, so it needs the
    same proof: an unsigned relay ``revoked: true`` flag is advisory only.
    ``revoked_at`` is inside the signed bytes so the relay cannot restate WHEN a
    key died under a still-valid signature.
    """
    return {
        "v": 1,
        "t": "op-key-revocation",
        "fleet_id": fleet_id,
        "key_id": revoked_key_id,
        "revoked_at": revoked_at,
    }


def unrevoke_payload(
    fleet_id: str,
    revoked_key_id: str,
    revoked_at_being_cleared: str,
    issued_at: str,
    nonce: str,
) -> dict:
    """Structure an operator key signs to UN-REVOKE a key (#27 / #48).

    Compare-and-swap: binds the exact revocation being undone, issue time, and
    a nonce. A captured un-revoke for key X cannot clear a later tombstone for X.
    Never re-pins on its own — re-admission still costs an endorsement.
    """
    if not nonce:
        raise ValueError("unrevoke nonce must be a non-empty string")
    return {
        "v": 1,
        "t": "op-key-unrevoke",
        "fleet_id": fleet_id,
        "key_id": revoked_key_id,
        "revoked_at_being_cleared": revoked_at_being_cleared,
        "issued_at": issued_at,
        "nonce": nonce,
    }


def agent_key_endorsement_payload(
    fleet_id: str, agent_id: str, agent_key_id: str, agent_public_key_b64url: str
) -> dict:
    """Structure the operator signs to endorse an AGENT's identity key (peer trust)."""
    return {
        "v": 1,
        "t": "agent-key-endorsement",
        "fleet_id": fleet_id,
        "agent_id": agent_id,
        "key_id": agent_key_id,
        "public_key": agent_public_key_b64url,
    }

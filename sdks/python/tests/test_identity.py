"""Cross-language interop: the Python identity core must satisfy the SAME frozen
vector the TS relay produced, proving canonicalization agrees byte-for-byte."""

import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ekho.identity import (
    canonicalize,
    sign_canonical,
    verify_canonical,
    key_id,
    endorsement_payload,
    agent_key_endorsement_payload,
)

# One source of truth for the vector: the relay's fixture (monorepo path).
_VECTOR_PATH = (
    Path(__file__).resolve().parents[3]
    / "packages/relay/tests/fixtures/operator-identity-vector.json"
)
VECTOR = json.loads(_VECTOR_PATH.read_text())


def _pub_b64_from_seed(seed: bytes) -> str:
    raw = (
        Ed25519PrivateKey.from_private_bytes(seed)
        .public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def test_canonical_matches_frozen_vector():
    assert canonicalize(VECTOR["payload"]) == VECTOR["canonical"]


def test_verifies_frozen_signature():
    assert (
        verify_canonical(
            VECTOR["payload"], VECTOR["signature_b64url"], VECTOR["public_key_b64url"]
        )
        is True
    )


def test_rejects_tampered_payload():
    bad = dict(VECTOR["payload"])
    bad["conversation_id"] = "conv_evil"
    assert (
        verify_canonical(bad, VECTOR["signature_b64url"], VECTOR["public_key_b64url"])
        is False
    )


def test_rejects_malformed_signature_without_raising():
    assert verify_canonical(VECTOR["payload"], "@@notb64@@", VECTOR["public_key_b64url"]) is False


def test_sign_round_trip():
    seed = bytes.fromhex(VECTOR["seed_hex"])
    payload = {"v": 1, "fleet_id": "flt_x", "nonce": "AAA"}
    sig = sign_canonical(payload, seed)
    assert verify_canonical(payload, sig, _pub_b64_from_seed(seed)) is True


def test_key_id_matches_vector():
    assert key_id(VECTOR["public_key_b64url"]) == VECTOR["key_id"]
    assert len(key_id(VECTOR["public_key_b64url"])) == 16


def test_endorsement_payloads_match_ts_shape():
    assert canonicalize(endorsement_payload("flt_x", "kid", "pub")) == canonicalize(
        {"v": 1, "t": "op-key-endorsement", "fleet_id": "flt_x", "key_id": "kid", "public_key": "pub"}
    )
    assert canonicalize(
        agent_key_endorsement_payload("flt_x", "a1", "kid", "pub")
    ) == canonicalize(
        {
            "v": 1,
            "t": "agent-key-endorsement",
            "fleet_id": "flt_x",
            "agent_id": "a1",
            "key_id": "kid",
            "public_key": "pub",
        }
    )

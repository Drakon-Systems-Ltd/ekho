"""The agent persists its own Ed25519 identity seed + the operator keys it pins."""

from ekho_hermes.credentials import load_or_create_identity, save_identity


def test_creates_and_persists_a_stable_identity(tmp_path):
    a = load_or_create_identity(str(tmp_path))
    assert a.seed_hex and len(bytes.fromhex(a.seed_hex)) == 32
    # A second load returns the SAME key — the agent identity is durable.
    b = load_or_create_identity(str(tmp_path))
    assert b.seed_hex == a.seed_hex
    assert a.public_key_b64url() == b.public_key_b64url()


def test_pins_operator_keys_round_trip(tmp_path):
    a = load_or_create_identity(str(tmp_path))
    a.pinned_operator_keys["k1"] = "pub1"
    a.pinned_operator_keys["k2"] = "pub2"
    save_identity(str(tmp_path), a)
    b = load_or_create_identity(str(tmp_path))
    assert b.pinned_operator_keys == {"k1": "pub1", "k2": "pub2"}


def test_public_key_matches_sdk_derivation(tmp_path):
    from ekho import public_key_b64url_from_seed

    a = load_or_create_identity(str(tmp_path))
    assert a.public_key_b64url() == public_key_b64url_from_seed(bytes.fromhex(a.seed_hex))

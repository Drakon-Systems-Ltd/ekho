"""On connect the agent registers its identity key and bootstrap-pins the
operator key(s) from config (the trusted channel for pre-signing agents)."""

from ekho import identity
from ekho_hermes.connection import register_and_bootstrap_identity

OP_SEED = bytes(range(5, 37))
OP_PUB = identity.public_key_b64url_from_seed(OP_SEED)
OP_KID = identity.key_id(OP_PUB)


class _FakeClient:
    def __init__(self):
        self.registered = None

    def register_identity_key(self, public_key):
        self.registered = public_key
        return {"key_id": identity.key_id(public_key)}


def test_registers_own_key_and_pins_operator_key(tmp_path):
    fc = _FakeClient()
    ident = register_and_bootstrap_identity(
        fc, operator_pubkey=OP_PUB, config_dir=str(tmp_path)
    )
    # Registered its own identity key with the relay...
    assert fc.registered == ident.public_key_b64url()
    # ...and pinned the operator key as its trust root.
    assert ident.pinned_operator_keys[OP_KID] == OP_PUB


def test_accepts_key_id_prefixed_form(tmp_path):
    fc = _FakeClient()
    ident = register_and_bootstrap_identity(
        fc, operator_pubkey=f"{OP_KID}:{OP_PUB}", config_dir=str(tmp_path)
    )
    assert ident.pinned_operator_keys[OP_KID] == OP_PUB


def test_no_operator_pubkey_still_registers_own_key(tmp_path):
    fc = _FakeClient()
    ident = register_and_bootstrap_identity(
        fc, operator_pubkey=None, config_dir=str(tmp_path)
    )
    assert fc.registered == ident.public_key_b64url()
    assert ident.pinned_operator_keys == {}


def test_registration_failure_does_not_raise(tmp_path):
    class Boom:
        def register_identity_key(self, _):
            raise RuntimeError("relay down")

    # Must not raise — connecting cannot be blocked by a relay blip.
    ident = register_and_bootstrap_identity(
        Boom(), operator_pubkey=OP_PUB, config_dir=str(tmp_path)
    )
    assert ident.pinned_operator_keys[OP_KID] == OP_PUB  # pin still applied

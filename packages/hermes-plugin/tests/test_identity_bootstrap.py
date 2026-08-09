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


# --- enrollment TOFU wiring (#5) --------------------------------------------


def _wire_fake_connection(monkeypatch, tmp_path, enroll_keys):
    """Point ensure_connected at fakes: no network, a stashed enroll key set."""
    from types import SimpleNamespace

    from ekho import AgentCredentials
    from ekho_hermes import connection, credentials as creds_mod

    class _FakeSdkClient:
        def __init__(self, creds):
            self.creds = creds

        def register_identity_key(self, public_key):
            return {"key_id": identity.key_id(public_key)}

        def close(self):
            pass

    monkeypatch.setattr(connection, "_connection", None)
    monkeypatch.setattr(connection, "EkhoAgentClient", _FakeSdkClient)
    monkeypatch.setattr(
        connection,
        "enroll_or_load",
        lambda config, config_dir: AgentCredentials(
            agent_id="agt", secret="s", relay_base_url="http://r"
        ),
    )
    creds_mod._last_enroll_operator_keys = enroll_keys
    return SimpleNamespace()


def test_ensure_connected_tofu_pins_enroll_operator_keys(monkeypatch, tmp_path):
    from types import SimpleNamespace

    from ekho_hermes import connection
    from ekho_hermes.config import EkhoConfig
    from ekho_hermes.credentials import load_or_create_identity

    _wire_fake_connection(
        monkeypatch, tmp_path,
        [SimpleNamespace(key_id=OP_KID, public_key=OP_PUB, revoked=False)],
    )
    config = EkhoConfig(relay_url="http://r", fleet_id="flt")
    connection.ensure_connected(config, config_dir=str(tmp_path), start_heartbeat=False)
    try:
        ident = load_or_create_identity(str(tmp_path))
        assert ident.pinned_operator_keys[OP_KID] == OP_PUB
        assert ident.tofu_at  # latched — persisted to the identity file
    finally:
        monkeypatch.setattr(connection, "_connection", None)


def test_ensure_connected_explicit_config_pin_wins_over_tofu(monkeypatch, tmp_path):
    from types import SimpleNamespace

    from ekho_hermes import connection
    from ekho_hermes.config import EkhoConfig
    from ekho_hermes.credentials import load_or_create_identity

    rogue_pub = identity.public_key_b64url_from_seed(bytes(range(50, 82)))
    rogue_kid = identity.key_id(rogue_pub)
    _wire_fake_connection(
        monkeypatch, tmp_path,
        [SimpleNamespace(key_id=rogue_kid, public_key=rogue_pub, revoked=False)],
    )
    # An explicit config pin lands first, so the identity is no longer
    # never-pinned — the relay's enroll keys must NOT be TOFU-adopted.
    config = EkhoConfig(relay_url="http://r", fleet_id="flt", operator_pubkey=OP_PUB)
    connection.ensure_connected(config, config_dir=str(tmp_path), start_heartbeat=False)
    try:
        ident = load_or_create_identity(str(tmp_path))
        assert ident.pinned_operator_keys == {OP_KID: OP_PUB}
        assert rogue_kid not in ident.pinned_operator_keys
        assert ident.tofu_at is None
    finally:
        monkeypatch.setattr(connection, "_connection", None)

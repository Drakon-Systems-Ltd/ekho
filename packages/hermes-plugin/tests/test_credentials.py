"""Tests for the enroll-or-load credentials flow."""

import json
import os

import pytest

from ekho import AgentCredentials
from ekho_hermes.config import EkhoConfig
from ekho_hermes.credentials import (
    enroll_or_load,
    load_credentials,
    save_credentials,
)


# --- Fakes -----------------------------------------------------------------


class _StubEnrollResponse:
    """Stands in for the SDK's EnrollResponse with a .to_credentials()."""

    def __init__(self, agent_id, secret, relay_base_url):
        self._creds = AgentCredentials(
            agent_id=agent_id,
            secret=secret,
            relay_base_url=relay_base_url,
            heartbeat_interval_seconds=30,
            poll_interval_seconds=5,
        )

    def to_credentials(self):
        return self._creds


class _FakeClient:
    """Fake SDK client whose .enroll records its input and returns a stub."""

    def __init__(self, credentials):
        self.credentials = credentials
        self.enroll_called_with = None

    def enroll(self, payload):
        self.enroll_called_with = payload
        return _StubEnrollResponse(
            agent_id="enrolled-agent",
            secret="enrolled-secret",
            relay_base_url=payload.get("relay_base_url")
            or self.credentials.relay_base_url,
        )


def _factory_capture():
    created = {}

    def factory(credentials):
        client = _FakeClient(credentials)
        created["client"] = client
        return client

    return factory, created


# --- save/load round-trip --------------------------------------------------


def test_save_load_roundtrip(tmp_path):
    creds = AgentCredentials(
        agent_id="a1",
        secret="s1",
        relay_base_url="https://relay.example",
        heartbeat_interval_seconds=42,
        poll_interval_seconds=7,
    )
    save_credentials(str(tmp_path), creds)
    loaded = load_credentials(str(tmp_path))
    assert loaded is not None
    assert loaded.agent_id == "a1"
    assert loaded.secret == "s1"
    assert loaded.relay_base_url == "https://relay.example"
    assert loaded.heartbeat_interval_seconds == 42
    assert loaded.poll_interval_seconds == 7


def test_saved_credentials_file_is_0600(tmp_path):
    creds = AgentCredentials(agent_id="a", secret="s", relay_base_url="https://r")
    save_credentials(str(tmp_path), creds)
    path = tmp_path / "credentials.json"
    mode = os.stat(path).st_mode & 0o777
    assert mode == 0o600


def test_load_missing_returns_none(tmp_path):
    assert load_credentials(str(tmp_path)) is None


# --- enroll_or_load: explicit credentials ----------------------------------


def test_explicit_credentials_saved_and_returned(tmp_path):
    config = EkhoConfig(
        relay_url="https://relay.example",
        agent_id="explicit-id",
        agent_secret="explicit-secret",
    )
    factory, created = _factory_capture()
    creds = enroll_or_load(config, str(tmp_path), client_factory=factory)
    assert creds.agent_id == "explicit-id"
    assert creds.secret == "explicit-secret"
    assert creds.relay_base_url == "https://relay.example"
    # No client built (no enroll needed).
    assert "client" not in created
    # Saved to disk for next time.
    saved = json.loads((tmp_path / "credentials.json").read_text())
    assert saved["agent_id"] == "explicit-id"


# --- enroll_or_load: saved credentials -------------------------------------


def test_saved_credentials_short_circuit(tmp_path):
    existing = AgentCredentials(
        agent_id="saved-id",
        secret="saved-secret",
        relay_base_url="https://relay.example",
    )
    save_credentials(str(tmp_path), existing)
    config = EkhoConfig(
        relay_url="https://relay.example",
        fleet_id="fleet-1",
        enrollment_token="tok",
    )
    factory, created = _factory_capture()
    creds = enroll_or_load(config, str(tmp_path), client_factory=factory)
    assert creds.agent_id == "saved-id"
    # Saved creds win — no enrollment attempted.
    assert "client" not in created


# --- enroll_or_load: enroll path -------------------------------------------


def test_enroll_path(tmp_path):
    config = EkhoConfig(
        relay_url="https://relay.example",
        fleet_id="fleet-1",
        enrollment_token="one-time-token",
        display_name="My Agent",
    )
    factory, created = _factory_capture()
    creds = enroll_or_load(config, str(tmp_path), client_factory=factory)
    assert creds.agent_id == "enrolled-agent"
    assert creds.secret == "enrolled-secret"
    # The fake client was constructed and .enroll called with the right input.
    client = created["client"]
    assert client.enroll_called_with["fleet_id"] == "fleet-1"
    assert client.enroll_called_with["token"] == "one-time-token"
    assert client.enroll_called_with["display_name"] == "My Agent"
    assert client.enroll_called_with["runtime"] == "custom"
    assert "hostname" in client.enroll_called_with
    # Persisted for next run.
    saved = load_credentials(str(tmp_path))
    assert saved.agent_id == "enrolled-agent"


def test_enroll_default_display_name(tmp_path):
    config = EkhoConfig(
        relay_url="https://relay.example",
        fleet_id="fleet-1",
        enrollment_token="tok",
    )
    factory, created = _factory_capture()
    enroll_or_load(config, str(tmp_path), client_factory=factory)
    name = created["client"].enroll_called_with["display_name"]
    assert name.startswith("hermes-")


def test_enroll_missing_token_raises(tmp_path):
    config = EkhoConfig(relay_url="https://relay.example", fleet_id="fleet-1")
    factory, _ = _factory_capture()
    with pytest.raises(ValueError):
        enroll_or_load(config, str(tmp_path), client_factory=factory)


def test_missing_relay_raises(tmp_path):
    config = EkhoConfig(agent_id="a", agent_secret="s")  # no relay
    factory, _ = _factory_capture()
    with pytest.raises(ValueError):
        enroll_or_load(config, str(tmp_path), client_factory=factory)


# --- enroll operator-keys stash (#5) ----------------------------------------


def test_enroll_stashes_operator_keys_and_take_is_one_shot(tmp_path):
    from types import SimpleNamespace

    from ekho_hermes import credentials as creds_mod
    from ekho_hermes.credentials import take_enroll_operator_keys

    class _KeyedStub(_StubEnrollResponse):
        operator_keys = [SimpleNamespace(key_id="K", public_key="PUB", revoked=False)]

    class _KeyedClient(_FakeClient):
        def enroll(self, payload):
            self.enroll_called_with = payload
            return _KeyedStub(
                agent_id="enrolled-agent",
                secret="enrolled-secret",
                relay_base_url=self.credentials.relay_base_url,
            )

    creds_mod._last_enroll_operator_keys = None  # isolate from other tests
    config = EkhoConfig(
        relay_url="https://relay.example", fleet_id="fleet-1", enrollment_token="tok"
    )
    enroll_or_load(config, str(tmp_path), client_factory=_KeyedClient)

    keys = take_enroll_operator_keys()
    assert keys is not None and keys[0].key_id == "K"
    # One-shot: a second take yields nothing (mirrors takeEnrollOperatorKeys).
    assert take_enroll_operator_keys() is None


def test_enroll_without_operator_keys_stashes_none(tmp_path):
    from ekho_hermes import credentials as creds_mod
    from ekho_hermes.credentials import take_enroll_operator_keys

    creds_mod._last_enroll_operator_keys = None
    config = EkhoConfig(
        relay_url="https://relay.example", fleet_id="fleet-1", enrollment_token="tok"
    )
    factory, _ = _factory_capture()  # stub response has no operator_keys attr
    enroll_or_load(config, str(tmp_path), client_factory=factory)
    assert take_enroll_operator_keys() is None

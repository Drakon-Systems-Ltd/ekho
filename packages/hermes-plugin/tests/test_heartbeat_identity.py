"""#97: the Hermes plugin reports who it is on every heartbeat."""

from __future__ import annotations

import json
import types
from unittest.mock import MagicMock

from ekho import AgentCredentials, EkhoAgentClient
from ekho import __version__ as SDK_VERSION
from ekho.client import INSTANCE_ID

from ekho_hermes import connection
from ekho_hermes.version import ADAPTER_VERSION, heartbeat_identity, hermes_version


def _hermes(**attrs):
    return {"hermes_cli": types.SimpleNamespace(**attrs)}


def test_identity_names_the_plugin_its_release_and_hermes():
    assert heartbeat_identity(_hermes(__version__="2026.9.24")) == {
        "adapter": "hermes-plugin",
        "adapter_version": ADAPTER_VERSION,
        "host_runtime": "hermes",
        "host_runtime_version": "2026.9.24",
    }


def test_hermes_version_is_unknown_outside_a_hermes_host():
    assert hermes_version({}) is None
    assert "host_runtime_version" not in heartbeat_identity({})


def test_hermes_placeholder_version_falls_back_to_the_release_date():
    assert hermes_version(_hermes(__version__="0.0.0", __release_date__="2026.9.24")) == "2026.9.24"
    assert hermes_version(_hermes(__version__="0.0.0")) is None


def test_hermes_version_drops_anything_that_is_not_a_short_token():
    assert hermes_version(_hermes(__version__="1.2.3 (/home/me/hermes)")) is None
    assert hermes_version(_hermes(__version__=123)) is None

    class Exploding:
        def __getattr__(self, name):
            raise RuntimeError("install stamp unreadable")

    assert hermes_version({"hermes_cli": Exploding()}) is None


def test_heartbeat_loop_sends_identity_through_the_sdk(monkeypatch):
    """The real SDK client: the plugin's adapter fields plus the SDK's own."""
    session = MagicMock()
    response = MagicMock()
    response.ok = True
    response.content = b'{"ok":true,"next_heartbeat_due_seconds":30}'
    response.json.return_value = {"ok": True, "next_heartbeat_due_seconds": 30}

    def request(*args, **kwargs):
        connection._heartbeat_stop.set()  # one beat, then the loop exits
        return response

    session.request.side_effect = request
    client = EkhoAgentClient(
        AgentCredentials(agent_id="agent_h", secret="s", relay_base_url="http://relay.example"),
        session=session,
    )
    monkeypatch.setattr(connection, "heartbeat_identity", lambda: heartbeat_identity(_hermes(__version__="2026.9.24")))
    connection._heartbeat_stop.clear()
    try:
        connection._heartbeat_loop(client, 30)
    finally:
        connection._heartbeat_stop.clear()

    body = json.loads(session.request.call_args.kwargs["data"].decode("utf-8"))
    assert body["status"] == "healthy"
    assert body["adapter"] == "hermes-plugin"
    assert body["adapter_version"] == ADAPTER_VERSION
    assert body["host_runtime"] == "hermes"
    assert body["host_runtime_version"] == "2026.9.24"
    assert body["sdk_version"] == SDK_VERSION
    assert body["instance_id"] == INSTANCE_ID
    assert "adapter" not in body["metrics"]


def test_a_failing_identity_never_stops_the_heartbeat(monkeypatch):
    sent = []

    class Client:
        def heartbeat(self, payload):
            sent.append(payload)
            connection._heartbeat_stop.set()

    def boom():
        raise RuntimeError("identity failed")

    monkeypatch.setattr(connection, "heartbeat_identity", boom)
    connection._heartbeat_stop.clear()
    try:
        connection._heartbeat_loop(Client(), 30)
    finally:
        connection._heartbeat_stop.clear()
    assert sent and sent[0]["status"] == "healthy" and "adapter" not in sent[0]

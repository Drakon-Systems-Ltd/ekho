"""Outbound origin stamping (ekho#17).

An Ekho agent identity is per-box: every session on this host signs with the
same key, so after #32 (the relay returning sender metadata verbatim) a sibling
session can only tell "I said that" from "someone else has my key" if the send
names the session that produced it.

These exercise the handler glue in ``ekho_hermes.plugin`` with a fake relay
connection: the session id must reach the wire payload when Hermes supplies one,
and the field must be absent — never minted — when it does not.
"""

import json

import pytest

from ekho_hermes import plugin
from ekho_hermes.messages import EKHO_ORIGIN_STAMP


class _FakeClient:
    def __init__(self):
        self.sent = None

    def send_message(self, payload):
        self.sent = payload

        class _Result:
            message_id = "m_1"

        return _Result()


class _FakeConn:
    def __init__(self):
        self.client = _FakeClient()
        self.config_dir = None  # skips signing (graceful)

        class _Creds:
            agent_id = "self"

        self.credentials = _Creds()


@pytest.fixture()
def conn(monkeypatch):
    monkeypatch.setenv("EKHO_RELAY_URL", "http://relay.example")
    monkeypatch.setattr(plugin, "upload_paths", lambda client, paths: [])
    connection = _FakeConn()
    monkeypatch.setattr(plugin, "ensure_connected", lambda config: connection)
    return connection


def _send(conn, **kw):
    out = json.loads(
        plugin._handle_ekho_send(
            {"recipient_agent_id": "agent_b", "message": "hi"}, **kw
        )
    )
    assert out["sent"] is True
    return conn.client.sent["metadata"]


# --- resolve_origin_session_id --------------------------------------------


def test_resolve_prefers_session_key_then_session_id():
    assert (
        plugin.resolve_origin_session_id({"session_key": "sk", "session_id": "sid"})
        == "sk"
    )
    assert plugin.resolve_origin_session_id({"session_id": "sid"}) == "sid"
    assert plugin.resolve_origin_session_id({"sessionKey": "sk"}) == "sk"


def test_resolve_reads_one_level_of_context_mapping():
    assert plugin.resolve_origin_session_id({"context": {"session_id": "sid"}}) == "sid"
    assert plugin.resolve_origin_session_id({"session": {"session_key": "sk"}}) == "sk"


def test_resolve_returns_empty_for_anything_else():
    # No session in the call shape -> no stamp. Never raises, never invents.
    assert plugin.resolve_origin_session_id({}) == ""
    assert plugin.resolve_origin_session_id({"session_key": "  ", "session_id": ""}) == ""
    assert plugin.resolve_origin_session_id({"session_key": 42}) == ""
    assert plugin.resolve_origin_session_id({"context": "not-a-mapping"}) == ""
    # A task is not a session: a per-task id would fragment one session into many.
    assert plugin.resolve_origin_session_id({"task_id": "task_123"}) == ""


def test_resolve_trims():
    assert plugin.resolve_origin_session_id({"session_key": "  sk  "}) == "sk"


# --- ekho_send wire payload ------------------------------------------------


def test_send_stamps_origin_session_id_from_kwargs(conn):
    assert _send(conn, session_key="sess_abc") == {
        "ekho_origin": EKHO_ORIGIN_STAMP,
        "origin_session_id": "sess_abc",
    }


def test_send_omits_origin_session_id_when_host_supplies_none(conn):
    # Today's Hermes call shape (handler invoked with args only) lands here.
    assert _send(conn) == {"ekho_origin": EKHO_ORIGIN_STAMP}
    assert "origin_session_id" not in conn.client.sent["metadata"]


def test_send_omits_origin_session_id_for_unrelated_kwargs(conn):
    assert _send(conn, task_id="task_123", tool_call_id="call_1") == {
        "ekho_origin": EKHO_ORIGIN_STAMP
    }

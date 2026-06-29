"""Tests for the room-aware plugin handlers (ekho_open_room + ekho_send room).

These exercise the handler glue in ``ekho_hermes.plugin`` with a fake relay
connection, so the room-create call and the room-targeted send are verified
without a live relay. Pure wire shaping lives in ``test_messages.py``.
"""

import json

import pytest

from ekho_hermes import plugin
from ekho_hermes.config import EkhoConfig


class _FakeClient:
    def __init__(self):
        self.sent = None
        self.created = None

    def create_room(self, name, members):
        self.created = {"name": name, "members": list(members)}

        class _Room:
            id = "room_new"

        room = _Room()
        room.name = name
        room.members = ["self"] + list(members)
        return room

    def send_message(self, payload):
        self.sent = payload

        class _Result:
            message_id = "m_room"

        return _Result()


class _FakeConn:
    def __init__(self):
        self.client = _FakeClient()
        self.config_dir = None  # skips signing (graceful)

        class _Creds:
            agent_id = "self"

        self.credentials = _Creds()


@pytest.fixture()
def relay_env(monkeypatch):
    monkeypatch.setenv("EKHO_RELAY_URL", "http://relay.example")
    # Avoid any real upload/sign work.
    monkeypatch.setattr(plugin, "upload_paths", lambda client, paths: [])


def test_open_room_creates_and_returns_room(relay_env, monkeypatch):
    conn = _FakeConn()
    monkeypatch.setattr(plugin, "ensure_connected", lambda config: conn)

    out = json.loads(
        plugin._handle_ekho_open_room(
            {"topic": "Migration rollout", "member_agent_ids": ["agent_b"]}
        )
    )
    assert out["opened"] is True
    assert out["room_id"] == "room_new"
    assert out["name"] == "Migration rollout"
    assert "self" in out["members"] and "agent_b" in out["members"]
    assert 'room_id="room_new"' in out["next"]
    # The creating agent does NOT list itself; the relay auto-adds it.
    assert conn.client.created == {"name": "Migration rollout", "members": ["agent_b"]}


def test_open_room_requires_topic(relay_env, monkeypatch):
    monkeypatch.setattr(plugin, "ensure_connected", lambda config: _FakeConn())
    out = json.loads(plugin._handle_ekho_open_room({"topic": "  "}))
    assert "error" in out


def test_send_with_room_id_targets_group(relay_env, monkeypatch):
    conn = _FakeConn()
    monkeypatch.setattr(plugin, "ensure_connected", lambda config: conn)

    out = json.loads(
        plugin._handle_ekho_send({"room_id": "room_new", "message": "into the room"})
    )
    assert out["sent"] is True
    assert out["room_id"] == "room_new"
    # The wire payload targets the room as a group recipient, threaded under it.
    assert conn.client.sent["recipient"] == {"kind": "group", "id": "room_new"}
    assert conn.client.sent["conversation_id"] == "room_new"


def test_send_requires_a_target(relay_env, monkeypatch):
    monkeypatch.setattr(plugin, "ensure_connected", lambda config: _FakeConn())
    out = json.loads(plugin._handle_ekho_send({"message": "to nobody"}))
    assert "error" in out

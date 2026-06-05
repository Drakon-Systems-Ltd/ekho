"""Tests for the auto-reply start guard wired into the connection singleton.

Mirrors the OpenClaw plugin's ``maybeStartAutoReply``: start the loop exactly
once, and never in a process that carries ``EKHO_AUTOREPLY_DISABLE=1`` (the
spawned reply-turn child).
"""

import pytest

from ekho import AgentCredentials

from ekho_hermes import connection
from ekho_hermes.autoreply import EKHO_AUTOREPLY_DISABLE_ENV


class _Conn:
    def __init__(self, agent_id="agt-1"):
        self.client = object()
        self.credentials = AgentCredentials(
            agent_id=agent_id, secret="s", relay_base_url="http://relay"
        )


@pytest.fixture(autouse=True)
def _reset():
    connection.reset_autoreply_singleton()
    yield
    connection.reset_autoreply_singleton()


def test_disabled_env_does_not_start():
    calls = []

    def fake_start(**kw):
        calls.append(kw)
        return lambda: None

    stop = connection.start_autoreply_once(
        _Conn(), env={EKHO_AUTOREPLY_DISABLE_ENV: "1"}, start_fn=fake_start
    )
    assert stop is None
    assert calls == []  # loop never started in a reply-turn child


def test_starts_once_and_is_idempotent():
    calls = []

    def fake_stop():
        return None

    def fake_start(**kw):
        calls.append(kw)
        return fake_stop

    s1 = connection.start_autoreply_once(_Conn(), env={}, start_fn=fake_start)
    s2 = connection.start_autoreply_once(_Conn(), env={}, start_fn=fake_start)

    assert s1 is fake_stop and s2 is fake_stop
    assert len(calls) == 1  # second call returns the existing loop, no restart
    assert calls[0]["self_agent_id"] == "agt-1"
    assert calls[0]["client"] is not None

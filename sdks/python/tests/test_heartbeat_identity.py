"""#97: the Python SDK reports who it is on every heartbeat."""

from __future__ import annotations

import json
import platform
import re
from pathlib import Path
from unittest.mock import MagicMock

import ekho
from ekho.client import INSTANCE_ID, EkhoAgentClient, with_heartbeat_identity
from ekho.types import AgentCredentials


def _client():
    session = MagicMock()
    response = MagicMock()
    response.ok = True
    response.content = b'{"ok":true,"next_heartbeat_due_seconds":30}'
    response.json.return_value = {"ok": True, "next_heartbeat_due_seconds": 30}
    session.request.return_value = response
    client = EkhoAgentClient(
        AgentCredentials(agent_id="agent_abc", secret="s", relay_base_url="http://relay.example"),
        session=session,
    )
    return client, session


def _sent_body(session) -> dict:
    return json.loads(session.request.call_args.kwargs["data"].decode("utf-8"))


def test_heartbeat_reports_sdk_python_and_a_process_instance_id():
    client, session = _client()
    client.heartbeat({"status": "healthy", "metrics": {}})
    body = _sent_body(session)
    assert body["status"] == "healthy"
    assert body["adapter"] == "python-sdk"
    assert body["adapter_version"] == ekho.__version__
    assert body["sdk_version"] == ekho.__version__
    assert body["host_runtime"] == "python"
    assert body["host_runtime_version"] == platform.python_version()
    assert body["instance_id"] == INSTANCE_ID
    # The relay's instance_id charset and length (agent-identity.ts).
    assert re.fullmatch(r"[A-Za-z0-9_-]{8,64}", INSTANCE_ID)


def test_a_named_adapter_owns_the_adapter_fields():
    body = with_heartbeat_identity(
        {"status": "healthy", "adapter": "hermes-plugin", "adapter_version": "0.9.0"}
    )
    assert body["adapter"] == "hermes-plugin"
    assert body["adapter_version"] == "0.9.0"
    assert "host_runtime" not in body  # not labelled "python" on the plugin's behalf
    assert body["sdk_version"] == ekho.__version__
    assert body["instance_id"] == INSTANCE_ID


def test_instance_id_is_stable_within_the_process():
    a = with_heartbeat_identity({"status": "idle"})
    b = with_heartbeat_identity({"status": "busy"})
    assert a["instance_id"] == b["instance_id"]


def test_version_matches_pyproject():
    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    declared = re.search(r'^version = "([^"]+)"$', pyproject, re.MULTILINE)
    assert declared and declared.group(1) == ekho.__version__

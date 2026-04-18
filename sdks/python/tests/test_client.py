"""Tests for the Ekho Python SDK.

The golden signature values below were generated from a Node 20 script using
the same crypto primitives the relay uses. If these tests pass, the Python
client produces byte-for-byte identical HMAC output to the Node SDK, which
is the whole point.

Reference generator (runnable):

    const crypto = require("node:crypto");
    const sha = (s) =>
        crypto.createHash("sha256").update(s).digest("hex");
    const sign = (secret, p) =>
        crypto.createHmac("sha256", secret).update(p).digest("hex");
    const payload =
        `POST\n/v1/messages\n${ts}\n${nonce}\n${sha(body)}`;
    sign("super-secret-key", payload);
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from ekho._signing import (
    build_payload,
    iso_now,
    new_nonce,
    sha256_hex,
    sign,
    signed_headers,
)
from ekho.client import EkhoAgentClient, EkhoRequestError
from ekho.types import AgentCredentials


# --- Golden-value signature tests -----------------------------------------

SECRET = "super-secret-key"
TIMESTAMP = "2026-04-18T12:34:56.789Z"
NONCE = "00000000-0000-4000-8000-000000000000"


def test_sha256_empty_matches_node():
    # Reference: sha256('') in Node
    assert (
        sha256_hex("")
        == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )


def test_sha256_body_matches_node():
    body = json.dumps(
        {
            "recipient": {"kind": "agent", "id": "agent_def"},
            "body": {"text": "hello"},
        },
        separators=(",", ":"),
    )
    assert (
        sha256_hex(body)
        == "df6c97153ed561165e95c78581c3827e8124bee81d168ad04f12f82b474f4757"
    )


def test_sign_post_message_matches_node_golden():
    body = json.dumps(
        {
            "recipient": {"kind": "agent", "id": "agent_def"},
            "body": {"text": "hello"},
        },
        separators=(",", ":"),
    )
    payload = build_payload("POST", "/v1/messages", TIMESTAMP, NONCE, body)
    # Node reference
    assert (
        sign(SECRET, payload)
        == "012c90f97c45fcecc1c9cacfcf3b0972e18cd08d6e784df87b58a55b76e4831a"
    )


def test_sign_get_inbox_matches_node_golden():
    # GET with no body — the relay still hashes the empty string.
    payload = build_payload("GET", "/v1/inbox", TIMESTAMP, NONCE, "")
    assert (
        sign(SECRET, payload)
        == "73a858cb2316e3eea6186861f599cc947efab74ab99a078e5bbb6a0d8eccd81a"
    )


# --- Header construction --------------------------------------------------

def test_signed_headers_fields_and_values():
    body = ""
    headers = signed_headers(
        "agent_abc",
        SECRET,
        "GET",
        "/v1/inbox",
        body,
        timestamp=TIMESTAMP,
        nonce=NONCE,
    )
    assert headers["content-type"] == "application/json"
    assert headers["x-ekho-agent-id"] == "agent_abc"
    assert headers["x-ekho-agent-secret"] == SECRET
    assert headers["x-ekho-timestamp"] == TIMESTAMP
    assert headers["x-ekho-nonce"] == NONCE
    assert (
        headers["x-ekho-signature"]
        == "73a858cb2316e3eea6186861f599cc947efab74ab99a078e5bbb6a0d8eccd81a"
    )


def test_signed_headers_generates_fresh_ts_and_nonce_when_omitted():
    h1 = signed_headers("agent_abc", SECRET, "GET", "/v1/inbox", "")
    h2 = signed_headers("agent_abc", SECRET, "GET", "/v1/inbox", "")
    # Two separate calls should produce different nonces (UUID4).
    assert h1["x-ekho-nonce"] != h2["x-ekho-nonce"]
    # Timestamps are ISO 8601 with 'Z' suffix and millisecond precision.
    assert h1["x-ekho-timestamp"].endswith("Z")
    # Basic shape check: YYYY-MM-DDTHH:MM:SS.mmmZ = 24 chars.
    assert len(h1["x-ekho-timestamp"]) == 24


def test_iso_now_shape():
    ts = iso_now()
    assert ts.endswith("Z")
    assert "T" in ts
    assert len(ts) == 24  # 2026-04-18T12:34:56.789Z


def test_new_nonce_is_uuid_like():
    n = new_nonce()
    # xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx = 36 chars with 4 dashes
    assert len(n) == 36
    assert n.count("-") == 4


# --- Client behaviour (with mocked session) -------------------------------

def _make_client_with_mock():
    session = MagicMock()
    creds = AgentCredentials(
        agent_id="agent_abc",
        secret=SECRET,
        relay_base_url="http://relay.example",
    )
    client = EkhoAgentClient(creds, session=session)
    return client, session


def test_client_send_message_posts_signed_request():
    client, session = _make_client_with_mock()
    response = MagicMock()
    response.ok = True
    response.content = (
        b'{"message_id":"m1","status":"queued",'
        b'"queued_at":"2026-04-18T00:00:00.000Z"}'
    )
    response.json.return_value = {
        "message_id": "m1",
        "status": "queued",
        "queued_at": "2026-04-18T00:00:00.000Z",
    }
    session.request.return_value = response

    result = client.send_message(
        {
            "recipient": {"kind": "agent", "id": "agent_def"},
            "message_type": "direct",
            "body": {"text": "hi"},
            "conversation_id": "c",
            "correlation_id": "k",
        }
    )
    assert result.message_id == "m1"

    # Exactly one HTTP call; method/url/data match expectations.
    assert session.request.call_count == 1
    call = session.request.call_args
    assert call.args[0] == "POST"
    assert call.args[1] == "http://relay.example/v1/messages"
    headers = call.kwargs["headers"]
    # All five signed headers present.
    for h in (
        "x-ekho-agent-id",
        "x-ekho-agent-secret",
        "x-ekho-timestamp",
        "x-ekho-nonce",
        "x-ekho-signature",
    ):
        assert h in headers
    # Body was sent as a non-empty JSON string.
    data = call.kwargs["data"]
    assert isinstance(data, str) and data.startswith("{")


def test_client_get_inbox_sends_no_body():
    client, session = _make_client_with_mock()
    response = MagicMock()
    response.ok = True
    response.content = b'{"messages":[],"controls":[]}'
    response.json.return_value = {"messages": [], "controls": []}
    session.request.return_value = response

    inbox = client.get_inbox(limit=10)
    assert inbox.messages == []
    call = session.request.call_args
    assert call.args[0] == "GET"
    assert call.args[1] == "http://relay.example/v1/inbox?limit=10"
    # GET requests send no body (data=None).
    assert call.kwargs["data"] is None


def test_client_raises_on_http_error():
    client, session = _make_client_with_mock()
    response = MagicMock()
    response.ok = False
    response.status_code = 401
    response.text = '{"error":"invalid signature"}'
    session.request.return_value = response

    with pytest.raises(EkhoRequestError) as exc:
        client.get_inbox()
    assert exc.value.status_code == 401
    assert "/v1/inbox" in str(exc.value)


def test_client_signature_path_strips_query_string():
    """The relay signs on request.url.split('?')[0]. Our client must match."""
    client, session = _make_client_with_mock()
    response = MagicMock()
    response.ok = True
    response.content = b'{"messages":[],"controls":[]}'
    response.json.return_value = {"messages": [], "controls": []}
    session.request.return_value = response

    client.get_inbox(limit=5)
    headers = session.request.call_args.kwargs["headers"]

    # Rebuild the signature ourselves using the path WITHOUT the query string
    # and the exact timestamp/nonce the client used. If our client included
    # the '?limit=5' in the signed path, this would mismatch.
    expected = sign(
        SECRET,
        build_payload(
            "GET",
            "/v1/inbox",
            headers["x-ekho-timestamp"],
            headers["x-ekho-nonce"],
            "",
        ),
    )
    assert headers["x-ekho-signature"] == expected


def test_default_intervals():
    creds = AgentCredentials(
        agent_id="a", secret="s", relay_base_url="http://x"
    )
    client = EkhoAgentClient(creds)
    assert client.poll_interval_seconds == 5
    assert client.heartbeat_interval_seconds == 30


def test_custom_intervals():
    creds = AgentCredentials(
        agent_id="a",
        secret="s",
        relay_base_url="http://x",
        poll_interval_seconds=2,
        heartbeat_interval_seconds=60,
    )
    client = EkhoAgentClient(creds)
    assert client.poll_interval_seconds == 2
    assert client.heartbeat_interval_seconds == 60

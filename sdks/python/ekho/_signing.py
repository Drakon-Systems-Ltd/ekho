"""Internal HMAC signing helpers.

Mirrors packages/relay/src/auth.ts and packages/sdk/src/client.ts exactly:

    payload = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" +
              NONCE + "\n" + SHA256(BODY)
    signature = hex( HMAC_SHA256(secret, payload) )

Body is the JSON-serialised request payload (empty for GET / no body).
Path excludes the query string, matching request.url.split("?")[0] on
the relay.
"""

from __future__ import annotations

import hashlib
import hmac
import uuid
from datetime import datetime, timezone
from typing import Dict


def sha256_hex(data: str) -> str:
    """Hex SHA-256 of a string — matches node crypto.createHash('sha256')."""
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def sign(secret: str, payload: str) -> str:
    """HMAC-SHA256 hex digest — matches node crypto.createHmac."""
    return hmac.new(
        secret.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def build_payload(
    method: str,
    path: str,
    timestamp: str,
    nonce: str,
    body: str,
) -> str:
    """Build the exact string the relay expects to HMAC over."""
    return f"{method}\n{path}\n{timestamp}\n{nonce}\n{sha256_hex(body)}"


def iso_now() -> str:
    """ISO 8601 UTC timestamp with millisecond precision and 'Z' suffix.

    Matches JavaScript's `new Date().toISOString()` format, e.g.
    '2026-04-18T12:34:56.789Z'.
    """
    now = datetime.now(timezone.utc)
    # Trim microseconds to milliseconds (3 digits), append Z
    ms = now.microsecond // 1000
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms:03d}Z"


def new_nonce() -> str:
    """Random UUID string — matches crypto.randomUUID()."""
    return str(uuid.uuid4())


def signed_headers(
    agent_id: str,
    secret: str,
    method: str,
    signature_path: str,
    body: str,
    *,
    timestamp: str | None = None,
    nonce: str | None = None,
) -> Dict[str, str]:
    """Build the full set of auth headers for an Ekho agent request.

    The `timestamp` and `nonce` kwargs exist for deterministic tests —
    in normal use they are generated fresh per call.
    """
    ts = timestamp or iso_now()
    nc = nonce or new_nonce()
    payload = build_payload(method, signature_path, ts, nc, body)
    return {
        "content-type": "application/json",
        "x-ekho-agent-id": agent_id,
        "x-ekho-agent-secret": secret,
        "x-ekho-timestamp": ts,
        "x-ekho-nonce": nc,
        "x-ekho-signature": sign(secret, payload),
    }

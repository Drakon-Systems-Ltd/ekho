"""Synchronous Ekho agent client.

Mirrors packages/sdk/src/client.ts. Every request is HMAC-SHA256 signed to
match the relay's requireAgentAuth middleware byte-for-byte.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import requests

from ._signing import signed_headers
from .types import (
    AckInput,
    ActionDecision,
    ActionResultInput,
    AgentCredentials,
    ApprovalStatus,
    EnrollInput,
    EnrollResponse,
    HeartbeatInput,
    HeartbeatResult,
    InboxResponse,
    ProposeActionInput,
    SendMessageInput,
    SendMessageResult,
)

DEFAULT_POLL_INTERVAL_SECONDS = 5
DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30
DEFAULT_TIMEOUT_SECONDS = 30


def _serialize_body(payload: Any) -> str:
    """JSON body for BOTH the signature and the wire.

    Must match the relay's canonical form. The relay re-serialises the parsed
    request body with JS ``JSON.stringify`` (raw UTF-8, compact) and HMACs that.
    Python's ``json.dumps`` defaults to ``ensure_ascii=True``, which escapes
    non-ASCII as ``\\uXXXX`` — so a message containing an em-dash, smart quote,
    or emoji would be signed over a different string than the relay hashes,
    yielding ``401 invalid signature`` intermittently. ``ensure_ascii=False``
    keeps raw UTF-8 so the two sides agree.
    """
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


class EkhoRequestError(RuntimeError):
    """Raised when the relay returns a non-2xx response."""

    def __init__(self, path: str, status_code: int, body: str):
        super().__init__(
            f"Ekho request failed for {path}: {status_code} {body}"
        )
        self.path = path
        self.status_code = status_code
        self.body = body


class EkhoAgentClient:
    """Low-level, sync HTTP client for the Ekho agent API."""

    def __init__(
        self,
        credentials: AgentCredentials,
        *,
        session: Optional[requests.Session] = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ):
        self._credentials = credentials
        self._session = session or requests.Session()
        self._timeout = timeout

    # --- Properties ------------------------------------------------------

    @property
    def agent_id(self) -> str:
        return self._credentials.agent_id

    @property
    def poll_interval_seconds(self) -> int:
        return (
            self._credentials.poll_interval_seconds
            if self._credentials.poll_interval_seconds is not None
            else DEFAULT_POLL_INTERVAL_SECONDS
        )

    @property
    def heartbeat_interval_seconds(self) -> int:
        return (
            self._credentials.heartbeat_interval_seconds
            if self._credentials.heartbeat_interval_seconds is not None
            else DEFAULT_HEARTBEAT_INTERVAL_SECONDS
        )

    # --- Core request plumbing ------------------------------------------

    def _request(
        self,
        method: str,
        route_path: str,
        payload: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        # Serialise body to the relay's canonical form (see _serialize_body).
        # Empty string matches TS `payload ? JSON.stringify(payload) : ""`.
        body = "" if payload is None else _serialize_body(payload)
        signature_path = route_path.split("?")[0]

        headers = signed_headers(
            self._credentials.agent_id,
            self._credentials.secret,
            method,
            signature_path,
            body,
        )

        url = f"{self._credentials.relay_base_url}{route_path}"
        # Send the EXACT UTF-8 bytes of the string we signed. We sign over the
        # raw-UTF-8 JSON (ensure_ascii=False), so the wire bytes must be that
        # string's UTF-8 encoding — otherwise the relay re-serialises the parsed
        # body and the HMAC diverges on any non-ASCII content.
        data = None if method == "GET" else body.encode("utf-8")

        response = self._session.request(
            method,
            url,
            data=data,
            headers=headers,
            timeout=self._timeout,
        )
        if not response.ok:
            raise EkhoRequestError(
                route_path,
                response.status_code,
                response.text,
            )

        if not response.content:
            return {}
        return response.json()

    # --- Public API -----------------------------------------------------

    def enroll(self, payload: EnrollInput) -> EnrollResponse:
        """Enroll a new agent using a one-time token.

        This is the one endpoint that does NOT require auth headers (the relay
        accepts it unauthenticated). We still send them — they'll simply be
        ignored — which lets us share one request path.
        """
        # Enroll doesn't go through requireAgentAuth, so we bypass _request
        # to avoid including stale agent credentials we may not have yet.
        body = _serialize_body(dict(payload))
        url = f"{self._credentials.relay_base_url}/v1/enroll"
        response = self._session.post(
            url,
            data=body.encode("utf-8"),
            headers={"content-type": "application/json"},
            timeout=self._timeout,
        )
        if not response.ok:
            raise EkhoRequestError(
                "/v1/enroll",
                response.status_code,
                response.text,
            )
        return EnrollResponse.from_dict(response.json())

    def send_message(self, payload: SendMessageInput) -> SendMessageResult:
        return SendMessageResult.from_dict(
            self._request("POST", "/v1/messages", dict(payload))
        )

    def get_inbox(self, limit: int = 25) -> InboxResponse:
        return InboxResponse.from_dict(
            self._request("GET", f"/v1/inbox?limit={limit}")
        )

    def register_identity_key(self, public_key: str) -> Dict[str, Any]:
        """Register (or rotate) this agent's Ed25519 identity public key for
        agent-to-agent trust. Idempotent on the relay side."""
        return self._request("POST", "/v1/identity-key", {"public_key": public_key})

    def ack_messages(self, acks: List[AckInput]) -> Dict[str, Any]:
        return self._request(
            "POST",
            "/v1/acks",
            {"acks": [dict(a) for a in acks]},
        )

    def heartbeat(self, payload: HeartbeatInput) -> HeartbeatResult:
        return HeartbeatResult.from_dict(
            self._request("POST", "/v1/heartbeats", dict(payload))
        )

    def propose_action(self, payload: ProposeActionInput) -> ActionDecision:
        return ActionDecision.from_dict(
            self._request("POST", "/v1/actions/propose", dict(payload))
        )

    def get_approval(self, approval_id: str) -> ApprovalStatus:
        return ApprovalStatus.from_dict(
            self._request("GET", f"/v1/actions/{approval_id}")
        )

    def action_result(self, payload: ActionResultInput) -> Dict[str, Any]:
        return self._request("POST", "/v1/actions/result", dict(payload))

    def upload_attachment(
        self,
        *,
        filename: str,
        mime: str,
        data_base64: str,
    ) -> Dict[str, Any]:
        import base64

        size_bytes = len(base64.b64decode(data_base64))
        return self._request(
            "POST",
            "/v1/attachments",
            {
                "filename": filename,
                "mime": mime,
                "size_bytes": size_bytes,
                "data_base64": data_base64,
            },
        )

    def download_attachment(self, attachment_id: str) -> bytes:
        # _request JSON-parses; download bypasses it like enroll does.
        route_path = f"/v1/attachments/{attachment_id}"
        headers = signed_headers(
            self._credentials.agent_id,
            self._credentials.secret,
            "GET",
            route_path,
            "",
        )
        url = f"{self._credentials.relay_base_url}{route_path}"
        resp = self._session.request(
            "GET",
            url,
            headers=headers,
            timeout=self._timeout,
        )
        if not resp.ok:
            raise EkhoRequestError(
                route_path,
                resp.status_code,
                resp.text,
            )
        return resp.content

    def close(self) -> None:
        self._session.close()

    def __enter__(self) -> "EkhoAgentClient":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

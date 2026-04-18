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
        # Serialise body. Empty string matches TS
        # `payload ? JSON.stringify(payload) : ""`.
        # separators=(',', ':') gives the compact JSON.stringify form.
        # The relay hashes whatever body string we send; what matters is
        # that the string we hash is the exact string we put on the wire.
        # We pass `data=body` below, so that invariant holds.
        body = (
            ""
            if payload is None
            else json.dumps(payload, separators=(",", ":"))
        )
        signature_path = route_path.split("?")[0]

        headers = signed_headers(
            self._credentials.agent_id,
            self._credentials.secret,
            method,
            signature_path,
            body,
        )

        url = f"{self._credentials.relay_base_url}{route_path}"
        # For GET, TS sends no body; the signed payload hashes "" in both cases
        # because `body` was set to "" when payload is None.
        data = None if method == "GET" else body

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
        body = json.dumps(dict(payload), separators=(",", ":"))
        url = f"{self._credentials.relay_base_url}/v1/enroll"
        response = self._session.post(
            url,
            data=body,
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

    def close(self) -> None:
        self._session.close()

    def __enter__(self) -> "EkhoAgentClient":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

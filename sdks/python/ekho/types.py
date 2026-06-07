"""Dataclass mirrors of packages/sdk/src/types.ts.

These use TypedDict for payload shapes (so callers can pass plain dicts) and
dataclasses for response types parsed from the relay. All field names match
the TypeScript SDK and the relay's wire format exactly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, TypedDict


# --- Credentials -----------------------------------------------------------

@dataclass
class AgentCredentials:
    agent_id: str
    secret: str
    relay_base_url: str
    heartbeat_interval_seconds: Optional[int] = None
    poll_interval_seconds: Optional[int] = None


# --- Attachments -----------------------------------------------------------

@dataclass
class AttachmentMeta:
    id: str
    filename: str
    mime: str
    size_bytes: int

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AttachmentMeta":
        return cls(
            id=data["id"],
            filename=data.get("filename", ""),
            mime=data.get("mime", ""),
            size_bytes=int(data.get("size_bytes", 0)),
        )


# --- Inbound message shapes ------------------------------------------------

@dataclass
class InboxMessage:
    message_id: str
    conversation_id: str
    correlation_id: str
    sender_agent_id: str
    message_type: str
    priority: str
    body: Dict[str, Any]
    metadata: Dict[str, Any]
    created_at: str
    deadline_at: str
    # "operator" iff the sender is the verified fleet operator; else "agent".
    sender_kind: Optional[str] = None
    # Resolved attachment metadata (never bytes). Fetch via
    # download_attachment.
    attachments: List[AttachmentMeta] = field(default_factory=list)
    # Verifiable identity (None unless the sender signed). operator_sig is only
    # populated for operator senders, agent_sig only for agent senders (the relay
    # gates these on the server-derived sender kind). The agent verifies them
    # itself against pinned/endorsed keys — see ekho.identity.
    operator_sig: Optional[str] = None
    agent_sig: Optional[str] = None
    key_id: Optional[str] = None
    sig_canonical: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "InboxMessage":
        return cls(
            message_id=data["message_id"],
            conversation_id=data["conversation_id"],
            correlation_id=data["correlation_id"],
            sender_agent_id=data["sender_agent_id"],
            message_type=data["message_type"],
            priority=data["priority"],
            body=data.get("body") or {},
            metadata=data.get("metadata") or {},
            created_at=data["created_at"],
            deadline_at=data["deadline_at"],
            sender_kind=data.get("sender_kind"),
            attachments=[
                AttachmentMeta.from_dict(a)
                for a in data.get("attachments", [])
            ],
            operator_sig=data.get("operator_sig"),
            agent_sig=data.get("agent_sig"),
            key_id=data.get("key_id"),
            sig_canonical=data.get("sig_canonical"),
        )


@dataclass
class ControlMessage:
    control_id: str
    action: str
    reason: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ControlMessage":
        return cls(
            control_id=data["control_id"],
            action=data["action"],
            reason=data.get("reason", ""),
        )


@dataclass
class RosterEntry:
    agent_id: str
    display_name: str
    runtime: str
    status: str
    # The teammate's identity key + operator endorsement, so a peer can verify a
    # signed message and that the sender's key chains back to the operator.
    identity_public_key: Optional[str] = None
    key_id: Optional[str] = None
    endorsed_by_key_id: Optional[str] = None
    endorsement_sig: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RosterEntry":
        return cls(
            agent_id=data["agent_id"],
            display_name=data.get("display_name", ""),
            runtime=data.get("runtime", ""),
            status=data.get("status", ""),
            identity_public_key=data.get("identity_public_key"),
            key_id=data.get("key_id"),
            endorsed_by_key_id=data.get("endorsed_by_key_id"),
            endorsement_sig=data.get("endorsement_sig"),
        )


@dataclass
class OperatorKeyEntry:
    """A pinned operator signing key delivered to agents for verification."""

    key_id: str
    public_key: str
    revoked: bool = False
    endorsed_by_key_id: Optional[str] = None
    endorsement_sig: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "OperatorKeyEntry":
        return cls(
            key_id=data["key_id"],
            public_key=data["public_key"],
            revoked=bool(data.get("revoked", False)),
            endorsed_by_key_id=data.get("endorsed_by_key_id"),
            endorsement_sig=data.get("endorsement_sig"),
        )


@dataclass
class InboxResponse:
    messages: List[InboxMessage]
    controls: List[ControlMessage]
    # The polling agent's own fleet — binds verified signatures to a fleet.
    fleet_id: Optional[str] = None
    # Whether this agent recognizes the console operator as its verified principal.
    operator_trusted: bool = False
    # Other agents in the same fleet (excludes the operator identity and self).
    roster: List[RosterEntry] = field(default_factory=list)
    # Operator-controlled bounded agent-to-agent delegation (None if the relay
    # predates the feature — the client then falls back to its local default).
    peer_autoreply: Optional[bool] = None
    peer_turn_budget: Optional[int] = None
    # Pinned operator signing keys (incl. revoked, so the agent can drop them).
    operator_keys: List[OperatorKeyEntry] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "InboxResponse":
        return cls(
            messages=[
                InboxMessage.from_dict(m)
                for m in data.get("messages", [])
            ],
            controls=[
                ControlMessage.from_dict(c)
                for c in data.get("controls", [])
            ],
            fleet_id=data.get("fleet_id"),
            operator_trusted=bool(data.get("operator_trusted", False)),
            roster=[
                RosterEntry.from_dict(r)
                for r in data.get("roster", [])
            ],
            peer_autoreply=data.get("peer_autoreply"),
            peer_turn_budget=data.get("peer_turn_budget"),
            operator_keys=[
                OperatorKeyEntry.from_dict(k)
                for k in data.get("operator_keys", [])
            ],
        )


# --- Outbound payload shapes (plain dicts on the wire) ---------------------

class Recipient(TypedDict, total=False):
    kind: Literal["agent", "group", "broadcast"]
    id: str


class SendMessageInput(TypedDict, total=False):
    recipient: Recipient
    message_type: Literal[
        "direct", "broadcast", "alert", "handoff",
        "claim", "complete", "heartbeat", "control",
    ]
    priority: Literal["low", "normal", "high", "urgent"]
    ttl_seconds: int
    requires_approval: bool
    body: Dict[str, Any]
    metadata: Dict[str, Any]
    conversation_id: str
    correlation_id: str
    # Verifiable peer identity (optional): the agent signs the canonical payload
    # with its own identity key; the relay relays these verbatim.
    agent_sig: str
    key_id: str
    sig_canonical: Dict[str, Any]


class HeartbeatInput(TypedDict, total=False):
    status: Literal["healthy", "degraded", "busy", "idle"]
    active_conversation_ids: List[str]
    metrics: Dict[str, Any]


class ProposeActionInput(TypedDict, total=False):
    conversation_id: str
    action_type: str
    summary: str
    risk_level: Literal["low", "medium", "high", "critical"]
    payload: Dict[str, Any]


class ActionResultInput(TypedDict, total=False):
    approval_id: str
    result: Literal["executed", "cancelled", "failed"]
    completed_at: str
    output: Dict[str, Any]


class EnrollInput(TypedDict, total=False):
    fleet_id: str
    token: str
    display_name: str
    runtime: Literal["custom", "openclaw", "langgraph", "autogen"]
    hostname: str
    capabilities: List[str]


class AckInput(TypedDict):
    message_id: str
    status: Literal["received"]
    received_at: str


# --- Typed response shapes -------------------------------------------------

@dataclass
class EnrollResponse:
    agent_id: str
    secret: str
    relay_base_url: str
    heartbeat_interval_seconds: int
    poll_interval_seconds: int
    policy_profile: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "EnrollResponse":
        return cls(
            agent_id=data["agent_id"],
            secret=data["secret"],
            relay_base_url=data["relay_base_url"],
            heartbeat_interval_seconds=data["heartbeat_interval_seconds"],
            poll_interval_seconds=data["poll_interval_seconds"],
            policy_profile=data.get("policy_profile", "default"),
        )

    def to_credentials(self) -> AgentCredentials:
        return AgentCredentials(
            agent_id=self.agent_id,
            secret=self.secret,
            relay_base_url=self.relay_base_url,
            heartbeat_interval_seconds=self.heartbeat_interval_seconds,
            poll_interval_seconds=self.poll_interval_seconds,
        )


@dataclass
class ActionDecision:
    """One of: {'decision': 'allow'} | {'decision': 'deny'} |
    {'decision': 'pending_approval', 'approval_id': '...'}."""

    decision: Literal["allow", "deny", "pending_approval"]
    approval_id: Optional[str] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ActionDecision":
        return cls(
            decision=data["decision"],
            approval_id=data.get("approval_id"),
            raw=data,
        )


@dataclass
class SendMessageResult:
    message_id: str
    status: str
    queued_at: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SendMessageResult":
        return cls(
            message_id=data["message_id"],
            status=data["status"],
            queued_at=data["queued_at"],
        )


@dataclass
class HeartbeatResult:
    ok: bool
    next_heartbeat_due_seconds: int

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "HeartbeatResult":
        return cls(
            ok=bool(data.get("ok", True)),
            next_heartbeat_due_seconds=int(
                data.get("next_heartbeat_due_seconds", 0)
            ),
        )


@dataclass
class ApprovalStatus:
    id: str
    status: str
    action_type: str
    risk_level: str
    summary: str
    requested_at: str
    resolved_at: Optional[str]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ApprovalStatus":
        return cls(
            id=data["id"],
            status=data["status"],
            action_type=data["action_type"],
            risk_level=data["risk_level"],
            summary=data["summary"],
            requested_at=data["requested_at"],
            resolved_at=data.get("resolved_at"),
        )


# Convenience union types / aliases
PayloadDict = Dict[str, Any]

"""Ekho Python SDK — signed agent client for the Ekho relay.

Public API mirrors @drakon-systems/ekho-sdk for Node.js.
"""

from .adapter import AdapterHooks, EkhoAgentAdapter
from .client import EkhoAgentClient, EkhoRequestError
from .types import (
    AckInput,
    ActionDecision,
    ActionResultInput,
    AgentCredentials,
    ApprovalStatus,
    ControlMessage,
    EnrollInput,
    EnrollResponse,
    HeartbeatInput,
    HeartbeatResult,
    InboxMessage,
    InboxResponse,
    ProposeActionInput,
    SendMessageInput,
    SendMessageResult,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # Client / adapter
    "EkhoAgentClient",
    "EkhoAgentAdapter",
    "AdapterHooks",
    "EkhoRequestError",
    # Credentials + enrol
    "AgentCredentials",
    "EnrollInput",
    "EnrollResponse",
    # Message shapes
    "SendMessageInput",
    "SendMessageResult",
    "InboxMessage",
    "InboxResponse",
    "ControlMessage",
    "AckInput",
    # Heartbeats / actions
    "HeartbeatInput",
    "HeartbeatResult",
    "ProposeActionInput",
    "ActionDecision",
    "ActionResultInput",
    "ApprovalStatus",
]

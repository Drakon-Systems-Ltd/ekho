"""Ekho Python SDK — signed agent client for the Ekho relay.

Public API mirrors @drakon-systems/ekho-sdk for Node.js.
"""

from .adapter import AdapterHooks, EkhoAgentAdapter
from .client import EkhoAgentClient, EkhoRequestError
from . import identity
from .identity import (
    agent_key_endorsement_payload,
    canonicalize,
    endorsement_payload,
    key_id,
    public_key_b64url_from_seed,
    sign_canonical,
    verify_canonical,
)
from .verify import VerificationResult, verify_inbound
from .types import (
    AckInput,
    ActionDecision,
    ActionResultInput,
    AgentCredentials,
    ApprovalStatus,
    AttachmentMeta,
    ControlMessage,
    EnrollInput,
    EnrollResponse,
    HeartbeatInput,
    HeartbeatResult,
    InboxMessage,
    InboxResponse,
    OperatorKeyEntry,
    ProposeActionInput,
    RosterEntry,
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
    "RosterEntry",
    "OperatorKeyEntry",
    "ControlMessage",
    # Verifiable identity (Ed25519)
    "identity",
    "canonicalize",
    "sign_canonical",
    "verify_canonical",
    "key_id",
    "public_key_b64url_from_seed",
    "endorsement_payload",
    "agent_key_endorsement_payload",
    "verify_inbound",
    "VerificationResult",
    "AckInput",
    "AttachmentMeta",
    # Heartbeats / actions
    "HeartbeatInput",
    "HeartbeatResult",
    "ProposeActionInput",
    "ActionDecision",
    "ActionResultInput",
    "ApprovalStatus",
]

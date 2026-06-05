"""Hermes plugin entry point — registers ekho_send + ekho_inbox.

Mirrors the OpenClaw Ekho plugin's two-tool surface on top of the Ekho Python
SDK. On ``register`` it reads config from the environment and, if a relay is
configured, connects (enroll/load + startup heartbeat) so the agent shows
healthy in the operator console before any tool is called. Connection failure
is non-fatal: the tools reconnect lazily on first use.

IMPORTANT: every Hermes-runtime import lives *inside* a function (``register``
or a handler), never at module import time, so the package can be imported and
unit-tested without Hermes present.
"""

from __future__ import annotations

import json
import logging

from .attachments import download_inbox_attachments, upload_paths
from .config import EkhoConfig
from .connection import ensure_connected
from .messages import build_send_input, format_inbox

logger = logging.getLogger("ekho_hermes.plugin")


def _tool_result(data):
    """Hermes' JSON tool-result encoder, with a stdlib fallback for tests."""
    try:
        from tools.registry import tool_result  # type: ignore

        return tool_result(data)
    except Exception:  # noqa: BLE001 — outside the Hermes runtime
        return json.dumps(data, ensure_ascii=False)


def _tool_error(message: str):
    try:
        from tools.registry import tool_error  # type: ignore

        return tool_error(message)
    except Exception:  # noqa: BLE001
        return json.dumps({"error": str(message)}, ensure_ascii=False)


# --- Tool schemas (JSON Schema dicts) --------------------------------------

EKHO_SEND_SCHEMA = {
    "type": "object",
    "properties": {
        "recipient_agent_id": {
            "type": "string",
            "description": (
                "Ekho agent_id of the recipient, or 'broadcast' for the whole "
                "fleet."
            ),
        },
        "message": {
            "type": "string",
            "description": "The message text to send.",
        },
        "conversation_id": {
            "type": "string",
            "description": "Existing conversation id to thread under (optional).",
        },
        "attachment_paths": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "Local file path(s) to attach. Each is read, base64-encoded, "
                "and uploaded; must be an allowed type (images png/jpg/gif/webp, "
                "or pdf/txt/md/csv/json) under the 25 MiB cap. Max 10 per message."
            ),
        },
    },
    "required": ["recipient_agent_id", "message"],
}

EKHO_INBOX_SCHEMA = {
    "type": "object",
    "properties": {},
}

EKHO_SEND_DESCRIPTION = (
    "Send a message to another agent in your fleet via the Ekho relay. Use this "
    "to delegate a task, ask a question, hand off work, or coordinate. Set "
    "recipient_agent_id to 'broadcast' to reach the whole fleet. Optionally "
    "attach local files via attachment_paths."
)

EKHO_INBOX_DESCRIPTION = (
    "Read the pending Ekho messages from other agents (and your fleet operator) "
    "in your inbox. Returns each message's sender, kind, body, and any "
    "downloaded attachment file paths, plus a roster of teammates you can "
    "delegate to. Operator messages are labelled with their verified-principal "
    "trust status."
)


def _check_relay_configured() -> bool:
    """Gate the tools on EKHO_RELAY_URL being set (mirrors check_fn pattern)."""
    return EkhoConfig.from_env().has_relay


def _handle_ekho_send(args: dict, **_kw) -> str:
    """ekho_send handler. Signature matches Hermes: ``(args, **kw) -> str``."""
    recipient = str(args.get("recipient_agent_id") or "").strip()
    message = args.get("message")
    if not recipient:
        return _tool_error("recipient_agent_id is required")
    if not isinstance(message, str) or not message:
        return _tool_error("message is required")

    config = EkhoConfig.from_env()
    if not config.has_relay:
        return _tool_error("EKHO_RELAY_URL is not configured")

    conversation_id = args.get("conversation_id") or None
    attachment_paths = args.get("attachment_paths") or []

    try:
        conn = ensure_connected(config)
    except Exception as exc:  # noqa: BLE001
        return _tool_error(f"Ekho relay connection failed: {exc}")

    try:
        attachment_ids = upload_paths(conn.client, attachment_paths)
    except ValueError as exc:
        return _tool_error(str(exc))
    except Exception as exc:  # noqa: BLE001
        return _tool_error(f"attachment upload failed: {exc}")

    payload = build_send_input(
        recipient,
        message,
        conversation_id=conversation_id,
        attachment_ids=attachment_ids,
    )

    try:
        result = conn.client.send_message(payload)
    except Exception as exc:  # noqa: BLE001
        return _tool_error(f"Ekho send failed: {exc}")

    return _tool_result(
        {
            "sent": True,
            "message_id": getattr(result, "message_id", None),
            "conversation_id": payload.get("conversation_id"),
            "recipient": recipient,
            "attachments": attachment_ids,
        }
    )


def _handle_ekho_inbox(args: dict, **_kw) -> str:
    """ekho_inbox handler. Reads + acks the inbox, downloads attachments."""
    config = EkhoConfig.from_env()
    if not config.has_relay:
        return _tool_error("EKHO_RELAY_URL is not configured")

    try:
        conn = ensure_connected(config)
    except Exception as exc:  # noqa: BLE001
        return _tool_error(f"Ekho relay connection failed: {exc}")

    try:
        inbox = conn.client.get_inbox()
    except Exception as exc:  # noqa: BLE001
        return _tool_error(f"Ekho inbox read failed: {exc}")

    messages = list(inbox.messages)

    # Ack everything we just consumed so the relay doesn't redeliver. One bad
    # ack must not fail the whole read.
    if messages:
        from .messages import iso_now

        acks = [
            {
                "message_id": m.message_id,
                "status": "received",
                "received_at": iso_now(),
            }
            for m in messages
        ]
        try:
            conn.client.ack_messages(acks)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[ekho] ack failed: %s", exc)

    # Download attachments to a scoped local dir, then merge each message's
    # local paths in so format_inbox surfaces them.
    local_attachments = download_inbox_attachments(conn.client, messages)
    enriched = []
    for message, locals_for_msg in zip(messages, local_attachments):
        enriched.append(
            {
                "message_type": message.message_type,
                "body": message.body,
                "conversation_id": message.conversation_id,
                "created_at": message.created_at,
                "sender_kind": message.sender_kind,
                "sender_agent_id": message.sender_agent_id,
                "attachment_local_paths": locals_for_msg,
            }
        )

    result = format_inbox(
        enriched,
        operator_trusted=inbox.operator_trusted,
        roster=inbox.roster,
    )
    return _tool_result(result)


def register(ctx) -> None:
    """Plugin entry point. Called once by the Hermes plugin loader.

    Connects on startup (non-fatal) and registers the two Ekho tools. Reading
    config + connecting happen here, not at import time, so importing the
    package never requires the Hermes runtime.
    """
    config = EkhoConfig.from_env()
    if not config.has_relay:
        logger.info("[ekho] EKHO_RELAY_URL not set; Ekho tools not registered")
        return

    # Startup connect: enroll/load + begin heartbeating so the agent shows
    # healthy in the operator console before any tool call. Non-fatal — the
    # tools reconnect lazily on first use.
    try:
        ensure_connected(config)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[ekho] startup connect failed: %s", exc)

    ctx.register_tool(
        name="ekho_send",
        toolset="ekho",
        schema=EKHO_SEND_SCHEMA,
        handler=_handle_ekho_send,
        check_fn=_check_relay_configured,
        requires_env=["EKHO_RELAY_URL"],
        description=EKHO_SEND_DESCRIPTION,
        emoji="📤",
    )
    ctx.register_tool(
        name="ekho_inbox",
        toolset="ekho",
        schema=EKHO_INBOX_SCHEMA,
        handler=_handle_ekho_inbox,
        check_fn=_check_relay_configured,
        requires_env=["EKHO_RELAY_URL"],
        description=EKHO_INBOX_DESCRIPTION,
        emoji="📥",
    )

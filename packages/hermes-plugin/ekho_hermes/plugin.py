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

import base64
import json
import logging
import os
from datetime import datetime, timezone

from .attachments import download_inbox_attachments, upload_paths
from .autoreply import get_cached_inbox
from .config import EkhoConfig
from .connection import ensure_connected, start_autoreply_once
from .credentials import load_or_create_identity
from .messages import build_send_input, format_inbox
from .verification import build_signed_send_fields

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
                "fleet. Omit when sending to a room (use room_id)."
            ),
        },
        "room_id": {
            "type": "string",
            "description": (
                "Send to a topic room: every room member receives the message. "
                "Takes precedence over recipient_agent_id."
            ),
        },
        "message": {
            "type": "string",
            "description": "The message text to send.",
        },
        "conversation_id": {
            "type": "string",
            "description": (
                "Existing conversation id to thread under (optional; ignored "
                "when room_id is set — the room is the conversation)."
            ),
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
    "required": ["message"],
}

EKHO_INBOX_SCHEMA = {
    "type": "object",
    "properties": {},
}

EKHO_OPEN_ROOM_SCHEMA = {
    "type": "object",
    "properties": {
        "topic": {
            "type": "string",
            "description": (
                "The room name — a short, specific topic (e.g. 'Invoice sync "
                "rollout')."
            ),
        },
        "member_agent_ids": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "Ekho agent_ids of the OTHER agents to include (you are added "
                "automatically). Must be agents in your fleet."
            ),
        },
    },
    "required": ["topic"],
}

EKHO_SEND_DESCRIPTION = (
    "Send a message to another agent in your fleet via the Ekho relay. Use this "
    "to delegate a task, ask a question, hand off work, or coordinate. Set "
    "recipient_agent_id to 'broadcast' to reach the whole fleet, or set room_id "
    "to post into a topic room (every member receives it). Optionally attach "
    "local files via attachment_paths."
)

EKHO_OPEN_ROOM_DESCRIPTION = (
    "Open a named topic room for a multi-step collaboration or a handoff you'll "
    "iterate on, then continue there instead of repeated direct messages. The "
    "room is scoped to the agents you list (you are added automatically) and is "
    "visible to the operator, who can follow and chime in. Returns the room id — "
    "send into it with ekho_send using room_id."
)

EKHO_INBOX_DESCRIPTION = (
    "Re-read the Ekho messages you are currently handling. You receive operator "
    "messages automatically — new fleet messages are delivered to you as turns, "
    "so you do not need to poll. Use this to re-read your most recent inbound "
    "batch (e.g. to recall sender ids / conversation ids while replying via "
    "ekho_send), to download any attachments to local file paths you can open, "
    "and to see the live roster of teammates you can delegate to. Operator "
    "messages are labelled with their verified-principal trust status."
)


def _check_relay_configured() -> bool:
    """Gate the tools on EKHO_RELAY_URL being set (mirrors check_fn pattern)."""
    return EkhoConfig.from_env().has_relay


def _handle_ekho_send(args: dict, **_kw) -> str:
    """ekho_send handler. Signature matches Hermes: ``(args, **kw) -> str``."""
    recipient = str(args.get("recipient_agent_id") or "").strip()
    room_id = str(args.get("room_id") or "").strip()
    message = args.get("message")
    if not recipient and not room_id:
        return _tool_error(
            "provide recipient_agent_id (an agent id or 'broadcast') or room_id"
        )
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
        room_id=room_id or None,
    )

    # Best-effort: sign the outbound message so recipients can verify it's us.
    # An unsigned send is still valid (graceful) — skip on any missing prereq.
    try:
        config_dir = getattr(conn, "config_dir", None)
        if config_dir and config.fleet_id:
            ident = load_or_create_identity(config_dir)
            nonce = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode("ascii")
            sent_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            payload.update(
                build_signed_send_fields(
                    identity_obj=ident,
                    fleet_id=config.fleet_id,
                    self_agent_id=conn.credentials.agent_id,
                    recipient=payload.get("recipient", {}),
                    conversation_id=payload.get("conversation_id", ""),
                    body_text=message,
                    nonce=nonce,
                    sent_at=sent_at,
                    # v2 (#9): bind what the relay could otherwise relabel/swap.
                    message_type="direct",
                    priority="normal",
                    attachments=attachment_ids,
                )
            )
    except Exception as exc:  # noqa: BLE001 — unsigned send is still valid
        logger.debug("[ekho] outbound signing skipped: %s", exc)

    try:
        result = conn.client.send_message(payload)
    except Exception as exc:  # noqa: BLE001
        return _tool_error(f"Ekho send failed: {exc}")

    out = {
        "sent": True,
        "message_id": getattr(result, "message_id", None),
        "conversation_id": payload.get("conversation_id"),
        "recipient": room_id or recipient,
        "attachments": attachment_ids,
    }
    if room_id:
        out["room_id"] = room_id
    return _tool_result(out)


def _handle_ekho_open_room(args: dict, **_kw) -> str:
    """ekho_open_room handler. Opens a named topic room scoped to a set of fleet
    agents and returns the room id so the agent can continue there via ekho_send
    with room_id."""
    topic = str(args.get("topic") or "").strip()
    if not topic:
        return _tool_error("topic is required")

    config = EkhoConfig.from_env()
    if not config.has_relay:
        return _tool_error("EKHO_RELAY_URL is not configured")

    members = [
        str(m)
        for m in (args.get("member_agent_ids") or [])
        if isinstance(m, str) and m
    ]

    try:
        conn = ensure_connected(config)
    except Exception as exc:  # noqa: BLE001
        return _tool_error(f"Ekho relay connection failed: {exc}")

    try:
        room = conn.client.create_room(topic, members)
    except Exception as exc:  # noqa: BLE001
        return _tool_error(f"Ekho open room failed: {exc}")

    return _tool_result(
        {
            "opened": True,
            "room_id": getattr(room, "id", None),
            "name": getattr(room, "name", topic),
            "members": getattr(room, "members", []),
            "next": (
                f'Send into this room with ekho_send using '
                f'room_id="{getattr(room, "id", "")}".'
            ),
        }
    )


def _handle_ekho_inbox(args: dict, **_kw) -> str:
    """ekho_inbox handler. Reads the auto-reply loop's most-recent cached batch
    (no re-poll, no ack — the loop is the single consumer and already acked) and
    downloads any attachments to scoped local paths on demand."""
    config = EkhoConfig.from_env()
    if not config.has_relay:
        return _tool_error("EKHO_RELAY_URL is not configured")

    try:
        conn = ensure_connected(config)
    except Exception as exc:  # noqa: BLE001
        return _tool_error(f"Ekho relay connection failed: {exc}")

    # The background auto-reply loop is the single consumer of the relay inbox:
    # it polls (consuming + delivering) and acks. Reading its cache here instead
    # of polling again means a manual call during a turn can never double-consume
    # rows the loop is mid-processing — and we never ack (the loop already did).
    cached = get_cached_inbox()
    messages = cached["messages"]

    # Download attachments to a scoped local dir, then merge each message's
    # local paths in so format_inbox surfaces them.
    local_attachments = download_inbox_attachments(conn.client, messages)
    enriched = []
    for message, locals_for_msg in zip(messages, local_attachments):
        enriched.append(
            {
                "message_id": message.message_id,
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
        operator_trusted=cached["operator_trusted"],
        roster=cached["roster"],
        verifications=cached.get("verifications"),
        peer_autoreply=cached.get("peer_autoreply", False),
        peer_turn_budget=cached.get("peer_turn_budget"),
        peer_turns_used=cached.get("peer_turns_used"),
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
    # healthy in the operator console before any tool call, then start the
    # background auto-reply loop so the agent answers the verified operator
    # without waiting for a tool call. Non-fatal — the tools reconnect lazily on
    # first use. A spawned one-shot reply turn carries EKHO_AUTOREPLY_DISABLE=1,
    # so start_autoreply_once is a no-op there (the loop-breaker).
    try:
        conn = ensure_connected(config)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[ekho] startup connect failed: %s", exc)
    else:
        try:
            start_autoreply_once(
                conn,
                peer_enabled=config.peer_autoreply,
                peer_turn_budget=config.peer_turn_budget,
                # #5: how strictly peers must prove themselves before waking a
                # turn ("warn" default; EKHO_REQUIRE_SIGNED sets it per process).
                require_signed=config.require_signed,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("[ekho] auto-reply start failed: %s", exc)

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
        name="ekho_open_room",
        toolset="ekho",
        schema=EKHO_OPEN_ROOM_SCHEMA,
        handler=_handle_ekho_open_room,
        check_fn=_check_relay_configured,
        requires_env=["EKHO_RELAY_URL"],
        description=EKHO_OPEN_ROOM_DESCRIPTION,
        emoji="🚪",
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

    _maybe_register_turn_health_hook(ctx)


def _maybe_register_turn_health_hook(ctx) -> None:
    """Feature-detect a host hook that fires when a model call finishes, and fold
    its outcome into the turn-health window (parity with the OpenClaw plugin's
    ``model_call_ended``). The Hermes ctx hook surface varies by version, so we
    probe a few registration method + event names and degrade to a silent no-op
    if none are present — Hermes agents then keep full connection health + the
    env model label exactly as before, just without cognitive telemetry."""
    from .connection import note_model_call_ended

    def _on_ended(event, *_a, **_kw):
        try:
            e = event if isinstance(event, dict) else getattr(event, "__dict__", {}) or {}
            note_model_call_ended(e.get("outcome"), e.get("errorCategory") or e.get("failureKind") or e.get("error_category"))
        except Exception as exc:  # noqa: BLE001 — never let telemetry break a turn
            logger.debug("[ekho] model_call_ended handler error: %s", exc)

    register_fns = ("register_hook", "add_hook", "on")
    event_names = ("model_call_ended", "model_call_finished", "after_model_call")
    for fn_name in register_fns:
        fn = getattr(ctx, fn_name, None)
        if not callable(fn):
            continue
        for ev in event_names:
            try:
                fn(ev, _on_ended)
                logger.info("[ekho] turn-health telemetry wired via ctx.%s(%r)", fn_name, ev)
                return
            except Exception as exc:  # noqa: BLE001 — try the next candidate
                logger.debug("[ekho] hook %s(%s) unavailable: %s", fn_name, ev, exc)
    logger.info("[ekho] no model-call hook on this Hermes ctx; turn-health stays env-only")

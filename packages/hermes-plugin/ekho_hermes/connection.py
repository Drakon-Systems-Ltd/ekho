"""Module-singleton Ekho relay connection + background heartbeat.

Mirrors the OpenClaw plugin's ``connection.ts``: ``ensure_connected`` enrolls
(or loads saved credentials), builds ONE ``EkhoAgentClient``, and starts ONE
daemon heartbeat thread so the agent shows healthy in the operator console
without first calling a tool. Idempotent — safe to call from every tool
invocation; the real work happens once.

This is threaded (not asyncio), matching the SDK's style.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Callable, Optional

from ekho import AgentCredentials, EkhoAgentClient

from . import autoreply
from .config import EkhoConfig
from .credentials import enroll_or_load

logger = logging.getLogger("ekho_hermes.connection")

# Where saved credentials live. Hermes deploys this plugin under
# ~/.hermes/plugins/ekho/, so we scope state under ~/.hermes/ekho/.
DEFAULT_CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".hermes", "ekho")


@dataclass
class Connection:
    """A live relay connection: the shared client + the resolved credentials."""

    client: EkhoAgentClient
    credentials: AgentCredentials


# Module singletons — guarded by _lock so concurrent tool calls build at most
# one connection and one heartbeat thread.
_connection: Connection | None = None
_lock = threading.Lock()
_heartbeat_thread: threading.Thread | None = None
_heartbeat_stop = threading.Event()
# The background auto-reply loop's stop() callable, started at most once.
_autoreply_stop: Optional[Callable[[], None]] = None


def _heartbeat_loop(client: EkhoAgentClient, interval_seconds: int) -> None:
    """Immediate beat, then every ``interval_seconds``. Survives all errors."""
    while not _heartbeat_stop.is_set():
        try:
            client.heartbeat({"status": "healthy"})
        except Exception as exc:  # noqa: BLE001 — a relay blip must not kill the loop
            logger.debug("[ekho] heartbeat failed: %s", exc)
        # Wake promptly on shutdown() instead of sleeping the full interval.
        _heartbeat_stop.wait(max(1, int(interval_seconds)))


def ensure_connected(
    config: EkhoConfig,
    *,
    config_dir: str = DEFAULT_CONFIG_DIR,
    start_heartbeat: bool = True,
) -> Connection:
    """Return the shared :class:`Connection`, building it once.

    On first call: resolve credentials (explicit / saved / enroll), build the
    SDK client, and start the daemon heartbeat thread (unless
    ``start_heartbeat`` is False). Subsequent calls return the existing
    connection.
    """
    global _connection, _heartbeat_thread

    if _connection is not None:
        return _connection

    with _lock:
        # Re-check under the lock — another thread may have connected while we
        # waited.
        if _connection is not None:
            return _connection

        credentials = enroll_or_load(config, config_dir)
        client = EkhoAgentClient(credentials)
        connection = Connection(client=client, credentials=credentials)

        if start_heartbeat and _heartbeat_thread is None:
            _heartbeat_stop.clear()
            interval = config.heartbeat_interval_seconds
            thread = threading.Thread(
                target=_heartbeat_loop,
                args=(client, interval),
                name="ekho-heartbeat",
                daemon=True,
            )
            thread.start()
            _heartbeat_thread = thread

        _connection = connection
        logger.info(
            "[ekho] connected as %s -> %s",
            credentials.agent_id,
            credentials.relay_base_url,
        )
        return _connection


def start_autoreply_once(
    conn: Connection,
    *,
    env: Optional[dict] = None,
    start_fn: Optional[Callable[..., Callable[[], None]]] = None,
    peer_enabled: bool = False,
    peer_turn_budget: int = autoreply.DEFAULT_PEER_TURN_BUDGET,
) -> Optional[Callable[[], None]]:
    """Start the background auto-reply loop exactly once for this process.

    Mirrors the OpenClaw plugin's ``maybeStartAutoReply``: a process carrying
    ``EKHO_AUTOREPLY_DISABLE=1`` (the spawned one-shot reply turn) connects for
    the ``ekho_send`` tool but never starts its own loop — the structural
    loop-breaker. ``peer_enabled`` / ``peer_turn_budget`` drive bounded
    agent-to-agent delegation. ``env`` and ``start_fn`` are injectable for tests.
    """
    global _autoreply_stop
    env = os.environ if env is None else env
    if env.get(autoreply.EKHO_AUTOREPLY_DISABLE_ENV) == "1":
        logger.info(
            "[ekho] auto-reply disabled in this process (%s)",
            autoreply.EKHO_AUTOREPLY_DISABLE_ENV,
        )
        return None
    with _lock:
        if _autoreply_stop is not None:
            return _autoreply_stop
        starter = start_fn or autoreply.start_autoreply
        _autoreply_stop = starter(
            client=conn.client,
            self_agent_id=conn.credentials.agent_id,
            log=logger,
            peer_enabled=peer_enabled,
            peer_turn_budget=peer_turn_budget,
        )
        return _autoreply_stop


def reset_autoreply_singleton() -> None:
    """Clear the auto-reply singleton without stopping a live loop (test hook)."""
    global _autoreply_stop
    _autoreply_stop = None


def shutdown() -> None:
    """Stop the heartbeat + auto-reply threads and reset the singleton."""
    global _connection, _heartbeat_thread, _autoreply_stop

    if _autoreply_stop is not None:
        try:
            _autoreply_stop()
        except Exception:  # noqa: BLE001
            pass
        _autoreply_stop = None

    _heartbeat_stop.set()
    thread = _heartbeat_thread
    if thread is not None and thread.is_alive():
        thread.join(timeout=5.0)
    _heartbeat_thread = None

    conn = _connection
    if conn is not None:
        try:
            conn.client.close()
        except Exception:  # noqa: BLE001
            pass
    _connection = None

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
import time
from dataclasses import dataclass
from typing import Callable, Optional

from ekho import AgentCredentials, EkhoAgentClient
from ekho.identity import key_id as _derive_key_id

from . import autoreply
from .config import EkhoConfig
from .credentials import (
    enroll_or_load,
    load_or_create_identity,
    save_identity,
    take_enroll_operator_keys,
)
from .verification import sync_pinned_operator_keys

logger = logging.getLogger("ekho_hermes.connection")

# Where saved credentials live. Hermes deploys this plugin under
# ~/.hermes/plugins/ekho/. State used to live in ~/.hermes/ekho/, but the
# gateway runs with cwd ~/.hermes, so a bare importable-named ekho/ dir there
# satisfies find_spec("ekho") as an empty namespace package and shadows the
# real SDK the moment the venv copy goes missing (field case: Tars, 2-3 Aug
# 2026 — silent plugin death). "ekho-state" contains a dash, which can never
# be a Python module name, so the class of failure is structurally gone.
DEFAULT_CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".hermes", "ekho-state")
_LEGACY_CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".hermes", "ekho")


def _migrate_legacy_config_dir() -> None:
    """One-shot rename of the legacy ~/.hermes/ekho state dir to ekho-state.

    Only fires when the legacy dir exists, the new one doesn't, and the legacy
    dir really is plugin state (has credentials/identity) — never touches an
    unrelated dir that merely shares the name.
    """
    legacy, target = _LEGACY_CONFIG_DIR, DEFAULT_CONFIG_DIR
    if os.path.isdir(target) or not os.path.isdir(legacy):
        return
    markers = ("credentials.json", "identity.json", ".ekho-credentials.json")
    if not any(os.path.exists(os.path.join(legacy, m)) for m in markers):
        return
    try:
        os.rename(legacy, target)
        logger.info("[ekho] migrated state dir %s -> %s", legacy, target)
    except OSError as exc:
        logger.warning("[ekho] could not migrate state dir %s: %s", legacy, exc)


@dataclass
class Connection:
    """A live relay connection: the shared client + the resolved credentials."""

    client: EkhoAgentClient
    credentials: AgentCredentials
    config_dir: Optional[str] = None


# Module singletons — guarded by _lock so concurrent tool calls build at most
# one connection and one heartbeat thread.
_connection: Connection | None = None
_lock = threading.Lock()
_heartbeat_thread: threading.Thread | None = None
_heartbeat_stop = threading.Event()
# The background auto-reply loop's stop() callable, started at most once.
_autoreply_stop: Optional[Callable[[], None]] = None


# ---- Turn / model-call health (operator health board) --------------------
# Parity with the OpenClaw plugin: the heartbeat status is always "healthy" (it
# only proves the CONNECTION is up). An agent whose model fails every turn (bad
# auth/404/quota) keeps heartbeating while its brain is dead. The host calls
# note_model_call_ended(outcome, category) per finished model call; we fold each
# into a rolling window and report a truthful turn_health in the heartbeat.

_TURN_HEALTH_WINDOW_MS = 60 * 60_000  # 1h rolling window
_TURN_HEALTH_MAX = 200  # cap retained samples
_model_calls: list[tuple[float, bool, str]] = []  # (epoch_ms, ok, category)
_turn_lock = threading.Lock()


def note_model_call_ended(outcome: Optional[str], category: Optional[str] = None, now_ms: Optional[float] = None) -> None:
    """Fold a finished model call into the rolling window (pruning old/oversized)."""
    ts = now_ms if now_ms is not None else time.time() * 1000.0
    ok = outcome == "completed"
    with _turn_lock:
        _model_calls.append((ts, ok, "" if ok else (category or "error")))
        if len(_model_calls) > _TURN_HEALTH_MAX:
            del _model_calls[:-_TURN_HEALTH_MAX]
        cutoff = ts - _TURN_HEALTH_WINDOW_MS
        while _model_calls and _model_calls[0][0] < cutoff:
            _model_calls.pop(0)


def derive_turn_health(calls: list[tuple[float, bool, str]], now_ms: float) -> dict:
    """Truthful cognitive-health verdict from recent outcomes (pure — tested directly).
    down: calls exist but none completed (brain failing every attempt), or a run of
    >=3 consecutive failures after health. degraded: errors mixed with successes.
    ok: recent success, no error tail. unknown: no calls in window (never invented)."""
    cutoff = now_ms - _TURN_HEALTH_WINDOW_MS
    win = [c for c in calls if c[0] >= cutoff]
    if not win:
        return {"turn_health": "unknown", "errors_1h": 0, "calls_1h": 0}
    errors = [c for c in win if not c[1]]
    has_success = any(c[1] for c in win)
    tail = 0
    for c in reversed(win):
        if c[1]:
            break
        tail += 1
    if not has_success:
        verdict = "down"
    elif tail >= 3:
        verdict = "down"
    elif errors:
        verdict = "degraded"
    else:
        verdict = "ok"
    last_err = next((c[2] for c in reversed(win) if not c[1]), "")
    last_ok = next((c[0] for c in reversed(win) if c[1]), None)
    return {
        "turn_health": verdict,
        "errors_1h": len(errors),
        "calls_1h": len(win),
        "last_error": None if verdict == "ok" else (last_err or None),
        "last_ok_ms": last_ok,
    }


def _turn_health_metrics(now_ms: Optional[float] = None) -> dict:
    """Snapshot the current turn-health metrics for the heartbeat (string-valued)."""
    ts = now_ms if now_ms is not None else time.time() * 1000.0
    with _turn_lock:
        h = derive_turn_health(list(_model_calls), ts)
    if h["turn_health"] == "unknown":
        return {}
    m = {
        "turn_health": h["turn_health"],
        "model_errors_1h": str(h["errors_1h"]),
        "model_calls_1h": str(h["calls_1h"]),
    }
    if h.get("last_error"):
        m["last_error"] = h["last_error"]
    if h.get("last_ok_ms"):
        m["last_ok_at"] = _iso_from_ms(h["last_ok_ms"])
    return m


def _iso_from_ms(ms: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ms % 1000):03d}Z"


def _reset_turn_health() -> None:
    """Test seam: clear the rolling turn-health window."""
    with _turn_lock:
        _model_calls.clear()


def _report_metrics() -> dict:
    """Best-effort agent metrics for the operator health board. Model/provider from
    env (EKHO_REPORT_MODEL / EKHO_REPORT_PROVIDER); turn_health from real model-call
    outcomes so a connected-but-brain-dead agent reads red, not green."""
    metrics: dict = {}
    model = (os.environ.get("EKHO_REPORT_MODEL") or "").strip()
    provider = (os.environ.get("EKHO_REPORT_PROVIDER") or "").strip()
    if model:
        metrics["model"] = model
    if provider:
        metrics["provider"] = provider
    metrics.update(_turn_health_metrics())
    return metrics


def _heartbeat_loop(client: EkhoAgentClient, interval_seconds: int) -> None:
    """Immediate beat, then every ``interval_seconds``. Survives all errors."""
    while not _heartbeat_stop.is_set():
        try:
            client.heartbeat({"status": "healthy", "metrics": _report_metrics()})
        except Exception as exc:  # noqa: BLE001 — a relay blip must not kill the loop
            logger.debug("[ekho] heartbeat failed: %s", exc)
        # Wake promptly on shutdown() instead of sleeping the full interval.
        _heartbeat_stop.wait(max(1, int(interval_seconds)))


def register_and_bootstrap_identity(
    client: Any,
    *,
    operator_pubkey: Optional[str],
    config_dir: str,
    log: logging.Logger = logger,
) -> Any:
    """Register the agent's identity key with the relay and bootstrap-pin the
    operator key(s) from config (the trusted out-of-band channel for agents that
    predate signing). Best-effort: a relay blip must never break connecting.
    ``operator_pubkey`` is comma-separated "<b64url>" or "<key_id>:<b64url>"."""
    identity = load_or_create_identity(config_dir)
    try:
        client.register_identity_key(identity.public_key_b64url())
    except Exception as exc:  # noqa: BLE001
        log.warning("[ekho] identity-key registration failed: %s", exc)
    changed = False
    for entry in (operator_pubkey or "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        pub = entry.split(":", 1)[1].strip() if ":" in entry else entry
        if not pub:
            continue
        try:
            kid = _derive_key_id(pub)
        except Exception:  # noqa: BLE001 — skip a malformed key, don't crash
            continue
        # #14: the seed is a bootstrap hint, never an override. Without this
        # check the poll's revocation drop and the config re-pin fought on every
        # wake and the config won, so a compromised key stayed trusted forever.
        # Warn loudly: the operator's config is stale and only they can fix it.
        revoked_at = (getattr(identity, "revoked_operator_keys", None) or {}).get(kid)
        if revoked_at:
            log.warning(
                "[ekho] ignoring configured operator_pubkey %s: the relay reported it REVOKED at %s. "
                "Remove it from EKHO_OPERATOR_PUBKEY — a revoked key is never re-pinned.",
                kid,
                revoked_at,
            )
            if identity.pinned_operator_keys.pop(kid, None) is not None:
                changed = True
            continue
        if identity.pinned_operator_keys.get(kid) != pub:
            identity.pinned_operator_keys[kid] = pub
            changed = True
    if changed:
        save_identity(config_dir, identity)
    return identity


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

        if config_dir == DEFAULT_CONFIG_DIR:
            _migrate_legacy_config_dir()
        credentials = enroll_or_load(config, config_dir)
        client = EkhoAgentClient(credentials)
        connection = Connection(client=client, credentials=credentials, config_dir=config_dir)

        # Register our identity key + bootstrap-pin the operator key (best-effort).
        try:
            identity = register_and_bootstrap_identity(
                client, operator_pubkey=getattr(config, "operator_pubkey", None), config_dir=config_dir
            )
            # TOFU (#5): pin the operator keys the relay handed us at enrollment —
            # sent since the beginning, dropped on the floor until now. Only fires
            # for a never-pinned identity (see sync_pinned_operator_keys); explicit
            # config pins above always win.
            enroll_keys = take_enroll_operator_keys()
            if (
                enroll_keys
                and identity is not None
                and sync_pinned_operator_keys(
                    identity, enroll_keys, fleet_id=config.fleet_id
                )
            ):
                save_identity(config_dir, identity)
                logger.info(
                    "[ekho] pinned %d operator key(s) from enrollment (TOFU)",
                    len(identity.pinned_operator_keys),
                )
        except Exception as exc:  # noqa: BLE001 — never block connecting
            logger.warning("[ekho] identity bootstrap failed: %s", exc)

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
    require_signed: str = "warn",
) -> Optional[Callable[[], None]]:
    """Start the background auto-reply loop exactly once for this process.

    Mirrors the OpenClaw plugin's ``maybeStartAutoReply``: a process carrying
    ``EKHO_AUTOREPLY_DISABLE=1`` (the spawned one-shot reply turn) connects for
    the ``ekho_send`` tool but never starts its own loop — the structural
    loop-breaker. ``peer_enabled`` / ``peer_turn_budget`` drive bounded
    agent-to-agent delegation; ``require_signed`` is the peer wake strictness
    (#5). ``env`` and ``start_fn`` are injectable for tests.
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
        # Load the agent's identity so the loop can verify signatures. Guarded:
        # a test Connection without config_dir simply runs without verification.
        identity_obj = None
        on_identity_changed = None
        config_dir = getattr(conn, "config_dir", None)
        if config_dir:
            try:
                identity_obj = load_or_create_identity(config_dir)
                on_identity_changed = (
                    lambda ident, _dir=config_dir: save_identity(_dir, ident)
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("[ekho] identity load failed; verification off: %s", exc)

        starter = start_fn or autoreply.start_autoreply
        _autoreply_stop = starter(
            client=conn.client,
            self_agent_id=conn.credentials.agent_id,
            log=logger,
            peer_enabled=peer_enabled,
            peer_turn_budget=peer_turn_budget,
            identity_obj=identity_obj,
            on_identity_changed=on_identity_changed,
            require_signed=require_signed,
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

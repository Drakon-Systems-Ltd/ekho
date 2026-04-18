"""High-level Ekho agent adapter — background polling + heartbeats.

Mirrors packages/sdk/src/adapter.ts, translated to threading primitives.
Both loops run as daemon threads so they don't block interpreter shutdown.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Callable, Optional, Set

from .client import EkhoAgentClient
from .types import (
    ActionDecision,
    ActionResultInput,
    AgentCredentials,
    ControlMessage,
    InboxMessage,
    ProposeActionInput,
    SendMessageInput,
)

logger = logging.getLogger("ekho.adapter")

# Hook signatures — sync callables. v1 is threaded, not async.
OnMessage = Callable[[InboxMessage, "EkhoAgentAdapter"], None]
BeforeAction = Callable[[ProposeActionInput, "EkhoAgentAdapter"], None]
OnControl = Callable[[ControlMessage, "EkhoAgentAdapter"], None]
OnApprovalPending = Callable[[str, "EkhoAgentAdapter"], None]

APPROVAL_POLL_INTERVAL_SECONDS = 1.5


class AdapterHooks:
    """Container for optional lifecycle callbacks.

    Mirrors the TS `AdapterHooks` object literal. All fields optional.
    """

    def __init__(
        self,
        *,
        on_message: Optional[OnMessage] = None,
        before_action: Optional[BeforeAction] = None,
        on_control: Optional[OnControl] = None,
        on_approval_pending: Optional[OnApprovalPending] = None,
    ):
        self.on_message = on_message
        self.before_action = before_action
        self.on_control = on_control
        self.on_approval_pending = on_approval_pending


def _iso_now() -> str:
    now = datetime.now(timezone.utc)
    ms = now.microsecond // 1000
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms:03d}Z"


class EkhoAgentAdapter:
    def __init__(
        self,
        credentials: AgentCredentials,
        hooks: Optional[AdapterHooks] = None,
        *,
        client: Optional[EkhoAgentClient] = None,
    ):
        self._client = client or EkhoAgentClient(credentials)
        self._hooks = hooks or AdapterHooks()
        self._running = threading.Event()
        self._paused = False
        self._active_conversation_ids: Set[str] = set()
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._inbox_thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    # --- Properties ------------------------------------------------------

    @property
    def agent_id(self) -> str:
        return self._client.agent_id

    @property
    def client(self) -> EkhoAgentClient:
        return self._client

    @property
    def running(self) -> bool:
        return self._running.is_set()

    @property
    def paused(self) -> bool:
        return self._paused

    # --- Lifecycle ------------------------------------------------------

    def start(self) -> None:
        """Kick off heartbeat + inbox loops. Idempotent."""
        if self._running.is_set():
            return
        self._running.set()
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop, name="ekho-heartbeat", daemon=True
        )
        self._inbox_thread = threading.Thread(
            target=self._inbox_loop, name="ekho-inbox", daemon=True
        )
        self._heartbeat_thread.start()
        self._inbox_thread.start()

    def stop(
        self,
        *,
        join: bool = False,
        timeout: Optional[float] = None,
    ) -> None:
        """Signal both loops to exit. If `join`, block until threads stop."""
        self._running.clear()
        if join:
            for t in (self._heartbeat_thread, self._inbox_thread):
                if t and t.is_alive():
                    t.join(timeout=timeout)

    def __enter__(self) -> "EkhoAgentAdapter":
        self.start()
        return self

    def __exit__(self, *exc_info) -> None:
        self.stop(join=True, timeout=5.0)
        self._client.close()

    # --- Send-side helpers ----------------------------------------------

    def send(self, payload: SendMessageInput):
        return self._client.send_message(payload)

    def propose_action(self, action: ProposeActionInput) -> ActionDecision:
        """Propose an action; if it requires approval, block (on the caller's
        thread) until the operator approves/rejects or the adapter stops."""
        if self._hooks.before_action:
            self._hooks.before_action(action, self)
        if self._paused:
            raise RuntimeError("agent is paused by control plane")

        decision = self._client.propose_action(action)
        if decision.decision == "allow":
            return decision
        if decision.decision == "deny":
            raise RuntimeError("action denied by Ekho policy")

        approval_id = decision.approval_id or ""
        if self._hooks.on_approval_pending and approval_id:
            self._hooks.on_approval_pending(approval_id, self)

        while self._running.is_set():
            approval = self._client.get_approval(approval_id)
            if approval.status in ("approved", "executed"):
                return decision
            if approval.status in ("rejected", "cancelled", "expired"):
                raise RuntimeError(f"action {approval.status} by operator")
            time.sleep(APPROVAL_POLL_INTERVAL_SECONDS)
        raise RuntimeError("adapter stopped while waiting for approval")

    def report_action_result(self, payload: ActionResultInput):
        return self._client.action_result(payload)

    # --- Background loops ----------------------------------------------

    def _heartbeat_loop(self) -> None:
        while self._running.is_set():
            try:
                self._client.heartbeat(
                    {
                        "status": (
                            "degraded" if self._paused else "healthy"
                        ),
                        "active_conversation_ids": list(
                            self._active_conversation_ids
                        ),
                        "metrics": {"paused": self._paused},
                    }
                )
            except Exception as exc:  # noqa: BLE001 — survive all errors
                logger.error("[ekho-adapter] heartbeat failed: %s", exc)
            # Wait with early-exit via Event — honour stop() promptly.
            self._wait(self._client.heartbeat_interval_seconds)

    def _inbox_loop(self) -> None:
        while self._running.is_set():
            try:
                inbox = self._client.get_inbox()
                for control in inbox.controls:
                    self._handle_control(control)
                for msg in inbox.messages:
                    with self._lock:
                        self._active_conversation_ids.add(msg.conversation_id)
                    if self._hooks.on_message:
                        try:
                            self._hooks.on_message(msg, self)
                        except Exception as exc:  # noqa: BLE001
                            logger.error(
                                "[ekho-adapter] on_message raised: %s",
                                exc,
                            )
                    self._client.ack_messages(
                        [
                            {
                                "message_id": msg.message_id,
                                "status": "received",
                                "received_at": _iso_now(),
                            }
                        ]
                    )
            except Exception as exc:  # noqa: BLE001
                logger.error("[ekho-adapter] inbox loop failed: %s", exc)
            self._wait(self._client.poll_interval_seconds)

    def _handle_control(self, control: ControlMessage) -> None:
        if control.action in ("pause", "quarantine"):
            self._paused = True
        elif control.action == "resume":
            self._paused = False
        if self._hooks.on_control:
            try:
                self._hooks.on_control(control, self)
            except Exception as exc:  # noqa: BLE001
                logger.error("[ekho-adapter] on_control raised: %s", exc)

    def _wait(self, seconds: float) -> None:
        """Sleep that wakes up promptly on stop()."""
        # _running stays set while we're meant to be running, so we poll
        # it in short slices rather than using Event.wait — lets stop()
        # wake both loops within ~500ms.
        deadline = time.monotonic() + seconds
        while self._running.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(remaining, 0.5))

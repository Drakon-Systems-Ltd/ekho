"""Background auto-reply loop — the Hermes counterpart to the OpenClaw plugin's
``autoreply.ts``.

A daemon thread polls the relay inbox. On a qualifying message *from the
verified operator* it wakes the agent by spawning a one-shot Hermes turn
(``python -m hermes_cli.main -z "<prompt>"``); plugins load in one-shot mode, so
that child has the ``ekho_send`` tool and replies through Ekho. The child runs
with ``EKHO_AUTOREPLY_DISABLE=1`` so it never starts its own poll loop (the
structural loop-breaker), and turns are serialized so only one runs at a time.

SAFETY MODEL (identical to OpenClaw): only the OPERATOR (the relay-verified
principal) auto-triggers a turn, and only while this agent currently trusts the
operator (the Access-tab toggle). Peer-agent messages are still delivered to the
inbox cache (visible via ``ekho_inbox``) but never auto-trigger — so agent↔agent
auto-reply ping-pong is impossible by construction, and the agent only spends
tokens answering you.

No Hermes imports live here, and nothing is hardcoded — the SDK client and the
process spawn are injected/duck-typed, so this module imports and unit-tests
without Hermes or a real relay present.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence

from .attachments import download_inbox_attachments
from .messages import iso_now

logger = logging.getLogger("ekho_hermes.autoreply")

# --- Tunables (mirror autoreply.ts) ----------------------------------------

# Message types that warrant waking the agent. Everything else (heartbeat,
# control, complete, acks, ...) is consumed but never triggers a turn.
TRIGGER_TYPES = frozenset({"direct", "broadcast", "handoff", "claim", "alert"})

PEER_RATE_MAX = 5  # turns per peer per window before suppression
PEER_RATE_WINDOW_S = 60.0

# Bounded delegation: a peer may wake this agent at most this many times per
# conversation before the latch closes (delivered + visible via ekho_inbox, but
# no turn). An operator message in the conversation re-opens it. Caps degenerate
# agent<->agent ping-pong without starving productive collaboration.
DEFAULT_PEER_TURN_BUDGET = 6
PEER_LATCH_CONVERSATION_CAP = 500  # FIFO-evicted per-conversation counter map

SEEN_CAP = 500  # FIFO-evicted dedupe set
LAST_BATCH_CAP = 25  # ring exposed to ekho_inbox

TURN_TIMEOUT_S = 180.0
DEFAULT_POLL_INTERVAL_S = 5.0

# The one-shot CLI entry: `python -m hermes_cli.main -z "<prompt>"`.
ONESHOT_MODULE = "hermes_cli.main"

# Env flag the spawned reply turn carries so it connects (for ekho_send) but
# never starts its own poll loop, which would double-process the inbox / recurse.
EKHO_AUTOREPLY_DISABLE_ENV = "EKHO_AUTOREPLY_DISABLE"


# --- Most-recent-batch cache (single consumer = the loop) ------------------
# The loop is the only caller of get_inbox(); ekho_inbox reads this cache
# instead of polling again, so a manual tool call during a turn can never
# double-consume rows the loop is mid-processing. Guarded by a lock because the
# loop thread writes while a tool call (another thread) may read.

_cache_lock = threading.Lock()
_last_batch: "OrderedDict[str, Any]" = OrderedDict()
_last_batch_meta: Dict[str, Any] = {
    "operator_trusted": False,
    "roster": [],
    "controls": [],
}


def reset_cache() -> None:
    """Clear the module cache (used by tests and on a fresh start)."""
    with _cache_lock:
        _last_batch.clear()
        _last_batch_meta["operator_trusted"] = False
        _last_batch_meta["roster"] = []
        _last_batch_meta["controls"] = []


def record_batch(inbox: Any) -> None:
    """Record a freshly delivered inbox batch so ``ekho_inbox`` can read it.

    ``inbox`` is an SDK ``InboxResponse`` (``.messages``, ``.operator_trusted``,
    ``.roster``, ``.controls``). Messages are kept newest-wins, capped FIFO.
    """
    with _cache_lock:
        _last_batch_meta["operator_trusted"] = bool(
            getattr(inbox, "operator_trusted", False)
        )
        _last_batch_meta["roster"] = list(getattr(inbox, "roster", []) or [])
        _last_batch_meta["controls"] = list(getattr(inbox, "controls", []) or [])
        for msg in getattr(inbox, "messages", []) or []:
            message_id = getattr(msg, "message_id", None)
            if not message_id:
                continue
            # Re-insert so most-recent wins ordering; trim oldest beyond the cap.
            _last_batch.pop(message_id, None)
            _last_batch[message_id] = msg
        while len(_last_batch) > LAST_BATCH_CAP:
            _last_batch.popitem(last=False)  # evict oldest


def get_cached_inbox() -> Dict[str, Any]:
    """The view ``ekho_inbox`` returns: the loop's most recent cached batch.

    No relay call, no ack — the loop already consumed and acked these.
    """
    with _cache_lock:
        return {
            "messages": list(_last_batch.values()),
            "operator_trusted": _last_batch_meta["operator_trusted"],
            "roster": list(_last_batch_meta["roster"]),
            "controls": list(_last_batch_meta["controls"]),
        }


# --- Per-loop state --------------------------------------------------------


@dataclass
class AutoReplyState:
    seen: set = field(default_factory=set)
    seen_order: List[str] = field(default_factory=list)
    recent_inbound_by_peer: Dict[str, Dict[str, float]] = field(default_factory=dict)
    in_flight: bool = False
    # conversation_id -> count of times a peer has woken this agent in it.
    peer_turns_by_conversation: Dict[str, int] = field(default_factory=dict)
    peer_conv_order: List[str] = field(default_factory=list)


def mark_seen(state: AutoReplyState, message_id: str) -> None:
    if message_id in state.seen:
        return
    state.seen.add(message_id)
    state.seen_order.append(message_id)
    while len(state.seen_order) > SEEN_CAP:
        evicted = state.seen_order.pop(0)
        state.seen.discard(evicted)


def peer_latch_open(state: AutoReplyState, conversation_id: str, budget: int) -> bool:
    """True while this conversation still has peer-turn budget left."""
    return state.peer_turns_by_conversation.get(conversation_id, 0) < budget


def consume_peer_latch(state: AutoReplyState, conversation_id: str) -> None:
    """Record that a peer woke the agent in this conversation (FIFO-capped)."""
    if conversation_id not in state.peer_turns_by_conversation:
        state.peer_conv_order.append(conversation_id)
    state.peer_turns_by_conversation[conversation_id] = (
        state.peer_turns_by_conversation.get(conversation_id, 0) + 1
    )
    while len(state.peer_conv_order) > PEER_LATCH_CONVERSATION_CAP:
        evicted = state.peer_conv_order.pop(0)
        state.peer_turns_by_conversation.pop(evicted, None)


def reset_peer_latch(state: AutoReplyState, conversation_id: str) -> None:
    """Re-open a conversation's latch — the operator engaging re-energises it."""
    state.peer_turns_by_conversation[conversation_id] = 0


def _body_text(msg: Any) -> str:
    body = getattr(msg, "body", None) or {}
    text = body.get("text") if isinstance(body, dict) else None
    return text.strip() if isinstance(text, str) else ""


def is_real_inbound(
    msg: Any,
    self_agent_id: str,
    state: AutoReplyState,
    operator_trusted: bool,
    *,
    peer_enabled: bool = False,
) -> bool:
    """Qualifying filter — an inbound message auto-wakes the agent only when ALL
    hold. The OPERATOR path is always trust-gated; the PEER path is gated on
    ``peer_enabled`` (bounded delegation) and additionally latched per
    conversation in ``process_inbox_once``."""
    message_id = getattr(msg, "message_id", None)
    if not isinstance(message_id, str):
        return False
    # 1. Never react to our own outbound.
    if getattr(msg, "sender_agent_id", None) == self_agent_id:
        return False
    # 2. Type allowlist (excludes heartbeat/control/complete/acks).
    if getattr(msg, "message_type", None) not in TRIGGER_TYPES:
        return False
    # 3. Non-empty text body.
    if not _body_text(msg):
        return False
    # 4. Dedupe.
    if message_id in state.seen:
        return False
    # 5. Principal gate: operator (trust-gated) or teammate (delegation-gated).
    if getattr(msg, "sender_kind", None) == "operator":
        return bool(operator_trusted)
    return bool(peer_enabled)


def apply_peer_rate_gate(
    messages: Sequence[Any],
    state: AutoReplyState,
    now: float,
    log: Optional[logging.Logger] = None,
) -> List[Any]:
    """Per-peer rolling rate gate. The operator (the principal) is exempt;
    returns the subset that survives suppression. Kept for parity/future — in v1
    only the operator qualifies, so this is effectively a passthrough."""
    kept: List[Any] = []
    suppressed: set = set()
    for msg in messages:
        if getattr(msg, "sender_kind", None) == "operator":
            kept.append(msg)  # never rate-limit the principal
            continue
        peer = getattr(msg, "sender_agent_id", "")
        entry = state.recent_inbound_by_peer.get(peer)
        if entry is None or now - entry["window_start"] > PEER_RATE_WINDOW_S:
            entry = {"count": 0.0, "window_start": now}
            state.recent_inbound_by_peer[peer] = entry
        if entry["count"] >= PEER_RATE_MAX:
            suppressed.add(peer)
            continue
        entry["count"] += 1
        kept.append(msg)
    for peer in suppressed:
        (log or logger).warning(
            "[ekho-autoreply] peer %s exceeded %d auto-replies in %.0fs; "
            "suppressing further replies this window (circuit breaker)",
            peer,
            PEER_RATE_MAX,
            PEER_RATE_WINDOW_S,
        )
    return kept


# --- Prompt + command construction -----------------------------------------


def _att_field(att: Any, key: str, default: Any = "") -> Any:
    if isinstance(att, dict):
        return att.get(key, default)
    return getattr(att, key, default)


def _attachments_note(msg: Any, local_for_msg: Optional[Sequence[Any]]) -> str:
    """The per-message attachment line. If the daemon already downloaded the
    files (``local_for_msg`` carries ``local_path``), point the agent straight at
    those paths — the spawned one-shot child has an empty inbox cache, so telling
    it to call ekho_inbox would fail. Otherwise fall back to listing the metadata
    off the message and noting ekho_inbox."""
    if local_for_msg:
        parts: List[str] = []
        have_paths = False
        for d in local_for_msg:
            name = _att_field(d, "filename") or _att_field(d, "id") or "file"
            mime = _att_field(d, "mime")
            size = _att_field(d, "size_bytes", 0)
            path = _att_field(d, "local_path", None)
            if path:
                parts.append(f"{name} ({mime}, {size}B) — saved locally at: {path}")
                have_paths = True
            else:
                parts.append(f"{name} ({mime}, {size}B)")
        joined = "; ".join(parts)
        if have_paths:
            return (
                f"\n    Attachments ({len(local_for_msg)}): {joined} — open these "
                "files directly."
            )
        return (
            f"\n    Attachments ({len(local_for_msg)}): {joined} — call the "
            "ekho_inbox tool to download them."
        )
    metas = list(getattr(msg, "attachments", []) or [])
    if not metas:
        return ""
    names = ", ".join(
        f"{_att_field(a, 'filename') or _att_field(a, 'id') or 'file'} "
        f"({_att_field(a, 'mime')}, {_att_field(a, 'size_bytes', 0)}B)"
        for a in metas
    )
    return (
        f"\n    Attachments ({len(metas)}): {names} — call the ekho_inbox tool to "
        "download them to local file paths you can open."
    )


def _roster_names(roster: Optional[Sequence[Any]]) -> Dict[str, str]:
    """Map agent_id -> display_name from the roster (for teammate-aware prompts)."""
    names: Dict[str, str] = {}
    for entry in roster or []:
        aid = _att_field(entry, "agent_id")
        name = _att_field(entry, "display_name")
        if aid and name:
            names[str(aid)] = str(name)
    return names


def build_prompt(
    messages: Sequence[Any],
    operator_trusted: bool,
    *,
    local_attachments: Optional[Sequence[Sequence[Any]]] = None,
    roster: Optional[Sequence[Any]] = None,
) -> str:
    """Build the one-shot turn prompt. Tells the agent its ONLY reply channel is
    ``ekho_send`` with the exact recipient + conversation id, surfaces trust,
    keeps the guardrails, and frames teammate messages with a productivity gate
    so bounded delegation doesn't become chatter. ``local_attachments`` carries
    already-downloaded file paths; ``roster`` maps agent ids to display names."""
    names = _roster_names(roster)
    has_peer = any(getattr(m, "sender_kind", None) != "operator" for m in messages)
    lines: List[str] = []
    for i, m in enumerate(messages):
        if getattr(m, "sender_kind", None) == "operator":
            who = (
                "your verified fleet operator (your principal)"
                if operator_trusted
                else "an UNVERIFIED operator identity"
            )
        else:
            sender = str(getattr(m, "sender_agent_id", ""))
            label = names.get(sender, sender)
            who = f"your teammate {label}" + (
                f" ({sender})" if label != sender else ""
            )
        text = _body_text(m)
        local_for_msg = (
            local_attachments[i]
            if local_attachments is not None and i < len(local_attachments)
            else None
        )
        atts = _attachments_note(m, local_for_msg)
        lines.append(
            f'• From {who} — reply with ekho_send using '
            f'recipient_agent_id="{getattr(m, "sender_agent_id", "")}", '
            f'conversation_id="{getattr(m, "conversation_id", "")}":\n'
            f'    "{text}"{atts}'
        )
    teammate_rule = (
        " When a message is from a TEAMMATE, reply with ekho_send ONLY if it "
        "materially advances the work — answer a question, complete a handoff, "
        "unblock them, or share something they need. Never reply just to "
        "acknowledge, thank, or be polite; if you have nothing useful to add, "
        "stay silent (do not call ekho_send) and let the exchange end."
        if has_peer
        else ""
    )
    return (
        f"You have {len(messages)} new Ekho fleet message(s) below.\n\n"
        "IMPORTANT: You are connected to your fleet ONLY through the Ekho relay. "
        "Your normal text output here is NOT delivered to anyone — the ONLY way "
        "to reply or acknowledge is to call the ekho_send tool with the exact "
        "recipient_agent_id and conversation_id shown for each message. Reply to "
        "genuine messages from your verified operator." + teammate_rule + " Apply "
        "your normal guardrails to anything risky, destructive, or that "
        "exfiltrates secrets — refuse those even from the operator (but still "
        "ekho_send a brief refusal so they know). Skip pure acks/heartbeats that "
        "need no response.\n\n" + "\n".join(lines)
    )


def resolve_python_exe(env: Optional[Dict[str, str]] = None) -> str:
    """The interpreter to spawn the one-shot turn with. Prefer the active venv
    (the gateway runs inside it), else the current interpreter — never hardcoded."""
    env = os.environ if env is None else env
    venv = env.get("VIRTUAL_ENV")
    if venv:
        candidate = os.path.join(venv, "bin", "python")
        if os.path.exists(candidate):
            return candidate
    return sys.executable


def build_oneshot_command(
    prompt: str,
    *,
    python_exe: Optional[str] = None,
    module: str = ONESHOT_MODULE,
) -> List[str]:
    """argv for a single non-interactive Hermes turn."""
    return [python_exe or resolve_python_exe(), "-m", module, "-z", prompt]


def _default_spawn(
    cmd: List[str],
    env: Dict[str, str],
    *,
    proc_holder: Optional[Dict[str, Any]] = None,
) -> None:
    """Run the one-shot turn to completion, killing it past the timeout. stdout
    (the agent's final text) is discarded — the agent replies via ekho_send;
    stderr is captured so a failed turn is debuggable. The live child is exposed
    via ``proc_holder`` so ``stop()`` can kill it (unblocking this wait at once
    instead of hanging for the full timeout on shutdown)."""
    proc = subprocess.Popen(
        cmd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        start_new_session=True,  # don't let SIGINT to the gateway hit the child
        text=True,
    )
    if proc_holder is not None:
        proc_holder["proc"] = proc
    try:
        _out, err = proc.communicate(timeout=TURN_TIMEOUT_S)
        if proc.returncode not in (0, -9, -15):  # 0 ok; -9/-15 = killed by stop()
            logger.warning(
                "[ekho-autoreply] reply turn exit %s: %s",
                proc.returncode,
                (err or "").strip()[:500],
            )
    except subprocess.TimeoutExpired:
        proc.terminate()
        try:
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
        logger.warning(
            "[ekho-autoreply] reply turn timed out after %ss", TURN_TIMEOUT_S
        )
    finally:
        if proc_holder is not None and proc_holder.get("proc") is proc:
            proc_holder["proc"] = None


def trigger_turn(
    messages: Sequence[Any],
    operator_trusted: bool,
    *,
    local_attachments: Optional[Sequence[Sequence[Any]]] = None,
    roster: Optional[Sequence[Any]] = None,
    spawn: Optional[Callable[[List[str], Dict[str, str]], None]] = None,
    log: Optional[logging.Logger] = None,
) -> None:
    """Wake the agent to handle ``messages`` by spawning a one-shot reply turn."""
    prompt = build_prompt(
        messages,
        operator_trusted,
        local_attachments=local_attachments,
        roster=roster,
    )
    cmd = build_oneshot_command(prompt)
    env = dict(os.environ)
    env[EKHO_AUTOREPLY_DISABLE_ENV] = "1"
    (log or logger).info(
        "[ekho-autoreply] waking agent to handle %d message(s)", len(messages)
    )
    (spawn or _default_spawn)(cmd, env)


# --- The tick + the loop ---------------------------------------------------


def process_inbox_once(
    client: Any,
    self_agent_id: str,
    state: AutoReplyState,
    *,
    spawn: Optional[Callable[[List[str], Dict[str, str]], None]] = None,
    now: Optional[float] = None,
    log: Optional[logging.Logger] = None,
    peer_enabled: bool = False,
    peer_turn_budget: int = DEFAULT_PEER_TURN_BUDGET,
) -> Dict[str, int]:
    """One poll cycle: read + cache the inbox, ack the whole batch (real or not)
    BEFORE any turn (at-most-once), and on a qualifying message wake the agent.
    The operator always wakes it (trust-gated); teammates wake it when
    ``peer_enabled``, bounded by a per-conversation latch (``peer_turn_budget``).
    Returns a small summary for observability/tests."""
    log = log or logger
    if state.in_flight:
        return {"polled": 0, "real": 0, "kept": 0, "spawned": 0, "acked": 0}
    if now is None:
        now = time.monotonic()

    inbox = client.get_inbox()
    messages = list(getattr(inbox, "messages", []) or [])

    # Expose the freshly delivered batch to ekho_inbox.
    record_batch(inbox)

    ack_all = [
        {"message_id": m.message_id, "status": "received", "received_at": iso_now()}
        for m in messages
        if getattr(m, "message_id", None)
    ]

    operator_trusted = bool(getattr(inbox, "operator_trusted", False))

    # The console is the live source of truth for delegation: when the relay
    # surfaces peer_autoreply / peer_turn_budget, they override the bootstrap
    # env/config defaults. Older relays omit them (None) -> keep the defaults.
    relay_peer = getattr(inbox, "peer_autoreply", None)
    eff_peer_enabled = bool(relay_peer) if relay_peer is not None else peer_enabled
    relay_budget = getattr(inbox, "peer_turn_budget", None)
    eff_budget = (
        int(relay_budget)
        if isinstance(relay_budget, int) and relay_budget > 0
        else peer_turn_budget
    )

    real = [
        m
        for m in messages
        if is_real_inbound(
            m, self_agent_id, state, operator_trusted, peer_enabled=eff_peer_enabled
        )
    ]
    if messages:
        log.info(
            "[ekho-autoreply] poll: %d msg(s) trusted=%s peer=%s real=%d [%s]",
            len(messages),
            operator_trusted,
            eff_peer_enabled,
            len(real),
            ", ".join(
                f"{getattr(m, 'sender_kind', '?')}/{getattr(m, 'message_type', '?')}"
                for m in messages
            ),
        )

    def _ack() -> int:
        if not ack_all:
            return 0
        try:
            client.ack_messages(ack_all)
        except Exception as exc:  # noqa: BLE001 — a redelivery is harmless
            log.warning("[ekho-autoreply] ack failed: %s", exc)
        return len(ack_all)

    if not real:
        acked = _ack()
        return {
            "polled": len(messages),
            "real": 0,
            "kept": 0,
            "spawned": 0,
            "latched": 0,
            "acked": acked,
        }

    # Operator engagement re-energises the peer latch for its conversation, so a
    # collaboration the operator joins gets fresh budget.
    for m in real:
        if getattr(m, "sender_kind", None) == "operator":
            reset_peer_latch(state, getattr(m, "conversation_id", ""))

    # Per-peer rolling rate gate first (operator exempt), then the per-conversation
    # latch on the surviving teammate messages.
    rate_kept = apply_peer_rate_gate(real, state, now, log)
    kept: List[Any] = []
    latched = 0
    for m in rate_kept:
        if getattr(m, "sender_kind", None) == "operator":
            kept.append(m)
            continue
        conv = getattr(m, "conversation_id", "")
        if peer_latch_open(state, conv, eff_budget):
            consume_peer_latch(state, conv)
            kept.append(m)
        else:
            latched += 1
            log.info(
                "[ekho-autoreply] peer latch closed for conversation %s "
                "(budget %d reached); delivered without a turn",
                conv,
                eff_budget,
            )

    # Mark every real message handled (dedupe defence).
    for m in real:
        mark_seen(state, m.message_id)

    # ACK BEFORE the turn — a slow/crashed turn can never cause a redelivery
    # that re-triggers us.
    acked = _ack()

    spawned = 0
    if kept:
        # Pre-download any operator attachments HERE (the daemon has the relay
        # client) so the prompt can hand the agent real local file paths — the
        # spawned one-shot child has an empty inbox cache and couldn't fetch
        # them itself. Best-effort: a failed download just drops the paths.
        local_attachments = None
        if any(getattr(m, "attachments", None) for m in kept):
            try:
                local_attachments = download_inbox_attachments(client, kept)
            except Exception as exc:  # noqa: BLE001
                log.debug("[ekho-autoreply] attachment pre-download failed: %s", exc)
        state.in_flight = True
        try:
            trigger_turn(
                kept,
                operator_trusted,
                local_attachments=local_attachments,
                roster=getattr(inbox, "roster", None),
                spawn=spawn,
                log=log,
            )
            spawned = 1
        except Exception as exc:  # noqa: BLE001
            log.warning("[ekho-autoreply] turn trigger failed: %s", exc)
        finally:
            state.in_flight = False

    return {
        "polled": len(messages),
        "real": len(real),
        "kept": len(kept),
        "spawned": spawned,
        "latched": latched,
        "acked": acked,
    }


def start_autoreply(
    *,
    client: Any,
    self_agent_id: str,
    log: Optional[logging.Logger] = None,
    poll_interval_s: float = DEFAULT_POLL_INTERVAL_S,
    spawn: Optional[Callable[[List[str], Dict[str, str]], None]] = None,
    peer_enabled: bool = False,
    peer_turn_budget: int = DEFAULT_PEER_TURN_BUDGET,
) -> Callable[[], None]:
    """Start the background poll loop in a daemon thread. Spends zero LLM tokens
    unless a real message arrives. ``peer_enabled`` turns on bounded
    agent-to-agent delegation (latched at ``peer_turn_budget`` per conversation).
    Returns a ``stop()`` callable."""
    log = log or logger
    state = AutoReplyState()
    stop_event = threading.Event()
    # The live reply-turn child, so stop() can kill it and unblock the loop
    # thread instantly instead of waiting out the turn timeout.
    proc_holder: Dict[str, Any] = {"proc": None}

    if spawn is None:
        def effective_spawn(cmd: List[str], env: Dict[str, str]) -> None:
            _default_spawn(cmd, env, proc_holder=proc_holder)
    else:
        effective_spawn = spawn

    def _loop() -> None:
        while not stop_event.is_set():
            stop_event.wait(poll_interval_s)
            if stop_event.is_set():
                break
            try:
                process_inbox_once(
                    client,
                    self_agent_id,
                    state,
                    spawn=effective_spawn,
                    log=log,
                    peer_enabled=peer_enabled,
                    peer_turn_budget=peer_turn_budget,
                )
            except Exception as exc:  # noqa: BLE001 — a relay blip must not kill the loop
                log.debug("[ekho-autoreply] tick failed: %s", exc)

    thread = threading.Thread(target=_loop, name="ekho-autoreply", daemon=True)
    thread.start()
    log.info(
        "[ekho-autoreply] listening for inbound (poll %.0fs) as %s "
        "(peer_delegation=%s, budget=%d)",
        poll_interval_s,
        self_agent_id,
        "on" if peer_enabled else "off",
        peer_turn_budget,
    )

    def stop() -> None:
        stop_event.set()
        proc = proc_holder.get("proc")
        if proc is not None:
            try:
                proc.kill()  # unblock a mid-flight turn so the loop can exit
            except Exception:  # noqa: BLE001 — already gone
                pass
        thread.join(timeout=5.0)

    return stop

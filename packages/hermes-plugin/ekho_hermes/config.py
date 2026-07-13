"""Plugin configuration, sourced entirely from the environment.

Mirrors the OpenClaw plugin's ``EkhoPluginConfig`` (relay URL required; fleet,
token, display name, explicit creds, heartbeat interval all optional). Nothing
is hardcoded — generic OSS, so every identity field comes from env.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30
DEFAULT_PEER_TURN_BUDGET = 25

_TRUTHY = {"1", "true", "yes", "on"}


def _clean(value: Optional[str]) -> Optional[str]:
    """Trim a raw env value, treating empty/whitespace as unset."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


_FALSEY = {"0", "false", "no", "off"}


def _truthy(value: Optional[str]) -> bool:
    """Parse a boolean-ish env value; anything not clearly truthy is False."""
    cleaned = _clean(value)
    return cleaned is not None and cleaned.lower() in _TRUTHY


def _truthy_default_true(value: Optional[str]) -> bool:
    """Parse a boolean-ish env value defaulting to True when UNSET.

    An absent (or empty/whitespace) env var yields the new default (True); an
    explicit falsey value (``0``/``false``/``no``/``off``) still disables. Any
    other non-empty value is treated as truthy.
    """
    cleaned = _clean(value)
    if cleaned is None:
        return True
    return cleaned.lower() not in _FALSEY


@dataclass
class EkhoConfig:
    """Resolved Ekho plugin configuration.

    ``relay_url`` is the only required field; everything else is optional and
    drives the enroll-or-load flow (fleet + token for first-run enrollment, or
    explicit agent_id + secret to skip enrollment entirely).
    """

    relay_url: Optional[str] = None
    fleet_id: Optional[str] = None
    enrollment_token: Optional[str] = None
    display_name: Optional[str] = None
    agent_id: Optional[str] = None
    agent_secret: Optional[str] = None
    heartbeat_interval_seconds: int = DEFAULT_HEARTBEAT_INTERVAL_SECONDS
    # Bounded agent-to-agent delegation. ON by default: teammates can wake this
    # agent, still latched per conversation by peer_turn_budget so it can never
    # become unbounded ping-pong. An operator disables it per agent from the
    # console (the relay value overrides this default), or via EKHO_PEER_AUTOREPLY=0.
    peer_autoreply: bool = True
    peer_turn_budget: int = DEFAULT_PEER_TURN_BUDGET
    # Operator signing public key(s) to bootstrap-pin as the trust root, for
    # agents enrolled before signing existed. Format: "<b64url>" or
    # "<key_id>:<b64url>", comma-separated. Optional — the trusted out-of-band
    # channel (the Security screen shows the value to paste).
    operator_pubkey: Optional[str] = None

    @property
    def has_relay(self) -> bool:
        """True when a relay URL is configured — the plugin is a no-op without one."""
        return bool(self.relay_url)

    @classmethod
    def from_env(cls, env=None) -> "EkhoConfig":
        """Build config from environment variables (``os.environ`` by default).

        ``env`` is injectable so tests don't have to mutate the process
        environment.
        """
        env = os.environ if env is None else env

        raw_interval = _clean(env.get("EKHO_HEARTBEAT_INTERVAL"))
        try:
            interval = (
                int(raw_interval)
                if raw_interval is not None
                else DEFAULT_HEARTBEAT_INTERVAL_SECONDS
            )
        except ValueError:
            interval = DEFAULT_HEARTBEAT_INTERVAL_SECONDS
        if interval <= 0:
            interval = DEFAULT_HEARTBEAT_INTERVAL_SECONDS

        raw_budget = _clean(env.get("EKHO_PEER_TURN_BUDGET"))
        try:
            budget = (
                int(raw_budget)
                if raw_budget is not None
                else DEFAULT_PEER_TURN_BUDGET
            )
        except ValueError:
            budget = DEFAULT_PEER_TURN_BUDGET
        if budget <= 0:
            budget = DEFAULT_PEER_TURN_BUDGET

        return cls(
            relay_url=_clean(env.get("EKHO_RELAY_URL")),
            fleet_id=_clean(env.get("EKHO_FLEET_ID")),
            enrollment_token=_clean(env.get("EKHO_ENROLLMENT_TOKEN")),
            display_name=_clean(env.get("EKHO_DISPLAY_NAME")),
            agent_id=_clean(env.get("EKHO_AGENT_ID")),
            agent_secret=_clean(env.get("EKHO_AGENT_SECRET")),
            heartbeat_interval_seconds=interval,
            peer_autoreply=_truthy_default_true(env.get("EKHO_PEER_AUTOREPLY")),
            peer_turn_budget=budget,
            operator_pubkey=_clean(env.get("EKHO_OPERATOR_PUBKEY")),
        )

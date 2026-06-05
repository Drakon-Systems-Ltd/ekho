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


def _clean(value: Optional[str]) -> Optional[str]:
    """Trim a raw env value, treating empty/whitespace as unset."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


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

        return cls(
            relay_url=_clean(env.get("EKHO_RELAY_URL")),
            fleet_id=_clean(env.get("EKHO_FLEET_ID")),
            enrollment_token=_clean(env.get("EKHO_ENROLLMENT_TOKEN")),
            display_name=_clean(env.get("EKHO_DISPLAY_NAME")),
            agent_id=_clean(env.get("EKHO_AGENT_ID")),
            agent_secret=_clean(env.get("EKHO_AGENT_SECRET")),
            heartbeat_interval_seconds=interval,
        )

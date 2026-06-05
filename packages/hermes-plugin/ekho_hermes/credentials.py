"""Enroll-or-load credentials flow, mirroring the OpenClaw plugin.

Resolution order (same as ``credentials.ts`` ``enrollOrLoad``):
  1. Explicit ``agent_id`` + ``agent_secret`` in config -> save + return.
  2. Saved credentials at ``<config_dir>/credentials.json`` -> return.
  3. Enroll with ``fleet_id`` + ``enrollment_token`` via the SDK -> save + return.

Credentials are persisted as JSON (0600) so a restart reuses the same agent
identity instead of re-enrolling. Kept testable: ``client_factory`` is injected
so tests can pass a fake SDK client whose ``.enroll`` returns a stub with
``.to_credentials()``.
"""

from __future__ import annotations

import json
import os
import socket
from pathlib import Path
from typing import Callable, Optional

from ekho import AgentCredentials, EkhoAgentClient

from .config import EkhoConfig

CREDENTIALS_FILE = "credentials.json"


def _credentials_path(config_dir: str) -> Path:
    return Path(config_dir) / CREDENTIALS_FILE


def load_credentials(config_dir: str) -> Optional[AgentCredentials]:
    """Load saved credentials, or ``None`` if absent/unreadable."""
    path = _credentials_path(config_dir)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not data.get("agent_id") or not data.get("secret") or not data.get("relay_base_url"):
        return None
    return AgentCredentials(
        agent_id=data["agent_id"],
        secret=data["secret"],
        relay_base_url=data["relay_base_url"],
        heartbeat_interval_seconds=data.get("heartbeat_interval_seconds"),
        poll_interval_seconds=data.get("poll_interval_seconds"),
    )


def save_credentials(config_dir: str, credentials: AgentCredentials) -> None:
    """Persist credentials as JSON with 0600 perms (created dir is 0700)."""
    directory = Path(config_dir)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(directory, 0o700)
    except OSError:
        pass
    path = _credentials_path(config_dir)
    payload = {
        "agent_id": credentials.agent_id,
        "secret": credentials.secret,
        "relay_base_url": credentials.relay_base_url,
        "heartbeat_interval_seconds": credentials.heartbeat_interval_seconds,
        "poll_interval_seconds": credentials.poll_interval_seconds,
    }
    # Write then tighten perms — create the file 0600 from the start so the
    # secret is never briefly world-readable.
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
    finally:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def enroll_or_load(
    config: EkhoConfig,
    config_dir: str,
    *,
    client_factory: Callable[[AgentCredentials], EkhoAgentClient] = EkhoAgentClient,
) -> AgentCredentials:
    """Return usable credentials, enrolling on first run if needed.

    ``client_factory`` builds an SDK client from credentials; it is injected so
    tests can supply a fake whose ``.enroll`` returns a stub with
    ``.to_credentials()``. The relay URL must be set on ``config``.
    """
    if not config.relay_url:
        raise ValueError("EKHO_RELAY_URL is required to connect to an Ekho relay")

    # 1. Explicit credentials in config — save (so later runs hit branch 2) and return.
    if config.agent_id and config.agent_secret:
        creds = AgentCredentials(
            agent_id=config.agent_id,
            secret=config.agent_secret,
            relay_base_url=config.relay_url,
        )
        save_credentials(config_dir, creds)
        return creds

    # 2. Saved credentials from a previous enrollment.
    saved = load_credentials(config_dir)
    if saved is not None:
        return saved

    # 3. Enroll with a one-time token. Needs fleet_id + enrollment_token.
    if not config.fleet_id or not config.enrollment_token:
        raise ValueError(
            "No Ekho credentials and no enrollment token configured. "
            "Set EKHO_AGENT_ID + EKHO_AGENT_SECRET, or "
            "EKHO_FLEET_ID + EKHO_ENROLLMENT_TOKEN."
        )

    hostname = socket.gethostname()
    display_name = config.display_name or f"hermes-{hostname}"

    # The client needs *some* credentials object even pre-enrollment — the
    # relay's /v1/enroll is unauthenticated, so a bootstrap secret is fine; the
    # SDK ignores it for the enroll call.
    bootstrap = AgentCredentials(
        agent_id="",
        secret="",
        relay_base_url=config.relay_url,
    )
    client = client_factory(bootstrap)
    response = client.enroll(
        {
            "fleet_id": config.fleet_id,
            "token": config.enrollment_token,
            "display_name": display_name,
            "runtime": "custom",
            "hostname": hostname,
        }
    )
    creds = response.to_credentials()
    # Enroll responses carry their own relay_base_url; keep the configured one
    # if the relay echoed an empty value back.
    if not creds.relay_base_url:
        creds.relay_base_url = config.relay_url
    save_credentials(config_dir, creds)
    return creds

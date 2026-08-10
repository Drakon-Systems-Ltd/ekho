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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Optional

from ekho import AgentCredentials, EkhoAgentClient, public_key_b64url_from_seed

from .config import EkhoConfig

CREDENTIALS_FILE = "credentials.json"
IDENTITY_FILE = "identity.json"


@dataclass
class EkhoIdentity:
    """The agent's own Ed25519 identity (private) + the operator keys it pins.

    seed_hex is the 32-byte Ed25519 seed — the private key, which never leaves the
    host. pinned_operator_keys (key_id -> public_key b64url) is the trust root the
    agent verifies operator messages and peer-key endorsements against.
    """

    seed_hex: str
    pinned_operator_keys: Dict[str, str] = field(default_factory=dict)
    # Set once, when the empty pin set trust-on-first-use adopted the relay's
    # operator keys (#5). Latched forever so a later emptied pin set can never
    # be re-seeded by whoever controls the relay at that moment.
    tofu_at: Optional[str] = None
    # key_id -> ISO timestamp we first saw the relay report it revoked (#14).
    # A tombstone ledger, not a cache: unpinning a revoked key is worthless on
    # its own because the config seed, TOFU and endorsement chaining all re-add
    # it on the next wake. Every add path consults this, so revocation sticks.
    revoked_operator_keys: Dict[str, str] = field(default_factory=dict)

    def public_key_b64url(self) -> str:
        return public_key_b64url_from_seed(bytes.fromhex(self.seed_hex))


def _identity_path(config_dir: str) -> Path:
    return Path(config_dir) / IDENTITY_FILE


def load_or_create_identity(config_dir: str) -> EkhoIdentity:
    """Load the agent's identity, generating a fresh keypair on first run."""
    path = _identity_path(config_dir)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("seed_hex"):
                return EkhoIdentity(
                    seed_hex=str(data["seed_hex"]),
                    pinned_operator_keys=dict(data.get("pinned_operator_keys") or {}),
                    tofu_at=str(data["tofu_at"]) if data.get("tofu_at") else None,
                    revoked_operator_keys=dict(data.get("revoked_operator_keys") or {}),
                )
        except (OSError, ValueError):
            pass
    identity = EkhoIdentity(seed_hex=os.urandom(32).hex())
    save_identity(config_dir, identity)
    return identity


def save_identity(config_dir: str, identity: EkhoIdentity) -> None:
    """Persist the identity as JSON, 0600 (the seed is a private key)."""
    directory = Path(config_dir)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(directory, 0o700)
    except OSError:
        pass
    path = _identity_path(config_dir)
    payload = {
        "seed_hex": identity.seed_hex,
        "pinned_operator_keys": identity.pinned_operator_keys,
    }
    if identity.tofu_at:
        payload["tofu_at"] = identity.tofu_at
    if identity.revoked_operator_keys:
        payload["revoked_operator_keys"] = identity.revoked_operator_keys
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
    finally:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


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


# Operator keys the relay handed us at enrollment — the trust bootstrap the
# relay has always sent and this plugin used to drop on the floor (#5).
# Consumed once by ensure_connected right after enrollment.
_last_enroll_operator_keys: Optional[list] = None


def take_enroll_operator_keys() -> Optional[list]:
    """One-shot getter for the operator keys the last enrollment returned."""
    global _last_enroll_operator_keys
    keys = _last_enroll_operator_keys
    _last_enroll_operator_keys = None
    return keys


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
    # Stash the enroll response's operator keys (the trust bootstrap) so
    # ensure_connected can TOFU-pin them right after enrollment (#5).
    global _last_enroll_operator_keys
    enroll_keys = getattr(response, "operator_keys", None)
    _last_enroll_operator_keys = list(enroll_keys) if enroll_keys else None
    creds = response.to_credentials()
    # Enroll responses carry their own relay_base_url; keep the configured one
    # if the relay echoed an empty value back.
    if not creds.relay_base_url:
        creds.relay_base_url = config.relay_url
    save_credentials(config_dir, creds)
    return creds

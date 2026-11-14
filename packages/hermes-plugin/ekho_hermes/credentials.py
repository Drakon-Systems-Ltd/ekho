"""Enroll-or-load credentials flow, mirroring the OpenClaw plugin.

Resolution order (same as ``credentials.ts`` ``enrollOrLoad``):
  1. Explicit ``agent_id`` + ``agent_secret`` in config -> save + return.
  2. Saved credentials at ``<config_dir>/credentials.json`` -> return.
  3. Enroll with ``fleet_id`` + ``enrollment_token`` via the SDK -> save + return.

Credentials are persisted as JSON (0600) so a restart reuses the same agent
identity instead of re-enrolling. Kept testable: ``client_factory`` is injected
so tests can pass a fake SDK client whose ``.enroll`` returns a stub with
``.to_credentials()``.

The identity file (the agent's private seed plus the operator keys it pins,
the TOFU latch and the revocation tombstones) follows the same rules as the
TypeScript SDK's ``identity/store.ts``: a present-but-unusable file is
preserved beside itself and refused, never replaced by a freshly minted key;
an absent file on an already-enrolled agent is refused unless the operator
says so (``EKHO_ALLOW_NEW_IDENTITY=1``); every save is atomic (sibling temp
file, fsync, rename), so a concurrent reader never observes a torn file.
"""

from __future__ import annotations

import json
import os
import socket
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional

from ekho import AgentCredentials, EkhoAgentClient, public_key_b64url_from_seed

from .config import EkhoConfig

CREDENTIALS_FILE = "credentials.json"
IDENTITY_FILE = "identity.json"

# Set to "1" to let an already-enrolled agent mint a brand-new identity key.
# Mirrors the OpenClaw plugin's flag of the same name.
ALLOW_NEW_IDENTITY_ENV = "EKHO_ALLOW_NEW_IDENTITY"

_SEED_BYTES = 32


class IdentityUnavailableError(RuntimeError):
    """Raised instead of minting a key.

    ``reason`` is ``"unreadable"`` (a file is present but this build cannot
    use it: not JSON, no seed, a malformed seed, unreadable bytes) or
    ``"missing"`` (no file, but the agent is already enrolled so its identity
    must exist somewhere). A key that exists only because a read failed is a
    forged identity, not a recovery; the caller must stop and say so.
    ``preserved_path`` is the byte-exact copy kept for forensics, if one could
    be written.
    """

    def __init__(self, message: str, reason: str, preserved_path: Optional[Path] = None):
        super().__init__(message)
        self.reason = reason
        self.preserved_path = preserved_path


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
    # key_id -> why this key is trusted on THIS box (#26): {"admitted_by":
    # "tofu"|"chain", "endorsed_by_key_id"?, "endorsement_sig"?, "admitted_at"}.
    # Written at the moment the gate admitted the key, so the question "why is
    # this key trusted here?" has an offline answer — the relay is exactly the
    # party we would otherwise have to ask.
    operator_key_admissions: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    # Fields the identity file carried that this build doesn't know about (a
    # newer plugin's, or the OpenClaw side sharing the config dir). Kept so a
    # load/save round trip doesn't silently delete them.
    extra: Dict[str, Any] = field(default_factory=dict, repr=False)

    def public_key_b64url(self) -> str:
        return public_key_b64url_from_seed(bytes.fromhex(self.seed_hex))


_KNOWN_IDENTITY_FIELDS = frozenset(
    {
        "seed_hex",
        "pinned_operator_keys",
        "tofu_at",
        "revoked_operator_keys",
        "operator_key_admissions",
    }
)


def _identity_path(config_dir: str) -> Path:
    return Path(config_dir) / IDENTITY_FILE


def _parse_identity(raw: bytes) -> Optional[EkhoIdentity]:
    """Decode identity bytes, or ``None`` when they are not a usable identity.

    Never raises: any decoding, structural or seed problem is "unusable", and
    the caller decides what that means (refuse, never regenerate).
    """
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    seed_hex = data.get("seed_hex")
    if not isinstance(seed_hex, str) or not seed_hex:
        return None
    try:
        if len(bytes.fromhex(seed_hex)) != _SEED_BYTES:
            return None
    except ValueError:
        return None
    try:
        return EkhoIdentity(
            seed_hex=seed_hex,
            pinned_operator_keys=dict(data.get("pinned_operator_keys") or {}),
            tofu_at=str(data["tofu_at"]) if data.get("tofu_at") else None,
            revoked_operator_keys=dict(data.get("revoked_operator_keys") or {}),
            operator_key_admissions=dict(data.get("operator_key_admissions") or {}),
            extra={k: v for k, v in data.items() if k not in _KNOWN_IDENTITY_FIELDS},
        )
    except (TypeError, ValueError):
        return None


def preserve_unusable_file(path: Path, raw: Optional[bytes]) -> Optional[Path]:
    """Byte-for-byte copy of an unusable state file, for forensics.

    Bytes, not a decoded string: invalid UTF-8 must survive exactly. Best
    effort — the refusal is what matters, so a failure here returns ``None``
    rather than raising. The original is never touched.

    One copy per distinct content: when a copy with exactly these bytes is
    already beside the file it is returned and nothing is written, so a caller
    that retries the same unusable file keeps a single copy of it.
    """
    if raw is None:
        return None
    prefix = f"{path.name}.unusable-"
    try:
        siblings = sorted(p for p in path.parent.iterdir() if p.name.startswith(prefix))
    except OSError:
        siblings = []
    for existing in siblings:
        try:
            if (
                not existing.is_symlink()
                and existing.is_file()
                and existing.stat().st_size == len(raw)
                and existing.read_bytes() == raw
            ):
                return existing
        except OSError:
            continue
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    target = path.with_name(f"{path.name}.unusable-{stamp}")
    try:
        fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(raw)
    except OSError:
        # A partial copy is not a byte-exact copy; do not leave one behind.
        try:
            os.unlink(str(target))
        except OSError:
            pass
        return None
    return target


def load_or_create_identity(config_dir: str, *, allow_create: bool = True) -> EkhoIdentity:
    """Load the agent's identity, generating a fresh keypair on first run.

    ``allow_create`` says whether an ABSENT file may be answered with a freshly
    minted identity. Default ``True`` (first enrolment). Pass ``False`` for an
    agent that is already enrolled: its identity must already exist somewhere,
    so an absent file is a lost or moved file, not a new agent.

    A file that is present but unusable is never regenerated over: its bytes
    are preserved beside it and :class:`IdentityUnavailableError` is raised.
    The file, and with it the seed, the pinned operator keys, the TOFU latch
    and the revocation tombstones, stays exactly as it is until it is restored.
    """
    path = _identity_path(config_dir)
    # lexists: a dangling symlink is "present but unusable", not "absent".
    if os.path.lexists(path):
        raw: Optional[bytes] = None
        try:
            raw = path.read_bytes()
        except OSError:
            raw = None
        identity = _parse_identity(raw) if raw is not None else None
        if identity is not None:
            return identity
        preserved = preserve_unusable_file(path, raw)
        raise IdentityUnavailableError(
            f"[ekho] identity file {path} is present but unusable; refusing to mint a "
            "replacement key"
            + (f" (bytes preserved at {preserved})" if preserved else "")
            + ". Restore the file from a backup, or remove it and set "
            f"{ALLOW_NEW_IDENTITY_ENV}=1 to enrol a new key on purpose.",
            "unreadable",
            preserved,
        )
    if not allow_create:
        raise IdentityUnavailableError(
            f"[ekho] no identity file at {path} but this agent is already enrolled; "
            "refusing to mint a new key. Restore the file from a backup (the relay "
            f"already holds this agent's key), or set {ALLOW_NEW_IDENTITY_ENV}=1 to "
            "re-key on purpose.",
            "missing",
        )
    identity = EkhoIdentity(seed_hex=os.urandom(_SEED_BYTES).hex())
    save_identity(config_dir, identity)
    return identity


def should_allow_new_identity(
    env: Mapping[str, str],
    *,
    has_stored_credentials: bool,
    has_config_credentials: bool,
) -> bool:
    """May this process mint a brand-new identity key if none is on disk?

    Yes for a fresh enrolment (nothing enrolled yet). For an enrolled agent —
    saved credentials on disk, or an agent id and secret in config — only with
    the operator's explicit say-so, ``EKHO_ALLOW_NEW_IDENTITY=1``. Pure, so
    the rule itself is tested, not just the loader.
    """
    enrolled = has_stored_credentials or has_config_credentials
    return (not enrolled) or env.get(ALLOW_NEW_IDENTITY_ENV) == "1"


def _fsync_dir(directory: Path) -> None:
    """Flush the directory entry so the rename itself is durable (best effort)."""
    try:
        dfd = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dfd)
    except OSError:
        pass
    finally:
        os.close(dfd)


def save_identity(config_dir: str, identity: EkhoIdentity) -> None:
    """Persist the identity as JSON, 0600 (the seed is a private key).

    Atomic: the payload goes to a sibling temp file (created 0600, never
    world-readable), is fsynced, and is renamed over the real file. A reader
    — the Hermes child process, another plugin instance, the OpenClaw plugin
    sharing the directory — sees either the previous complete file or the new
    complete file, never a truncated one. If anything fails before the rename
    the previous file is untouched and the temp file is removed.
    """
    directory = Path(config_dir)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(directory, 0o700)
    except OSError:
        pass
    path = _identity_path(config_dir)
    # Unknown fields first, so a key this build does own always wins the merge.
    payload = {
        **identity.extra,
        "seed_hex": identity.seed_hex,
        "pinned_operator_keys": identity.pinned_operator_keys,
    }
    if identity.tofu_at:
        payload["tofu_at"] = identity.tofu_at
    if identity.revoked_operator_keys:
        payload["revoked_operator_keys"] = identity.revoked_operator_keys
    if identity.operator_key_admissions:
        payload["operator_key_admissions"] = identity.operator_key_admissions
    # Serialise first: a payload that cannot be encoded must fail before any
    # file is touched, not half-way through a write.
    encoded = json.dumps(payload, indent=2).encode("utf-8")
    tmp = path.with_name(f"{path.name}.tmp-{os.getpid()}-{time.time_ns()}")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        try:
            view = memoryview(encoded)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    _fsync_dir(directory)


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

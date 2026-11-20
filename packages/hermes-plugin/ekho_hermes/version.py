"""What this plugin says about itself on each heartbeat (#97).

``ADAPTER_VERSION`` is the Ekho release this plugin ships in. It is a constant,
not plugin.yaml's ``version:`` (a Hermes manifest field that does not follow
the Ekho release number, see README) and not a file read at run time.
release-version-lockstep.test.ts keeps it equal to the relay's version.

The Ekho Python SDK adds ``sdk_version`` and the per-process ``instance_id``.
"""

from __future__ import annotations

import re
import sys
from typing import Any, Dict, Mapping, Optional

ADAPTER_VERSION = "0.9.0"

# The relay's version charset (packages/relay/src/agent-identity.ts).
_VERSION_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}")


def _token(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if _VERSION_TOKEN.fullmatch(value) else None


def hermes_version(modules: Optional[Mapping[str, Any]] = None) -> Optional[str]:
    """Hermes's own version, if the host has already imported ``hermes_cli``.

    Never imports Hermes and never runs git: outside a Hermes host (tests, the
    standalone healthcheck) the answer is simply unknown. ``__version__`` is
    Hermes's install stamp; its "0.0.0" placeholder (a checkout with no stamp)
    is not a version, so ``__release_date__`` is used instead.
    """
    module = (sys.modules if modules is None else modules).get("hermes_cli")
    if module is None:
        return None
    for attr in ("__version__", "__release_date__"):
        try:
            value = _token(getattr(module, attr, None))
        except Exception:  # noqa: BLE001 — a lazy attribute that fails is "unknown"
            continue
        if value and value != "0.0.0":
            return value
    return None


def heartbeat_identity(modules: Optional[Mapping[str, Any]] = None) -> Dict[str, str]:
    identity = {
        "adapter": "hermes-plugin",
        "adapter_version": ADAPTER_VERSION,
        "host_runtime": "hermes",
    }
    version = hermes_version(modules)
    if version:
        identity["host_runtime_version"] = version
    return identity

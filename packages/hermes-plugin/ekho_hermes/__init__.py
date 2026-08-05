"""Ekho relay adapter for Hermes agents.

Gives a Hermes agent two tools — ``ekho_send`` and ``ekho_inbox`` — to
coordinate with the rest of an Ekho fleet over a relay. Mirrors the OpenClaw
Ekho plugin (enroll/load credentials, background heartbeat, trust/roster
surfacing, attachment handling) on top of the Ekho Python SDK.

Only ``register`` touches the Hermes runtime; every other module is importable
on its own (pure-ish), which is what the test suite relies on.
"""

from ._sdk_path import ensure_sdk_importable as _ensure_sdk_importable

_SDK_OK = _ensure_sdk_importable()

try:
    from .plugin import register  # noqa: E402 — needs the SDK path shim above
except ImportError as _exc:
    # Hermes' plugin loader swallows load failures below WARNING, which turned
    # a missing SDK into months of silent Ekho death (Tars 2 Aug, Vision
    # 29 Jul 2026) while the plugin stayed "enabled" in metadata. Fail LOUDLY:
    # error-level log + stderr, with the remediation, then still raise.
    import logging as _logging
    import sys as _sys

    if _SDK_OK:
        _cause = f"plugin import failed: {_exc}"
    else:
        _cause = (
            "the private 'ekho' Python SDK is not importable in this "
            "interpreter and no source tree was found (a Hermes update/venv "
            f"rebuild removes the installed SDK): {_exc}"
        )
    _MSG = (
        f"[ekho] FATAL: Hermes Ekho plugin failed to load — {_cause}. "
        "Diagnose: 'python <plugin-dir>/healthcheck.py' (installed copy) or "
        "'python -m ekho_hermes.healthcheck' (repo checkout). Repair: add "
        "'--repair' (pip-installs the SDK into this venv), or set "
        "EKHO_SDK_PATH to <ekho-repo>/sdks/python."
    )
    _logging.getLogger("ekho_hermes").error(_MSG)
    print(_MSG, file=_sys.stderr)
    raise

__all__ = ["register"]

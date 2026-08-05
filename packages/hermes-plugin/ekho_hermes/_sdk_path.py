"""SDK-path shim: make the private ``ekho`` SDK importable when absent.

Stdlib-only and free of package-relative state so it can be loaded and tested
standalone (the test suite loads this file directly, without executing the
package ``__init__``).
"""

from __future__ import annotations

import importlib.util
import os
import sys

# Lives beside the plugin's other state (credentials moved to ekho-state in
# 3f83b9e). Holds the last SDK source tree that resolved successfully, so a
# venv rebuild that wipes site-packages cannot take importability with it.
_RECORD_FILE = os.path.join("~", ".hermes", "ekho-state", "sdk-path")


def _record_path() -> str:
    return os.path.expanduser(_RECORD_FILE)


def _looks_like_sdk_root(root: str) -> bool:
    return os.path.isfile(os.path.join(root, "ekho", "__init__.py"))


def _candidate_roots():
    """Yield SDK source-tree candidates, most-specific first."""
    env = os.environ.get("EKHO_SDK_PATH")
    if env:
        yield os.path.expanduser(env)
    try:
        with open(_record_path(), encoding="utf-8") as fh:
            recorded = fh.read().strip()
    except OSError:
        recorded = ""
    if recorded:
        yield recorded
    # The checkout this plugin itself lives in (editable install from a repo):
    # <repo>/packages/hermes-plugin/ekho_hermes/_sdk_path.py -> <repo>/sdks/python
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(here)))
    yield os.path.join(repo_root, "sdks", "python")
    yield os.path.expanduser(os.path.join("~", "ekho", "sdks", "python"))


def _record_root(root: str) -> None:
    """Best-effort persistence of a working SDK source tree.

    Skip trees inside site-/dist-packages: those die with the venv, and
    recording one would overwrite a previously recorded source checkout that
    would have survived.
    """
    if "site-packages" in root or "dist-packages" in root:
        return
    try:
        os.makedirs(os.path.dirname(_record_path()), exist_ok=True)
        with open(_record_path(), "w", encoding="utf-8") as fh:
            fh.write(root + "\n")
    except OSError:
        pass  # recording is an optimisation, never a failure


def ensure_sdk_importable() -> bool:
    """Make the private ``ekho`` SDK importable when the venv doesn't ship it.

    ``find_spec("ekho") is None`` is NOT a sufficient "SDK missing" test: any
    ``ekho/`` directory without an ``__init__.py`` on sys.path — notably the
    plugin's legacy credential dir ``~/.hermes/ekho`` when the gateway's cwd is
    ``~/.hermes``, or an ``~/ekho`` repo checkout when cwd is ``$HOME`` — forms
    an empty namespace package that satisfies find_spec but breaks every
    ``from ekho import ...`` with "unknown location". A real installed package
    has ``spec.origin`` set; a namespace phantom has ``origin=None``, so that
    is the discriminator. (Field cases: Tars's gateway 2-3 Aug 2026 and
    Vision's 29 Jul-5 Aug 2026 — a Hermes venv rebuild dropped the SDK and the
    phantom made the loss silent.)

    Returns True when the SDK is importable on exit (already real, or wired up
    via a discovered source tree), False when nothing could be found — the
    caller decides how loudly to fail.
    """
    try:
        spec = importlib.util.find_spec("ekho")
    except (ImportError, ValueError):
        spec = None
    if spec is not None and spec.origin is not None:
        # Real package. If it resolves from a source tree (editable install),
        # remember the tree: it survives the venv rebuild that wipes the
        # install itself.
        root = os.path.dirname(os.path.dirname(os.path.abspath(spec.origin)))
        if _looks_like_sdk_root(root):
            _record_root(root)
        return True
    for root in _candidate_roots():
        if not _looks_like_sdk_root(root):
            continue
        sys.path.insert(0, root)
        # A previously imported namespace phantom would keep winning over the
        # real package; evict it so the next import re-resolves.
        cached = sys.modules.get("ekho")
        if cached is not None and getattr(cached, "__file__", None) is None:
            del sys.modules["ekho"]
        _record_root(root)
        return True
    return False

"""SDK-path shim: make the private ``ekho`` SDK importable when absent.

Stdlib-only and free of package-relative state so it can be loaded and tested
standalone (the test suite loads this file directly, without executing the
package ``__init__``).
"""

from __future__ import annotations

import importlib.util
import os
import sys


def ensure_sdk_importable() -> None:
    """Make the private ``ekho`` SDK importable when the venv doesn't ship it.

    ``find_spec("ekho") is None`` is NOT a sufficient "SDK missing" test: any
    ``ekho/`` directory without an ``__init__.py`` on sys.path — notably the
    plugin's own credential dir ``~/.hermes/ekho`` when the gateway's cwd is
    ``~/.hermes``, or an ``~/ekho`` repo checkout when cwd is ``$HOME`` — forms
    an empty namespace package that satisfies find_spec but breaks every
    ``from ekho import ...`` with "unknown location". A real installed package
    has ``spec.origin`` set; a namespace phantom has ``origin=None``, so that
    is the discriminator. (Field case: Tars's gateway, 2-3 Aug 2026 — a venv
    rebuild dropped the SDK and the phantom made the loss silent.)
    """
    try:
        spec = importlib.util.find_spec("ekho")
    except (ImportError, ValueError):
        spec = None
    if spec is not None and spec.origin is not None:
        return  # real package (installed or already on sys.path)
    sdk_root = os.path.expanduser(
        os.environ.get("EKHO_SDK_PATH", "~/ekho/sdks/python")
    )
    if os.path.isfile(os.path.join(sdk_root, "ekho", "__init__.py")):
        sys.path.insert(0, sdk_root)
        # A previously imported namespace phantom would keep winning over the
        # real package; evict it so the next import re-resolves.
        cached = sys.modules.get("ekho")
        if cached is not None and getattr(cached, "__file__", None) is None:
            del sys.modules["ekho"]

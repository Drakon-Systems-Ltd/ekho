"""Test path bootstrap.

Puts ``packages/hermes-plugin`` (for ``import ekho_hermes...``) and
``sdks/python`` (for ``import ekho``) on sys.path so the pure plugin modules and
the SDK both resolve without an install step.
"""

import sys
from pathlib import Path

_HERE = Path(__file__).resolve()
_PLUGIN_ROOT = _HERE.parents[1]               # packages/hermes-plugin
_REPO_ROOT = _PLUGIN_ROOT.parents[1]          # repo root
_SDK_PYTHON = _REPO_ROOT / "sdks" / "python"  # sdks/python (provides `ekho`)

for path in (_PLUGIN_ROOT, _SDK_PYTHON):
    p = str(path)
    if p not in sys.path:
        sys.path.insert(0, p)

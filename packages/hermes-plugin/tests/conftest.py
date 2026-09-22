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

import pytest  # noqa: E402

from ekho_hermes.verification import (  # noqa: E402
    reset_advisory_revocation_warning_state_for_tests,
)


@pytest.fixture(autouse=True)
def _isolate_advisory_warning_throttle():
    """#74: the advisory-revocation warning throttle is process-local by design,
    so without this one test's identical advisory set silences the next test's.
    """
    reset_advisory_revocation_warning_state_for_tests()
    yield
    reset_advisory_revocation_warning_state_for_tests()

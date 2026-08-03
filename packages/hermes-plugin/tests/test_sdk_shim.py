"""Tests for the SDK-path shim (``ekho_hermes/_sdk_path.py``).

The shim must treat an empty namespace package (an ``ekho/`` directory with no
``__init__.py`` on sys.path — e.g. the plugin's credential dir when cwd is
``~/.hermes``) the same as "SDK missing", because such a phantom satisfies
``find_spec`` while breaking every real import. Each case runs in a subprocess
so the sys.path/sys.modules surgery cannot leak into other tests, and the shim
module is loaded directly from its file so the package ``__init__`` (which
needs a functional SDK) never executes.
"""

import os
import subprocess
import sys
import textwrap
from pathlib import Path

SHIM_PATH = Path(__file__).resolve().parents[1] / "ekho_hermes" / "_sdk_path.py"

_LOAD_SHIM = f"""
import importlib.util
_spec = importlib.util.spec_from_file_location("sdk_path_under_test", {str(SHIM_PATH)!r})
_shim = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_shim)
ensure_sdk_importable = _shim.ensure_sdk_importable
"""


def _run(payload: str, cwd: Path, env_extra: dict) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.update(env_extra)
    return subprocess.run(
        [sys.executable, "-c", _LOAD_SHIM + textwrap.dedent(payload)],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_namespace_phantom_does_not_defeat_shim(tmp_path):
    """cwd holds an empty ekho/ dir (namespace phantom) and no SDK is
    installed; the shim must wire up EKHO_SDK_PATH so ``import ekho`` resolves
    to the real package."""
    (tmp_path / "ekho").mkdir()  # phantom: bare dir, no __init__.py
    sdk_root = tmp_path / "sdk"
    (sdk_root / "ekho").mkdir(parents=True)
    (sdk_root / "ekho" / "__init__.py").write_text("SENTINEL = 'real-sdk'\n")

    payload = """
        import importlib.util
        spec = importlib.util.find_spec("ekho")
        assert spec is not None and spec.origin is None, "expected namespace phantom"
        ensure_sdk_importable()
        import ekho
        assert getattr(ekho, "SENTINEL", None) == "real-sdk", repr(ekho)
        print("OK")
        """
    result = _run(payload, cwd=tmp_path, env_extra={"EKHO_SDK_PATH": str(sdk_root)})
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


def test_cached_phantom_module_is_evicted(tmp_path):
    """If the phantom was already imported, the shim must evict it from
    sys.modules so the re-import reaches the real package."""
    (tmp_path / "ekho").mkdir()
    sdk_root = tmp_path / "sdk"
    (sdk_root / "ekho").mkdir(parents=True)
    (sdk_root / "ekho" / "__init__.py").write_text("SENTINEL = 'real-sdk'\n")

    payload = """
        import ekho  # imports the phantom and caches it
        assert getattr(ekho, "__file__", None) is None
        ensure_sdk_importable()
        import ekho
        assert getattr(ekho, "SENTINEL", None) == "real-sdk", repr(ekho)
        print("OK")
        """
    result = _run(payload, cwd=tmp_path, env_extra={"EKHO_SDK_PATH": str(sdk_root)})
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


def test_shim_noop_when_real_sdk_installed(tmp_path):
    """When a real ekho package is importable, the shim must not touch
    sys.path."""
    real_root = tmp_path / "installed"
    (real_root / "ekho").mkdir(parents=True)
    (real_root / "ekho" / "__init__.py").write_text("SENTINEL = 'installed'\n")

    payload = f"""
        import sys
        sys.path.insert(0, {str(real_root)!r})
        before = list(sys.path)
        ensure_sdk_importable()
        assert sys.path == before, "shim modified sys.path despite real SDK"
        import ekho
        assert ekho.SENTINEL == "installed"
        print("OK")
        """
    result = _run(
        payload,
        cwd=tmp_path,
        env_extra={"EKHO_SDK_PATH": str(tmp_path / "nonexistent")},
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


def test_missing_sdk_and_no_checkout_is_a_quiet_noop(tmp_path):
    """No SDK anywhere and EKHO_SDK_PATH points nowhere: the shim must not
    raise; the eventual import error stays with the caller."""
    payload = """
        ensure_sdk_importable()
        print("OK")
        """
    result = _run(
        payload,
        cwd=tmp_path,
        env_extra={"EKHO_SDK_PATH": str(tmp_path / "nope")},
    )
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout

"""Tests for the post-update health check (``ekho_hermes/healthcheck.py``).

The healthy path runs the real module end-to-end in a subprocess (`python -m
ekho_hermes.healthcheck`), which is exactly what a fleet box runs after a
Hermes update. Failure branches are unit-tested in-process with monkeypatched
resolution, because the test environment always has a working repo-relative
SDK.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def test_healthcheck_module_passes_end_to_end(tmp_path):
    env = dict(os.environ)
    env["HOME"] = str(tmp_path)
    env.pop("EKHO_RELAY_URL", None)  # force the dummy-URL + stubbed-connect path
    result = subprocess.run(
        [sys.executable, "-m", "ekho_hermes.healthcheck"],
        cwd=PLUGIN_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "[PASS] sdk:" in result.stdout
    assert "[PASS] sdk-surface:" in result.stdout
    assert "[PASS] registration:" in result.stdout
    assert "healthy" in result.stdout


def test_healthcheck_does_not_leak_dummy_relay_env(tmp_path, monkeypatch):
    from ekho_hermes import healthcheck

    monkeypatch.delenv("EKHO_RELAY_URL", raising=False)
    passed, detail = healthcheck.check_registration()
    assert passed, detail
    assert "EKHO_RELAY_URL" not in os.environ


def test_check_sdk_reports_phantom(monkeypatch):
    import importlib.machinery

    from ekho_hermes import healthcheck

    phantom = importlib.machinery.ModuleSpec("ekho", None, is_package=True)
    assert phantom.origin is None
    monkeypatch.setattr(healthcheck, "ensure_sdk_importable", lambda: False)
    monkeypatch.setattr(
        healthcheck.importlib.util, "find_spec", lambda name: phantom
    )
    passed, detail = healthcheck.check_sdk()
    assert not passed
    assert "phantom" in detail


def test_check_sdk_reports_missing(monkeypatch):
    from ekho_hermes import healthcheck

    monkeypatch.setattr(healthcheck, "ensure_sdk_importable", lambda: False)
    monkeypatch.setattr(healthcheck.importlib.util, "find_spec", lambda name: None)
    passed, detail = healthcheck.check_sdk()
    assert not passed
    assert "missing" in detail


def test_check_registration_reports_missing_tools(monkeypatch):
    from ekho_hermes import healthcheck, plugin

    def _register_nothing(ctx):
        return None

    monkeypatch.setattr(plugin, "register", _register_nothing)
    passed, detail = healthcheck.check_registration()
    assert not passed
    assert "missing" in detail


def test_repair_with_no_source_tree(monkeypatch, tmp_path):
    from ekho_hermes import healthcheck

    monkeypatch.setattr(healthcheck, "_candidate_roots", lambda: iter(()))
    passed, detail = healthcheck.repair()
    assert not passed
    assert "no SDK source tree" in detail


def test_main_exit_codes(monkeypatch, capsys):
    from ekho_hermes import healthcheck

    monkeypatch.setattr(healthcheck, "check_sdk", lambda: (True, "ok"))
    monkeypatch.setattr(healthcheck, "check_sdk_surface", lambda: (True, "ok"))
    monkeypatch.setattr(healthcheck, "check_registration", lambda: (True, "ok"))
    assert healthcheck.main([]) == 0

    monkeypatch.setattr(healthcheck, "check_sdk", lambda: (False, "broken"))
    assert healthcheck.main([]) == 1
    captured = capsys.readouterr()
    assert "--repair" in captured.err


def test_standalone_file_run_from_installed_dir_named_ekho(tmp_path):
    """The documented install copies the package to ~/.hermes/plugins/ekho —
    the package name changes, so `-m ekho_hermes...` dies. Running the module
    AS A FILE from that layout must work end-to-end, and must not let the
    plugin dir (named `ekho`!) satisfy the SDK check."""
    import shutil

    install_dir = tmp_path / ".hermes" / "plugins" / "ekho"
    shutil.copytree(
        PLUGIN_DIR / "ekho_hermes", install_dir, ignore=shutil.ignore_patterns("__pycache__")
    )
    env = dict(os.environ)
    env["HOME"] = str(tmp_path)
    env["EKHO_SDK_PATH"] = str(PLUGIN_DIR.parents[1] / "sdks" / "python")
    env.pop("EKHO_RELAY_URL", None)
    env.pop("PYTHONPATH", None)
    result = subprocess.run(
        [sys.executable, str(install_dir / "healthcheck.py")],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "[PASS] sdk:" in result.stdout
    assert "[PASS] registration:" in result.stdout
    # the SDK check must have resolved the real SDK, not the plugin dir
    assert str(install_dir) not in [
        line for line in result.stdout.splitlines() if line.startswith("[PASS] sdk:")
    ][0]


def test_dash_m_under_sdk_shadowing_name_fails_loudly(tmp_path):
    """`python -m ekho.healthcheck` imports the plugin AS `ekho`, shadowing
    the SDK name — that mode must die loudly at package import (with the
    remediation on stderr), never report on a poisoned interpreter."""
    import shutil

    plugins_dir = tmp_path / "plugins"
    install_dir = plugins_dir / "ekho"
    shutil.copytree(
        PLUGIN_DIR / "ekho_hermes", install_dir, ignore=shutil.ignore_patterns("__pycache__")
    )
    env = dict(os.environ)
    env["HOME"] = str(tmp_path)
    env["EKHO_SDK_PATH"] = str(PLUGIN_DIR.parents[1] / "sdks" / "python")
    result = subprocess.run(
        [sys.executable, "-m", "ekho.healthcheck"],
        cwd=plugins_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode != 0, result.stdout + result.stderr
    assert "FATAL" in result.stderr
    assert "healthcheck" in result.stderr


def test_healthcheck_reports_interpreter():
    from ekho_hermes import healthcheck

    import io
    from contextlib import redirect_stdout

    buf = io.StringIO()
    with redirect_stdout(buf):
        healthcheck._run_checks()
    assert sys.executable in buf.getvalue()

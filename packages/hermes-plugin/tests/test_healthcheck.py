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


# --- #85: shadowing plugin copies under the Hermes plugins root -------------
#
# The verdict comes from Hermes' own discovery now, not from a manifest parser
# here, so every case below needs the real ``hermes_cli``. Without it the check
# answers "cannot tell" for any root, which is its own contract and is covered
# in test_plugin_shadows_hermes.py rather than asserted nine times over.

from ekho_hermes import shadow_check  # noqa: E402

_needs_hermes = pytest.mark.skipif(
    shadow_check.hermes_discovery() is None,
    reason="hermes_cli not importable: the shadow verdict is Hermes' own",
)


def _fake_plugin(plugins_root, dirname, name="ekho"):
    d = plugins_root / dirname
    d.mkdir(parents=True)
    (d / "plugin.yaml").write_text(
        f"name: {name}\nversion: 0.1.0\nrequires_env:\n  - name: EKHO_RELAY_URL\n",
        encoding="utf-8",
    )
    (d / "__init__.py").write_text(f"# {dirname}\n", encoding="utf-8")
    return d


@_needs_hermes
def test_check_plugin_shadows_passes_with_single_canonical(tmp_path):
    from ekho_hermes import healthcheck

    plugins = tmp_path / ".hermes" / "plugins"
    _fake_plugin(plugins, "ekho")
    _fake_plugin(plugins, "other", name="other")
    passed, detail = healthcheck.check_plugin_shadows(str(plugins))
    assert passed, detail


@_needs_hermes
def test_check_plugin_shadows_reports_every_duplicate(tmp_path):
    from ekho_hermes import healthcheck

    plugins = tmp_path / ".hermes" / "plugins"
    live = _fake_plugin(plugins, "ekho")
    backup = _fake_plugin(plugins, "ekho.bak-pre050-20260101")
    passed, detail = healthcheck.check_plugin_shadows(str(plugins))
    assert not passed
    assert str(live) in detail
    assert str(backup) in detail


@_needs_hermes
def test_main_exits_nonzero_on_shadowing_copy(tmp_path, monkeypatch, capsys):
    from ekho_hermes import healthcheck

    monkeypatch.setattr(healthcheck, "check_sdk", lambda: (True, "ok"))
    monkeypatch.setattr(healthcheck, "check_sdk_surface", lambda: (True, "ok"))
    monkeypatch.setattr(healthcheck, "check_registration", lambda: (True, "ok"))
    plugins = tmp_path / ".hermes" / "plugins"
    _fake_plugin(plugins, "ekho")
    backup = _fake_plugin(plugins, "ekho.bak-pre050-20260101")
    assert healthcheck.main(["--plugins-dir", str(plugins)]) == 1
    assert "[FAIL] plugin-shadows:" in capsys.readouterr().out
    assert backup.is_dir()  # verify-only never moves anything


@_needs_hermes
def test_repair_moves_shadowing_copies_to_backups(tmp_path, monkeypatch, capsys):
    from ekho_hermes import healthcheck

    monkeypatch.setattr(healthcheck, "repair", lambda: (True, "sdk ok"))
    monkeypatch.setattr(healthcheck, "check_sdk", lambda: (True, "ok"))
    monkeypatch.setattr(healthcheck, "check_sdk_surface", lambda: (True, "ok"))
    monkeypatch.setattr(healthcheck, "check_registration", lambda: (True, "ok"))
    plugins = tmp_path / ".hermes" / "plugins"
    live = _fake_plugin(plugins, "ekho")
    backup = _fake_plugin(plugins, "ekho.bak-pre050-20260101")
    unrelated = _fake_plugin(plugins, "other", name="other")

    assert healthcheck.main(["--repair", "--plugins-dir", str(plugins)]) == 0
    out = capsys.readouterr().out
    assert "[PASS] repair-shadows:" in out
    assert "[PASS] plugin-shadows:" in out
    # moved, not deleted — contents intact under <hermes>/backups/
    moved = tmp_path / ".hermes" / "backups" / backup.name
    assert not backup.exists()
    assert (moved / "__init__.py").read_text() == f"# {backup.name}\n"
    assert live.is_dir() and unrelated.is_dir()


def test_repair_refuses_without_canonical_dir(tmp_path):
    from ekho_hermes import healthcheck

    plugins = tmp_path / ".hermes" / "plugins"
    a = _fake_plugin(plugins, "ekho.bak-1")
    b = _fake_plugin(plugins, "ekho.bak-2")
    passed, detail = healthcheck.repair_plugin_shadows(str(plugins))
    assert not passed
    assert a.is_dir() and b.is_dir()


def _stub_checks(monkeypatch, healthcheck):
    monkeypatch.setattr(healthcheck, "repair", lambda: (True, "sdk ok"))
    monkeypatch.setattr(healthcheck, "check_sdk", lambda: (True, "ok"))
    monkeypatch.setattr(healthcheck, "check_sdk_surface", lambda: (True, "ok"))
    monkeypatch.setattr(healthcheck, "check_registration", lambda: (True, "ok"))


@_needs_hermes
def test_versioned_symlink_is_not_a_shadow(tmp_path):
    from ekho_hermes import healthcheck

    plugins = tmp_path / ".hermes" / "plugins"
    target = _fake_plugin(plugins, "ekho-0.5.4")
    (plugins / "ekho").symlink_to(target, target_is_directory=True)
    passed, detail = healthcheck.check_plugin_shadows(str(plugins))
    assert passed is True, detail


@_needs_hermes
def test_repair_refuses_while_a_symlinked_live_install_is_in_play(
    tmp_path, monkeypatch, capsys
):
    """#85 follow-up: this used to move the stale copy and report PASS.

    Changed deliberately. ``plugins/ekho -> ekho-0.5.4`` is a symlink in a dir
    Hermes discovers, and a link in one root is exactly what another root's
    install can be reaching through: the endpoint comparison that let this pass
    cannot see a link in the middle of a chain. The stale copy stays put, the
    layout is named, and a human resolves it.
    """
    from ekho_hermes import healthcheck

    _stub_checks(monkeypatch, healthcheck)
    plugins = tmp_path / ".hermes" / "plugins"
    target = _fake_plugin(plugins, "ekho-0.5.4")
    live = plugins / "ekho"
    live.symlink_to(target, target_is_directory=True)
    stale = _fake_plugin(plugins, "ekho.bak-pre050")

    assert healthcheck.main(["--repair", "--plugins-dir", str(plugins)]) == 1
    out = capsys.readouterr().out
    assert "[FAIL] repair-shadows:" in out
    assert "is a symlink" in out and str(live) in out
    assert target.is_dir()
    assert (live / "plugin.yaml").is_file()  # symlink still resolves
    assert stale.is_dir()  # refused means refused: nothing moved
    assert not (tmp_path / ".hermes" / "backups").exists()


@_needs_hermes
def test_plugins_dir_dot_puts_backups_beside_it(tmp_path, monkeypatch):
    from ekho_hermes import healthcheck

    plugins = tmp_path / ".hermes" / "plugins"
    _fake_plugin(plugins, "ekho")
    stale = _fake_plugin(plugins, "ekho.bak")
    monkeypatch.chdir(plugins)
    passed, detail = healthcheck.repair_plugin_shadows(".")
    assert passed, detail
    assert not (plugins / "backups").exists()
    assert (tmp_path / ".hermes" / "backups" / stale.name).is_dir()


@_needs_hermes
def test_repair_backup_dest_never_nests(tmp_path, monkeypatch):
    from ekho_hermes import healthcheck

    monkeypatch.setattr(healthcheck.time, "strftime", lambda _fmt: "20260101000000")
    backups = tmp_path / ".hermes" / "backups"
    plugins = tmp_path / ".hermes" / "plugins"
    _fake_plugin(plugins, "ekho")
    # Both the plain name and the timestamped name are already taken.
    (backups / "ekho.bak").mkdir(parents=True)
    (backups / "ekho.bak.20260101000000").mkdir()
    _fake_plugin(plugins, "ekho.bak")
    passed, detail = healthcheck.repair_plugin_shadows(str(plugins))
    assert passed, detail
    dest = backups / "ekho.bak.20260101000000.1"
    assert (dest / "plugin.yaml").is_file()
    assert not any((backups / "ekho.bak.20260101000000").iterdir())
    assert not any((backups / "ekho.bak").iterdir())


def test_missing_plugins_dir_warns_but_does_not_fail(tmp_path, monkeypatch, capsys):
    from ekho_hermes import healthcheck

    _stub_checks(monkeypatch, healthcheck)
    missing = tmp_path / ".hermes" / "plugins"
    assert healthcheck.main(["--plugins-dir", str(missing)]) == 0
    assert "[WARN] plugin-shadows:" in capsys.readouterr().out


@_needs_hermes
def test_dangling_live_symlink_fails(tmp_path):
    from ekho_hermes import healthcheck

    plugins = tmp_path / ".hermes" / "plugins"
    plugins.mkdir(parents=True)
    (plugins / "ekho").symlink_to(plugins / "ekho-0.5.4", target_is_directory=True)
    passed, detail = healthcheck.check_plugin_shadows(str(plugins))
    assert passed is False
    assert "dangling" in detail

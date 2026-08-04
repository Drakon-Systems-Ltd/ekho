"""The legacy ~/.hermes/ekho state dir is renamed to ekho-state exactly once.

The legacy name is an importable module name sitting in the gateway's cwd
(~/.hermes), where it shadows the real ``ekho`` SDK as an empty namespace
package whenever the venv copy disappears. The migration removes the phantom
by renaming; these tests pin the guard rails: only fires on real plugin state,
never clobbers an existing target, tolerates absence.
"""

import os

from ekho_hermes import connection


def _patch_dirs(monkeypatch, tmp_path):
    legacy = tmp_path / ".hermes" / "ekho"
    target = tmp_path / ".hermes" / "ekho-state"
    monkeypatch.setattr(connection, "_LEGACY_CONFIG_DIR", str(legacy))
    monkeypatch.setattr(connection, "DEFAULT_CONFIG_DIR", str(target))
    return legacy, target


def test_migrates_real_state_dir(monkeypatch, tmp_path):
    legacy, target = _patch_dirs(monkeypatch, tmp_path)
    legacy.mkdir(parents=True)
    (legacy / "credentials.json").write_text("{}")
    (legacy / "attachments").mkdir()

    connection._migrate_legacy_config_dir()

    assert not legacy.exists()
    assert (target / "credentials.json").is_file()
    assert (target / "attachments").is_dir()


def test_ignores_unrelated_dir_sharing_the_name(monkeypatch, tmp_path):
    legacy, target = _patch_dirs(monkeypatch, tmp_path)
    legacy.mkdir(parents=True)
    (legacy / "README.md").write_text("not plugin state")

    connection._migrate_legacy_config_dir()

    assert legacy.exists()
    assert not target.exists()


def test_never_overwrites_existing_target(monkeypatch, tmp_path):
    legacy, target = _patch_dirs(monkeypatch, tmp_path)
    legacy.mkdir(parents=True)
    (legacy / "credentials.json").write_text('{"old": true}')
    target.mkdir(parents=True)
    (target / "credentials.json").write_text('{"new": true}')

    connection._migrate_legacy_config_dir()

    assert legacy.exists()
    assert (target / "credentials.json").read_text() == '{"new": true}'


def test_noop_when_nothing_to_migrate(monkeypatch, tmp_path):
    _patch_dirs(monkeypatch, tmp_path)
    connection._migrate_legacy_config_dir()  # must not raise

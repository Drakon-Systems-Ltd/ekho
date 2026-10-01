"""#85 follow-up: the shadow verdict is Hermes', the roots are Hermes', and
anything this process could not establish is "cannot tell" — never PASS.

Every case here is a regression against the first cut (#86), which read
``plugin.yaml`` with a line parser and looked only at ``~/.hermes/plugins``.
Real temp dirs and the real Hermes throughout: a stubbed discovery would only
re-assert this module's idea of Hermes, which is the mistake being fixed. Where
Hermes is not importable the case is skipped with the reason, and the answer it
*does* give there is asserted at the bottom.
"""

import json
import os
import stat
from contextlib import contextmanager

import pytest

from ekho_hermes import healthcheck, shadow_check

PLUGIN_SCHEMA_V1 = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"

needs_discovery = pytest.mark.skipif(
    shadow_check.hermes_discovery() is None,
    reason="hermes_cli not importable: the shadow verdict is Hermes' own",
)
needs_roots = pytest.mark.skipif(
    shadow_check.hermes_resolution() is None,
    reason="hermes_constants not importable: the root set is Hermes' own",
)
needs_unprivileged = pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="running as root: mode bits deny nobody, so nothing is unreadable",
)


# --- fixtures ---------------------------------------------------------------


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A Hermes home of our own: ``$HOME`` moved, ``HERMES_HOME`` unset.

    ``hermes_constants`` reads both live (its root memo is keyed on them), so
    this is enough to make the real resolver answer about a temp tree.
    """
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("HERMES_HOME", raising=False)
    return tmp_path


def yaml_plugin(plugins_root, dirname, text):
    directory = plugins_root / dirname
    directory.mkdir(parents=True)
    (directory / "plugin.yaml").write_text(text, encoding="utf-8")
    (directory / "__init__.py").write_text(f"# {dirname}\n", encoding="utf-8")
    return directory


def plugin(plugins_root, dirname, name="ekho"):
    return yaml_plugin(plugins_root, dirname, f"name: {name}\nversion: 0.1.0\n")


def json_plugin(plugins_root, dirname, name="ekho"):
    """A portable Agent Plugins package — no ``plugin.yaml`` anywhere in it."""
    directory = plugins_root / dirname
    directory.mkdir(parents=True)
    (directory / "plugin.json").write_text(
        json.dumps({"$schema": PLUGIN_SCHEMA_V1, "name": name, "version": "0.1.0"}),
        encoding="utf-8",
    )
    return directory


@contextmanager
def denied(path, mode=0o000):
    """Hold *path* at *mode* for the duration, then put its own mode back.

    Restored in a finally so tmp_path teardown can still walk the tree.
    """
    before = stat.S_IMODE(os.stat(path).st_mode)
    os.chmod(path, mode)
    try:
        yield path
    finally:
        os.chmod(path, before)


def tree(paths):
    return {str(p) for p in paths}


# --- gap 1: the verdict is Hermes', not a manifest parser's -----------------


@needs_discovery
@pytest.mark.parametrize(
    ("label", "manifest"),
    [
        ("inline-comment", "name: ekho  # backup copy\nversion: 0.1.0\n"),
        ("block-scalar", "name: >-\n  ekho\nversion: 0.1.0\n"),
        ("escaped-scalar", 'name: "ek\\u0068o"\nversion: 0.1.0\n'),
        ("typed-scalar", "name: !!str ekho\nversion: 0.1.0\n"),
    ],
)
def test_manifest_forms_only_hermes_reads_are_still_shadows(tmp_path, label, manifest):
    """Every one of these takes the ``ekho`` key away from the live install.

    A line parser answers ``'>-'``, ``'ek\\u0068o'`` and ``'!!str ekho'`` for
    three of them and never sees the shadow. (It happens to get the inline
    comment right, which is the point: which forms a hand-written reader
    survives is not knowable in advance, so it does not get a vote.) The
    verdict is whatever Hermes' own discovery says the key is.
    """
    plugins = tmp_path / ".hermes" / "plugins"
    live = plugin(plugins, "ekho")
    backup = yaml_plugin(plugins, f"ekho.bak-{label}", manifest)

    passed, detail = healthcheck.check_plugin_shadows(str(plugins))
    assert passed is False, detail
    assert str(live) in detail and str(backup) in detail


@needs_discovery
def test_portable_plugin_json_backup_is_a_shadow(tmp_path):
    """#86 read ``plugin.yaml`` and nothing else, so a portable copy was invisible.

    Hermes picks a directory up by ``plugin.json`` just as readily, keys it on
    the name inside, and loads it when it sorts last.
    """
    plugins = tmp_path / ".hermes" / "plugins"
    live = plugin(plugins, "ekho")
    backup = json_plugin(plugins, "ekho.bak-portable")
    assert not (backup / "plugin.yaml").exists()

    passed, detail = healthcheck.check_plugin_shadows(str(plugins))
    assert passed is False, detail
    assert str(backup) in detail

    moved, detail = healthcheck.repair_plugin_shadows(str(plugins))
    assert moved, detail
    assert not backup.exists() and live.is_dir()
    assert (tmp_path / ".hermes" / "backups" / backup.name / "plugin.json").is_file()


# --- gap 2: the roots are Hermes' -------------------------------------------


@needs_discovery
@needs_roots
def test_run_from_a_profile_still_sees_the_default_root(home, monkeypatch):
    """``HERMES_HOME=<root>/profiles/work`` does not narrow the check to that profile.

    #86 scanned ``~/.hermes/plugins`` alone, so a shadow one directory over in
    the profile the gateway is actually running as came out clean — and the
    default root's ``plugins/ekho`` is allowed to be a symlink into a profile's
    tree, so the two cannot be checked apart.
    """
    default_plugins = home / ".hermes" / "plugins"
    profile_plugins = home / ".hermes" / "profiles" / "work" / "plugins"
    plugin(default_plugins, "ekho")
    plugin(profile_plugins, "ekho")
    backup = plugin(profile_plugins, "ekho.bak-pre050")
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes" / "profiles" / "work"))

    roots = shadow_check.hermes_roots()
    assert not roots.undetermined, roots.reason
    assert tree(roots.roots) >= {str(default_plugins), str(profile_plugins)}

    passed, detail = healthcheck.check_plugin_shadows()
    assert passed is False, detail
    assert str(backup) in detail


@needs_discovery
@needs_roots
def test_hermes_home_is_expanded_the_way_hermes_expands_it(home, monkeypatch):
    """``HERMES_HOME=$HOME/.hermes`` is a path with a variable in it, not a dir.

    Read literally it is a relative path that exists nowhere, every scan of it
    comes back empty, and the check reports a clean install while the gateway
    loads a backup out of the directory the variable actually names.
    """
    monkeypatch.setenv("HERMES_HOME", "$HOME/.hermes")
    roots = shadow_check.hermes_roots()
    assert not roots.undetermined, roots.reason
    assert str(home / ".hermes" / "plugins") in tree(roots.roots)
    assert not any("$" in part for root in roots.roots for part in root.parts)
    assert "$HOME/.hermes/plugins" not in tree(roots.roots)

    # And the expansion has to be Hermes' own, not a coincidence with ``~``:
    # point it somewhere the native default is not, and the shadow there is
    # still the one the gateway would load.
    monkeypatch.setenv("HERMES_HOME", "$HOME/.hermes-alt")
    plugins = home / ".hermes-alt" / "plugins"
    plugin(plugins, "ekho")
    backup = plugin(plugins, "ekho.bak-pre050")
    assert str(plugins) in tree(shadow_check.hermes_roots().roots)

    passed, detail = healthcheck.check_plugin_shadows()
    assert passed is False, detail
    assert str(backup) in detail


# --- gap 3: uncertainty is never PASS ---------------------------------------


@needs_discovery
@needs_roots
@needs_unprivileged
def test_unlistable_profiles_dir_makes_the_whole_root_set_undetermined(home):
    """Searchable but not listable is the shape that reads as "no profiles".

    ``profiles/work/plugins/ekho -> <root>/plugins/ekho.bak-x`` still resolves
    perfectly from a directory this process may not list — traversal does not
    need listing — so a protective set silently missing every profile is not
    one, and the repair that runs against it moves the tree out from under a
    live install.
    """
    plugins = home / ".hermes" / "plugins"
    plugin(plugins, "ekho")
    backup = plugin(plugins, "ekho.bak-pre050")
    profiles = home / ".hermes" / "profiles"
    profiles.mkdir(parents=True)

    with denied(profiles, 0o111):  # traversable, not listable
        roots = shadow_check.hermes_roots()
        assert roots.undetermined and str(profiles) in roots.reason

        passed, detail = healthcheck.check_plugin_shadows()
        assert passed is None, detail
        assert str(profiles) in detail and "Permission" in detail

        moved, detail = healthcheck.repair_plugin_shadows()
        assert moved is False, detail
        assert backup.is_dir()
        assert not (home / ".hermes" / "backups").exists()


@needs_discovery
@needs_unprivileged
def test_unreadable_copy_is_undetermined_not_a_clean_root(tmp_path):
    """Hermes skips a child it cannot read and logs it; the loader is right to.

    Here it is the whole question. That directory may be a copy the gateway's
    user reads and loads, so a root holding one has no verdict — and the repair
    refuses even though the plan is empty, because "no shadowing plugin copies
    to move" is the same false all-clear as a PASS.
    """
    plugins = tmp_path / ".hermes" / "plugins"
    plugin(plugins, "ekho")
    backup = plugin(plugins, "ekho.bak-pre050")

    with denied(backup):
        passed, detail = healthcheck.check_plugin_shadows(str(plugins))
        assert passed is None, detail
        assert str(backup) in detail and "Permission" in detail

        moved, detail = healthcheck.repair_plugin_shadows(str(plugins))
        assert moved is False, detail
        assert backup.is_dir()
        assert not (tmp_path / ".hermes" / "backups").exists()


@needs_discovery
@needs_unprivileged
def test_unreadable_plugin_json_is_undetermined(tmp_path):
    """Stat-ing a manifest proves nothing about the file whose bytes decide the key.

    ``plugin.json`` at mode 0600 owned by the service lists and stats for
    anyone and opens for nobody else, and Hermes reports it as an
    ``AgentPluginError`` — a ValueError — that is indistinguishable from a
    schema failure unless the ``from`` is followed. So every manifest candidate
    is opened and a byte is taken out of it.
    """
    plugins = tmp_path / ".hermes" / "plugins"
    plugin(plugins, "ekho")
    backup = json_plugin(plugins, "ekho.bak-portable")

    with denied(backup / "plugin.json"):
        passed, detail = healthcheck.check_plugin_shadows(str(plugins))
        assert passed is None, detail
        assert str(backup / "plugin.json") in detail

        moved, detail = healthcheck.repair_plugin_shadows(str(plugins))
        assert moved is False, detail
        assert backup.is_dir()


@needs_unprivileged
def test_explicit_root_under_an_unsearchable_parent_is_undetermined(tmp_path):
    """``Path.is_dir()`` on a path whose parent denies search RAISES.

    EACCES is not one of the errnos ``pathlib`` swallows, so the check died
    with a traceback before any error-aware stat ran; on the versions that do
    swallow it the answer is False, which prints as "plugin not installed
    there" — the sentence that sends the operator to the wrong box. Both are
    the same bug: a filesystem non-answer read as an answer.
    """
    parent = tmp_path / ".hermes"
    plugins = parent / "plugins"
    plugin(plugins, "ekho")

    with denied(parent, 0o000):
        passed, detail = healthcheck.check_plugin_shadows(str(plugins))
        assert passed is None, detail
        assert str(plugins) in detail and "Permission" in detail


def test_permission_error_wrapped_by_hermes_is_still_a_permission_error():
    """The ``raise AgentPluginError(...) from exc`` shape, on its own.

    Judged on the logged object alone it is a ValueError and reads as "this is
    not a plugin", which is an ANSWER. Judged through ``__cause__`` it is a
    directory nobody read.
    """
    import logging

    cause = PermissionError(13, "Permission denied", "/plugins/ekho.bak/plugin.json")
    wrapper = ValueError("plugin.json is not valid readable JSON")
    wrapper.__cause__ = cause
    record = logging.LogRecord(
        "hermes_cli.plugins",
        logging.WARNING,
        __file__,
        0,
        "Failed to parse %s: %s",
        ("/plugins/ekho.bak/plugin.json", wrapper),
        None,
    )

    assert shadow_check._os_error_in_chain(wrapper) is cause
    found = shadow_check._unreadable_from_records([record])
    assert len(found) == 1
    assert "/plugins/ekho.bak/plugin.json" in found[0].reason
    # A manifest that merely parsed wrong is a verdict, not a gap.
    plain = logging.LogRecord(
        "hermes_cli.plugins",
        logging.WARNING,
        __file__,
        0,
        "Failed to parse %s: %s",
        ("/plugins/other/plugin.yaml", ValueError("bad schema")),
        None,
    )
    assert shadow_check._unreadable_from_records([plain]) == ()


# --- repair safety: all roots, or none --------------------------------------


@needs_discovery
@needs_roots
def test_one_root_without_a_canonical_copy_refuses_every_root(home):
    """The operator told to choose should find the rest of the box as they left it.

    A profile with two copies and no ``ekho/`` is a human's call. Repairing the
    default root around it is a half-done repair, which is worse than none.
    """
    default_plugins = home / ".hermes" / "plugins"
    profile_plugins = home / ".hermes" / "profiles" / "work" / "plugins"
    plugin(default_plugins, "ekho")
    default_backup = plugin(default_plugins, "ekho.bak-pre050")
    first = plugin(profile_plugins, "ekho.bak-1")
    second = plugin(profile_plugins, "ekho.bak-2")

    moved, detail = healthcheck.repair_plugin_shadows()
    assert moved is False, detail
    assert str(profile_plugins) in detail
    assert default_backup.is_dir() and first.is_dir() and second.is_dir()
    assert not (home / ".hermes" / "backups").exists()


@needs_discovery
@needs_roots
def test_the_only_install_is_never_moved_just_because_it_is_not_called_ekho(home):
    """``plugins/ekho-0.5.4`` alone is what Hermes loads, not a shadow of anything.

    "Move everything but the canonical copy" reads as "move the lot" when there
    is no canonical copy, which would take the plugin off the box — so that
    root contributes nothing to move and the install stays exactly where it is.

    And no other root moves either. Which directory is the live install is a
    human's guess on this box until they rename one, and a box in that state is
    not one to shuffle the rest of around: the operator told to choose should
    find everything else as they left it.
    """
    profile_plugins = home / ".hermes" / "profiles" / "work" / "plugins"
    only = plugin(profile_plugins, "ekho-0.5.4")
    default_plugins = home / ".hermes" / "plugins"
    plugin(default_plugins, "ekho")
    elsewhere = plugin(default_plugins, "ekho.bak-pre050")

    scan = shadow_check.scan_root(profile_plugins)
    assert scan.installs == (only,) and scan.canonical is None
    assert scan.shadows == ()

    passed, detail = healthcheck.check_plugin_shadows(str(profile_plugins))
    assert passed is True, detail

    moved, detail = healthcheck.repair_plugin_shadows()
    assert moved is False, detail
    assert str(profile_plugins) in detail
    assert only.is_dir()
    assert elsewhere.is_dir()  # the other root did not move either
    assert not (home / ".hermes" / "backups").exists()


@needs_discovery
@needs_roots
def test_a_symlinked_dependent_under_another_key_refuses_the_repair(home):
    """The link is not in a copy of ours, and moving our copy still breaks it.

    ``profiles/work/plugins/security/ekho -> <root>/plugins/ekho.bak-x`` is
    keyed ``security/ekho``: it is not a copy of ``ekho`` by any test, it is a
    plugin Hermes loads, and it dangles the moment that backup moves. So the
    walk covers every directory Hermes discovered under every key, not the
    collision set.
    """
    default_plugins = home / ".hermes" / "plugins"
    profile_plugins = home / ".hermes" / "profiles" / "work" / "plugins"
    plugin(default_plugins, "ekho")
    backup = plugin(default_plugins, "ekho.bak-x")
    (profile_plugins / "security").mkdir(parents=True)
    dependent = profile_plugins / "security" / "ekho"
    dependent.symlink_to(backup, target_is_directory=True)

    moved, detail = healthcheck.repair_plugin_shadows()
    assert moved is False, detail
    assert str(dependent) in detail and "symlink" in detail
    assert backup.is_dir()
    assert (dependent / "plugin.yaml").is_file()  # still resolves
    assert not (home / ".hermes" / "backups").exists()


# --- no Hermes, no verdict --------------------------------------------------


def test_without_hermes_discovery_the_check_cannot_tell(tmp_path, monkeypatch):
    """WARN, not PASS, and ``--repair`` moves nothing.

    Runs for real under an interpreter without ``hermes_cli``; elsewhere the
    import is stubbed out to the same answer, because what is asserted is the
    contract, not the reason.
    """
    monkeypatch.setattr(shadow_check, "hermes_discovery", lambda: None)
    plugins = tmp_path / ".hermes" / "plugins"
    plugin(plugins, "ekho")
    backup = plugin(plugins, "ekho.bak-pre050")

    passed, detail = healthcheck.check_plugin_shadows(str(plugins))
    assert passed is None, detail
    assert "hermes_cli" in detail

    moved, detail = healthcheck.repair_plugin_shadows(str(plugins))
    assert moved is False, detail
    assert backup.is_dir()
    assert not (tmp_path / ".hermes" / "backups").exists()


def test_without_hermes_constants_there_is_no_root_set(tmp_path, monkeypatch):
    """Which directories to scan is Hermes' question too — and ``[]`` is an answer.

    An empty root set and "I could not work out the root set" would both come
    out as a clean box, so the second one refuses instead.
    """
    monkeypatch.setattr(shadow_check, "hermes_resolution", lambda: None)
    plugins = tmp_path / ".hermes" / "plugins"
    plugin(plugins, "ekho")
    backup = plugin(plugins, "ekho.bak-pre050")

    passed, detail = healthcheck.check_plugin_shadows()
    assert passed is None, detail
    assert "hermes_constants" in detail

    moved, detail = healthcheck.repair_plugin_shadows()
    assert moved is False, detail
    assert backup.is_dir()


def test_main_warns_and_exits_nonzero_on_repair_it_cannot_justify(
    tmp_path, monkeypatch, capsys
):
    """The two halves of "cannot tell" as an operator meets them."""
    monkeypatch.setattr(healthcheck, "repair", lambda: (True, "sdk ok"))
    monkeypatch.setattr(healthcheck, "check_sdk", lambda: (True, "ok"))
    monkeypatch.setattr(healthcheck, "check_sdk_surface", lambda: (True, "ok"))
    monkeypatch.setattr(healthcheck, "check_registration", lambda: (True, "ok"))
    monkeypatch.setattr(shadow_check, "hermes_discovery", lambda: None)
    plugins = tmp_path / ".hermes" / "plugins"
    plugin(plugins, "ekho")
    backup = plugin(plugins, "ekho.bak-pre050")

    assert healthcheck.main(["--plugins-dir", str(plugins)]) == 0
    assert "[WARN] plugin-shadows:" in capsys.readouterr().out

    assert healthcheck.main(["--repair", "--plugins-dir", str(plugins)]) == 1
    assert "[FAIL] repair-shadows:" in capsys.readouterr().out
    assert backup.is_dir()


# --- the layouts that must still come out clean ------------------------------


@needs_discovery
def test_versioned_install_discovered_under_two_names_is_one_install(tmp_path):
    """``plugins/ekho -> plugins/ekho-0.5.4`` is found twice and loads once.

    Hermes reports both directories under the key, and collapsing them by what
    they actually are is the difference between a shadow check and a check that
    fails every versioned install on the fleet.
    """
    plugins = tmp_path / ".hermes" / "plugins"
    target = plugin(plugins, "ekho-0.5.4")
    (plugins / "ekho").symlink_to(target, target_is_directory=True)

    scan = shadow_check.scan_root(plugins)
    assert len(scan.copies) == 2 and len(scan.installs) == 1
    passed, detail = healthcheck.check_plugin_shadows(str(plugins))
    assert passed is True, detail


@needs_discovery
@needs_roots
def test_a_clean_box_with_profiles_passes(home):
    """One install per root, several roots, nothing to say."""
    plugin(home / ".hermes" / "plugins", "ekho")
    plugin(home / ".hermes" / "profiles" / "work" / "plugins", "ekho")
    plugin(home / ".hermes" / "profiles" / "work" / "plugins", "other", name="other")

    passed, detail = healthcheck.check_plugin_shadows()
    assert passed is True, detail

    moved, detail = healthcheck.repair_plugin_shadows()
    assert moved is True, detail
    assert detail == "no shadowing plugin copies to move"


@needs_discovery
@needs_roots
def test_repair_parks_each_copy_beside_the_root_it_came_from(home):
    """A profile's backup stays in the profile: the move never crosses a home."""
    default_plugins = home / ".hermes" / "plugins"
    profile = home / ".hermes" / "profiles" / "work"
    plugin(default_plugins, "ekho")
    default_backup = plugin(default_plugins, "ekho.bak-a")
    plugin(profile / "plugins", "ekho")
    profile_backup = plugin(profile / "plugins", "ekho.bak-b")

    moved, detail = healthcheck.repair_plugin_shadows()
    assert moved, detail
    assert not default_backup.exists() and not profile_backup.exists()
    assert (home / ".hermes" / "backups" / "ekho.bak-a" / "plugin.yaml").is_file()
    assert (profile / "backups" / "ekho.bak-b" / "plugin.yaml").is_file()

    passed, detail = healthcheck.check_plugin_shadows()
    assert passed is True, detail


# --- one directory is one root, however it is spelled ------------------------


@needs_discovery
@needs_roots
def test_a_relative_hermes_home_is_one_root_not_two(home, monkeypatch):
    """``HERMES_HOME=.hermes`` run from ``$HOME`` names the dir the default root is.

    Hermes hands the two answers back in two shapes: the home exactly as
    spelled (``.hermes``) and the containing root resolved
    (``/home/x/.hermes``). Compared as text they are different roots, so the
    one plugins dir is scanned twice and the one backup is planned for twice.
    The first move succeeds; the second moves a directory that is no longer
    there, and the FileNotFoundError escapes ``--repair`` before the SDK is
    repaired and before anything is verified. #86 scanned the absolute default
    root once and got this layout right.
    """
    plugins = home / ".hermes" / "plugins"
    live = plugin(plugins, "ekho")
    backup = plugin(plugins, "ekho.bak-pre050")
    monkeypatch.chdir(home)
    monkeypatch.setenv("HERMES_HOME", ".hermes")

    roots = shadow_check.hermes_roots()
    assert not roots.undetermined, roots.reason
    assert tree(roots.roots) == {str(plugins)}

    moved, detail = healthcheck.repair_plugin_shadows()
    assert moved, detail
    assert detail.count("->") == 1, detail
    assert not backup.exists() and live.is_dir()
    assert (home / ".hermes" / "backups" / backup.name / "plugin.yaml").is_file()

    passed, detail = healthcheck.check_plugin_shadows()
    assert passed is True, detail


def test_a_source_that_vanished_is_reported_not_raised(tmp_path):
    """A plan item whose directory has gone stops the run and is reported.

    Every move is a filesystem call on a box that can change under it. Uncaught,
    the failure escapes ``--repair`` after other copies have already moved: no
    report of which ones, no SDK repair, no verification. The executor is fed a
    plan whose second source is not there, and has to answer.
    """
    plugins = tmp_path / ".hermes" / "plugins"
    real = plugin(plugins, "ekho.bak-moved")
    gone = plugins / "ekho.bak-vanished"

    ok, detail = healthcheck._apply_plan([(plugins, real), (plugins, gone)])
    assert ok is False, detail
    assert str(gone) in detail and "FileNotFoundError" in detail
    assert str(real) in detail  # what DID move is named
    assert (tmp_path / ".hermes" / "backups" / real.name / "plugin.yaml").is_file()


# --- symlinks above the plugins dir ------------------------------------------


@needs_discovery
@needs_roots
def test_a_symlinked_profile_dir_refuses_the_repair(home):
    """The link is ABOVE ``plugins/``, where no copy comparison ever looks.

    ``profiles/work -> <somewhere else>`` makes ``profiles/work/plugins`` a
    root in a tree nobody named, and both ends of every path inside it agree
    with themselves. Only walking the components from the Hermes home down
    finds it.
    """
    elsewhere = home / "elsewhere" / "work"
    plugin(elsewhere / "plugins", "ekho")
    profiles = home / ".hermes" / "profiles"
    profiles.mkdir(parents=True)
    (profiles / "work").symlink_to(elsewhere, target_is_directory=True)
    plugin(home / ".hermes" / "plugins", "ekho")
    backup = plugin(home / ".hermes" / "plugins", "ekho.bak-pre050")

    moved, detail = healthcheck.repair_plugin_shadows()
    assert moved is False, detail
    assert str(profiles / "work") in detail and "symlink" in detail
    assert backup.is_dir()
    assert not (home / ".hermes" / "backups").exists()


@needs_discovery
@needs_roots
def test_a_profile_plugins_dir_linked_to_the_default_root_refuses_the_repair(home):
    """``profiles/work/plugins -> ~/.hermes/plugins`` shares the default root's
    identity, so de-duplication keeps one root. The link must still be seen:
    it is checked before the duplicate is dropped, not after."""
    default = home / ".hermes" / "plugins"
    plugin(default, "ekho")
    backup = plugin(default, "ekho.bak-pre050")
    work = home / ".hermes" / "profiles" / "work"
    work.mkdir(parents=True)
    (work / "plugins").symlink_to(default, target_is_directory=True)

    moved, detail = healthcheck.repair_plugin_shadows()
    assert moved is False, detail
    assert str(work / "plugins") in detail and "symlink" in detail
    assert backup.is_dir()
    assert not (home / ".hermes" / "backups").exists()


@needs_discovery
def test_a_symlinked_explicit_root_is_refused_not_resolved(tmp_path):
    """``--plugins-dir`` names a path; resolving it hides the layout to refuse.

    ``.resolve()`` turned ``<home>/plugins -> <elsewhere>`` into its target
    before any preflight ran, so the root the operator addressed was never
    tested for being a link and the backups were parked under a home they never
    named.
    """
    real = tmp_path / "srv" / "plugins"
    plugin(real, "ekho")
    backup = plugin(real, "ekho.bak-pre050")
    linked = tmp_path / ".hermes" / "plugins"
    linked.parent.mkdir(parents=True)
    linked.symlink_to(real, target_is_directory=True)

    moved, detail = healthcheck.repair_plugin_shadows(str(linked))
    assert moved is False, detail
    assert str(linked) in detail and "symlink" in detail
    assert backup.is_dir()
    assert not (tmp_path / ".hermes" / "backups").exists()
    assert not (tmp_path / "srv" / "backups").exists()

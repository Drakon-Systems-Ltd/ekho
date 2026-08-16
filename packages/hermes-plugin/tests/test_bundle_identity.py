"""Hermes bundle identity: observed hash vs optional claimed stamp (#39).

A constant injected into the hashed source cannot fail the hand-patch test —
it rides along in the same bytes. The claimed stamp lives in a file excluded
from the hash, so mutating any hashed file desyncs them.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

import pytest

from ekho_hermes.bundle_identity import (
    CLAIMED_STAMP_NAME,
    describe,
    observed_sha256,
    write_claimed_stamp,
)

PLUGIN_PKG = Path(__file__).resolve().parents[1] / "ekho_hermes"


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    dest = tmp_path / "ekho_hermes"
    shutil.copytree(
        PLUGIN_PKG,
        dest,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", CLAIMED_STAMP_NAME),
    )
    return dest


def test_observed_is_deterministic(tree: Path):
    assert observed_sha256(tree) == observed_sha256(tree)
    assert len(observed_sha256(tree)) == 64


def test_hand_patch_changes_observed(tree: Path):
    before = observed_sha256(tree)
    target = tree / "plugin.py"
    target.write_bytes(target.read_bytes() + b"\n# hand-patch\n")
    after = observed_sha256(tree)
    assert after != before


def test_claimed_stamp_file_does_not_change_observed(tree: Path):
    before = observed_sha256(tree)
    write_claimed_stamp(tree)
    assert observed_sha256(tree) == before
    ident = describe(tree)
    assert ident.match == "yes"
    assert ident.claimed == before


def test_hand_patch_after_claim_is_a_mismatch(tree: Path):
    """This is the test a constant-in-source stamp cannot pass.

    If CLAIMED_SHA256 lived inside a hashed file, rewriting that file to
    keep the claim in lockstep with the new bytes would still report match=yes
    after a hand-patch. Because the claim is excluded from the hash, a
    mutation of hashed source leaves claimed untouched and match=no.
    """
    write_claimed_stamp(tree)
    claimed = describe(tree).claimed
    (tree / "verification.py").write_bytes(
        (tree / "verification.py").read_bytes() + b"\n# patched leftover\n"
    )
    ident = describe(tree)
    assert ident.claimed == claimed
    assert ident.observed != claimed
    assert ident.match == "no"


def test_constant_inside_hashed_source_cannot_detect_its_own_file(tree: Path):
    """Negative proof: baking the claim into plugin.py hides a patch of plugin.py.

    After writing CLAIMED_SHA256 into plugin.py (hashed) and then rewriting
    that same file to update both the code and the claim, describe() would
    have to treat that as a match if it read the claim from hashed source.
    We read the claim only from the excluded stamp file, so this poisoned
    plugin.py does not become a claim and the later patch still mismatches.
    """
    write_claimed_stamp(tree)
    plugin = tree / "plugin.py"
    plugin.write_bytes(
        plugin.read_bytes()
        + f'\nCLAIMED_SHA256 = "{observed_sha256(tree)}"\n'.encode()
    )
    ident = describe(tree)
    assert ident.match == "no"
    assert ident.claimed != ident.observed


def test_log_line_names_version_and_observed(tree: Path):
    ident = describe(tree)
    line = ident.log_line()
    assert line.startswith("[ekho] bundle version=")
    assert ident.observed in line
    assert "claimed=none" in line
    assert "match=n/a" in line


def test_register_logs_bundle_identity(caplog, monkeypatch):
    from ekho_hermes import plugin
    from ekho_hermes.bundle_identity import describe as live_describe

    class _Ctx:
        def register_tool(self, **_kw):
            return None

    monkeypatch.setenv("EKHO_RELAY_URL", "")
    monkeypatch.delenv("EKHO_RELAY_URL", raising=False)
    live = live_describe()
    with caplog.at_level(logging.INFO, logger="ekho_hermes.plugin"):
        plugin.register(_Ctx())
    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert live.observed in joined
    assert "bundle version=" in joined

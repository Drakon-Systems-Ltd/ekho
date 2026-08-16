"""Identity of the Hermes plugin tree that is actually loaded.

plugin.yaml's version string is not bound to the executing files. A box can
report 0.1.0 while running a hand-patched leftover. This module hashes the
loaded package (observed) and, if present, compares it to a claimed stamp
written *outside* the hashed set so a hand-patch cannot keep them in lockstep
by riding along inside the same bytes.

The claimed file is optional. Inventory works from ``observed`` alone.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

CLAIMED_STAMP_NAME = "_claimed_bundle.py"
HASHED_SUFFIXES = {".py", ".yaml"}
_CLAIMED_RE = re.compile(
    r'^CLAIMED_SHA256\s*=\s*["\']([0-9a-f]{64})["\']\s*$',
    re.MULTILINE,
)


def package_dir() -> Path:
    return Path(__file__).resolve().parent


def _hashed_files(root: Path) -> list[Path]:
    files = [
        p
        for p in root.rglob("*")
        if p.is_file()
        and p.suffix in HASHED_SUFFIXES
        and p.name != CLAIMED_STAMP_NAME
        and "__pycache__" not in p.parts
    ]
    files.sort(key=lambda p: p.relative_to(root).as_posix())
    return files


def observed_sha256(root: Path | None = None) -> str:
    """Stable sha256 over packaged source, excluding the claimed-stamp file."""
    root = package_dir() if root is None else root
    digest = hashlib.sha256()
    for path in _hashed_files(root):
        rel = path.relative_to(root).as_posix().encode("utf-8")
        data = path.read_bytes()
        digest.update(len(rel).to_bytes(4, "big"))
        digest.update(rel)
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def plugin_version(root: Path | None = None) -> str:
    root = package_dir() if root is None else root
    yaml_path = root / "plugin.yaml"
    if not yaml_path.is_file():
        return "unknown"
    for line in yaml_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("version:"):
            return stripped.split(":", 1)[1].strip().strip("\"'")
    return "unknown"


def claimed_sha256(root: Path | None = None) -> str | None:
    root = package_dir() if root is None else root
    stamp = root / CLAIMED_STAMP_NAME
    if not stamp.is_file():
        return None
    match = _CLAIMED_RE.search(stamp.read_text(encoding="utf-8"))
    return match.group(1) if match else None


def write_claimed_stamp(root: Path | None = None) -> Path:
    """Write CLAIMED_SHA256 for the current observed tree. Excluded from the hash."""
    root = package_dir() if root is None else root
    observed = observed_sha256(root)
    path = root / CLAIMED_STAMP_NAME
    path.write_text(
        (
            "# Generated claim of the hashed Hermes plugin tree.\n"
            "# Excluded from observed_sha256 — do not put hashed source in here.\n"
            f'CLAIMED_SHA256 = "{observed}"\n'
        ),
        encoding="utf-8",
    )
    return path


@dataclass(frozen=True)
class BundleIdentity:
    version: str
    observed: str
    claimed: str | None
    match: str  # "yes" | "no" | "n/a"

    def log_line(self) -> str:
        claimed = self.claimed if self.claimed is not None else "none"
        return (
            f"[ekho] bundle version={self.version} "
            f"observed={self.observed} claimed={claimed} match={self.match}"
        )

    def short_observed(self) -> str:
        return self.observed[:12]


def describe(root: Path | None = None) -> BundleIdentity:
    root = package_dir() if root is None else root
    observed = observed_sha256(root)
    claimed = claimed_sha256(root)
    if claimed is None:
        match = "n/a"
    elif claimed == observed:
        match = "yes"
    else:
        match = "no"
    return BundleIdentity(
        version=plugin_version(root),
        observed=observed,
        claimed=claimed,
        match=match,
    )

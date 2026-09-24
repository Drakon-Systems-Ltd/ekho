"""Post-update health check for the Hermes Ekho plugin.

Run after EVERY Hermes update or venv rebuild, with the python of the venv the
Hermes SERVICE actually uses (check the service unit / hermes wrapper if the
box has more than one venv — a stale ``.venv`` beside the active ``venv`` is a
known trap). The check prints which interpreter it verified.

From a repo checkout / editable install:

    python -m ekho_hermes.healthcheck            # verify
    python -m ekho_hermes.healthcheck --repair   # fix, then verify

From an installed plugin dir (the documented copy to ``~/.hermes/plugins/ekho``
renames the package, so ``-m ekho_hermes...`` no longer resolves) — run it as a
FILE; this is fully supported:

    python ~/.hermes/plugins/ekho/healthcheck.py [--repair]

``python -m ekho.healthcheck`` cannot work: an installed dir named ``ekho``
shadows the SDK's import name, so the package import fails loudly before the
check starts. Use the file form above.

Verifies with evidence, not metadata (an "enabled" plugin whose SDK vanished
still shows enabled — the exact failure that silenced Tars and Vision):

  1. the private ``ekho`` SDK resolves to a REAL package (``spec.origin`` set,
     not a namespace phantom from a bare ``ekho/`` dir on sys.path, and not
     the plugin's own install dir shadowing the name),
  2. the SDK surface the plugin needs actually imports,
  3. the plugin's ``register`` wires all three tools — captured on a stub
     runtime with the startup connect stubbed out, so it is safe offline and
     never touches the relay,
  4. exactly one dir under each Hermes plugins root takes the ``ekho`` key —
     Hermes keys plugins on the manifest name, not the folder, so a backup copy
     left there silently replaces the live plugin (#85).

Which copy wins that key comes from Hermes' own discovery, and which roots are
in scope comes from ``hermes_constants``: the default root's ``plugins/``, the
``HERMES_HOME`` profile's, and every ``profiles/*/plugins`` beside it.
``--plugins-dir`` overrides the set with one directory. When Hermes cannot be
imported, or a directory the verdict rests on will not be read, the check says
so and WARNs — it never reports PASS on a question it could not ask
(``ekho_hermes.shadow_check``).

``--repair`` moves every non-canonical dir taking the ``ekho`` key to
``<hermes>/backups/`` (a move, never a delete), then pip-installs the first
discoverable SDK source tree (editable) into THIS interpreter's environment and
re-verifies. It preflights every root first and is all-or-nothing: one
undetermined root, one root whose copies leave no ``ekho/`` to keep, or one
symlink anywhere in anything Hermes discovered, and nothing is moved in any
root. Exit code 0 = healthy, 1 = broken, 2 = invoked unsafely.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_STANDALONE = __package__ in (None, "")

if _STANDALONE:
    # Executed as a file. sys.path[0] is this script's directory — which, in
    # the installed layout, is a package named ``ekho`` whose __init__ is the
    # PLUGIN's. Left on sys.path it would satisfy find_spec("ekho") with a
    # real origin and turn a missing SDK into a false green. Strip it before
    # anything resolves ``ekho``.
    sys.path[:] = [
        p
        for p in sys.path
        if os.path.abspath(p) != _HERE or p == ""
    ]
    if "" in sys.path and os.path.abspath(os.getcwd()) == _HERE:
        sys.path.remove("")

    def _load_sibling(mod_name, file_name):
        spec = importlib.util.spec_from_file_location(
            mod_name, os.path.join(_HERE, file_name)
        )
        mod = importlib.util.module_from_spec(spec)
        # dataclasses resolves the defining module via sys.modules.
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod

    _shim = _load_sibling("_ekho_hermes_sdk_path", "_sdk_path.py")
    _shadow = _load_sibling("_ekho_hermes_shadow_check", "shadow_check.py")
else:
    from . import _sdk_path as _shim
    from . import shadow_check as _shadow

ensure_sdk_importable = _shim.ensure_sdk_importable
_candidate_roots = _shim._candidate_roots
_looks_like_sdk_root = _shim._looks_like_sdk_root

EXPECTED_TOOLS = ("ekho_send", "ekho_open_room", "ekho_inbox")
PLUGIN_NAME = "ekho"


def _import_plugin_module():
    """Import the plugin module regardless of what the installed dir is named.

    Package mode uses the real package name. Standalone mode binds this
    directory under the canonical ``ekho_hermes`` name first, so the plugin's
    relative imports work even when the dir on disk is called ``ekho``.
    """
    if not _STANDALONE:
        return importlib.import_module(f"{__package__}.plugin")
    if "ekho_hermes" not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            "ekho_hermes",
            os.path.join(_HERE, "__init__.py"),
            submodule_search_locations=[_HERE],
        )
        pkg = importlib.util.module_from_spec(spec)
        sys.modules["ekho_hermes"] = pkg
        try:
            spec.loader.exec_module(pkg)
        except BaseException:
            del sys.modules["ekho_hermes"]
            raise
    return importlib.import_module("ekho_hermes.plugin")


class _CaptureCtx:
    """Minimal stand-in for the Hermes plugin context: records registrations."""

    def __init__(self) -> None:
        self.tools: list[str] = []

    def register_tool(self, name=None, **kwargs) -> None:  # noqa: ANN001
        self.tools.append(name)


def check_sdk() -> tuple[bool, str]:
    ensure_sdk_importable()
    try:
        spec = importlib.util.find_spec("ekho")
    except (ImportError, ValueError):
        spec = None
    if spec is None:
        return False, "SDK missing: find_spec('ekho') is None and no source tree found"
    if spec.origin is None:
        return False, (
            "namespace phantom: a bare ekho/ directory on sys.path shadows the "
            "SDK (spec.origin=None) and no real package was found"
        )
    if os.path.dirname(os.path.abspath(spec.origin)) == _HERE:
        return False, (
            "name collision: 'ekho' resolves to the plugin's own install dir "
            f"({_HERE}), not the SDK — the real SDK is missing or shadowed"
        )
    return True, f"SDK is a real package: {spec.origin}"


def check_sdk_surface() -> tuple[bool, str]:
    try:
        from ekho import AgentCredentials, EkhoAgentClient, verify_inbound  # noqa: F401
        from ekho import identity  # noqa: F401
        from ekho.verify import VerificationResult  # noqa: F401
    except Exception as exc:  # noqa: BLE001 — any failure here is the finding
        return False, f"SDK surface import failed: {exc!r}"
    return True, "SDK surface imports (credentials/client/identity/verify)"


def check_registration() -> tuple[bool, str]:
    try:
        plugin = _import_plugin_module()
    except Exception as exc:  # noqa: BLE001
        return False, f"plugin module import failed: {exc!r}"

    ctx = _CaptureCtx()
    relay_before = os.environ.get("EKHO_RELAY_URL")
    # register() is a no-op without a relay URL; give it a dummy, and stub the
    # startup connect so the check never touches the network (register already
    # treats connect failure as non-fatal).
    os.environ["EKHO_RELAY_URL"] = relay_before or "https://healthcheck.invalid"
    real_connect = plugin.ensure_connected

    def _no_connect(*args, **kwargs):  # noqa: ANN001
        raise RuntimeError("healthcheck: startup connect intentionally skipped")

    plugin.ensure_connected = _no_connect
    try:
        plugin.register(ctx)
    except Exception as exc:  # noqa: BLE001
        return False, f"register() raised: {exc!r}"
    finally:
        plugin.ensure_connected = real_connect
        if relay_before is None:
            del os.environ["EKHO_RELAY_URL"]

    missing = [tool for tool in EXPECTED_TOOLS if tool not in ctx.tools]
    if missing:
        return False, f"register() wired {ctx.tools}, missing {missing}"
    return True, "register() wired all tools: " + ", ".join(EXPECTED_TOOLS)


_GATEWAY_PYTHON_REMEDY = (
    "Run this check with the python of the venv the Hermes service uses, where "
    "hermes_cli and hermes_constants import."
)


def _roots_to_scan(plugins_root: str | None) -> tuple[list[Path], str | None]:
    """The plugins dirs to look at, or why we cannot name them.

    An explicit ``--plugins-dir`` is the operator's own answer and is taken as
    given (resolved, so ``--plugins-dir .`` still has a real parent for
    ``backups/``). Otherwise the set is Hermes' — the default root, this
    profile, and every sibling profile — and when Hermes cannot be asked there
    is no set, which is not the same as an empty one.
    """
    if plugins_root is not None:
        return [Path(plugins_root).resolve()], None
    found = _shadow.hermes_roots()
    if found.undetermined:
        detail = found.reason or "reason not reported"
        return [], (
            f"cannot tell where Hermes looks for plugins: {detail} — "
            f"{found.remedy or _GATEWAY_PYTHON_REMEDY} "
            "(or name the root with --plugins-dir)"
        )
    return list(found.roots), None


def _root_verdict(scan_result) -> tuple[str, str]:  # noqa: ANN001
    """``('pass' | 'fail' | 'unknown' | 'absent', one sentence)`` for one root.

    ``unknown`` is never folded into either of the others. A root whose
    discovery did not answer, or that holds one directory this process could
    not read, may hold the copy that is doing the shadowing — so it is reported
    as a gap, with the path and the errno the operator has to act on.
    """
    root = scan_result.root
    if scan_result.undetermined:
        return "unknown", (
            f"cannot tell what Hermes loads under {root}: {scan_result.reason} "
            f"({scan_result.remedy or _GATEWAY_PYTHON_REMEDY})"
        )
    gap = ""
    if scan_result.unreadable:
        first = scan_result.unreadable[0]
        more = len(scan_result.unreadable) - 1
        gap = (
            f"cannot tell what Hermes loads under {root}: {first.reason}"
            + (f" (and {more} more under {root})" if more else "")
        )
    if scan_result.shadowed:
        # A finding outranks the gap beside it — both are non-PASS, and only
        # one of them tells the operator what to move.
        return "fail", (
            f"{len(scan_result.installs)} dirs under {root} take the "
            f"'{PLUGIN_NAME}' key — Hermes loads only "
            f"{scan_result.winner or 'the last'}, the rest are shadowed: "
            + ", ".join(str(p) for p in scan_result.installs)
            + (f" ({gap})" if gap else "")
        )
    if gap:
        return "unknown", f"{gap} ({_shadow.FS_REMEDY})"
    dangling, problem = _shadow.dangling_canonical(root, PLUGIN_NAME)
    if problem:
        return "unknown", f"cannot tell what {root / PLUGIN_NAME} is: {problem}"
    if dangling:
        return "fail", (
            f"{root / PLUGIN_NAME} is a dangling symlink — the live plugin is gone"
        )
    if not scan_result.installs:
        return "absent", f"nothing under {root} takes the '{PLUGIN_NAME}' key"
    return "pass", (
        f"1 dir under {root} takes the '{PLUGIN_NAME}' key: {scan_result.installs[0]}"
    )


def check_plugin_shadows(plugins_root: str | None = None) -> tuple[bool | None, str]:
    """``None`` = warn: either nothing declares the name, or we could not tell.

    Every root gets its own sentence and the worst one decides. Uncertainty
    outranks a clean root and never outranks a finding: a box where one root is
    shadowed and another could not be read is broken either way, and the
    operator needs both lines.
    """
    roots, problem = _roots_to_scan(plugins_root)
    if problem:
        return None, problem
    if plugins_root is not None and not roots[0].is_dir():
        return None, (
            f"{roots[0]} does not exist — plugin not installed there "
            "(pass --plugins-dir if Hermes uses another root)"
        )
    verdicts = [_root_verdict(s) for s in _shadow.scan(roots)]
    detail = "; ".join(line for _status, line in verdicts)
    seen = {status for status, _line in verdicts}
    if "fail" in seen:
        return False, detail
    if "unknown" in seen:
        return None, detail
    if "pass" not in seen:
        return None, (
            f"{detail} — plugin not installed in any Hermes plugins root "
            "(pass --plugins-dir if Hermes uses another root)"
        )
    return True, detail


def _unique_dest(backups: Path, name: str) -> Path:
    dest = backups / name
    if not (dest.exists() or dest.is_symlink()):
        return dest
    stamp = time.strftime("%Y%m%d%H%M%S")
    n = 0
    while True:
        dest = backups / (f"{name}.{stamp}" if n == 0 else f"{name}.{stamp}.{n}")
        if not (dest.exists() or dest.is_symlink()):
            return dest
        n += 1


def repair_plugin_shadows(plugins_root: str | None = None) -> tuple[bool, str]:
    """Move every non-canonical ``ekho``-keyed dir to ``<root>/../backups/``.

    All-or-nothing across every root, preflighted before anything moves. A root
    that could not be read, a shadowed root with no ``ekho/`` to keep, or a
    symlink anywhere in anything Hermes discovered refuses the WHOLE plan —
    including, for the first two, when the plan is empty, because "nothing to
    move" is the same false all-clear as a PASS.
    """
    roots, problem = _roots_to_scan(plugins_root)
    if problem:
        return False, problem
    scans = _shadow.scan(roots)
    plan = [(s, shadow) for s in scans for shadow in s.shadows]
    refusal = _shadow.plan_refusal(scans, moving=bool(plan))
    if refusal:
        return False, refusal
    if not plan:
        return True, "no shadowing plugin copies to move"
    # Each copy is parked beside the root it came from, so a profile's backups
    # stay in that profile and the move stays on one filesystem.
    moved = []
    for scan_result, src in plan:
        backups = Path(scan_result.root).parent / "backups"
        backups.mkdir(parents=True, exist_ok=True)
        dest = _unique_dest(backups, src.name)
        shutil.move(str(src), str(dest))
        moved.append(f"{src} -> {dest}")
    return True, "moved shadowing copies: " + "; ".join(moved)


def repair() -> tuple[bool, str]:
    root = next((r for r in _candidate_roots() if _looks_like_sdk_root(r)), None)
    if root is None:
        return False, (
            "no SDK source tree found to install — clone the ekho repo and set "
            "EKHO_SDK_PATH to <repo>/sdks/python, then re-run --repair"
        )
    proc = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-e", root],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        return False, f"pip install -e {root} failed:\n{proc.stderr.strip()}"
    importlib.invalidate_caches()
    sys.modules.pop("ekho", None)
    return True, f"installed SDK editable from {root} into {sys.executable}"


def _run_checks(plugins_root: str | None = None) -> bool:
    # The interpreter IS part of the verdict: verifying a stale venv while the
    # service runs another proves nothing. Print it so the operator can match
    # it against the Hermes service unit / wrapper.
    print(f"[info] interpreter verified: {sys.executable}")
    print(f"[info] plugin dir: {_HERE}")
    ok = True
    for label, fn in (
        ("sdk", check_sdk),
        ("sdk-surface", check_sdk_surface),
        ("registration", check_registration),
        ("plugin-shadows", lambda: check_plugin_shadows(plugins_root)),
    ):
        passed, detail = fn()
        status = "WARN" if passed is None else "PASS" if passed else "FAIL"
        print(f"[{status}] {label}: {detail}")
        ok = ok and passed is not False
    return ok


def main(argv=None) -> int:  # noqa: ANN001
    parser = argparse.ArgumentParser(
        prog="python -m ekho_hermes.healthcheck", description=__doc__
    )
    parser.add_argument(
        "--repair",
        action="store_true",
        help=(
            "move shadowing plugin copies to each root's ../backups/ and "
            "pip-install the SDK source tree into this interpreter, then verify"
        ),
    )
    parser.add_argument(
        "--plugins-dir",
        default=None,
        help=(
            "scan this one plugins root instead of the set Hermes reads "
            "(default root, HERMES_HOME, every profiles/*/plugins)"
        ),
    )
    args = parser.parse_args(argv)

    if args.repair:
        moved, detail = repair_plugin_shadows(args.plugins_dir)
        print(f"[{'PASS' if moved else 'FAIL'}] repair-shadows: {detail}")
        if not moved:
            return 1
        repaired, detail = repair()
        print(f"[{'PASS' if repaired else 'FAIL'}] repair: {detail}")
        if not repaired:
            return 1

    if _run_checks(args.plugins_dir):
        print("healthy: Hermes Ekho plugin dependency chain verified")
        return 0
    print(
        "BROKEN: fix with '--repair' (run with the python of the venv the "
        "Hermes service actually uses), or set EKHO_SDK_PATH to "
        "<ekho-repo>/sdks/python",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

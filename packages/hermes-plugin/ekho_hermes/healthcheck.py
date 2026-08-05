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
     never touches the relay.

``--repair`` pip-installs the first discoverable SDK source tree (editable)
into THIS interpreter's environment and re-verifies. Exit code 0 = healthy,
1 = broken, 2 = invoked unsafely.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import os
import subprocess
import sys

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

    def _load_shim():
        spec = importlib.util.spec_from_file_location(
            "_ekho_hermes_sdk_path", os.path.join(_HERE, "_sdk_path.py")
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    _shim = _load_shim()
else:
    from . import _sdk_path as _shim

ensure_sdk_importable = _shim.ensure_sdk_importable
_candidate_roots = _shim._candidate_roots
_looks_like_sdk_root = _shim._looks_like_sdk_root

EXPECTED_TOOLS = ("ekho_send", "ekho_open_room", "ekho_inbox")


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


def _run_checks() -> bool:
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
    ):
        passed, detail = fn()
        print(f"[{'PASS' if passed else 'FAIL'}] {label}: {detail}")
        ok = ok and passed
    return ok


def main(argv=None) -> int:  # noqa: ANN001
    parser = argparse.ArgumentParser(
        prog="python -m ekho_hermes.healthcheck", description=__doc__
    )
    parser.add_argument(
        "--repair",
        action="store_true",
        help="pip-install the SDK source tree into this interpreter, then verify",
    )
    args = parser.parse_args(argv)

    if args.repair:
        repaired, detail = repair()
        print(f"[{'PASS' if repaired else 'FAIL'}] repair: {detail}")
        if not repaired:
            return 1

    if _run_checks():
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

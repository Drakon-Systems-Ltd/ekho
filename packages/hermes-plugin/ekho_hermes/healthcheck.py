"""Post-update health check for the Hermes Ekho plugin.

Run after EVERY Hermes update or venv rebuild:

    python -m ekho_hermes.healthcheck            # verify
    python -m ekho_hermes.healthcheck --repair   # fix, then verify

Verifies with evidence, not metadata (an "enabled" plugin whose SDK vanished
still shows enabled — the exact failure that silenced Tars and Vision):

  1. the private ``ekho`` SDK resolves to a REAL package (``spec.origin`` set,
     not a namespace phantom from a bare ``ekho/`` dir on sys.path),
  2. the SDK surface the plugin needs actually imports,
  3. ``ekho_hermes.plugin.register`` wires all three tools — captured on a
     stub runtime with the startup connect stubbed out, so it is safe offline
     and never touches the relay.

``--repair`` pip-installs the first discoverable SDK source tree (editable)
into THIS interpreter's environment and re-verifies. Run it with the Hermes
venv's python. Exit code 0 = healthy, 1 = broken.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import os
import subprocess
import sys

from ._sdk_path import _candidate_roots, _looks_like_sdk_root, ensure_sdk_importable

EXPECTED_TOOLS = ("ekho_send", "ekho_open_room", "ekho_inbox")


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
        plugin = importlib.import_module("ekho_hermes.plugin")
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
        "BROKEN: fix with 'python -m ekho_hermes.healthcheck --repair' "
        "(run with the Hermes venv's python), or set EKHO_SDK_PATH to "
        "<ekho-repo>/sdks/python",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

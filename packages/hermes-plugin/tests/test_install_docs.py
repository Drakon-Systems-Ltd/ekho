"""The README's install section must only name routes that work.

The Python SDK is not on PyPI, so the documented install is the source route
(``./sdks/python``) from the repository root. Pins that the unavailable
``pip install ekho-sdk`` route stays out and that the source route resolves.
"""

import re
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parents[1]
_REPO_ROOT = _PLUGIN_ROOT.parents[1]
_README = _PLUGIN_ROOT / "README.md"


def _install_section():
    text = _README.read_text(encoding="utf-8")
    match = re.search(r"^## Install\n(.*?)^## ", text, re.S | re.M)
    assert match, "README has no ## Install section"
    return match.group(1)


def test_install_does_not_offer_unpublished_pypi_package():
    assert not re.search(r"pip install\s+ekho-sdk", _README.read_text(encoding="utf-8"))


def test_install_source_route_resolves_from_repo_root():
    section = _install_section()
    assert "pip install ./sdks/python" in section
    assert "root of a checkout" in section
    pyproject = (_REPO_ROOT / "sdks" / "python" / "pyproject.toml").read_text(encoding="utf-8")
    assert re.search(r'^name = "ekho-sdk"$', pyproject, re.M)
    assert (_REPO_ROOT / "sdks" / "python" / "ekho" / "__init__.py").is_file()
    assert (_REPO_ROOT / "packages" / "hermes-plugin" / "ekho_hermes").is_dir()

"""The SDK install docs must only name routes that work.

The Python SDK is not on PyPI, so the documented install is the source route
(``./sdks/python``) from the repository root. Pins that the unavailable
``pip install ekho-sdk`` route stays out of both the plugin and SDK READMEs,
that the source route resolves, and that the dependencies the docs name match
the ones ``sdks/python/pyproject.toml`` declares.
"""

import re
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parents[1]
_REPO_ROOT = _PLUGIN_ROOT.parents[1]
_README = _PLUGIN_ROOT / "README.md"
_SDK_DIR = _REPO_ROOT / "sdks" / "python"
_SDK_README = _SDK_DIR / "README.md"


def _declared_sdk_dependencies():
    pyproject = (_SDK_DIR / "pyproject.toml").read_text(encoding="utf-8")
    block = re.search(r"^dependencies = \[(.*?)^\]", pyproject, re.S | re.M)
    assert block, "sdks/python/pyproject.toml has no dependencies list"
    names = re.findall(r'"([A-Za-z0-9_.-]+)', block.group(1))
    assert names, "sdks/python/pyproject.toml declares no dependencies"
    return names


def _install_section():
    text = _README.read_text(encoding="utf-8")
    match = re.search(r"^## Install\n(.*?)^## ", text, re.S | re.M)
    assert match, "README has no ## Install section"
    return match.group(1)


def test_install_does_not_offer_unpublished_pypi_package():
    for readme in (_README, _SDK_README):
        assert not re.search(r"pip install\s+ekho-sdk", readme.read_text(encoding="utf-8")), readme


def test_sdk_readme_offers_source_install():
    text = _SDK_README.read_text(encoding="utf-8")
    match = re.search(r"^## Install\n(.*?)^## ", text, re.S | re.M)
    assert match, "SDK README has no ## Install section"
    section = match.group(1)
    assert "not published to PyPI" in section
    assert "cd ekho/sdks/python" in section
    assert "pip install -e ." in section


def test_docs_name_every_declared_sdk_dependency():
    deps = _declared_sdk_dependencies()
    assert {"requests", "cryptography"} <= set(deps)
    sdk_text = _SDK_README.read_text(encoding="utf-8")
    requirements = re.search(r"^## Requirements\n(.*?)^## ", sdk_text, re.S | re.M)
    assert requirements, "SDK README has no ## Requirements section"
    for dep in deps:
        assert f"`{dep}`" in requirements.group(1), dep
    # The --without-pip copy note must name every dependency, must not claim
    # a single one, and must not present the copy as a complete install.
    section = _install_section()
    note = re.search(r"^> If the venv was created `--without-pip`.*$", section, re.M)
    assert note, "plugin README lost the --without-pip note"
    for dep in deps:
        assert f"`{dep}`" in note.group(0), dep
    assert "single dependency" not in note.group(0)
    assert "not a complete install" in note.group(0)


def test_install_source_route_resolves_from_repo_root():
    section = _install_section()
    assert "pip install ./sdks/python" in section
    assert "root of a checkout" in section
    pyproject = (_REPO_ROOT / "sdks" / "python" / "pyproject.toml").read_text(encoding="utf-8")
    assert re.search(r'^name = "ekho-sdk"$', pyproject, re.M)
    assert (_REPO_ROOT / "sdks" / "python" / "ekho" / "__init__.py").is_file()
    assert (_REPO_ROOT / "packages" / "hermes-plugin" / "ekho_hermes").is_dir()

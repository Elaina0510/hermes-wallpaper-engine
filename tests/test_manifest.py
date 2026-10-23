"""T1.5 — MOD-005 ``dashboard/manifest.json`` acceptance.

The manifest is not documentation: the gateway parses it at startup
(``hermes_cli/web_server_dashboard.py``) and, if ``api`` survives the
``_safe_plugin_api_relpath`` check **and** the plugin is in ``plugins.enabled``,
imports ``dashboard/plugin_api.py`` and mounts its ``router`` at
``/api/plugins/wallpaper-engine/``. So these cases drive the **host's own
functions** rather than re-implementing the rules:

  ``_safe_plugin_api_relpath``    actual-path validation of the ``api`` field
  ``_dashboard_plugin_entry``     the dict the rest of the gateway consumes
  ``_plugin_api_mount_skip_reason``  the ``plugins.enabled`` opt-in gate
  ``_discover_dashboard_plugins``    the whole ``<plugins root>/*/dashboard/manifest.json`` scan

Why this manifest is api-only
    The appearance panel is a **desktop** contribution
    (``desktop/src/99-register.js`` registers ``appearance.extra``), so this
    plugin ships no dashboard JS bundle. ``slots``/``entry``/``css`` therefore
    stay undeclared: ``entry`` would point the SPA at a file that will never
    exist. The host still injects its own ``dist/index.js`` default into the
    entry dict (asserted below) — the SPA's ``<script>`` for it 404s and is
    reported as a console warning, which is the accepted cost of an api-only
    dashboard plugin. ``tab.hidden`` keeps the plugin out of the nav rail.

How the host module is loaded
    ``importlib.util.spec_from_file_location`` on the real file — **not**
    ``import hermes_cli.web_server_dashboard``. Putting ``hermes-agent`` on
    ``sys.path`` would drag in the whole app (config, providers, secret store,
    …) just to call four pure functions. Loading by path still executes the
    module's five top-level imports, so the four that need the app
    (``hermes_yaml``, ``utils``, ``hermes_cli.config``/``hermes_cli.plugins``,
    ``hermes_constants``) are stubbed with minimal stand-ins for the duration of
    the session; ``fastapi`` is real (it is installed in the test venv). None of
    the functions under test touch those dependencies at import time — see
    ``host`` fixture and the ``_stub`` helper. The stubs are only consulted by
    ``_dashboard_plugin_search_dirs`` (``get_process_hermes_home`` /
    ``get_bundled_plugins_dir`` / ``env_var_enabled``), which the discovery case
    points at the *real* plugins root so the real manifest is found.

Run with (no bytecode, no cache directories left in the plugin tree)::

    PYTHONDONTWRITEBYTECODE=1 python \\
        -m pytest tests/test_manifest.py -v -p no:cacheprovider
"""

from __future__ import annotations

import ast
import importlib.util
import json
import os
import re
import sys
import types
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = TESTS_DIR.parent
DASHBOARD_DIR = PLUGIN_ROOT / "dashboard"
# <hermes home>/plugins/<plugin>/ — the host scans ``<hermes home>/plugins/*/dashboard``,
# so the home is two levels up from the plugin root.
HERMES_HOME = PLUGIN_ROOT.parent.parent
MANIFEST_PATH = DASHBOARD_DIR / "manifest.json"
CORE_JS = PLUGIN_ROOT / "desktop" / "src" / "00-core.js"

HERMES_AGENT_ROOT = Path(os.environ.get("HERMES_AGENT_ROOT", str(HERMES_HOME / "hermes-agent")))
HOST_MODULE_PATH = HERMES_AGENT_ROOT / "hermes_cli" / "web_server_dashboard.py"

EXPECTED_NAME = "wallpaper-engine"
EXPECTED_API = "plugin_api.py"

# Top-level imports of the host module that belong to the Hermes app itself.
# ``fastapi`` is deliberately absent: the test venv has it for real.
_STUBBED_MODULES = (
    "hermes_cli",
    "hermes_cli.config",
    "hermes_cli.plugins",
    "hermes_yaml",
    "hermes_constants",
    "utils",
)

pytestmark = pytest.mark.skipif(
    not HOST_MODULE_PATH.is_file(),
    reason=f"host module not found at {HOST_MODULE_PATH} (set HERMES_AGENT_ROOT)",
)


def _manifest() -> dict:
    # utf-8-sig is exactly what the host uses at discovery time, so a BOM would
    # still parse — the no-BOM assertion below keeps the file portable anyway.
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8-sig"))


@pytest.fixture(scope="module")
def host():
    """The real ``web_server_dashboard.py``, loaded by path with app deps stubbed."""
    saved = {name: sys.modules.get(name) for name in _STUBBED_MODULES}

    def _stub(name: str, **attrs):
        mod = types.ModuleType(name)
        mod.__dict__.update(attrs)
        sys.modules[name] = mod
        return mod

    _stub("hermes_yaml", safe_load=lambda *a, **k: None, safe_dump=lambda *a, **k: "")
    _stub("utils", env_var_enabled=lambda *a, **k: False)
    pkg = _stub("hermes_cli")
    pkg.__path__ = []  # namespace marker so ``hermes_cli.*`` stays stubbed
    _stub(
        "hermes_cli.config",
        cfg_get=lambda *a, **k: None,
        get_process_hermes_home=lambda: HERMES_HOME,
        load_config=lambda *a, **k: {},
    )
    _stub("hermes_cli.plugins", get_bundled_plugins_dir=lambda: HERMES_HOME / "__no_bundled__")
    _stub("hermes_constants", get_default_hermes_root=lambda: HERMES_HOME)

    module_name = "we_host_web_server_dashboard"
    spec = importlib.util.spec_from_file_location(module_name, HOST_MODULE_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    try:
        spec.loader.exec_module(mod)
        yield mod
    finally:
        sys.modules.pop(module_name, None)
        for name, previous in saved.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


# ---------------------------------------------------------------------------
# a) manifest.json is valid JSON and carries the required fields
# ---------------------------------------------------------------------------

def test_manifest_is_valid_json_without_bom():
    raw = MANIFEST_PATH.read_bytes()
    assert raw, "manifest.json is empty"
    assert not raw.startswith(b"\xef\xbb\xbf"), "BOM accepted by the host but avoidable noise"
    text = raw.decode("utf-8")
    data = json.loads(text)
    assert isinstance(data, dict)
    assert text.endswith("\n")


def test_manifest_field_set_is_exactly_the_intended_one():
    # No slots / entry / css: this plugin contributes no dashboard JS bundle, and a
    # stray key here would make the SPA fetch a file that will never exist.
    assert set(_manifest()) == {"name", "label", "description", "icon", "version", "tab", "api"}


def test_name_matches_plugin_directory():
    assert _manifest()["name"] == EXPECTED_NAME
    assert PLUGIN_ROOT.name == EXPECTED_NAME, "manifest name must equal the plugin dir the host scans"
    # The host derives the route prefix from this field: /api/plugins/<name>/.
    assert re.fullmatch(r"[a-z0-9][a-z0-9-]*[a-z0-9]", _manifest()["name"])


def test_label_description_icon_are_human_readable():
    m = _manifest()
    assert m["label"] == "Wallpaper Engine"
    assert isinstance(m["description"], str) and len(m["description"]) >= 40
    assert "\n" not in m["description"], "single-line description (rendered in a table cell)"
    assert m["icon"] == "Eye"


def test_icon_is_in_the_dashboard_icon_whitelist():
    """``App.tsx`` resolves the icon through a fixed ICON_MAP; unknown names
    silently fall back to ``Puzzle``, so pin the name to a real entry."""
    app_tsx = HERMES_AGENT_ROOT / "web" / "src" / "App.tsx"
    if not app_tsx.is_file():
        pytest.skip(f"{app_tsx} not available")
    text = app_tsx.read_text(encoding="utf-8")
    block = re.search(r"const ICON_MAP[^{]*\{(.*?)\};", text, re.S)
    assert block, "ICON_MAP block not found — host frontend layout changed"
    icons = set(re.findall(r"^\s*([A-Z]\w*),\s*$", block.group(1), re.M))
    assert icons, "ICON_MAP parsed empty"
    assert _manifest()["icon"] in icons, f"icon not renderable; known: {sorted(icons)}"


def test_version_matches_desktop_bundle_constant():
    """One version everywhere: manifest ↔ ``WE_PLUGIN_VERSION`` in 00-core.js."""
    assert CORE_JS.is_file(), f"missing {CORE_JS}"
    found = re.search(r"WE_PLUGIN_VERSION\s*=\s*['\"]([^'\"]+)['\"]", CORE_JS.read_text(encoding="utf-8"))
    assert found, "WE_PLUGIN_VERSION not found in desktop/src/00-core.js"
    assert _manifest()["version"] == found.group(1)


def test_tab_is_hidden_and_nothing_else():
    tab = _manifest()["tab"]
    assert isinstance(tab, dict)
    assert tab["hidden"] is True
    # A tab path/override would register a nav entry for a plugin that ships no
    # dashboard component — the hidden flag is the whole point.
    assert set(tab) == {"hidden"}


def test_api_is_a_relative_sibling_file():
    api = _manifest()["api"]
    assert api == EXPECTED_API
    assert not Path(api).is_absolute()
    assert (DASHBOARD_DIR / api).is_file()


def test_api_file_actually_exposes_a_module_level_router():
    """Cheap AST check (no import side effects — importing plugin_api starts the
    media server). The functional router contract is covered by test_plugin_api.py."""
    tree = ast.parse((DASHBOARD_DIR / EXPECTED_API).read_text(encoding="utf-8"))
    names = {
        target.id
        for node in tree.body
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    assert "router" in names, "plugin_api.py must assign a module-level `router`"


# ---------------------------------------------------------------------------
# b) the api path survives the host's security validation
# ---------------------------------------------------------------------------

def test_api_relpath_accepted_by_host_validator(host):
    assert host._safe_plugin_api_relpath(_manifest()["api"], dashboard_dir=DASHBOARD_DIR) == EXPECTED_API


def test_nested_relpath_inside_dashboard_is_also_accepted(host):
    """Contrast case: the rule is "stays inside dashboard/", not "no slashes"."""
    assert host._safe_plugin_api_relpath("pkg/api.py", dashboard_dir=DASHBOARD_DIR) == "pkg/api.py"


# ---------------------------------------------------------------------------
# c) negative cases — absolute and escaping paths are refused
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "api_field",
    [
        "C:/x/plugin_api.py",
        "C:\\x\\plugin_api.py",
        "/etc/plugin_api.py",
        "\\\\server\\share\\plugin_api.py",
        "../plugin_api.py",
        "../../plugin_api.py",
        "sub/../../plugin_api.py",
        "./../plugin_api.py",
        "",
        "   ",
        None,
        42,
        ["plugin_api.py"],
    ],
)
def test_unsafe_api_paths_are_refused(host, api_field):
    assert host._safe_plugin_api_relpath(api_field, dashboard_dir=DASHBOARD_DIR) is None


def test_unsafe_manifest_field_disables_backend_but_not_discovery(host):
    """The failure mode the validator guards: bad ``api`` ⇒ no routes, plugin still listed."""
    data = dict(_manifest(), api="../../../evil.py")
    entry = host._dashboard_plugin_entry(data, EXPECTED_NAME, DASHBOARD_DIR, "user")
    assert entry["has_api"] is False
    assert entry["_api_file"] is None
    assert entry["name"] == EXPECTED_NAME


# ---------------------------------------------------------------------------
# d) the entry dict the gateway consumes
# ---------------------------------------------------------------------------

def test_dashboard_plugin_entry_from_real_manifest(host):
    m = _manifest()
    entry = host._dashboard_plugin_entry(m, m["name"], DASHBOARD_DIR, "user")
    assert entry["name"] == "wallpaper-engine"
    assert entry["label"] == "Wallpaper Engine"
    assert entry["version"] == m["version"]
    assert entry["description"] == m["description"]
    assert entry["icon"] == "Eye"
    assert entry["tab"] == {"path": "/wallpaper-engine", "position": "end", "hidden": True}
    assert entry["slots"] == []
    assert entry["css"] is None
    assert entry["source"] == "user"
    assert Path(entry["_dir"]) == DASHBOARD_DIR
    # Backend mounting is what this manifest exists for.
    assert entry["has_api"] is True
    assert entry["_api_file"] == "plugin_api.py"
    # The host injects its own JS-entry default when none is declared; the plugin
    # ships no dashboard bundle, so that default is simply never served.
    assert entry["entry"] == "dist/index.js"


def test_user_plugin_api_needs_the_plugins_enabled_allowlist(host):
    entry = host._dashboard_plugin_entry(_manifest(), EXPECTED_NAME, DASHBOARD_DIR, "user")
    assert host._plugin_api_mount_skip_reason(entry, set(), set()) == "not in plugins.enabled"
    assert host._plugin_api_mount_skip_reason(entry, {EXPECTED_NAME}, set()) is None
    assert host._plugin_api_mount_skip_reason(entry, {EXPECTED_NAME}, {EXPECTED_NAME}) == "explicitly disabled"


def test_discovery_scan_finds_this_manifest(host):
    """End-to-end: the real ``<plugins root>/*/dashboard/manifest.json`` walk."""
    found = {p["name"]: p for p in host._discover_dashboard_plugins()}
    assert EXPECTED_NAME in found, f"not discovered; scan saw {sorted(found)}"
    plugin = found[EXPECTED_NAME]
    assert plugin["has_api"] is True
    assert plugin["_api_file"] == EXPECTED_API
    assert Path(plugin["_dir"]) == DASHBOARD_DIR
    assert plugin["source"] == "user"
    assert plugin.get("tab", {}).get("hidden") is True

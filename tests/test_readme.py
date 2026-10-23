"""T2.8 — the README must describe THIS repository, not a remembered one.

Every claim the README makes about a path, a build command, a route, an exported
symbol or a suite size is re-derived from the tree here and asserted. The point of
the file is to make "the docs drifted" a red test instead of a surprise at
install time.

What is deliberately *not* asserted:

* the ``320 passed, 4 skipped`` figure — it is a dated measurement (running the
  whole suite takes ~3 minutes and is the developer's job, §7.1). The test only
  requires it to be written as a dated measurement so it can never read as a
  timeless guarantee.
* anything the README itself labels 未验证 / 待真机 — those are honesty markers,
  and this file asserts they exist rather than checking they are true.

Run it like any other backend suite (contract C7):

    PYTHONDONTWRITEBYTECODE=1 <python> -m pytest tests/test_readme.py -p no:cacheprovider -q
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
README_PATH = PLUGIN_ROOT / "README.md"
SRC_DIR = PLUGIN_ROOT / "desktop" / "src"
FRONTEND_TESTS = PLUGIN_ROOT / "tests" / "frontend"


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def readme_text() -> str:
    assert README_PATH.is_file(), f"README.md is missing at {README_PATH}"
    text = README_PATH.read_text(encoding="utf-8")
    assert text.strip(), "README.md is empty"
    return text


def _inline_code(text: str) -> list[str]:
    """Every backticked span in the README, in order."""
    return re.findall(r"`([^`\n]+)`", text)


def _path_tokens(text: str) -> list[str]:
    """Backticked spans plus every word inside a fenced block.

    Shell examples quote paths that are not backticked individually, and those are
    exactly the paths a user will type — they get the same existence check.
    """
    tokens = _inline_code(text)
    for block in re.findall(r"```[a-zA-Z]*\n(.*?)```", text, re.S):
        for line in block.splitlines():
            line = line.split("#", 1)[0]
            for word in line.split():
                tokens.append(word.strip("'\"`"))
    return tokens


def _source_text() -> str:
    """All of desktop/src/*.js concatenated (the build's own input)."""
    return "\n".join(p.read_text(encoding="utf-8") for p in sorted(SRC_DIR.glob("*.js")))


# paths quoted in inline code that intentionally do not exist yet
_NOT_REQUIRED = {
    # the backup file the README tells the user to create right before step 3
    "config.yaml.bak-we",
}
_PATH_PREFIXES = ("dashboard/", "desktop/", "tests/", "vendor/", "data/")
_PATH_SUFFIX_RE = re.compile(r"\.(py|js|mjs|json|md|html|vdf|pkg)$")


# --------------------------------------------------------------------------- #
# structure
# --------------------------------------------------------------------------- #


def test_readme_has_the_required_sections(readme_text: str) -> None:
    """The task list (T2.8) names 7 mandatory topics; each needs its own heading."""
    headings = re.findall(r"^#{2,3} .+$", readme_text, re.M)
    joined = "\n".join(headings)
    for needle in (
        "架构一览",
        "安装与启用",
        "验证清单",
        "排障表",
        "已知限制",
        "开发指南",
    ):
        assert needle in joined, f"README is missing a '{needle}' heading"


def test_every_repo_path_mentioned_exists(readme_text: str) -> None:
    """Any plugin-relative or absolute path the README quotes must resolve.

    Glob patterns (``desktop/src/*.js``), placeholders (``<HERMES_HOME>/…``) and
    backup names are skipped by construction, not by luck: they contain ``*`` or
    ``<``, or are listed in ``_NOT_REQUIRED``.
    """
    checked = 0
    missing: list[str] = []
    for token in _path_tokens(readme_text):
        token = token.strip()
        if not token or token in _NOT_REQUIRED:
            continue
        if "*" in token or "<" in token or " " in token or "…" in token:
            continue
        candidate: Path | None = None
        if token == "README.md":
            candidate = README_PATH
        elif re.match(r"^[A-Za-z]:/", token):
            candidate = Path(token)
        elif token.startswith(_PATH_PREFIXES) and _PATH_SUFFIX_RE.search(token):
            candidate = PLUGIN_ROOT / token
        if candidate is None:
            continue
        checked += 1
        if not candidate.exists():
            missing.append(f"{token} -> {candidate}")
    assert checked >= 20, f"only {checked} paths were extracted; the sweep is not reading the README"
    assert not missing, "README references paths that do not exist:\n" + "\n".join(missing)


def test_tree_block_lists_real_files(readme_text: str) -> None:
    """The ASCII tree names files by basename only — resolve each one in the tree.

    ``dashboard/`` in the README drawing is split into ``├── scan.py`` lines, so the
    path sweep above cannot see them; this closes that gap by matching basenames.
    """
    tree = next(b for b in re.findall(r"```text\n(.*?)```", readme_text, re.S) if "plugin" in b)
    names = []
    for line in tree.splitlines():
        if "── " not in line:
            continue
        entry = line.split("── ", 1)[1].split("←")[0].strip()
        if entry.startswith("plugin.js") or "/" in entry or "*" in entry:
            continue
        if re.search(r"\.(py|js|mjs|json|md|html)$", entry):
            names.append(entry)
    assert len(names) >= 12, f"tree parsing found only {names}"

    on_disk = {p.name for p in PLUGIN_ROOT.rglob("*") if p.is_file()}
    missing = sorted(n for n in names if n not in on_disk)
    assert not missing, "README tree lists files that do not exist:\n" + "\n".join(missing)


def test_readme_never_claims_unverified_work_was_verified(readme_text: str) -> None:
    """Two rules: no bare '已验证通过', and the honesty markers must be present."""
    assert "已验证通过" not in readme_text
    for marker in ("未验证", "待真机"):
        assert marker in readme_text, f"README lost its '{marker}' qualifiers"


def test_readme_documents_all_seven_contracts(readme_text: str) -> None:
    for n in range(1, 8):
        assert f"C{n}" in readme_text, f"README does not mention contract C{n}"


# --------------------------------------------------------------------------- #
# build
# --------------------------------------------------------------------------- #


def test_build_command_flags_are_real() -> None:
    """README's ``python desktop/build.py --src … --out …`` must be the real CLI.

    ``--help`` is the only invocation used: it neither writes ``plugin.js`` nor
    touches the tree (contract C7).
    """
    proc = subprocess.run(
        [sys.executable, str(PLUGIN_ROOT / "desktop" / "build.py"), "--help"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    assert "--src" in proc.stdout and "--out" in proc.stdout


def test_readme_product_facts_match_the_built_file(readme_text: str) -> None:
    """Size, sha256 and "from N file(s)" must equal what is on disk / what N is."""
    product = PLUGIN_ROOT / "desktop" / "plugin.js"
    assert product.is_file(), "desktop/plugin.js is missing — README step 1 requires it"

    data = product.read_bytes()
    quoted_sha = re.search(r"sha256: ([0-9a-f]{64})", readme_text)
    assert quoted_sha, "README no longer quotes a full sha256 for the build output"
    assert hashlib.sha256(data).hexdigest() == quoted_sha.group(1), (
        "README's sha256 does not match desktop/plugin.js — rebuild or fix the README"
    )

    quoted_build = re.search(r"from (\d+) file\(s\), (\d+) bytes", readme_text)
    assert quoted_build, "README no longer quotes the build summary line"
    files_claimed, bytes_claimed = int(quoted_build.group(1)), int(quoted_build.group(2))
    assert files_claimed == len(list(SRC_DIR.glob("*.js")))
    assert bytes_claimed == len(data)


def test_readme_states_six_enforced_rules(readme_text: str) -> None:
    """The rule table must cover rule1..rule6 — the same set build.py enforces."""
    for n in range(1, 7):
        assert f"| rule{n} |" in readme_text, f"rule{n} row missing from the build table"
    build_src = (PLUGIN_ROOT / "desktop" / "build.py").read_text(encoding="utf-8")
    for n in range(1, 7):
        assert f"rule{n}" in build_src, f"build.py has no rule{n}"


# --------------------------------------------------------------------------- #
# frontend surface
# --------------------------------------------------------------------------- #


def test_every_we_symbol_in_readme_exists_in_src(readme_text: str) -> None:
    """No invented API names: each ``weXxx`` / ``WE_XXX`` the README names is real."""
    src = _source_text()
    symbols = {t for t in _inline_code(readme_text) if re.fullmatch(r"we[A-Za-z]+", t)}
    symbols |= {t for t in _inline_code(readme_text) if re.fullmatch(r"WE_[A-Z_]+", t)}
    assert len(symbols) >= 25, f"only {len(symbols)} symbols found; sweep looks broken"
    missing = sorted(s for s in symbols if not re.search(rf"\b{re.escape(s)}\b", src))
    assert not missing, "README names symbols that are not in desktop/src:\n" + "\n".join(missing)


def test_readme_scene_gap_matches_the_layer_module(readme_text: str) -> None:
    """The 'scene/web do not render yet' note must track WE_LAYER_RENDERED_KINDS.

    If someone wires the WebWallGL host into 10-layer.js, this fails until the
    README stops saying the feature is missing — the doc cannot silently lag in
    the optimistic direction.
    """
    layer = (SRC_DIR / "10-layer.js").read_text(encoding="utf-8")
    frozen = re.search(r"WE_LAYER_RENDERED_KINDS = Object\.freeze\(\[(.*?)\]\)", layer, re.S)
    assert frozen, "WE_LAYER_RENDERED_KINDS not found in 10-layer.js"
    kinds = re.findall(r"'([a-z]+)'", frozen.group(1))
    quoted = "[" + ",".join(f"'{k}'" for k in kinds) + "]"
    assert quoted in readme_text, f"README must quote the real rendered kinds ({quoted})"

    wired = [m for m in ("host.html", "/gl/", "we-frame") if m in _source_text()]
    if kinds == ["video", "image"] and not wired:
        assert "还不会出画面" in readme_text
        assert "尚未接入" in readme_text
    else:
        assert "还不会出画面" not in readme_text, (
            "the layer now renders more kinds (or has host wiring): update the README gap note"
        )


def test_store_has_exactly_eight_fields(readme_text: str) -> None:
    """The README calls the store '8 fields closed' — check the actual initial state."""
    core = (SRC_DIR / "00-core.js").read_text(encoding="utf-8")
    body = re.search(r"function weInitialState\(\)\s*\{(.*?)\n\}", core, re.S)
    assert body, "weInitialState() not found in 00-core.js"
    fields = re.findall(r"^\s{4}([A-Za-z]+):", body.group(1), re.M)
    assert len(fields) == 8, f"store shape changed: {fields}"

    # and the README must name the same eight, in the same order
    quoted = re.search(r"store 是封闭的 8 字段\*\*：(.+?)（见", readme_text)
    assert quoted, "README's store-field sentence changed shape"
    listed = re.findall(r"`([A-Za-z]+)`", quoted.group(1))
    assert listed == fields, f"README lists {listed}, source has {fields}"


def test_readme_test_commands_point_at_real_files(readme_text: str) -> None:
    """Every suite the README tells you to run must exist."""
    pytest_files = set(re.findall(r"`(test_[a-z_]+\.py)`", readme_text))
    assert pytest_files, "README no longer names any pytest file"
    for name in sorted(pytest_files):
        assert (PLUGIN_ROOT / "tests" / name).is_file(), f"tests/{name} does not exist"

    mjs_files = set(re.findall(r"(tests/frontend/[0-9a-z-]+\.test\.mjs)", readme_text))
    assert len(mjs_files) == 6, f"README should name all six suites, found {mjs_files}"
    for rel in sorted(mjs_files):
        assert (PLUGIN_ROOT / rel).is_file(), f"{rel} does not exist"


def test_readme_suite_counts_match_the_suites(readme_text: str) -> None:
    """``tests 167`` and the per-suite breakdown must equal the real test() counts."""
    per_suite = {
        p.name: len(re.findall(r"^\s*test\(", p.read_text(encoding="utf-8"), re.M))
        for p in sorted(FRONTEND_TESTS.glob("*.test.mjs"))
    }
    total = sum(per_suite.values())

    assert f"tests {total}" in readme_text, f"README does not quote the real total ({total})"
    breakdown = " + ".join(str(n) for n in per_suite.values())
    assert breakdown in readme_text, f"README's breakdown should read '{breakdown}'"
    for name, count in per_suite.items():
        assert count > 0, f"{name} contains no tests"


def test_readme_keeps_the_pytest_hygiene_flags(readme_text: str) -> None:
    """Contract C7: the documented command must disable bytecode and the cache."""
    assert "PYTHONDONTWRITEBYTECODE=1" in readme_text
    assert "-p no:cacheprovider" in readme_text


def test_pytest_baseline_reads_as_a_dated_measurement(readme_text: str) -> None:
    """No timeless 'the suite passes' claim: a number, a date, and no invented floor."""
    quoted = re.search(r"本机实测（(\d{4}-\d{2}-\d{2})）：`(\d+) passed, (\d+) skipped`", readme_text)
    assert quoted, "the pytest baseline must be written as 本机实测（YYYY-MM-DD）：`N passed, M skipped`"
    passed, skipped = int(quoted.group(2)), int(quoted.group(3))
    assert skipped == 4, f"quoted skip count {skipped} disagrees with the recorded 4"

    # The total is decomposed in the same sentence: "<N> 条是本文自检 … 产品套件本体为 <M>".
    # Both halves are checked, so adding a test here without touching the README fails.
    doc_claimed = int(re.search(r"其中 (\d+) 条是本文自检", readme_text).group(1))
    product_claimed = int(re.search(r"产品套件本体为 (\d+)", readme_text).group(1))
    doc_actual = len(re.findall(r"^def test_", Path(__file__).read_text(encoding="utf-8"), re.M))
    assert doc_claimed == doc_actual, f"README says {doc_claimed} self-check tests, file has {doc_actual}"
    assert product_claimed >= 292, f"quoted product count {product_claimed} is below the T1.4 baseline"
    assert passed == doc_actual + product_claimed, (
        f"{passed} != {doc_actual} (self-check) + {product_claimed} (product)"
    )

    # the tree must still contain the suite files that make that count plausible
    suites = sorted(p.name for p in (PLUGIN_ROOT / "tests").glob("test_*.py"))
    assert len(suites) >= 8, f"only {suites} present"


def test_readme_documents_the_node_directory_pitfall(readme_text: str) -> None:
    """The 'must pass .mjs files, not the directory' warning must stay."""
    assert "node --test tests/frontend`" in readme_text
    assert "'test failed'" in readme_text


# --------------------------------------------------------------------------- #
# backend surface
# --------------------------------------------------------------------------- #


def test_status_route_really_returns_seven_keys(readme_text: str) -> None:
    """The README's '/status 7 keys' list must equal get_status()'s return dict."""
    api = (PLUGIN_ROOT / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")
    block = re.search(r"def get_status\(\).*?return \{\s*\"ok\": True,(.*?)\n    \}", api, re.S)
    assert block, "get_status() return literal not found"
    actual = ["ok"] + re.findall(r"\"([A-Za-z]+)\":", block.group(1))
    assert len(actual) == 7, f"get_status() no longer returns 7 keys: {actual}"

    row = re.search(r"\| `GET /status` \|(.*?)\n", readme_text)
    assert row, "README's /status table row is gone"
    documented = re.findall(r"`([A-Za-z]+)`", row.group(1))
    assert documented == actual, f"README documents {documented}, code returns {actual}"


def test_library_route_and_payload_keys(readme_text: str) -> None:
    api = (PLUGIN_ROOT / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")
    assert '@router.get("/library")' in api
    scan = (PLUGIN_ROOT / "dashboard" / "scan.py").read_text(encoding="utf-8")
    payload = re.search(r"-> dict\[str, Any\]:.*?\"engineFound\":.*?\"errors\":", scan, re.S)
    assert payload, "could not locate the scan() payload keys"
    for key in ("engineFound", "mediaOrigin", "scannedAt", "items", "errors"):
        assert f'"{key}"' in payload.group(0)
    assert "5 键" in readme_text


def test_config_envelope_is_documented_as_c1(readme_text: str) -> None:
    """C1: GET /config wraps the document; the README must not promise a bare doc."""
    api = (PLUGIN_ROOT / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")
    assert re.search(r'@router.get\("/config"\)', api)
    assert re.search(r'@router.put\("/config"\)', api)
    assert 'return {"ok": True, "config": api_store().get()}' in api
    assert "body.config" in readme_text


def test_media_routes_are_real(readme_text: str) -> None:
    media = (PLUGIN_ROOT / "dashboard" / "media_server.py").read_text(encoding="utf-8")
    for marker in ('"/health"', '"/gl/"', 'startswith("/s/")', 'startswith("/m/")'):
        assert marker in media, f"media_server.py lost {marker}"
    for route in ("/m/<token>", "/s/<token>/<rel>", "/gl/<rel>", "/health"):
        assert route in readme_text, f"README does not document {route}"


# --------------------------------------------------------------------------- #
# enablement (the step the README must NOT perform, only describe)
# --------------------------------------------------------------------------- #


def test_readme_marks_the_config_step_as_requiring_confirmation(readme_text: str) -> None:
    assert "需你确认" in readme_text
    assert "hermes config set plugins.enabled" in readme_text
    # the "this was not executed" disclosure must stay attached to that command
    assert "**没有执行**" in readme_text


def test_readme_reports_the_absent_enabled_key_truthfully() -> None:
    """The 'no plugins.enabled key' claim is checked against the live config."""
    hermes_home = PLUGIN_ROOT.parent.parent  # <hermes home>/plugins/<plugin>/
    config = hermes_home / "config.yaml"
    if not config.is_file():  # running outside the dev machine
        pytest.skip("HERMES_HOME/config.yaml not present")
    text = config.read_text(encoding="utf-8", errors="replace")
    section = re.search(r"^plugins:\n((?:[ \t].*\n|\n)*)", text, re.M)
    assert section, "config.yaml has no plugins: section"
    block = section.group(1)
    # If someone (with the user's consent) already enabled the allow-list, the
    # README sentence about its absence must have been updated too — but this
    # test only guards the current state, so it only fires while the key is absent.
    if "enabled:" in block:
        pytest.skip("plugins.enabled is now present; README's 'current state' note is stale-checked manually")
    assert "clone_timeout_seconds" in block
    assert "没有** `enabled` 键" in README_PATH.read_text(encoding="utf-8")


def test_readme_does_not_edit_config_itself(readme_text: str) -> None:
    """Guard the hard rule: the page describes one write step and claims none was taken."""
    assert "已加入 plugins.enabled" not in readme_text, "README must not claim the allow-list was edited"
    assert readme_text.count("hermes config set plugins.enabled") == 1, (
        "exactly one write command should be documented, so it cannot be applied by accident"
    )


# --------------------------------------------------------------------------- #
# manifest + defaults
# --------------------------------------------------------------------------- #


def test_manifest_matches_the_readme_tree(readme_text: str) -> None:
    manifest_path = PLUGIN_ROOT / "dashboard" / "manifest.json"
    assert manifest_path.is_file(), "dashboard/manifest.json is missing"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    assert manifest["name"] == "wallpaper-engine"
    assert (manifest_path.parent / manifest["api"]).is_file(), "manifest.api points at a missing file"
    assert manifest.get("tab", {}).get("hidden") is True
    assert "tab.hidden: true" in readme_text, "README must warn that there is no sidebar tab"


def test_documented_defaults_match_the_code(readme_text: str) -> None:
    """The 'scrim 0.25 / 面板 55 / 卡片 45' baseline quoted in §5 must be the real one."""
    cfg = (PLUGIN_ROOT / "dashboard" / "config.py").read_text(encoding="utf-8")
    defaults = re.search(r"SETTINGS_DEFAULTS[^=]*=\s*\{(.*?)\n\}", cfg, re.S)
    assert defaults, "SETTINGS_DEFAULTS not found"
    block = defaults.group(1)
    for key, value in (("scrim", "0.25"), ("panelBase", "55"), ("cardBase", "45")):
        assert re.search(rf'"{key}":\s*{re.escape(value)}', block), f"{key} default is not {value}"
    flags = re.search(r"_NUMERIC_RANGES[^=]*=\s*\{(.*?)\n\}", cfg, re.S)
    assert flags and re.search(r'"scrim":\s*\(0\.0, 0\.9\)', flags.group(1))
    assert "0.0–0.9" in readme_text and "0–90" in readme_text, "README's scrim-unit note is gone"

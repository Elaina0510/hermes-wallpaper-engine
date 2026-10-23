"""T1.1 — MOD-001 §A discovery / enumeration / ``WallpaperItem`` acceptance.

Anchors (design §12.1):
  T1  discovery: a forged Steam tree (``libraryfolders.vdf`` + ``wallpaper_engine/
      wallpaper32.exe`` + workshop ``431960/<id>/project.json``) yields the one
      video item, with the right ``kind`` / ``path`` / ``preview``.
  T2  scene entry: ``project.json`` declares ``scene.json``, only ``scene.pkg``
      exists -> ``entry == "scene.pkg"``.
  T3  corrupt ``project.json`` -> HTTP 200 with that path in ``errors`` (never 500).
  T4  engine not installed -> ``engineFound: false``, ``items == []``.

Beyond the anchors this file also covers the §5.1 kind order, the four-level
scene resolution (all four levels), ``file`` missing -> item dropped, the
data/uploads exclusion, id (sha256 + collision salting), the 30 s cache and the
5 s scan timeout.

Fixture trees (``tests/fixtures/``)::

    fake-steam/steamapps/libraryfolders.vdf   -> lists "..\\fake-lib" only
    fake-lib/steamapps/common/wallpaper_engine/wallpaper32.exe
    fake-lib/steamapps/workshop/content/431960/3571376089/   (T1: one video)
    fake-steam-mixed/steamapps/...431960/2001..2012/         (kind + T2 + T3)
    fake-extra-root/3001/                                    (extraLibraryRoots)
    fake-data/uploads/9001/                                  (must never be scanned)

``fake-steam`` deliberately does **not** contain the engine: the only route to
``fake-lib`` is the vdf, so T1 proves the vdf parse instead of accidentally
passing through the "Steam root is itself a library" shortcut.

Every real discovery source (registry, env, fixed dirs, WSL) is switched off or
pointed at a fixture in every scanner, so nothing here depends on the host
machine (this box has no Wallpaper Engine installed).

Run with (no bytecode, no cache dirs left behind)::

    PYTHONDONTWRITEBYTECODE=1 python \\
        -m pytest tests/test_scan.py -v -p no:cacheprovider
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import pytest

TESTS_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = TESTS_DIR.parent
FIXTURES = TESTS_DIR / "fixtures"

FAKE_STEAM = FIXTURES / "fake-steam"  # vdf -> fake-lib
FAKE_LIB = FIXTURES / "fake-lib"
MIXED_LIB = FIXTURES / "fake-steam-mixed"
EXTRA_ROOT = FIXTURES / "fake-extra-root"
FAKE_DATA = FIXTURES / "fake-data"

sys.path.insert(0, str(PLUGIN_ROOT))

from dashboard import media_server as ms  # noqa: E402
from dashboard import scan  # noqa: E402

MEDIA_ORIGIN = "http://127.0.0.1:51234"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


class Clock:
    """Injected monotonic clock — the 30 s TTL is exercised without sleeping."""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def bare_probe(**overrides) -> scan.SteamProbe:
    """All four real sources switched off, then re-enabled per test."""
    kwargs = dict(registry_reader=None, env={}, probe_dirs=(), wsl_probe=None)
    kwargs.update(overrides)
    return scan.SteamProbe(**kwargs)


def env_probe(root: Path, **overrides) -> scan.SteamProbe:
    """Probe whose only source is ``DSH_WE_STEAM_ROOT`` -> ``root``."""
    return bare_probe(env={scan.STEAM_ROOT_ENV: str(root)}, **overrides)


def make_scanner(root: Path | None = None, **kwargs) -> scan.Scanner:
    probe = kwargs.pop("probe", None)
    clock = kwargs.pop("clock", None) or Clock()
    if probe is None:
        probe = env_probe(root) if root is not None else bare_probe()
    kwargs.setdefault("cache_ttl", scan.CACHE_TTL_S)
    kwargs.setdefault("scan_timeout", scan.SCAN_TIMEOUT_S)
    kwargs.setdefault("data_dir", FAKE_DATA)
    return scan.Scanner(
        probe=probe,
        clock=clock,
        media_origin_provider=lambda: MEDIA_ORIGIN,
        **kwargs,
    )


def by_id(payload: dict) -> dict[str, dict]:
    return {item["weId"]: item for item in payload["items"]}


def error_paths(payload: dict) -> list[str]:
    return [entry["path"] for entry in payload["errors"]]


def abspath(*parts: str | Path) -> str:
    return os.path.normpath(os.path.abspath(os.path.join(*[os.fspath(p) for p in parts])))


@pytest.fixture(autouse=True)
def _clean_token_table():
    yield
    ms.clear_tokens()


@pytest.fixture
def mixed() -> dict:
    """One scan of the mixed library, shared by the kind/entry tests."""
    return make_scanner(MIXED_LIB).scan()


def make_client(scanner: scan.Scanner, extra_roots=None):
    """Minimal router stand-in for ``GET /library`` (T1.3 owns the real one)."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()

    @app.get("/api/plugins/wallpaper-engine/library")
    def library(refresh: int = 0):  # noqa: ANN202
        return scanner.scan(force=bool(refresh), extra_library_roots=extra_roots)

    return TestClient(app)


# ---------------------------------------------------------------------------
# T4 — engine not installed (kept first: it is the cheapest sanity check)
# ---------------------------------------------------------------------------


def test_t4_not_installed_returns_empty_library():
    scanner = make_scanner()  # every source off -> nothing found
    payload = scanner.scan()

    assert payload["engineFound"] is False
    assert payload["items"] == []
    assert payload["errors"] == []
    assert payload["mediaOrigin"] == MEDIA_ORIGIN
    assert set(payload) == {"engineFound", "mediaOrigin", "scannedAt", "items", "errors"}
    assert scanner.install_dir is None


def test_t4_http_not_installed_is_200_not_500():
    client = make_client(make_scanner())
    response = client.get("/api/plugins/wallpaper-engine/library")

    assert response.status_code == 200
    body = response.json()
    assert body["engineFound"] is False
    assert body["items"] == []


def test_t4_probe_pointing_at_a_missing_dir_finds_nothing():
    scanner = make_scanner(FIXTURES / "does-not-exist")
    payload = scanner.scan()
    assert payload["engineFound"] is False and payload["items"] == []


# ---------------------------------------------------------------------------
# T1 — discovery through libraryfolders.vdf
# ---------------------------------------------------------------------------


def test_t1_discovers_video_workshop_item():
    scanner = make_scanner(FAKE_STEAM)
    payload = scanner.scan()

    assert payload["engineFound"] is True
    assert scanner.install_dir == abspath(FAKE_LIB, "steamapps", "common", "wallpaper_engine")
    assert scanner.library_dirs == [abspath(FAKE_LIB)]
    assert len(payload["items"]) == 1, payload["items"]

    item = payload["items"][0]
    project_dir = FAKE_LIB / "steamapps/workshop/content/431960/3571376089"
    assert item["kind"] == "video"
    assert item["title"] == "Cyber City"
    assert item["source"] == "workshop"
    assert item["weId"] == "3571376089"
    assert item["path"] == abspath(project_dir, "wallpaper.mp4")
    assert Path(item["path"]).is_file()
    assert item["dir"] == abspath(project_dir)
    assert item["preview"] == abspath(project_dir, "preview.jpg")
    assert item["entry"] is None  # §5.1: video/image entry is always null
    assert item["rating"] == "everyone"
    assert item["sizeBytes"] == Path(item["path"]).stat().st_size
    assert item["mtimeMs"] == int(Path(item["path"]).stat().st_mtime * 1000)
    assert item["props"] == {"schemecolor": "0.094 0.129 0.203"}
    assert item["schemeColor"] == "rgb(24, 33, 52)"


def test_t1_play_url_is_relative_media_token():
    payload = make_scanner(FAKE_STEAM).scan()
    item = payload["items"][0]

    token = ms.token_for(item["path"])
    assert item["play"] == {"type": "video", "url": f"/m/{token}"}
    # relative to mediaOrigin: no scheme, no host
    assert item["play"]["url"].startswith("/m/")
    assert "://" not in item["play"]["url"]
    # and the token table really points at the file (what /m serves)
    assert ms.lookup_token(token) == {"kind": "file", "path": item["path"], "entry": None}


def test_t1_http_library_returns_the_item():
    client = make_client(make_scanner(FAKE_STEAM))
    response = client.get("/api/plugins/wallpaper-engine/library")

    assert response.status_code == 200
    body = response.json()
    assert body["engineFound"] is True
    assert len(body["items"]) == 1
    assert body["items"][0]["kind"] == "video"
    assert body["items"][0]["title"] == "Cyber City"
    assert body["errors"] == []


def test_t1_corrupt_project_json_is_200_with_errors():
    """T3 over the HTTP layer — a broken project must not fail the response."""
    client = make_client(make_scanner(MIXED_LIB))
    response = client.get("/api/plugins/wallpaper-engine/library")

    assert response.status_code == 200
    body = response.json()
    broken = abspath(MIXED_LIB, "steamapps/workshop/content/431960/2003/project.json")
    assert broken in [e["path"] for e in body["errors"]]
    assert all(isinstance(e["message"], str) and e["message"] for e in body["errors"])
    # the healthy items are still there
    assert len(body["items"]) == 10


# ---------------------------------------------------------------------------
# discovery sources: registry / env / fixed / WSL — merge + de-duplicate
# ---------------------------------------------------------------------------


def test_probe_sources_merge_and_dedupe():
    probe = scan.SteamProbe(
        registry_reader=lambda: str(FAKE_STEAM),
        env={scan.STEAM_ROOT_ENV: f"{FAKE_STEAM};{FAKE_LIB}"},
        probe_dirs=(str(FAKE_STEAM), "D:\\Steam"),
        wsl_probe=lambda: [str(FAKE_LIB)],
    )
    roots = probe.roots()

    assert roots[0] == str(FAKE_STEAM)  # registry first
    keys = [os.path.normcase(os.path.abspath(r)) for r in roots]
    assert len(keys) == len(set(keys)), f"duplicates not merged: {roots}"
    # fake-steam (registry) and fake-lib (env/wsl), plus the one fixed dir that
    # is not already there -> 3 distinct roots, "D:\\Steam" survives.
    assert len(roots) == 3
    assert any(r.lower().startswith("d:") for r in roots)


def test_env_roots_accept_separators_and_quotes():
    raw = f'"{FAKE_STEAM}", {FAKE_LIB} ;  '
    probe = bare_probe(env={scan.STEAM_ROOT_ENV: raw})
    assert probe.roots() == [str(FAKE_STEAM), str(FAKE_LIB)]


def test_each_source_can_be_switched_off_independently():
    assert bare_probe().roots() == []
    assert bare_probe(probe_dirs=(str(FAKE_STEAM),)).roots() == [str(FAKE_STEAM)]
    assert bare_probe(registry_reader=lambda: str(FAKE_LIB)).roots() == [str(FAKE_LIB)]
    assert bare_probe(wsl_probe=lambda: [str(FAKE_LIB)]).roots() == [str(FAKE_LIB)]


def test_failing_registry_reader_does_not_break_discovery():
    def boom():
        raise RuntimeError("no registry in CI")

    probe = scan.SteamProbe(
        registry_reader=boom,
        env={scan.STEAM_ROOT_ENV: str(FAKE_STEAM)},
        probe_dirs=(),
        wsl_probe=None,
    )
    assert probe.roots() == [str(FAKE_STEAM)]
    assert make_scanner(probe=probe).scan()["engineFound"] is True


def test_libraries_from_vdf_requires_the_we_appid():
    vdf = FAKE_STEAM / "steamapps/libraryfolders.vdf"
    assert scan.libraries_from_vdf(vdf, steam_root=str(FAKE_STEAM)) == [abspath(FAKE_LIB)]
    assert scan.libraries_from_vdf(FIXTURES / "nope.vdf") == []


def test_registry_reader_degrades_instead_of_raising():
    """The production reader must degrade to None instead of raising."""
    value = scan.read_registry_steam_path(timeout=1.0)
    assert value is None or isinstance(value, str)


# ---------------------------------------------------------------------------
# T2 — scene entry resolution (all four levels)
# ---------------------------------------------------------------------------


def test_t2_declared_scene_json_but_only_scene_pkg(mixed):
    item = by_id(mixed)["2002"]

    assert item["kind"] == "scene"
    assert item["entry"] == "scene.pkg"
    assert item["path"] is None  # directory-shaped: entry carries the file
    assert item["play"]["type"] == "scene"
    token = ms.token_for(item["dir"])
    assert item["play"]["url"] == f"/s/{token}/scene.pkg"
    assert ms.lookup_token(token) == {"kind": "dir", "path": item["dir"], "entry": "scene.pkg"}
    # no error: resolution succeeded on the second level
    assert not [e for e in mixed["errors"] if "2002" in e["path"]]


def test_scene_resolution_level_2_prefers_scene_pkg_over_other_pkgs(mixed):
    assert by_id(mixed)["2010"]["entry"] == "scene.pkg"


def test_scene_resolution_level_4_single_pkg(mixed):
    assert by_id(mixed)["2011"]["entry"] == "foo.pkg"


def test_scene_resolution_failure_degrades_to_scene_with_null_play(mixed):
    item = by_id(mixed)["2009"]

    assert item["kind"] == "scene"  # never downgraded to video/unknown (§5.1)
    assert item["entry"] is None
    assert item["play"] is None
    assert any("场景入口解析失败" in e["message"] for e in mixed["errors"]
               if e["path"].endswith("2009" + os.sep + "project.json"))


def test_resolve_scene_entry_ignores_non_container_declared_file():
    """A declared ``index.html`` / ``.mp4`` never counts as a scene container."""
    web_dir = MIXED_LIB / "steamapps/workshop/content/431960/2005"
    assert scan.resolve_scene_entry(web_dir, "index.html") is None

    packed = MIXED_LIB / "steamapps/workshop/content/431960/2002"
    assert scan.resolve_scene_entry(packed, "index.html") == "scene.pkg"
    assert scan.resolve_scene_entry(packed, "scene.json") == "scene.pkg"


def test_resolve_scene_entry_reads_a_declared_scene_json_when_it_exists():
    """Level 1: the declared file wins when it is really on disk."""
    declared_dir = FIXTURES / "fake-scene-json/4001"
    assert scan.resolve_scene_entry(declared_dir, "scene.json") == "scene.json"
    assert scan.resolve_scene_entry(declared_dir, "nested/scene.json") == "nested/scene.json"


# ---------------------------------------------------------------------------
# §5.1 kind order
# ---------------------------------------------------------------------------


def test_kind_application_is_listed_but_unplayable(mixed):
    item = by_id(mixed)["2004"]

    assert item["kind"] == "application"
    assert item["play"] is None
    assert item["entry"] is None
    assert item["path"] == abspath(MIXED_LIB, "steamapps/workshop/content/431960/2004/app.exe")


def test_kind_web_uses_relative_html_entry(mixed):
    item = by_id(mixed)["2005"]

    assert item["kind"] == "web"
    assert item["entry"] == "index.html"
    token = ms.token_for(item["dir"])
    assert item["play"] == {"type": "web", "url": f"/s/{token}/index.html"}
    assert item["rating"] == "pg13"
    assert item["schemeColor"] == "rgb(216, 185, 182)"


def test_kind_image_comes_from_the_extension(mixed):
    item = by_id(mixed)["2006"]

    assert item["kind"] == "image"
    assert item["entry"] is None
    assert item["play"]["type"] == "image"
    assert item["play"]["url"] == f"/m/{ms.token_for(item['path'])}"


def test_kind_video_from_declared_type(mixed):
    item = by_id(mixed)["2001"]
    assert item["kind"] == "video"
    assert item["rating"] == "mature"
    assert item["props"] == {"schemecolor": "1 0 0", "schemecolor2": "plain"}
    assert item["schemeColor"] == "rgb(255, 0, 0)"


def test_kind_video_with_missing_media_is_unplayable(mixed):
    item = by_id(mixed)["2008"]

    assert item["kind"] == "video"
    assert item["play"] is None
    assert item["path"].endswith("gone.mp4")
    assert any("入口文件缺失" in e["message"] for e in mixed["errors"]
               if e["path"].endswith("2008" + os.sep + "project.json"))


def test_kind_web_with_missing_entry_is_unplayable(mixed):
    item = by_id(mixed)["2012"]

    assert item["kind"] == "web"  # still a web wallpaper, just unplayable
    assert item["entry"] == "index.html"
    assert item["play"] is None
    assert any("web 入口文件缺失" in e["message"] for e in mixed["errors"]
               if e["path"].endswith("2012" + os.sep + "project.json"))


def test_classify_table_order():
    # application wins over everything, scene beats extension-derived video
    assert scan.classify("application", "clip.mp4", True)[0] == "application"
    assert scan.classify("scene", "clip.mp4", True)[0] == "scene"
    assert scan.classify("web", "index.html", True) == ("web", "index.html", None)
    assert scan.classify("web", "index.js", True)[0] == "unknown"
    assert scan.classify("video", "x.mkv", True)[0] == "video"
    assert scan.classify("", "x.WEBM", True)[0] == "video"
    assert scan.classify("", "x.jpeg", True)[0] == "image"
    assert scan.classify("", "x.htm", True)[0] == "web"
    assert scan.classify("", "x.pkg", True)[0] == "unknown"  # needs the resolver


def test_project_without_file_field_is_dropped(mixed):
    ids = by_id(mixed)
    assert "2007" not in ids
    dropped = [e for e in mixed["errors"] if e["path"].endswith("2007" + os.sep + "project.json")]
    assert dropped and "file" in dropped[0]["message"]


def test_directory_without_project_json_is_silently_ignored(mixed):
    assert "not-a-project" not in by_id(mixed)
    assert not [e for e in mixed["errors"] if "not-a-project" in e["path"]]


# ---------------------------------------------------------------------------
# T3 — corrupt project.json
# ---------------------------------------------------------------------------


def test_t3_corrupt_project_json_reports_path_without_losing_the_scan(mixed):
    broken = abspath(MIXED_LIB, "steamapps/workshop/content/431960/2003/project.json")

    assert broken in error_paths(mixed)
    message = next(e["message"] for e in mixed["errors"] if e["path"] == broken)
    assert "解析失败" in message
    # every other project still made it: the failure is per-item, not per-scan
    assert len(mixed["items"]) == 10
    assert mixed["engineFound"] is True


def test_hostile_project_json_shapes_are_rejected_per_item(mixed):
    """A non-object project.json and a path-escaping ``file`` are per-item
    errors: the scan still returns every healthy wallpaper."""
    ids = by_id(mixed)

    assert "2013" not in ids
    wrong_shape = next(
        e for e in mixed["errors"] if e["path"].endswith("2013" + os.sep + "project.json")
    )
    assert "顶层不是 JSON 对象" in wrong_shape["message"]

    assert "2014" not in ids
    escaping = next(
        e for e in mixed["errors"] if e["path"].endswith("2014" + os.sep + "project.json")
    )
    assert "项目目录之外" in escaping["message"]
    # every surviving item still points inside its own project directory
    for item in mixed["items"]:
        assert os.path.isdir(item["dir"])


# ---------------------------------------------------------------------------
# item identity: full sha256 + collision salting
# ---------------------------------------------------------------------------


def test_item_id_is_full_sha256_of_the_project_dir(mixed):
    for item in mixed["items"]:
        expected = hashlib.sha256(item["dir"].encode("utf-8")).hexdigest()
        assert item["id"] == expected
        assert len(item["id"]) == 64 and all(c in "0123456789abcdef" for c in item["id"])


def test_item_id_is_stable_across_scans(mixed):
    again = make_scanner(MIXED_LIB).scan()
    assert [i["id"] for i in again["items"]] == [i["id"] for i in mixed["items"]]


def test_id_collision_is_salted_and_unique(monkeypatch):
    real = scan._sha256_hex
    colliding = {
        abspath(MIXED_LIB, "steamapps/workshop/content/431960/2001"),
        abspath(MIXED_LIB, "steamapps/workshop/content/431960/2002"),
    }

    def fake_sha(text: str) -> str:
        # only the *unsalted* inputs collide; the salted retry hashes normally
        if "\x00" not in text and text in colliding:
            return "ab" * 32  # deliberate sha256 "collision"
        return real(text)

    monkeypatch.setattr(scan, "_sha256_hex", fake_sha)

    payload = make_scanner(MIXED_LIB).scan()
    items = by_id(payload)
    assert items["2001"]["id"] == "ab" * 32
    assert items["2002"]["id"] != items["2001"]["id"]
    assert len(items["2002"]["id"]) == 64
    assert items["2002"]["id"] == real(
        abspath(MIXED_LIB, "steamapps/workshop/content/431960/2002") + "\x00" + "1"
    )
    ids = [i["id"] for i in payload["items"]]
    assert len(ids) == len(set(ids)) == 10


# ---------------------------------------------------------------------------
# extraLibraryRoots + data/uploads exclusion
# ---------------------------------------------------------------------------


def test_extra_root_of_plain_project_dirs_is_scanned():
    payload = make_scanner(probe=bare_probe()).scan(extra_library_roots=[str(EXTRA_ROOT)])

    assert payload["engineFound"] is False  # no Steam, yet the folder is listed
    assert len(payload["items"]) == 1
    item = payload["items"][0]
    assert item["title"] == "Looped Local"
    assert item["source"] == "local"
    assert item["kind"] == "video"


def test_extra_root_of_steam_library_shape_is_scanned():
    payload = make_scanner(probe=bare_probe()).scan(extra_library_roots=[str(MIXED_LIB)])

    assert len(payload["items"]) == 10
    assert {i["source"] for i in payload["items"]} == {"local"}


def test_data_uploads_never_enters_any_scan_root():
    scanner = make_scanner(probe=bare_probe())
    payload = scanner.scan(
        extra_library_roots=[str(FAKE_DATA / "uploads"), str(FAKE_DATA / "uploads/9001"), str(FAKE_DATA)]
    )

    assert payload["items"] == []
    assert payload["errors"] == []
    assert scanner.project_roots(None, [], [str(FAKE_DATA / "uploads")]) == []


def test_data_uploads_is_excluded_even_when_nested_in_a_scanned_root():
    """A project inside data/uploads must not appear via a parent scan root."""
    scanner = make_scanner(probe=bare_probe(), data_dir=FAKE_DATA / "uploads")
    payload = scanner.scan(extra_library_roots=[str(FAKE_DATA)])
    assert payload["items"] == []


# ---------------------------------------------------------------------------
# caching (30 s TTL) and the 5 s scan budget
# ---------------------------------------------------------------------------


def test_cache_serves_the_previous_result_within_30s(monkeypatch):
    calls: list[str] = []
    real = scan._read_project

    def counting(project_dir):
        calls.append(str(project_dir))
        return real(project_dir)

    monkeypatch.setattr(scan, "_read_project", counting)
    clock = Clock()
    scanner = make_scanner(MIXED_LIB, clock=clock)

    first = scanner.scan()
    assert len(calls) == 15  # 14 project dirs + the not-a-project noise dir

    second = scanner.scan()  # within TTL -> no disk work
    assert len(calls) == 15
    assert second == first
    assert second["scannedAt"] == first["scannedAt"]

    clock.advance(29.9)
    assert scanner.scan() == first
    assert len(calls) == 15

    clock.advance(0.2)  # 30.1 s since the scan -> expired
    third = scanner.scan()
    assert len(calls) == 30
    assert third["items"] == first["items"]


def test_cache_expiry_can_be_forced_with_the_now_argument(monkeypatch):
    """``scan(now=...)`` makes the TTL testable without touching the clock."""
    calls: list[str] = []
    real = scan._read_project
    monkeypatch.setattr(scan, "_read_project", lambda d: (calls.append(str(d)), real(d))[1])
    clock = Clock()
    scanner = make_scanner(FAKE_STEAM, clock=clock)

    first = scanner.scan()
    assert len(calls) == 1

    assert scanner.scan(now=clock.t + 29.0)["items"] == first["items"]
    assert len(calls) == 1  # still cached

    assert scanner.scan(now=clock.t + 31.0)["items"] == first["items"]
    assert len(calls) == 2  # expired -> rescanned


def test_invalidate_drops_the_cache(monkeypatch):
    calls: list[str] = []
    real = scan._read_project
    monkeypatch.setattr(scan, "_read_project", lambda d: (calls.append(str(d)), real(d))[1])
    scanner = make_scanner(FAKE_STEAM)

    scanner.scan()
    scanner.scan()
    assert len(calls) == 1
    scanner.invalidate()
    scanner.scan()
    assert len(calls) == 2


def test_force_refresh_bypasses_the_cache(monkeypatch):
    calls: list[str] = []
    real = scan._read_project
    monkeypatch.setattr(
        scan, "_read_project", lambda d: (calls.append(str(d)), real(d))[1]
    )
    scanner = make_scanner(MIXED_LIB)

    scanner.scan()
    scanner.scan(force=True)
    assert len(calls) == 30


def test_cache_is_keyed_on_extra_library_roots():
    scanner = make_scanner(probe=bare_probe())

    assert scanner.scan()["items"] == []
    assert len(scanner.scan(extra_library_roots=[str(EXTRA_ROOT)])["items"]) == 1
    # and back again: no stale cross-contamination
    assert scanner.scan()["items"] == []


def test_callers_cannot_poison_the_cache():
    scanner = make_scanner(FAKE_STEAM)
    first = scanner.scan()
    first["items"].clear()
    first["errors"].append({"path": "x", "message": "y"})

    second = scanner.scan()
    assert len(second["items"]) == 1
    assert second["errors"] == []


def test_scan_timeout_returns_previous_result_plus_error(monkeypatch):
    real = scan._read_project
    scanner = make_scanner(MIXED_LIB, scan_timeout=0.05)
    baseline = scanner.scan()
    assert len(baseline["items"]) == 10

    def slow(project_dir):
        time.sleep(0.25)  # 12 projects -> far beyond the 50 ms budget
        return real(project_dir)

    monkeypatch.setattr(scan, "_read_project", slow)
    started = time.monotonic()
    payload = scanner.scan(force=True)
    elapsed = time.monotonic() - started

    assert elapsed < 1.0, f"timeout not enforced: {elapsed:.2f}s"
    assert payload["items"] == baseline["items"]  # last good result
    assert payload["engineFound"] is True
    assert any("超时" in e["message"] for e in payload["errors"])


def test_scan_timeout_without_previous_result_is_an_empty_library_not_a_raise(monkeypatch):
    def slow(project_dir):
        time.sleep(0.25)
        return {}

    monkeypatch.setattr(scan, "_read_project", slow)
    scanner = make_scanner(MIXED_LIB, scan_timeout=0.05)
    payload = scanner.scan()

    assert payload["items"] == []
    assert payload["engineFound"] is False
    assert any("超时" in e["message"] for e in payload["errors"])


# ---------------------------------------------------------------------------
# response shape / ordering
# ---------------------------------------------------------------------------


def test_library_response_shape_and_ordering(mixed):
    assert set(mixed) == {"engineFound", "mediaOrigin", "scannedAt", "items", "errors"}
    assert mixed["mediaOrigin"] == MEDIA_ORIGIN
    stamp = datetime.fromisoformat(mixed["scannedAt"])
    assert stamp.tzinfo is not None  # §6.2: ISO-8601 with offset
    assert mixed["scannedAt"] != "" and "T" in mixed["scannedAt"]
    titles = [i["title"] for i in mixed["items"]]
    assert titles == sorted(titles, key=str.lower)
    keys = {
        "id", "weId", "kind", "title", "source", "path", "dir", "entry", "preview",
        "rating", "sizeBytes", "mtimeMs", "props", "schemeColor", "play",
    }
    assert set(mixed["items"][0]) == keys


def test_library_is_json_serialisable(mixed):
    assert json.loads(json.dumps(mixed)) == mixed


def _write_preset_project(root: Path, name: str, project: dict) -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "project.json").write_text(json.dumps(project), encoding="utf-8")
    (folder / "files").mkdir()
    (folder / "files" / "art.jpg").write_bytes(b"not-a-real-image")
    (folder / "preview.jpg").write_bytes(b"not-a-real-image")
    return folder


def test_dependency_preset_is_skipped_silently(tmp_path):
    """A WE "preset" submission (dependency + preset, no `file`) is not broken.

    Wallpaper Engine itself lists the *base* wallpaper for these; the preset only
    re-skins it. Reporting them as scan errors made the picker shout
    "扫描出错" on a perfectly healthy library (2026-10-22 report).
    """
    _write_preset_project(
        tmp_path,
        "1736966924",
        {"title": "Preset", "dependency": "921617616", "preset": {"MENU_mode": 1}},
    )

    payload = make_scanner(probe=bare_probe()).scan(extra_library_roots=[str(tmp_path)])
    assert payload["items"] == []
    assert payload["errors"] == [], "a preset must not land in errors[]"


def test_missing_file_without_dependency_stays_an_error(tmp_path):
    """The preset exception must not swallow genuinely broken projects."""
    _write_preset_project(tmp_path, "9999", {"title": "Broken", "preset": {}})

    payload = make_scanner(probe=bare_probe()).scan(extra_library_roots=[str(tmp_path)])
    assert payload["items"] == []
    assert len(payload["errors"]) == 1
    assert "缺少 file" in payload["errors"][0]["message"]

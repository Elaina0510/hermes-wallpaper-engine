"""T1.3 — MOD-004 §D FastAPI router acceptance (design §6.1/§6.2/§6.3, §3.2).

Every case drives the **real** ``dashboard/plugin_api.py`` router through a real
``fastapi.testclient.TestClient``, mounted exactly the way the gateway does it
(``app.include_router(router, prefix="/api/plugins/wallpaper-engine")``, see
``web_server_dashboard.py:878-882``). Nothing here stands in for the router —
the local apps that ``test_scan.py`` / ``test_config.py`` build for their own
module-level anchors are not used.

Collaborators are injected per test (``plugin_api.set_deps``), so:

* no test touches the host's Steam libraries — the fixture trees under
  ``tests/fixtures/`` are the only "Steam" the scanner ever sees;
* no test touches the plugin's real ``data/config.json`` — the store lives in
  ``tmp_path``; and
* the media origin is a fixed string, so no assertion depends on which port a
  listener happened to get.

Anchors promoted to HTTP (design §12.1):

  T1   ``-k t1_``    forged vdf tree → one video item, ``installDir``/``libraryDirs``
  T2   ``-k t2_``    declared ``scene.json`` but only ``scene.pkg`` on disk
  T3   ``-k t3_``    corrupt ``project.json`` → 200 + ``errors``, never 500
  T4   ``-k t4_``    engine not installed → ``engineFound: false``, ``items: []``
  T8   ``-k t8_``    Merge Patch round trip, 400 envelope, reconcile after rescan
  T8b  ``-k t8b_``   ``clamped`` receipt ``[requested, effective]``
  T8c  ``-k t8c_``   version 1 upgrade, version 99 → ``config.future-*``

Beyond those: the seven-key ``/status`` schema and its no-"starting" property,
``refresh=1`` vs the 30 s cache, the 5 s scan-timeout path at HTTP level, the
import-time eager media-server start, and the "a route never 500s" guarantees.

Run with (no bytecode, no cache directories left in the plugin tree)::

    PYTHONDONTWRITEBYTECODE=1 python \\
        -m pytest tests/test_plugin_api.py -v -p no:cacheprovider
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

TESTS_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = TESTS_DIR.parent
FIXTURES = TESTS_DIR / "fixtures"

sys.path.insert(0, str(PLUGIN_ROOT))

from dashboard import config as cfg  # noqa: E402
from dashboard import media_server as ms  # noqa: E402
from dashboard import plugin_api  # noqa: E402
from dashboard import scan  # noqa: E402

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

PREFIX = "/api/plugins/wallpaper-engine"
MEDIA_ORIGIN = "http://127.0.0.1:51234"

FAKE_STEAM = FIXTURES / "fake-steam"  # vdf -> fake-lib (one video wallpaper)
FAKE_LIB = FIXTURES / "fake-lib"
MIXED_LIB = FIXTURES / "fake-steam-mixed"  # kinds + T2 + T3, 10 items
EXTRA_ROOT = FIXTURES / "fake-extra-root"  # one loose project (3001)
FAKE_DATA = FIXTURES / "fake-data"  # uploads/ must never be scanned

STATUS_KEYS = {
    "ok",
    "version",
    "engineFound",
    "installDir",
    "libraryDirs",
    "mediaOrigin",
    "mediaError",
}
LIBRARY_KEYS = {"engineFound", "mediaOrigin", "scannedAt", "items", "errors"}


# ---------------------------------------------------------------------------
# harness
# ---------------------------------------------------------------------------


class Clock:
    """Injected monotonic clock, so the 30 s TTL is exercised without sleeping."""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def bare_probe(**overrides) -> scan.SteamProbe:
    """All four real discovery sources switched off."""
    kwargs = dict(registry_reader=None, env={}, probe_dirs=(), wsl_probe=None)
    kwargs.update(overrides)
    return scan.SteamProbe(**kwargs)


def env_probe(root: Path, **overrides) -> scan.SteamProbe:
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


def fixed_origin(value: str | None = MEDIA_ORIGIN):
    return lambda: value


def make_app() -> FastAPI:
    """The gateway's mount, reduced to what T1.3 owns (no auth dependency)."""
    app = FastAPI()
    app.include_router(plugin_api.router, prefix=PREFIX)
    return app


@pytest.fixture(autouse=True)
def _isolated_deps():
    plugin_api.reset_deps()
    yield
    plugin_api.reset_deps()
    ms.clear_tokens()


@pytest.fixture
def build(tmp_path):
    """Factory: wire the router to a fixture scanner + a tmp config store."""

    def _build(
        root: Path | None = FAKE_STEAM,
        *,
        probe=None,
        scanner=None,
        store=None,
        origin_provider=fixed_origin(),
        error_provider=None,
        scanner_kwargs=None,
    ):
        store = store if store is not None else cfg.ConfigStore(data_dir=tmp_path / "data")
        scanner = (
            scanner
            if scanner is not None
            else make_scanner(root, probe=probe, **(scanner_kwargs or {}))
        )
        plugin_api.set_deps(
            scanner=scanner,
            store=store,
            media_origin_provider=origin_provider,
            media_error_provider=error_provider,
        )
        return SimpleNamespace(client=TestClient(make_app()), scanner=scanner, store=store)

    return _build


def url(path: str) -> str:
    return PREFIX + path


def by_we_id(payload: dict) -> dict[str, dict]:
    return {item["weId"]: item for item in payload["items"]}


def read_config_file(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "data" / "config.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# router shape + import side effects (§3.2 / F5)
# ---------------------------------------------------------------------------


def test_router_exposes_exactly_the_four_documented_routes():
    """Paths are suffix-relative: the gateway supplies the ``/api/plugins/...``."""
    routes = {(route.path, method) for route in plugin_api.router.routes for method in route.methods}

    assert routes == {
        ("/status", "GET"),
        ("/library", "GET"),
        ("/config", "GET"),
        ("/config", "PUT"),
    }


def test_router_is_mounted_under_the_gateway_prefix():
    app = make_app()
    paths = {getattr(route, "path", "") for route in app.routes}

    assert url("/status") in paths
    assert url("/library") in paths
    assert url("/config") in paths


def test_import_starts_the_media_server_eagerly():
    """§3.2: eager at import, and a second import is idempotent (same port).

    ``plugin_api`` was imported at collection time; re-executing its body is the
    cheapest honest reproduction of "the gateway imports this file".
    """
    ms.shutdown()
    assert ms.server() is None

    reloaded = importlib.reload(plugin_api)

    assert reloaded._started_at_import is True
    assert ms.server() is not None
    origin = ms.media_origin()
    assert origin is not None and origin.startswith("http://127.0.0.1:")

    importlib.reload(plugin_api)  # second import: same listener, not a second one
    assert ms.media_origin() == origin


def test_status_back_starts_a_stopped_media_server(build):
    """There is no "starting" state, so a stopped server must be back-started
    before the schema is filled in (§3.2 "补启" path)."""
    api = build(root=None, origin_provider=None)  # default media_server wiring
    ms.shutdown()
    assert ms.server() is None

    response = api.client.get(url("/status"))

    assert response.status_code == 200
    body = response.json()
    assert ms.server() is not None
    assert body["mediaOrigin"] == ms.media_origin()
    assert body["mediaError"] is None
    assert "starting" not in response.text.lower()


# ---------------------------------------------------------------------------
# T4 — engine not installed
# ---------------------------------------------------------------------------


def test_t4_status_without_engine_is_200_and_null_install_dir(build):
    api = build(root=None)  # bare probe: no registry, no env, no candidates

    response = api.client.get(url("/status"))

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["engineFound"] is False
    assert body["installDir"] is None
    assert body["libraryDirs"] == []
    assert body["mediaOrigin"] == MEDIA_ORIGIN
    assert body["mediaError"] is None


def test_t4_library_without_engine_is_200_and_empty(build):
    api = build(root=None)

    response = api.client.get(url("/library"))

    assert response.status_code == 200
    body = response.json()
    assert body["engineFound"] is False
    assert body["items"] == []
    assert body["errors"] == []


def test_t4_missing_media_origin_comes_with_a_string_error(build):
    """§6.1: ``mediaOrigin: null`` is only legal alongside a string mediaError."""
    api = build(
        root=None,
        origin_provider=fixed_origin(None),
        error_provider=lambda: "OSError: 端口耗尽",
    )

    body = api.client.get(url("/status")).json()

    assert body["mediaOrigin"] is None
    assert body["mediaError"] == "OSError: 端口耗尽"
    assert isinstance(body["mediaError"], str)


def test_t4_missing_media_origin_without_a_recorded_error_still_reports_one(build):
    api = build(root=None, origin_provider=fixed_origin(None), error_provider=lambda: None)

    body = api.client.get(url("/status")).json()

    assert body["mediaOrigin"] is None
    assert isinstance(body["mediaError"], str) and body["mediaError"]


# ---------------------------------------------------------------------------
# T1 — discovery over HTTP (vdf -> library -> wallpaper32.exe)
# ---------------------------------------------------------------------------


def test_t1_status_reports_install_dir_and_library_dirs(build):
    api = build(FAKE_STEAM)

    body = api.client.get(url("/status")).json()

    assert body["engineFound"] is True
    assert body["installDir"] == os.path.normpath(
        str(FAKE_LIB / "steamapps" / "common" / "wallpaper_engine")
    )
    assert body["libraryDirs"] == [os.path.normpath(str(FAKE_LIB))]
    # the same findings the scanner caches for the next call
    assert api.scanner.install_dir == body["installDir"]
    assert api.scanner.library_dirs == body["libraryDirs"]


def test_t1_library_returns_the_workshop_video_item(build):
    api = build(FAKE_STEAM)

    response = api.client.get(url("/library"))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == LIBRARY_KEYS
    assert body["engineFound"] is True
    assert body["mediaOrigin"] == MEDIA_ORIGIN
    assert len(body["items"]) == 1

    item = body["items"][0]
    project_dir = FAKE_LIB / "steamapps/workshop/content/431960/3571376089"
    assert item["kind"] == "video"
    assert item["title"] == "Cyber City"
    assert item["weId"] == "3571376089"
    assert item["path"] == os.path.normpath(str(project_dir / "wallpaper.mp4"))
    assert item["play"] == {"type": "video", "url": f"/m/{ms.token_for(item['path'])}"}


def test_t1_status_after_a_scan_agrees_with_the_library_payload(build):
    api = build(FAKE_STEAM)
    library = api.client.get(url("/library")).json()
    status = api.client.get(url("/status")).json()

    assert library["engineFound"] is status["engineFound"] is True
    assert status["installDir"] == api.scanner.install_dir


# ---------------------------------------------------------------------------
# T2 — scene entry resolution
# ---------------------------------------------------------------------------


def test_t2_library_resolves_scene_pkg_for_a_declared_scene_json(build):
    api = build(MIXED_LIB)

    body = api.client.get(url("/library")).json()
    item = by_we_id(body)["2002"]

    assert item["kind"] == "scene"
    assert item["entry"] == "scene.pkg"
    assert item["path"] is None
    assert item["play"]["type"] == "scene"
    assert item["play"]["url"] == f"/s/{ms.token_for(item['dir'])}/scene.pkg"


# ---------------------------------------------------------------------------
# T3 — corrupt project.json
# ---------------------------------------------------------------------------


def test_t3_corrupt_project_json_is_200_with_errors(build):
    api = build(MIXED_LIB)

    response = api.client.get(url("/library"))

    assert response.status_code == 200
    body = response.json()
    broken = os.path.normpath(
        str(MIXED_LIB / "steamapps/workshop/content/431960/2003/project.json")
    )
    assert broken in [entry["path"] for entry in body["errors"]]
    message = next(e["message"] for e in body["errors"] if e["path"] == broken)
    assert "解析失败" in message
    # the failure stayed per-item: every healthy wallpaper is still there
    assert len(body["items"]) == 10


# ---------------------------------------------------------------------------
# /status schema (§6.1)
# ---------------------------------------------------------------------------


def test_status_schema_has_all_seven_keys_with_the_right_types(build):
    api = build(FAKE_STEAM)

    body = api.client.get(url("/status")).json()

    assert set(body) == STATUS_KEYS
    assert body["ok"] is True
    assert isinstance(body["version"], str) and body["version"]
    assert isinstance(body["engineFound"], bool)
    assert isinstance(body["installDir"], str)
    assert isinstance(body["libraryDirs"], list)
    assert all(isinstance(entry, str) for entry in body["libraryDirs"])
    assert isinstance(body["mediaOrigin"], str)
    assert body["mediaError"] is None


def test_status_never_reports_a_starting_state(build):
    api = build(FAKE_STEAM)

    text = api.client.get(url("/status")).text

    assert '"starting"' not in text
    assert "starting" not in text


def test_status_stays_200_when_discovery_raises(build):
    class Exploding:
        def discovery(self):  # noqa: ANN001, ANN202
            raise RuntimeError("probe went sideways")

        def scan(self, **kwargs):  # noqa: ANN003, ANN202
            raise AssertionError("scan must not be called by /status")

    api = build(scanner=Exploding())

    response = api.client.get(url("/status"))

    assert response.status_code == 200
    body = response.json()
    assert set(body) == STATUS_KEYS
    assert body["engineFound"] is False
    assert body["installDir"] is None


# ---------------------------------------------------------------------------
# /library — cache, refresh, ordering, never-500
# ---------------------------------------------------------------------------


def test_library_hits_the_30s_cache_by_default(build, monkeypatch):
    calls: list[str] = []
    real = scan._read_project
    monkeypatch.setattr(scan, "_read_project", lambda d: (calls.append(str(d)), real(d))[1])
    api = build(FAKE_STEAM)

    first = api.client.get(url("/library")).json()
    assert len(calls) == 1

    second = api.client.get(url("/library")).json()
    assert len(calls) == 1  # served from the cache
    assert [i["id"] for i in second["items"]] == [i["id"] for i in first["items"]]


@pytest.mark.parametrize("flag", ["1", "true", "TRUE", "yes", "on"])
def test_library_refresh_flag_forces_a_rescan(build, monkeypatch, flag):
    calls: list[str] = []
    real = scan._read_project
    monkeypatch.setattr(scan, "_read_project", lambda d: (calls.append(str(d)), real(d))[1])
    api = build(FAKE_STEAM)

    api.client.get(url("/library"))
    assert len(calls) == 1

    response = api.client.get(url("/library"), params={"refresh": flag})

    assert response.status_code == 200
    assert len(calls) == 2


@pytest.mark.parametrize("flag", ["0", "false", "", "junk"])
def test_library_ignores_a_non_truthy_refresh_flag(build, monkeypatch, flag):
    calls: list[str] = []
    real = scan._read_project
    monkeypatch.setattr(scan, "_read_project", lambda d: (calls.append(str(d)), real(d))[1])
    api = build(FAKE_STEAM)

    api.client.get(url("/library"))
    assert api.client.get(url("/library"), params={"refresh": flag}).status_code == 200

    assert len(calls) == 1


def test_library_items_are_sorted_by_title(build):
    api = build(MIXED_LIB)

    items = api.client.get(url("/library")).json()["items"]

    titles = [item["title"] for item in items]
    assert titles == sorted(titles, key=str.lower)
    assert all(item["kind"] for item in items)


def test_library_scanned_at_is_iso8601_with_offset(build):
    api = build(FAKE_STEAM)

    stamp = api.client.get(url("/library")).json()["scannedAt"]

    parsed = datetime.fromisoformat(stamp)
    assert parsed.tzinfo is not None
    assert "T" in stamp


def test_library_scan_timeout_returns_the_previous_result_with_errors(build, monkeypatch):
    """§6.2: the 5 s budget is a budget on the *scan*, not on the response."""
    api = build(MIXED_LIB, scanner_kwargs={"scan_timeout": 0.05})
    baseline = api.client.get(url("/library")).json()
    assert len(baseline["items"]) == 10

    real = scan._read_project

    def slow(project_dir):  # noqa: ANN001, ANN202
        time.sleep(0.25)
        return real(project_dir)

    monkeypatch.setattr(scan, "_read_project", slow)

    started = time.monotonic()
    response = api.client.get(url("/library"), params={"refresh": "1"})
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    body = response.json()
    assert elapsed < 2.0, f"timeout not enforced at the HTTP layer: {elapsed:.2f}s"
    assert [i["id"] for i in body["items"]] == [i["id"] for i in baseline["items"]]
    assert body["engineFound"] is True
    assert any("超时" in entry["message"] for entry in body["errors"])


def test_library_scan_timeout_without_a_previous_result_is_200_and_empty(build, monkeypatch):
    def slow(project_dir):  # noqa: ANN001, ANN202
        time.sleep(0.25)
        return {}

    monkeypatch.setattr(scan, "_read_project", slow)
    api = build(MIXED_LIB, scanner_kwargs={"scan_timeout": 0.05})

    response = api.client.get(url("/library"))

    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert any("超时" in entry["message"] for entry in body["errors"])


def test_library_stays_200_when_the_scanner_raises(build):
    class Exploding:
        def scan(self, **kwargs):  # noqa: ANN003, ANN202
            raise RuntimeError("boom")

    api = build(scanner=Exploding())

    response = api.client.get(url("/library"))

    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert set(body) == LIBRARY_KEYS
    assert any("boom" in entry["message"] for entry in body["errors"])


def test_library_scans_the_extra_roots_stored_in_config(build):
    api = build(root=None)  # no Steam at all
    assert api.client.get(url("/library")).json()["items"] == []

    put = api.client.put(url("/config"), json={"settings": {"extraLibraryRoots": [str(EXTRA_ROOT)]}})
    assert put.status_code == 200

    body = api.client.get(url("/library")).json()
    assert len(body["items"]) == 1
    assert body["items"][0]["title"] == "Looped Local"
    assert body["items"][0]["source"] == "local"


# ---------------------------------------------------------------------------
# T8 — GET/PUT /config over HTTP
# ---------------------------------------------------------------------------


def test_t8_config_get_returns_the_full_config_doc(build):
    api = build()

    response = api.client.get(url("/config"))

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    doc = body["config"]
    assert doc["version"] == cfg.CONFIG_VERSION
    assert doc["currentId"] is None
    assert set(doc["settings"]) == set(cfg.SETTINGS_DEFAULTS)
    assert doc["settings"]["scrim"] == cfg.SETTINGS_DEFAULTS["scrim"]


def test_t8_config_put_roundtrip_is_visible_in_get_and_on_disk(build, tmp_path):
    api = build()

    put = api.client.put(
        url("/config"),
        json={"currentId": "abc123", "settings": {"scrim": 0.5, "enabled": False}},
    )

    assert put.status_code == 200
    body = put.json()
    assert body["ok"] is True
    assert body["clamped"] == {}
    assert body["config"]["currentId"] == "abc123"
    assert body["config"]["settings"]["scrim"] == 0.5
    assert body["config"]["settings"]["enabled"] is False

    # SSOT is the file, and the renderer's re-read must agree with the receipt
    assert api.client.get(url("/config")).json()["config"] == body["config"]
    on_disk = read_config_file(tmp_path)
    assert on_disk["currentId"] == "abc123"
    assert on_disk["settings"]["scrim"] == 0.5


def test_t8_config_partial_update_keeps_untouched_fields(build):
    api = build()
    api.client.put(url("/config"), json={"settings": {"scrim": 0.4, "cardBase": 60}})

    body = api.client.put(url("/config"), json={"settings": {"scrim": 0.1}}).json()

    assert body["config"]["settings"]["scrim"] == 0.1
    assert body["config"]["settings"]["cardBase"] == 60


def test_t8_config_current_id_explicit_null_clears_the_selection(build):
    api = build()
    api.client.put(url("/config"), json={"currentId": "abc123"})

    body = api.client.put(url("/config"), json={"currentId": None}).json()

    assert body["ok"] is True
    assert body["config"]["currentId"] is None


def test_t8_config_rotation_is_replaced_whole_not_merged(build):
    api = build()
    api.client.put(
        url("/config"),
        json={"settings": {"rotation": {"enabled": True, "intervalMinutes": 45, "shuffle": True}}},
    )

    body = api.client.put(url("/config"), json={"settings": {"rotation": {"enabled": False}}}).json()

    assert body["config"]["settings"]["rotation"] == {
        "enabled": False,
        "intervalMinutes": 10,
        "shuffle": False,
    }


def test_t8_config_unknown_keys_are_ignored_not_fatal(build, caplog):
    caplog.set_level(logging.WARNING)
    api = build()

    response = api.client.put(url("/config"), json={"nope": 1, "settings": {"nope": 2}})

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "nope" not in response.json()["config"]["settings"]


@pytest.mark.parametrize(
    "payload",
    ["[]", '"a string"', "42", '{"settings": []}', '{"settings": "x"}', '{"currentId": 5}'],
)
def test_t8_config_structurally_bad_body_is_400_invalid_body(build, payload):
    api = build()

    response = api.client.put(
        url("/config"), content=payload, headers={"content-type": "application/json"}
    )

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"] == "INVALID_BODY"
    assert isinstance(body["detail"], str) and body["detail"]


def test_t8_config_undecodable_json_is_400_invalid_body(build):
    api = build()

    response = api.client.put(
        url("/config"), content=b"{not json", headers={"content-type": "application/json"}
    )

    assert response.status_code == 400
    body = response.json()
    assert body["ok"] is False
    assert body["error"] == "INVALID_BODY"
    assert isinstance(body["detail"], str) and body["detail"]


def test_t8_config_bad_body_does_not_touch_the_file(build, tmp_path):
    api = build()
    api.client.get(url("/config"))  # materialise the file first
    before = read_config_file(tmp_path)

    api.client.put(url("/config"), content=b"[]", headers={"content-type": "application/json"})

    assert read_config_file(tmp_path) == before


def test_t8_config_corrupt_file_is_backed_up_and_get_returns_defaults(build, tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "config.json").write_text("{ this is not json", encoding="utf-8")
    api = build()

    response = api.client.get(url("/config"))

    assert response.status_code == 200
    doc = response.json()["config"]
    assert doc["version"] == cfg.CONFIG_VERSION
    assert doc["currentId"] is None
    assert list(data_dir.glob("config.bad-*.json"))


def test_t8_config_current_id_reconcile_after_rescan_clears_it_and_persists(build, tmp_path, caplog):
    """§5.2: a vanished wallpaper becomes ``null`` — never a silent fallback."""
    caplog.set_level(logging.WARNING)
    api = build(scanner=make_scanner(MIXED_LIB))

    items = api.client.get(url("/library")).json()["items"]
    gone_id = by_we_id({"items": items})["2002"]["id"]
    api.client.put(
        url("/config"),
        json={"currentId": gone_id, "settings": {"extraLibraryRoots": [str(EXTRA_ROOT)]}},
    )
    assert read_config_file(tmp_path)["currentId"] == gone_id

    # cached, identical library: the id is still valid, nothing is written
    api.client.get(url("/library"))
    assert read_config_file(tmp_path)["currentId"] == gone_id

    # the workshop wallpaper is gone; only the user's extra root survives
    plugin_api.set_deps(
        scanner=make_scanner(probe=bare_probe()),
        store=api.store,
        media_origin_provider=fixed_origin(),
    )
    body = api.client.get(url("/library"), params={"refresh": "1"}).json()
    assert {item["title"] for item in body["items"]} == {"Looped Local"}
    assert body["engineFound"] is False

    doc = api.client.get(url("/config")).json()["config"]
    assert doc["currentId"] is None
    assert read_config_file(tmp_path)["currentId"] is None
    assert any("currentId" in record.message for record in caplog.records)


def test_t8_config_reconcile_is_a_noop_for_a_live_selection(build, tmp_path):
    api = build(FAKE_STEAM)
    item = api.client.get(url("/library")).json()["items"][0]
    api.client.put(url("/config"), json={"currentId": item["id"]})

    body = api.client.get(url("/library"), params={"refresh": "1"}).json()

    assert [i["id"] for i in body["items"]] == [item["id"]]
    assert api.client.get(url("/config")).json()["config"]["currentId"] == item["id"]


def test_t8_config_reconcile_is_skipped_when_the_probe_found_nothing(build, tmp_path):
    """A transient "no Steam at all" must not eat the user's selection."""
    api = build(FAKE_STEAM)
    item = api.client.get(url("/library")).json()["items"][0]
    api.client.put(url("/config"), json={"currentId": item["id"]})

    plugin_api.set_deps(
        scanner=make_scanner(probe=bare_probe()),
        store=api.store,
        media_origin_provider=fixed_origin(),
    )
    api.client.get(url("/library"), params={"refresh": "1"})

    assert read_config_file(tmp_path)["currentId"] == item["id"]


# ---------------------------------------------------------------------------
# T8b — clamp receipt over HTTP
# ---------------------------------------------------------------------------


def test_t8b_clamp_receipt_survives_json(build):
    api = build()

    response = api.client.put(url("/config"), json={"settings": {"cardBase": -5}})

    assert response.status_code == 200
    body = response.json()
    assert body["clamped"] == {"cardBase": [-5, 0]}
    assert body["config"]["settings"]["cardBase"] == 0


def test_t8b_clamp_receipt_covers_every_clamped_field(build):
    api = build()

    body = api.client.put(
        url("/config"),
        json={
            "settings": {
                "scrim": 5,
                "brightness": -1,
                "objectFit": "zoom",
                "sceneLiveFps": 45,
                "rotation": {"enabled": True, "intervalMinutes": 0},
            }
        },
    ).json()

    clamped = body["clamped"]
    assert clamped["scrim"] == [5, 0.9]
    assert clamped["brightness"] == [-1, 0]
    assert clamped["objectFit"] == ["zoom", "cover"]
    assert clamped["sceneLiveFps"] == [45, 30]
    assert clamped["rotation.intervalMinutes"] == [0, 1]
    assert body["config"]["settings"]["scrim"] == 0.9
    assert body["config"]["settings"]["sceneLiveFps"] == 30


def test_t8b_no_receipt_when_every_value_is_in_range(build):
    api = build()

    body = api.client.put(
        url("/config"), json={"settings": {"scrim": 0.3, "cardBase": 50}}
    ).json()

    assert body["clamped"] == {}


def test_t8b_clamp_is_logged_not_silent(build, caplog):
    caplog.set_level(logging.WARNING, logger=cfg.LOGGER_NAME)
    api = build()

    api.client.put(url("/config"), json={"settings": {"cardBase": -5}})

    assert any("cardBase" in record.message for record in caplog.records)


# ---------------------------------------------------------------------------
# T8c — version handling over HTTP
# ---------------------------------------------------------------------------


def test_t8c_version_1_config_is_upgraded_by_get(build, tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "config.json").write_text(
        json.dumps(
            {
                "version": 1,
                "currentId": "3571376089",
                "settings": {"scrim": 0.25, "backgroundBrightness": 120, "id": "3571376089"},
            }
        ),
        encoding="utf-8",
    )
    api = build()

    doc = api.client.get(url("/config")).json()["config"]

    assert doc["version"] == cfg.CONFIG_VERSION
    assert doc["settings"]["brightness"] == 120  # legacy alias mapped
    assert doc["currentId"] is None  # a DSH id cannot be mapped (§5.2)
    assert read_config_file(tmp_path)["version"] == cfg.CONFIG_VERSION


def test_t8c_version_99_is_backed_up_and_rebuilt(build, tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "config.json").write_text(
        json.dumps({"version": 99, "currentId": "x", "settings": {"scrim": 0.1}}),
        encoding="utf-8",
    )
    api = build()

    doc = api.client.get(url("/config")).json()["config"]

    assert doc["version"] == cfg.CONFIG_VERSION
    assert doc["currentId"] is None
    assert doc["settings"]["scrim"] == cfg.SETTINGS_DEFAULTS["scrim"]
    backups = list(data_dir.glob("config.future-*.json"))
    assert len(backups) == 1
    assert json.loads(backups[0].read_text(encoding="utf-8"))["version"] == 99


def test_t8c_version_2_is_left_alone(build, tmp_path):
    api = build()
    doc = api.client.put(url("/config"), json={"settings": {"scrim": 0.7}}).json()["config"]

    assert doc["version"] == cfg.CONFIG_VERSION
    assert read_config_file(tmp_path)["settings"]["scrim"] == 0.7
    assert not list((tmp_path / "data").glob("config.*-*.json"))

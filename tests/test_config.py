"""T8 / T8b / T8c — config layer acceptance (MOD-003 §C, design §5.2 / §6.3).

Nothing here is mocked: every case drives :mod:`dashboard.config` against a real
file in ``tmp_path``, and the HTTP cases go through a real FastAPI app +
``TestClient`` so the receipt survives JSON serialisation and the wiring
``{"ok", "config", "clamped"}`` is the one the router (T1.3) will emit. The app
below is deliberately *test-local* — ``plugin_api.py`` is T1.3's file.

Two properties are checked by reading the file back rather than trusting the
return value:

* a second :class:`ConfigStore` on the same path (a stand-in for a gateway
  restart) has to see the change — that is what "SSOT on disk" means;
* the ``clamped`` receipt is only worth anything if the value that took effect
  is also the value that got persisted.

Fixtures: ``store`` is per-test ``tmp_path`` based, so the plugin's real
``data/config.json`` is never touched.

Anchors (design §12.1):
  T8    ``-k t8_config``   Merge Patch round trip; corrupt file → backup + defaults.
  T8b   ``-k t8b_clamp``   clamp receipt ``[requested, effective]``.
  T8c   ``-k t8c_version`` version 1 upgrade, version 99 → ``config.future-*``.

Run with:
  PYTHONDONTWRITEBYTECODE=1 python \\
      -m pytest tests/test_config.py -v -p no:cacheprovider
"""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PLUGIN_ROOT))

from dashboard import config as cfg  # noqa: E402

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

_TS = r"\d{8}-\d{6}-\d{3}(?:-\d+)?"


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path):
    return cfg.ConfigStore(data_dir=tmp_path / "data")


@pytest.fixture
def client(store):
    from fastapi.testclient import TestClient

    return TestClient(_make_app(store))


@pytest.fixture
def logs(caplog):
    caplog.set_level(logging.DEBUG, logger=cfg.LOGGER_NAME)
    return caplog


def _make_app(store):
    """The GET/PUT /config pair T1.3 will mount, reduced to its contract."""
    app = FastAPI()

    @app.get("/api/plugins/wallpaper-engine/config")
    def read_config():
        return {"ok": True, "config": store.get()}

    @app.put("/api/plugins/wallpaper-engine/config")
    async def write_config(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(
                status_code=400,
                content={
                    "ok": False,
                    "error": "INVALID_BODY",
                    "detail": "body is not valid JSON",
                },
            )
        try:
            doc, clamped = store.apply_patch(body)
        except cfg.InvalidBody as exc:
            return JSONResponse(
                status_code=400,
                content={"ok": False, "error": "INVALID_BODY", "detail": str(exc)},
            )
        return {"ok": True, "config": doc, "clamped": clamped}

    return app


def _read_file(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write_file(path: Path, payload) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = payload if isinstance(payload, str) else json.dumps(payload)
    path.write_text(text, encoding="utf-8")
    return text


def _backups(path: Path, kind: str):
    return sorted(path.parent.glob(f"config.{kind}-*.json"))


# ---------------------------------------------------------------------------
# schema / defaults
# ---------------------------------------------------------------------------

_DOC_SETTINGS_FIELDS = {
    "enabled",
    "uiCards",
    "overlayBase",
    "scrim",
    "panelBase",
    "cardBase",
    "wallpaperBlur",
    "wallpaperOpacity",
    "brightness",
    "contrast",
    "saturate",
    "objectFit",
    "flip",
    "playbackRate",
    "videoMuted",
    "videoVolume",
    "pauseOnHidden",
    "pauseOnBlur",
    "sceneLive",
    "sceneLiveFps",
    "switchTransition",
    "rotation",
    "typeFilter",
    "contentRating",
    "userProps",
    "extraLibraryRoots",
}


def test_t8_config_defaults_cover_every_settings_field():
    """Every field of §5.2's Settings has a default, and nothing extra."""
    assert set(cfg.SETTINGS_DEFAULTS) == _DOC_SETTINGS_FIELDS
    assert cfg.SETTINGS_DEFAULTS == {
        "enabled": True,
        "uiCards": True,
        "overlayBase": 55,
        "scrim": 0.25,
        "panelBase": 55,
        "cardBase": 45,
        "wallpaperBlur": 0,
        "wallpaperOpacity": 100,
        "brightness": 100,
        "contrast": 100,
        "saturate": 100,
        "objectFit": "cover",
        "flip": False,
        "playbackRate": 1.0,
        "videoMuted": True,
        "videoVolume": 0.0,
        "pauseOnHidden": True,
        "pauseOnBlur": False,
        "sceneLive": True,
        "sceneLiveFps": 15,
        "switchTransition": "fade",
        "rotation": {"enabled": False, "intervalMinutes": 10, "shuffle": False},
        "typeFilter": "all",
        "contentRating": "all",
        "userProps": {},
        "extraLibraryRoots": [],
    }
    # A caller must not be able to mutate the schema through the accessor.
    first = cfg.default_settings()
    first["rotation"]["enabled"] = True
    first["userProps"]["x"] = {"y": 1}
    assert cfg.SETTINGS_DEFAULTS["rotation"]["enabled"] is False
    assert cfg.SETTINGS_DEFAULTS["userProps"] == {}


def test_t8_config_default_path_points_into_plugin_data_dir():
    assert cfg.DEFAULT_CONFIG_PATH == PLUGIN_ROOT / "data" / "config.json"
    assert cfg.CONFIG_VERSION == 2


def test_t8_config_missing_file_is_seeded_with_defaults(store):
    assert not store.path.exists()
    doc = store.get()
    assert doc == cfg.default_config()
    on_disk = _read_file(store.path)
    assert on_disk == cfg.default_config()
    assert on_disk["version"] == 2
    assert on_disk["currentId"] is None


# ---------------------------------------------------------------------------
# T8 — Merge Patch round trip
# ---------------------------------------------------------------------------


def test_t8_config_roundtrip_merge_patch_partial_update(store):
    """PUT two settings → GET changes only those two, everything else default."""
    doc, clamped = store.apply_patch({"settings": {"scrim": 0.5, "enabled": False}})

    assert clamped == {}
    assert doc["settings"]["scrim"] == 0.5
    assert doc["settings"]["enabled"] is False

    untouched = _DOC_SETTINGS_FIELDS - {"scrim", "enabled"}
    for field in untouched:
        assert doc["settings"][field] == cfg.SETTINGS_DEFAULTS[field], field

    # ... and the same through a fresh reader (process restart).
    reread = cfg.ConfigStore(path=store.path).get()
    assert reread == doc
    assert reread["version"] == 2


def test_t8_config_roundtrip_via_http_put_then_get(client, store):
    first = client.put(
        "/api/plugins/wallpaper-engine/config",
        json={"settings": {"panelBase": 80, "wallpaperBlur": 12}},
    )
    assert first.status_code == 200
    body = first.json()
    assert body["ok"] is True
    assert body["clamped"] == {}
    assert body["config"]["settings"]["panelBase"] == 80
    assert body["config"]["settings"]["wallpaperBlur"] == 12

    second = client.put(
        "/api/plugins/wallpaper-engine/config", json={"settings": {"scrim": 0.4}}
    )
    assert second.status_code == 200
    changed = second.json()["config"]
    assert changed["settings"]["scrim"] == 0.4
    assert changed["settings"]["panelBase"] == 80  # preserved from PUT #1
    assert changed["settings"]["wallpaperBlur"] == 12
    assert changed["settings"]["cardBase"] == 45  # untouched default

    got = client.get("/api/plugins/wallpaper-engine/config").json()
    assert got["config"] == changed
    assert _read_file(store.path) == changed


def test_t8_config_current_id_set_and_explicit_null_clears(store):
    doc = store.apply_patch({"currentId": "abc123"})[0]
    assert doc["currentId"] == "abc123"
    assert _read_file(store.path)["currentId"] == "abc123"

    # A PUT that says nothing about currentId leaves it alone.
    doc = store.apply_patch({"settings": {"scrim": 0.6}})[0]
    assert doc["currentId"] == "abc123"

    # Explicit null clears it; it is not "absent".
    doc, clamped = store.apply_patch({"currentId": None})
    assert doc["currentId"] is None
    assert clamped == {}
    assert _read_file(store.path)["currentId"] is None


def test_t8_config_unknown_keys_ignored_and_logged(store, logs):
    doc, clamped = store.apply_patch(
        {
            "settings": {"scrim": 0.3, "nonsense": 1, "glassAlpha": 10},
            "fontSetId": "default",
        }
    )
    assert doc["settings"]["scrim"] == 0.3
    assert "nonsense" not in doc["settings"]
    assert "glassAlpha" not in doc["settings"]
    assert "fontSetId" not in doc
    assert clamped == {}

    text = logs.text
    assert "unknown settings key 'nonsense'" in text
    assert "unknown settings key 'glassAlpha'" in text
    assert "unknown top-level key 'fontSetId'" in text


def test_t8_config_rotation_is_replaced_whole_not_merged(store):
    store.apply_patch(
        {
            "settings": {
                "rotation": {"enabled": True, "intervalMinutes": 30, "shuffle": True}
            }
        }
    )
    doc, _ = store.apply_patch({"settings": {"rotation": {"enabled": False}}})
    # Partial merge would have kept 30/True; whole replacement resets them.
    assert doc["settings"]["rotation"] == {
        "enabled": False,
        "intervalMinutes": 10,
        "shuffle": False,
    }
    assert _read_file(store.path)["settings"]["rotation"] == doc["settings"]["rotation"]


def test_t8_config_userprops_is_replaced_whole_not_merged(store):
    store.apply_patch(
        {"settings": {"userProps": {"111": {"speed": 1}, "222": {"glow": True}}}}
    )
    doc, _ = store.apply_patch({"settings": {"userProps": {"222": {"size": 0.5}}}})
    assert doc["settings"]["userProps"] == {"222": {"size": 0.5}}
    assert _read_file(store.path)["settings"]["userProps"] == {"222": {"size": 0.5}}


def test_t8_config_userprops_rejects_non_object_entries(store, logs):
    doc, clamped = store.apply_patch({"settings": {"userProps": {"111": 5, "222": {"a": 1}}}})
    assert doc["settings"]["userProps"] == {"222": {"a": 1}}
    assert clamped["userProps"] == [{"111": 5, "222": {"a": 1}}, {"222": {"a": 1}}]
    assert "not objects" in logs.text


def test_t8_config_settings_null_resets_every_field_to_default(store):
    store.apply_patch({"settings": {"scrim": 0.9, "cardBase": 90, "enabled": False}})
    doc, clamped = store.apply_patch({"settings": None})
    assert doc["settings"] == cfg.default_settings()
    assert clamped == {}


def test_t8_config_field_null_reverts_to_default(store):
    store.apply_patch({"settings": {"scrim": 0.7, "rotation": {"intervalMinutes": 45}}})
    doc, clamped = store.apply_patch({"settings": {"scrim": None}})
    assert doc["settings"]["scrim"] == 0.25
    assert clamped == {}  # a revert is not a clamp
    assert doc["settings"]["rotation"]["intervalMinutes"] == 45


def test_t8_config_corrupt_file_backed_up_and_rebuilt(store, logs):
    broken = '{"version": 2, "settings": {"scrim": 0.5,'  # truncated JSON
    _write_file(store.path, broken)

    doc = store.get()
    assert doc == cfg.default_config()

    backups = _backups(store.path, "bad")
    assert len(backups) == 1
    assert re.fullmatch(rf"config\.bad-{_TS}\.json", backups[0].name)
    assert backups[0].read_text(encoding="utf-8") == broken  # byte-identical

    rebuilt = _read_file(store.path)
    assert rebuilt == cfg.default_config()
    assert store.last_backup == backups[0]
    assert "unreadable" in logs.text


@pytest.mark.parametrize(
    "payload",
    [
        "",  # empty file
        "null",  # valid JSON, wrong shape
        "[1, 2, 3]",
        '"just a string"',
        "\x00\x01binary junk",
        '{"version": 2, "settings": {"scrim": 0.5},}',
    ],
    ids=["empty", "null", "list", "string", "garbage", "trailing-comma"],
)
def test_t8_config_corrupt_variants_get_a_backup(store, payload):
    path = store.path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")

    assert store.get() == cfg.default_config()
    backups = _backups(path, "bad")
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == payload
    assert _read_file(path) == cfg.default_config()


def test_t8_config_corrupt_twice_does_not_clobber_the_first_backup(store):
    path = store.path
    _write_file(path, "{broken")
    store.get()
    first = _backups(path, "bad")
    assert len(first) == 1

    store.reload()
    path.write_text("{broken again", encoding="utf-8")
    store.reload()
    second = _backups(path, "bad")
    assert len(second) == 2
    contents = {item.read_text(encoding="utf-8") for item in second}
    assert contents == {"{broken", "{broken again"}


def test_t8_config_invalid_body_is_rejected(client, store):
    assert client.put("/api/plugins/wallpaper-engine/config", json=[1, 2]).status_code == 400
    assert (
        client.put("/api/plugins/wallpaper-engine/config", json={"currentId": 5}).status_code
        == 400
    )
    assert (
        client.put(
            "/api/plugins/wallpaper-engine/config", json={"settings": "nope"}
        ).status_code
        == 400
    )
    bad = client.put("/api/plugins/wallpaper-engine/config", json={"settings": "nope"}).json()
    assert bad["ok"] is False
    assert bad["error"] == "INVALID_BODY"
    # A rejected body must not have touched the file.
    assert _read_file(store.path) == cfg.default_config()

    with pytest.raises(cfg.InvalidBody):
        store.apply_patch("not an object")


def test_t8_config_current_id_reconcile_after_rescan(store, logs):
    store.apply_patch({"currentId": "id-keep"})
    assert store.reconcile_current(["id-keep", "id-other"]) is None
    assert store.get()["currentId"] == "id-keep"

    dropped = store.reconcile_current(["id-other"])
    assert dropped == "id-keep"
    assert store.get()["currentId"] is None
    assert _read_file(store.path)["currentId"] is None
    # No silent fallback to a surviving wallpaper.
    assert store.get()["currentId"] != "id-other"
    assert "no longer in the library" in logs.text


def test_t8_config_reconcile_is_a_noop_when_nothing_is_selected(store):
    assert store.reconcile_current(["a", "b"]) is None
    assert store.get()["currentId"] is None


def test_t8_config_writes_are_atomic_and_leave_no_temp_files(store):
    for value in (0.1, 0.2, 0.3, 0.4):
        store.apply_patch({"settings": {"scrim": value}})
    names = sorted(item.name for item in store.path.parent.iterdir())
    assert names == ["config.json"]
    assert not list(store.path.parent.glob("*.tmp"))
    assert _read_file(store.path)["settings"]["scrim"] == 0.4


def test_t8_config_concurrent_patches_keep_the_file_consistent(store):
    # Every (start, step) pair stays inside that field's own clamp range, so a
    # final value below the expectation means a write was lost, not clamped.
    cases = {
        "scrim": (0.05, 0.01),
        "panelBase": (30, 1),
        "cardBase": (30, 1),
        "wallpaperBlur": (10, 1),
        "brightness": (120, 1),
    }
    errors: list[BaseException] = []

    def worker(field: str, start, step) -> None:
        try:
            for index in range(20):
                store.apply_patch({"settings": {field: start + step * index}})
        except BaseException as exc:  # pragma: no cover - only on failure
            errors.append(exc)

    threads = [
        threading.Thread(target=worker, args=(field, start, step))
        for field, (start, step) in cases.items()
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not errors
    on_disk = _read_file(store.path)  # must be readable, never truncated
    for field, (start, step) in cases.items():
        assert on_disk["settings"][field] == pytest.approx(start + step * 19)
    assert not list(store.path.parent.glob("*.tmp"))


# ---------------------------------------------------------------------------
# T8b — clamp receipt
# ---------------------------------------------------------------------------


def test_ui_cards_is_a_boolean_setting(store):
    """卡片化: on by default, and a non-boolean never flips it (bool is not int)."""
    assert cfg.SETTINGS_DEFAULTS["uiCards"] is True
    doc, clamped = store.apply_patch({"settings": {"uiCards": "yes"}})
    assert doc["settings"]["uiCards"] is True, "a string keeps the previous value"
    assert clamped["uiCards"] == ["yes", True]

    doc, _ = store.apply_patch({"settings": {"uiCards": False}})
    assert doc["settings"]["uiCards"] is False


def test_t8b_clamp_cardbase_receipt(client, store):
    """The literal anchor: cardBase -5 → 0 (the floor dropped from 20 to 0 on 2026-10-22)."""
    response = client.put(
        "/api/plugins/wallpaper-engine/config", json={"settings": {"cardBase": -5}}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["clamped"]["cardBase"] == [-5, 0]
    assert body["config"]["settings"]["cardBase"] == 0

    # GET agrees, and so does the file — the receipt is not a lie about disk.
    assert client.get("/api/plugins/wallpaper-engine/config").json()["config"][
        "settings"
    ]["cardBase"] == 0
    assert _read_file(store.path)["settings"]["cardBase"] == 0


def test_t8b_cardbase_zero_is_a_real_tier(client, store):
    """0 is accepted verbatim: fully transparent card, not a clamp back to 20."""
    body = client.put(
        "/api/plugins/wallpaper-engine/config", json={"settings": {"cardBase": 0}}
    ).json()
    assert "cardBase" not in body["clamped"]
    assert body["config"]["settings"]["cardBase"] == 0


@pytest.mark.parametrize(
    "field,requested,effective",
    [
        ("scrim", -0.5, 0),
        ("scrim", 0.95, 0.9),
        ("panelBase", -1, 0),
        ("panelBase", 101, 100),
        ("cardBase", -5, 0),
        ("cardBase", 120, 100),
        ("wallpaperBlur", -2, 0),
        ("wallpaperBlur", 41, 40),
        ("wallpaperOpacity", -5, 0),
        ("wallpaperOpacity", 150, 100),
        ("brightness", -1, 0),
        ("brightness", 250, 200),
        ("contrast", 201, 200),
        ("saturate", -20, 0),
        ("playbackRate", 0.1, 0.25),
        ("playbackRate", 4, 3),
        ("videoVolume", -1, 0),
        ("videoVolume", 1.5, 1),
    ],
)
def test_t8b_clamp_numeric_field(store, field, requested, effective):
    doc, clamped = store.apply_patch({"settings": {field: requested}})
    assert doc["settings"][field] == effective
    assert clamped[field] == [requested, effective]
    assert store.get()["settings"][field] == effective
    assert _read_file(store.path)["settings"][field] == effective


@pytest.mark.parametrize(
    "requested,effective",
    [
        (0, 15),
        (1, 15),
        (14, 15),
        (22, 15),
        (23, 30),
        (24, 30),
        (44, 30),
        (45, 30),  # tie → the cheaper, lower candidate
        (46, 60),
        (59, 60),
        (100, 60),
    ],
)
def test_t8b_clamp_scene_fps_normalised_to_nearest_legal(store, requested, effective):
    doc, clamped = store.apply_patch({"settings": {"sceneLiveFps": requested}})
    assert doc["settings"]["sceneLiveFps"] == effective
    assert clamped["sceneLiveFps"] == [requested, effective]


@pytest.mark.parametrize("value", [15, 30, 60])
def test_t8b_clamp_scene_fps_legal_value_is_untouched(store, value):
    doc, clamped = store.apply_patch({"settings": {"sceneLiveFps": value}})
    assert doc["settings"]["sceneLiveFps"] == value
    assert clamped == {}


@pytest.mark.parametrize("field", ["objectFit", "switchTransition", "typeFilter", "contentRating"])
def test_t8b_clamp_enum_accepts_every_legal_value(store, field):
    for value in cfg._ENUM_VALUES[field]:
        doc, clamped = store.apply_patch({"settings": {field: value}})
        assert doc["settings"][field] == value
        assert clamped == {}


def test_t8b_clamp_objectfit_illegal_becomes_cover(store):
    doc, clamped = store.apply_patch({"settings": {"objectFit": "stretch"}})
    assert doc["settings"]["objectFit"] == "cover"
    assert clamped["objectFit"] == ["stretch", "cover"]


def test_t8b_clamp_objectfit_case_is_normalised(store):
    doc, clamped = store.apply_patch({"settings": {"objectFit": "CONTAIN"}})
    assert doc["settings"]["objectFit"] == "contain"
    assert clamped["objectFit"] == ["CONTAIN", "contain"]


def test_t8b_clamp_switchtransition_illegal_becomes_fade(store):
    """§5.2: an illegal transition normalises to fade, even over 'cut'."""
    store.apply_patch({"settings": {"switchTransition": "cut"}})
    doc, clamped = store.apply_patch({"settings": {"switchTransition": "wipe"}})
    assert doc["settings"]["switchTransition"] == "fade"
    assert clamped["switchTransition"] == ["wipe", "fade"]


@pytest.mark.parametrize("field", ["typeFilter", "contentRating"])
def test_t8b_clamp_filter_enum_illegal_becomes_all(store, field):
    doc, clamped = store.apply_patch({"settings": {field: "nuclear"}})
    assert doc["settings"][field] == "all"
    assert clamped[field] == ["nuclear", "all"]


def test_t8b_clamp_interval_minutes_below_one(store, logs):
    doc, clamped = store.apply_patch({"settings": {"rotation": {"intervalMinutes": 0.2}}})
    assert doc["settings"]["rotation"]["intervalMinutes"] == 1
    assert clamped["rotation.intervalMinutes"] == [0.2, 1]
    # Whole-object replacement: the siblings fell back to their defaults.
    assert doc["settings"]["rotation"]["enabled"] is False
    assert "rotation.intervalMinutes" in logs.text


def test_t8b_clamp_interval_minutes_negative(store):
    doc, clamped = store.apply_patch({"settings": {"rotation": {"intervalMinutes": -30}}})
    assert doc["settings"]["rotation"]["intervalMinutes"] == 1
    assert clamped["rotation.intervalMinutes"] == [-30, 1]


def test_t8b_clamp_wrong_type_keeps_previous_and_is_receipted(store, logs):
    store.apply_patch({"settings": {"cardBase": 70}})
    doc, clamped = store.apply_patch({"settings": {"cardBase": "eighty"}})
    assert doc["settings"]["cardBase"] == 70
    assert clamped["cardBase"] == ["eighty", 70]
    assert "is not a finite number" in logs.text

    doc, clamped = store.apply_patch({"settings": {"enabled": 1}})
    assert doc["settings"]["enabled"] is True  # previous value, not truthiness
    assert clamped["enabled"] == [1, True]

    doc, clamped = store.apply_patch({"settings": {"sceneLiveFps": "30"}})
    assert doc["settings"]["sceneLiveFps"] == 15
    assert clamped["sceneLiveFps"] == ["30", 15]

    doc, clamped = store.apply_patch({"settings": {"panelBase": True}})
    assert doc["settings"]["panelBase"] == 55  # bool is not a number here
    assert clamped["panelBase"] == [True, 55]


def test_t8b_clamp_no_receipt_when_everything_is_in_range(store):
    doc, clamped = store.apply_patch(
        {
            "settings": {
                "scrim": 0.9,
                "panelBase": 100,
                "cardBase": 20,
                "wallpaperBlur": 40,
                "wallpaperOpacity": 0,
                "brightness": 200,
                "contrast": 0,
                "saturate": 200,
                "playbackRate": 3,
                "videoVolume": 1,
                "sceneLiveFps": 60,
                "objectFit": "fill",
                "switchTransition": "cut",
                "rotation": {"enabled": True, "intervalMinutes": 1, "shuffle": True},
            }
        }
    )
    assert clamped == {}
    assert doc["settings"]["scrim"] == 0.9
    assert doc["settings"]["cardBase"] == 20


def test_t8b_clamp_multiple_fields_all_receipted(store):
    doc, clamped = store.apply_patch(
        {
            "settings": {
                "scrim": 5,
                "cardBase": -5,
                "wallpaperBlur": -1,
                "sceneLiveFps": 100,
                "objectFit": "zoom",
                "rotation": {"intervalMinutes": 0},
            }
        }
    )
    assert clamped == {
        "scrim": [5, 0.9],
        "cardBase": [-5, 0],
        "wallpaperBlur": [-1, 0],
        "sceneLiveFps": [100, 60],
        "objectFit": ["zoom", "cover"],
        "rotation.intervalMinutes": [0, 1],
    }
    assert doc["settings"]["scrim"] == 0.9


def test_t8b_clamp_extra_library_roots_drops_non_strings(store):
    doc, clamped = store.apply_patch(
        {"settings": {"extraLibraryRoots": ["D:/wp", 42, "", "  ", "E:/more"]}}
    )
    assert doc["settings"]["extraLibraryRoots"] == ["D:/wp", "E:/more"]
    assert clamped["extraLibraryRoots"] == [
        ["D:/wp", 42, "", "  ", "E:/more"],
        ["D:/wp", "E:/more"],
    ]


def test_t8b_clamp_rotation_non_object_falls_back_to_defaults(store):
    doc, clamped = store.apply_patch({"settings": {"rotation": "yes"}})
    assert doc["settings"]["rotation"] == cfg.ROTATION_DEFAULTS
    assert clamped["rotation"] == ["yes", cfg.ROTATION_DEFAULTS]


def test_t8b_clamp_is_logged_not_silent(store, logs):
    store.apply_patch({"settings": {"cardBase": -5, "scrim": -1}})
    text = logs.text
    assert "clamped cardBase from -5 to 0" in text
    assert "clamped scrim from -1 to 0" in text


# ---------------------------------------------------------------------------
# T8c — version handling
# ---------------------------------------------------------------------------


def test_t8c_version_v1_upgraded_to_2_and_defaults_filled(store, logs):
    path = store.path
    _write_file(path, {"version": 1, "settings": {"scrim": 0.6, "cardBase": 70}})

    doc = store.get()
    assert doc["version"] == 2
    assert doc["settings"]["scrim"] == 0.6
    assert doc["settings"]["cardBase"] == 70
    assert set(doc["settings"]) == _DOC_SETTINGS_FIELDS

    on_disk = _read_file(path)
    assert on_disk["version"] == 2
    assert on_disk["settings"]["scrim"] == 0.6
    assert on_disk["settings"]["sceneLiveFps"] == 15
    assert on_disk["settings"]["rotation"] == cfg.ROTATION_DEFAULTS
    assert on_disk["currentId"] is None
    assert "upgraded version 1 -> 2" in logs.text


def test_t8c_version_v1_drops_deprecated_keys_and_maps_renames(store, logs):
    path = store.path
    _write_file(
        path,
        {
            "version": 1,
            "settings": {
                "backgroundBrightness": 120,
                "backgroundContrast": 90,
                "backgroundSaturate": 80,
                "contentRatingFilter": "everyone",
                "rotationEnabled": True,
                "border": 0.35,
                "blur": 10,
                "ropeScale": 0.9,
                "glassColor": "ffffff",
                "scrim": 0.3,
            },
        },
    )
    doc = store.get()
    settings = doc["settings"]
    assert settings["brightness"] == 120
    assert settings["contrast"] == 90
    assert settings["saturate"] == 80
    assert settings["contentRating"] == "everyone"
    assert settings["rotation"] == {
        "enabled": True,
        "intervalMinutes": 10,
        "shuffle": False,
    }
    assert settings["scrim"] == 0.3
    for dead in ("border", "blur", "ropeScale", "glassColor", "backgroundBrightness"):
        assert dead not in settings
    assert "deprecated settings key" in logs.text


def test_t8c_version_v1_clears_unmappable_selection(store, logs):
    """A DSH Workshop id is not a v2 id — clear it, do not guess."""
    path = store.path
    _write_file(path, {"version": 1, "settings": {"id": "3571376089", "scrim": 0.2}})
    doc = store.get()
    assert doc["currentId"] is None
    assert "id" not in doc["settings"]
    assert "cannot be mapped" in logs.text


def test_t8c_version_missing_is_treated_as_legacy(store):
    path = store.path
    _write_file(path, {"settings": {"scrim": 0.55}})
    doc = store.get()
    assert doc["version"] == 2
    assert doc["settings"]["scrim"] == 0.55
    assert _read_file(path)["version"] == 2


def test_t8c_version_v1_real_dsh_config_shape(store):
    """The actual shape on this machine: no version key, flat DSH settings."""
    path = store.path
    _write_file(
        path,
        {
            "fontSetId": "default",
            "settings": {
                "id": "3571376089",
                "scrim": 0.25,
                "border": 0.35,
                "blur": 10,
                "wallpaperBlur": 0,
                "backgroundBrightness": 100,
                "wallpaperOpacity": 0,
                "switchTransition": "cut",
                "rotationEnabled": False,
                "rotationGroups": [],
                "playbackRate": 1,
                "videoVolume": 0,
                "sceneLive": True,
                "sceneLiveFps": 15,
                "userProps": {},
                "objectFit": "cover",
                "contentRatingFilter": "everyone",
                "typeFilter": "all",
                "pauseOnHidden": True,
                "pauseOnBlur": False,
                "flip": False,
            },
        },
    )
    doc = store.get()
    assert doc["version"] == 2
    assert doc["currentId"] is None
    assert set(doc["settings"]) == _DOC_SETTINGS_FIELDS
    assert doc["settings"]["switchTransition"] == "cut"
    assert doc["settings"]["wallpaperOpacity"] == 0
    assert doc["settings"]["contentRating"] == "everyone"
    assert _read_file(path)["version"] == 2


def test_t8c_version_99_is_backed_up_and_rebuilt(store, logs):
    path = store.path
    future = {
        "version": 99,
        "currentId": "id-from-the-future",
        "settings": {"scrim": 0.5, "holoDeck": True, "cardBase": 90},
    }
    original = _write_file(path, future)

    doc = store.get()
    assert doc == cfg.default_config()  # no guessing at future fields

    backups = _backups(path, "future")
    assert len(backups) == 1
    assert re.fullmatch(rf"config\.future-{_TS}\.json", backups[0].name)
    assert backups[0].read_text(encoding="utf-8") == original
    assert json.loads(backups[0].read_text(encoding="utf-8")) == future

    rebuilt = _read_file(path)
    assert rebuilt == cfg.default_config()
    assert rebuilt["version"] == 2
    assert rebuilt["currentId"] is None
    assert "holoDeck" not in rebuilt["settings"]
    assert "newer than 2" in logs.text


def test_t8c_version_2_is_left_alone(store):
    path = store.path
    body = cfg.default_config()
    body["currentId"] = "id-1"
    body["settings"]["scrim"] = 0.35
    original = _write_file(path, body)

    doc = store.get()
    assert doc == body
    assert path.read_text(encoding="utf-8") == original  # untouched
    assert _backups(path, "future") == []
    assert _backups(path, "bad") == []


def test_t8c_version_2_with_bad_values_is_repaired_in_place(store, logs):
    """A hand-edited v2 file cannot smuggle 500 past the clamp table."""
    path = store.path
    body = cfg.default_config()
    body["settings"]["cardBase"] = 500
    body["settings"]["switchTransition"] = "wipe"
    _write_file(path, body)

    doc = store.get()
    assert doc["settings"]["cardBase"] == 100
    assert doc["settings"]["switchTransition"] == "fade"
    assert _read_file(path)["settings"]["cardBase"] == 100
    assert _backups(path, "bad") == []  # repairing, not discarding
    assert "rewritten normalised" in logs.text


def test_t8c_version_non_integer_is_treated_as_legacy(store, logs):
    path = store.path
    _write_file(path, {"version": "2", "settings": {"scrim": 0.45}})
    doc = store.get()
    assert doc["version"] == 2
    assert doc["settings"]["scrim"] == 0.45
    assert "not an integer" in logs.text

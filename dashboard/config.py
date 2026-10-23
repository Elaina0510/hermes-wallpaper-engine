"""Config SSOT for the wallpaper-engine plugin (MOD-003 §C — T1.2).

``data/config.json`` is the only place settings live. The renderer never
hardcodes a default and never trusts its optimistic update: it PUTs and then
overwrites its store with the ``config`` the response hands back (§6.3). That
contract is what makes clamping safe — the client is told what actually took
effect, and the file on disk is what it was told.

Envelope (``ConfigDoc``, §5.2)::

    {"version": 2, "currentId": <str|null>, "settings": {...}}

Decisions this module makes, stated once so nobody has to reverse-engineer
them from the code:

Receipt shape
    ``clamped == {field: [requested, effective]}`` — a two-element list, in the
    order the design writes it (``[原值, 生效值]``), not a dict. Nested fields
    use a dotted key (``rotation.intervalMinutes``) because ``intervalMinutes``
    alone is ambiguous once other objects grow timers. A field appears only
    when the value the client sent is not the value that took effect: an
    out-of-range number, an illegal enum, a wrong JSON type, or a rejected
    list/map item. Every entry is also written to the log at WARNING; the
    design's "不得让 clamp 静默发生而无回执" has two readers on purpose — the
    client for UI truth, the log for post-mortems.

Merge Patch depth
    One level of envelope (``currentId``, ``settings``), one level of settings
    fields. ``rotation`` and ``userProps`` are replaced **whole** (§6.3): a
    PUT that sends ``rotation: {"enabled": true}`` resets ``intervalMinutes``
    to 10 and ``shuffle`` to false — it does not keep the old interval. That is
    not an accident of the implementation, it is the semantic, and
    ``test_t8_config_rotation_overall_replace`` exists to keep it that way.
    Inside ``settings``, an explicit ``null`` means "revert this field to its
    default" (RFC 7386's delete step, resolved against the schema); it is not
    a clamp and therefore carries no receipt.

Illegal ``sceneLiveFps``
    Nearest legal value in ``{15, 30, 60}`` by absolute distance; a tie
    resolves to the *lower* candidate (45 → 30), which is the cheaper render
    load of the two. Non-numeric input keeps the previous value and is
    receipted — there is no distance to measure from "abc".

Numbers are clamped, never rounded
    ``cardBase: 20.4`` stays ``20.4``; the clamp table has bounds, not a
    rounding rule, and inventing one would make the value the renderer holds
    differ from the value it sent for no reason a client could predict.

Writes
    Atomic: ``tempfile.mkstemp`` in the *same* directory, ``flush`` +
    ``fsync``, then ``os.replace``. A crashed write leaves the previous file
    intact instead of a truncated one, and never leaves a ``.tmp`` behind.
    Serialisation is an in-process ``RLock`` per normalised path — correct for
    one gateway process, which is the deployment model (§1). Cross-process
    locking is deliberately out of scope: two gateways on one data directory
    would fight over the media port long before they fought over this file.

Logging
    Stdlib ``logging`` under :data:`LOGGER_NAME`, never ``print``: the plugin
    is imported by the gateway, and ``print`` from a library corrupts whatever
    the host writes to the same stream.

Repairs on load
    The same normaliser runs on both paths — PUT and load — so a hand-edited
    file cannot smuggle a value past the clamp table. Load-time repairs are
    logged and the file is rewritten once, but they do **not** go into a
    ``clamped`` receipt: ``GET /config`` has no receipt to carry.
"""

from __future__ import annotations

import copy
import json
import logging
import math
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

__all__ = [
    "CONFIG_VERSION",
    "LOGGER_NAME",
    "DEFAULT_DATA_DIR",
    "DEFAULT_CONFIG_PATH",
    "SETTINGS_DEFAULTS",
    "SETTINGS_FIELDS",
    "ROTATION_DEFAULTS",
    "InvalidBody",
    "default_settings",
    "default_config",
    "normalize_settings",
    "apply_merge_patch",
    "reconcile_current_id",
    "ConfigStore",
    "get_store",
    "set_store",
    "reset_store",
    "get_config",
    "put_config",
    "reconcile_current",
]

# ---------------------------------------------------------------------------
# schema (§5.2)
# ---------------------------------------------------------------------------

CONFIG_VERSION = 2

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = _PLUGIN_ROOT / "data"
DEFAULT_CONFIG_PATH = DEFAULT_DATA_DIR / "config.json"

LOGGER_NAME = "wallpaper-engine.config"
_log = logging.getLogger(LOGGER_NAME)

ROTATION_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "intervalMinutes": 10,
    "shuffle": False,
}

# Every field of Settings, with the default the design prints. A missing key in
# this table is a bug that test_t8_config_defaults_cover_every_settings_field
# catches before the renderer ever sees a hole.
SETTINGS_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    # Whether the surfaces are drawn as inset glass cards (chat surface + the
    # full-page views). Purely presentational: the wallpaper plays either way.
    "uiCards": True,
    "scrim": 0.25,
    "panelBase": 55,
    "cardBase": 45,
    # Overlay cards (设置 / 定时任务 / 命令中心 …) get their own transparency so
    # a modal can stay readable while the pages behind it go thin.
    "overlayBase": 55,
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
    "rotation": ROTATION_DEFAULTS,
    "typeFilter": "all",
    "contentRating": "all",
    "userProps": {},
    "extraLibraryRoots": [],
}

SETTINGS_FIELDS: tuple[str, ...] = tuple(SETTINGS_DEFAULTS)

# §6.3 clamp table. inclusive bounds.
_NUMERIC_RANGES: dict[str, tuple[float, float]] = {
    "scrim": (0.0, 0.9),
    "panelBase": (0, 100),
    "cardBase": (0, 100),
    "overlayBase": (0, 100),
    "wallpaperBlur": (0, 40),
    "wallpaperOpacity": (0, 100),
    "brightness": (0, 200),
    "contrast": (0, 200),
    "saturate": (0, 200),
    "playbackRate": (0.25, 3.0),
    "videoVolume": (0.0, 1.0),
}

_ENUM_VALUES: dict[str, tuple[str, ...]] = {
    "objectFit": ("cover", "contain", "fill"),
    "switchTransition": ("cut", "fade"),
    "typeFilter": ("all", "video", "image", "web", "scene"),
    "contentRating": ("all", "everyone"),
}

# Illegal enum → this. switchTransition's target is dictated by §5.2 ("归一化为
# fade"); the rest use their own default so the result is predictable.
_ENUM_FALLBACK: dict[str, str] = {
    "objectFit": "cover",
    "switchTransition": "fade",
    "typeFilter": "all",
    "contentRating": "all",
}

_BOOL_FIELDS = frozenset(
    {
        "enabled",
        "uiCards",
        "flip",
        "videoMuted",
        "pauseOnHidden",
        "pauseOnBlur",
        "sceneLive",
    }
)

FPS_CHOICES: tuple[int, ...] = (15, 30, 60)

# Legacy (DSH) key → our key. Applied only while upgrading version < 2; never
# on PUT, so a v2 client cannot silently send an old name and get it honoured.
_LEGACY_ALIASES: dict[str, str] = {
    "backgroundBrightness": "brightness",
    "backgroundContrast": "contrast",
    "backgroundSaturate": "saturate",
    "contentRatingFilter": "contentRating",
}

_BACKUP_TS_FMT = "%Y%m%d-%H%M%S"


class InvalidBody(Exception):
    """The PUT body is structurally unusable — the router answers 400.

    Reserved for shape errors (body not an object, ``settings`` neither object
    nor null, ``currentId`` neither string nor null). Out-of-range *values* are
    never this: §6.3 clamps those and says so in the receipt.
    """


# ---------------------------------------------------------------------------
# defaults
# ---------------------------------------------------------------------------


def default_settings() -> dict[str, Any]:
    """A fresh, independent copy of the Settings defaults."""
    return copy.deepcopy(SETTINGS_DEFAULTS)


def default_config() -> dict[str, Any]:
    """A fresh ``ConfigDoc`` with no wallpaper selected and default settings."""
    return {"version": CONFIG_VERSION, "currentId": None, "settings": default_settings()}


# ---------------------------------------------------------------------------
# value normalisation
# ---------------------------------------------------------------------------


def _is_number(value: Any) -> bool:
    # bool is an int subclass; `{"panelBase": true}` must not become 1.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def _record(receipt: Optional[dict], field: str, requested: Any, effective: Any) -> None:
    if receipt is not None:
        receipt[field] = [requested, effective]


def _clamp_number(
    field: str, raw: Any, previous: Any, receipt: Optional[dict]
) -> Any:
    low, high = _NUMERIC_RANGES[field]
    if not _is_number(raw):
        _log.warning(
            "config: %s=%r is not a finite number; keeping %r", field, raw, previous
        )
        _record(receipt, field, raw, previous)
        return previous
    effective = low if raw < low else high if raw > high else raw
    if effective != raw:
        _log.warning("config: clamped %s from %r to %r", field, raw, effective)
        _record(receipt, field, raw, effective)
    return effective


def _nearest_fps(raw: Any, previous: Any) -> Any:
    if not _is_number(raw):
        _log.warning("config: sceneLiveFps=%r is not a number; keeping %r", raw, previous)
        return previous
    # (distance, candidate) so a tie picks the lower, cheaper value.
    return min(FPS_CHOICES, key=lambda choice: (abs(choice - raw), choice))


def _normalize_enum(field: str, raw: Any, receipt: Optional[dict]) -> Any:
    if isinstance(raw, str):
        candidate = raw.strip().lower()
        if candidate in _ENUM_VALUES[field]:
            if candidate != raw:
                _log.warning(
                    "config: %s=%r normalised to %r", field, raw, candidate
                )
                _record(receipt, field, raw, candidate)
            return candidate
    fallback = _ENUM_FALLBACK[field]
    _log.warning(
        "config: %s=%r is not one of %s; normalised to %r",
        field,
        raw,
        "/".join(_ENUM_VALUES[field]),
        fallback,
    )
    _record(receipt, field, raw, fallback)
    return fallback


def _normalize_bool(field: str, raw: Any, previous: Any, receipt: Optional[dict]) -> Any:
    if isinstance(raw, bool):
        return raw
    _log.warning("config: %s=%r is not a boolean; keeping %r", field, raw, previous)
    _record(receipt, field, raw, previous)
    return previous


def _normalize_interval(
    raw: Any, previous: Any, receipt: Optional[dict]
) -> Any:
    field = "rotation.intervalMinutes"
    if not _is_number(raw):
        _log.warning(
            "config: %s=%r is not a number; keeping %r", field, raw, previous
        )
        _record(receipt, field, raw, previous)
        return previous
    if raw < 1:
        _log.warning("config: clamped %s from %r to 1", field, raw)
        _record(receipt, field, raw, 1)
        return 1
    return raw


def _normalize_rotation(raw: Any, receipt: Optional[dict]) -> dict[str, Any]:
    """Replace ``rotation`` whole — missing keys fall back to defaults (§6.3)."""
    out = copy.deepcopy(ROTATION_DEFAULTS)
    if not isinstance(raw, dict):
        _log.warning(
            "config: rotation=%r is not an object; using defaults", raw
        )
        _record(receipt, "rotation", raw, out)
        return out
    for key, value in raw.items():
        field = f"rotation.{key}"
        if key in ("enabled", "shuffle"):
            out[key] = _normalize_bool(field, value, out[key], receipt)
        elif key == "intervalMinutes":
            out[key] = _normalize_interval(value, out[key], receipt)
        else:
            _log.warning("config: unknown rotation key %r ignored", key)
    return out


def _normalize_user_props(
    raw: Any, previous: dict[str, Any], receipt: Optional[dict]
) -> dict[str, Any]:
    """Replace ``userProps`` whole; entries must be ``{weId: {prop: value}}``."""
    if not isinstance(raw, dict):
        _log.warning("config: userProps=%r is not an object; keeping previous", raw)
        _record(receipt, "userProps", raw, previous)
        return previous
    out: dict[str, Any] = {}
    dropped: list[Any] = []
    for we_id, props in raw.items():
        if isinstance(props, dict):
            out[str(we_id)] = copy.deepcopy(props)
        else:
            dropped.append(we_id)
    if dropped:
        _log.warning(
            "config: userProps entries %r are not objects; dropped", dropped
        )
        _record(receipt, "userProps", raw, out)
    return out


def _normalize_roots(
    raw: Any, previous: list[str], receipt: Optional[dict]
) -> list[str]:
    if not isinstance(raw, list):
        _log.warning(
            "config: extraLibraryRoots=%r is not a list; keeping previous", raw
        )
        _record(receipt, "extraLibraryRoots", raw, previous)
        return previous
    out = [item for item in raw if isinstance(item, str) and item.strip()]
    if len(out) != len(raw):
        _log.warning(
            "config: extraLibraryRoots: %d of %d entries are not non-empty strings; dropped",
            len(raw) - len(out),
            len(raw),
        )
        _record(receipt, "extraLibraryRoots", raw, out)
    return out


def normalize_settings(
    raw: Any,
    *,
    previous: Optional[dict] = None,
    receipt: Optional[dict] = None,
    source: str = "put",
) -> dict[str, Any]:
    """Fold ``raw`` onto ``previous`` and return a complete, valid Settings.

    ``previous`` is the current settings (PUT) or ``None`` (load). Unknown keys
    are logged and dropped; ``None`` means "revert to default"; everything else
    goes through the clamp table. ``receipt`` (a dict) collects
    ``{field: [requested, effective]}``.
    """
    base = default_settings()
    if isinstance(previous, dict):
        for field in SETTINGS_FIELDS:
            if field in previous:
                base[field] = copy.deepcopy(previous[field])

    if not isinstance(raw, dict):
        if raw is not None:
            _log.warning(
                "config: %s: settings is not an object (%s); keeping current",
                source,
                type(raw).__name__,
            )
        return base

    for key, value in raw.items():
        if key not in SETTINGS_DEFAULTS:
            _log.warning("config: %s: unknown settings key %r ignored", source, key)
            continue
        if value is None:
            # RFC 7386 delete, resolved against the schema. Not a clamp, so no
            # receipt entry — the client learns the new value from `config`.
            base[key] = copy.deepcopy(SETTINGS_DEFAULTS[key])
            continue
        if key == "rotation":
            base["rotation"] = _normalize_rotation(value, receipt)
        elif key == "userProps":
            base["userProps"] = _normalize_user_props(value, base["userProps"], receipt)
        elif key == "extraLibraryRoots":
            base["extraLibraryRoots"] = _normalize_roots(
                value, base["extraLibraryRoots"], receipt
            )
        elif key == "sceneLiveFps":
            effective = _nearest_fps(value, base["sceneLiveFps"])
            if effective != value:
                _log.warning(
                    "config: sceneLiveFps=%r is not one of %s; normalised to %r",
                    value,
                    FPS_CHOICES,
                    effective,
                )
                _record(receipt, "sceneLiveFps", value, effective)
            base["sceneLiveFps"] = effective
        elif key in _ENUM_VALUES:
            base[key] = _normalize_enum(key, value, receipt)
        elif key in _BOOL_FIELDS:
            base[key] = _normalize_bool(key, value, base[key], receipt)
        else:
            base[key] = _clamp_number(key, value, base[key], receipt)
    return base


# ---------------------------------------------------------------------------
# merge patch
# ---------------------------------------------------------------------------


def _normalize_current_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    raise InvalidBody("currentId must be a string or null")


def apply_merge_patch(
    doc: dict,
    patch: Any,
    *,
    receipt: Optional[dict] = None,
    source: str = "put",
) -> dict[str, Any]:
    """Pure JSON-Merge-Patch over a ``ConfigDoc`` (§6.3).

    Two known envelope keys, unknown ones logged and ignored. Absent keys keep
    their value; ``currentId: null`` clears the selection; ``settings`` is
    folded one field deep with ``rotation``/``userProps`` replaced whole.
    """
    if not isinstance(patch, dict):
        raise InvalidBody("body must be a JSON object")

    for key in patch:
        if key not in ("currentId", "settings"):
            _log.warning("config: %s: unknown top-level key %r ignored", source, key)

    current = doc if isinstance(doc, dict) else default_config()
    out: dict[str, Any] = {
        "version": CONFIG_VERSION,
        "currentId": current.get("currentId"),
        "settings": copy.deepcopy(current.get("settings") or default_settings()),
    }

    if "currentId" in patch:
        out["currentId"] = _normalize_current_id(patch["currentId"])

    if "settings" in patch:
        raw_settings = patch["settings"]
        if raw_settings is None:
            out["settings"] = default_settings()
        elif not isinstance(raw_settings, dict):
            raise InvalidBody("settings must be a JSON object or null")
        else:
            out["settings"] = normalize_settings(
                raw_settings,
                previous=out["settings"],
                receipt=receipt,
                source=source,
            )
    return out


def reconcile_current_id(
    doc: dict, valid_ids: Any
) -> tuple[dict[str, Any], Optional[str]]:
    """Clear ``currentId`` if it is no longer in the library (§5.2).

    Returns ``(doc, dropped_id)``. Never substitutes another wallpaper: the
    design is explicit that a vanished selection becomes ``null`` rather than a
    silent fallback.
    """
    valid = {str(item) for item in valid_ids}
    current = doc.get("currentId") if isinstance(doc, dict) else None
    out = copy.deepcopy(doc) if isinstance(doc, dict) else default_config()
    if current is None or current in valid:
        return out, None
    out["currentId"] = None
    return out, current


# ---------------------------------------------------------------------------
# store
# ---------------------------------------------------------------------------

_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(path: Path) -> threading.RLock:
    key = os.path.normcase(os.path.abspath(str(path)))
    with _LOCKS_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _LOCKS[key] = lock
        return lock


class ConfigStore:
    """Read/write ``data/config.json``, one instance per path per process.

    The document is cached in memory after the first load and written through
    on every mutation. ``load()`` is where repair happens: corrupt file, legacy
    version and future version are all resolved before the caller sees a doc.
    """

    def __init__(
        self,
        path: Optional[os.PathLike | str] = None,
        data_dir: Optional[os.PathLike | str] = None,
        logger: Optional[logging.Logger] = None,
    ) -> None:
        if path is not None and data_dir is not None:
            raise ValueError("pass either path or data_dir, not both")
        if path is None:
            path = (
                Path(os.fspath(data_dir)) / "config.json"
                if data_dir is not None
                else DEFAULT_CONFIG_PATH
            )
        self.path = Path(os.fspath(path))
        self._log = logger or _log
        self._lock = _lock_for(self.path)
        self._doc: Optional[dict] = None
        self._loaded = False
        #: repairs applied by the last :meth:`load` (field → [was, now]) —
        #: diagnostics only, never part of a response body.
        self.last_repairs: dict[str, Any] = {}
        #: where the last bad/future file was moved to, for /diag.
        self.last_backup: Optional[Path] = None

    # -- reading ----------------------------------------------------------

    def load(self) -> dict[str, Any]:
        """Return the current ``ConfigDoc`` (copy), repairing the file first."""
        with self._lock:
            return copy.deepcopy(self._load_locked())

    def get(self) -> dict[str, Any]:
        """Alias for :meth:`load` — the GET /config body."""
        return self.load()

    def reload(self) -> dict[str, Any]:
        """Forget the cache and read the file again."""
        with self._lock:
            self._doc = None
            self._loaded = False
            return copy.deepcopy(self._load_locked())

    def exists(self) -> bool:
        return self.path.is_file()

    @property
    def doc(self) -> dict[str, Any]:
        return self.load()

    # -- writing ----------------------------------------------------------

    def apply_patch(self, body: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        """PUT /config. Returns ``(config, clamped)`` — exactly the response."""
        if not isinstance(body, dict):
            raise InvalidBody("body must be a JSON object")
        with self._lock:
            current = self._load_locked()
            receipt: dict[str, Any] = {}
            updated = apply_merge_patch(current, body, receipt=receipt, source="put")
            if updated != current:
                self._write(updated)
            self._doc = updated
            self._loaded = True
            return copy.deepcopy(updated), receipt

    def set_current_id(self, current_id: Optional[str]) -> dict[str, Any]:
        doc, _ = self.apply_patch({"currentId": current_id})
        return doc

    def reconcile_current(self, valid_ids: Any) -> Optional[str]:
        """Clear a stale ``currentId`` and persist. Returns the dropped id."""
        with self._lock:
            current = self._load_locked()
            updated, dropped = reconcile_current_id(current, valid_ids)
            if dropped is None:
                return None
            self._write(updated)
            self._doc = updated
            self._loaded = True
            self._log.warning(
                "config: currentId %r is no longer in the library; cleared to null", dropped
            )
            return dropped

    def save(self, doc: Any) -> dict[str, Any]:
        """Replace the document wholesale (normalised first), then persist."""
        with self._lock:
            normalized, _ = self._normalize_doc(doc if isinstance(doc, dict) else {})
            self._write(normalized)
            self._doc = normalized
            self._loaded = True
            return copy.deepcopy(normalized)

    # -- internals --------------------------------------------------------

    def _load_locked(self) -> dict[str, Any]:
        if self._loaded and self._doc is not None:
            return self._doc
        doc = self._read_file()
        self._doc = doc
        self._loaded = True
        return doc

    def _read_file(self) -> dict[str, Any]:
        if not self.path.exists():
            doc = default_config()
            self._write(doc)
            self._log.info("config: %s did not exist; seeded defaults", self.path)
            return doc

        try:
            text = self.path.read_text(encoding="utf-8")
            raw = json.loads(text)
            if not isinstance(raw, dict):
                raise ValueError(
                    f"top-level JSON is {type(raw).__name__}, expected object"
                )
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            # §9: a damaged file is moved aside, never "repaired" in place —
            # whatever the user had is still readable in the backup.
            backup = self._backup("bad")
            doc = default_config()
            self._write(doc)
            self._log.error(
                "config: %s is unreadable (%s); moved to %s and rebuilt from defaults",
                self.path,
                exc,
                backup,
            )
            return doc

        return self._upgrade(raw)

    def _upgrade(self, raw: dict) -> dict[str, Any]:
        version = raw.get("version")
        if isinstance(version, bool) or not isinstance(version, int):
            if version is not None:
                self._log.warning(
                    "config: version=%r is not an integer; treating as legacy", version
                )
            version = None

        if version is None or version < CONFIG_VERSION:
            return self._migrate_legacy(raw, version)

        if version > CONFIG_VERSION:
            # Unknown future schema: do not guess what its fields mean.
            backup = self._backup("future")
            doc = default_config()
            self._write(doc)
            self._log.warning(
                "config: version %s is newer than %s; moved to %s and rebuilt from defaults",
                version,
                CONFIG_VERSION,
                backup,
            )
            return doc

        doc, repairs = self._normalize_doc(raw, source="load")
        if doc != raw:
            # Keep memory and disk in agreement: if the file was missing fields,
            # carried unknown keys, or held out-of-range values, write back the
            # normalised document once.
            self.last_repairs = repairs
            self._write(doc)
            self._log.warning(
                "config: %s did not match the v2 schema (%s); rewritten normalised",
                self.path,
                sorted(repairs) or "fields filled/unknown keys dropped",
            )
        return doc

    def _normalize_doc(self, raw: dict, source: str = "load") -> tuple[dict, dict]:
        receipt: dict[str, Any] = {}
        settings = normalize_settings(
            raw.get("settings"), previous=None, receipt=receipt, source=source
        )
        current_id = raw.get("currentId")
        if current_id is not None and not isinstance(current_id, str):
            self._log.warning(
                "config: currentId=%r is not a string; cleared", current_id
            )
            current_id = None
        for key in raw:
            if key not in ("version", "currentId", "settings"):
                self._log.warning("config: unknown top-level key %r ignored", key)
        doc = {
            "version": CONFIG_VERSION,
            "currentId": current_id,
            "settings": settings,
        }
        return doc, receipt

    def _migrate_legacy(self, raw: dict, version: Optional[int]) -> dict[str, Any]:
        raw_settings = raw.get("settings")
        if not isinstance(raw_settings, dict):
            if raw_settings is not None:
                self._log.warning(
                    "config: legacy settings is %s, not an object; rebuilding from defaults",
                    type(raw_settings).__name__,
                )
            raw_settings = {}

        migrated, dropped = _apply_legacy_aliases(raw_settings)
        current_id = raw.get("currentId")
        legacy_id = current_id if current_id is not None else raw_settings.get("id")
        if legacy_id is not None:
            # DSH stored the Workshop id; our WallpaperItem.id is a path hash.
            # Mapping one to the other would be a guess, so the selection is
            # cleared and the panel tells the user to pick again (§5.2).
            self._log.warning(
                "config: legacy selection %r cannot be mapped to a v2 id; currentId cleared",
                legacy_id,
            )

        doc = {
            "version": CONFIG_VERSION,
            "currentId": None,
            "settings": normalize_settings(migrated, previous=None, source="migrate"),
        }
        for key in raw:
            if key not in ("version", "currentId", "settings"):
                self._log.warning("config: unknown top-level key %r ignored", key)
        self._write(doc)
        self._log.info(
            "config: upgraded version %s -> %d at %s (%d legacy key(s) dropped)",
            version,
            CONFIG_VERSION,
            self.path,
            len(dropped),
        )
        return doc

    # -- disk -------------------------------------------------------------

    def _write(self, doc: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
        tmp_name: Optional[str] = None
        try:
            fd, tmp_name = tempfile.mkstemp(
                prefix=self.path.name + ".", suffix=".tmp", dir=str(self.path.parent)
            )
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, str(self.path))
            tmp_name = None
        finally:
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass

    def _backup(self, kind: str) -> Optional[Path]:
        """Move the current file aside as ``config.<kind>-<ts>.json``."""
        stamp = time.strftime(_BACKUP_TS_FMT, time.localtime())
        millis = int((time.time() % 1) * 1000)
        target = self.path.with_name(f"{self.path.stem}.{kind}-{stamp}-{millis:03d}.json")
        counter = 1
        while target.exists():
            target = self.path.with_name(
                f"{self.path.stem}.{kind}-{stamp}-{millis:03d}-{counter}.json"
            )
            counter += 1
        try:
            os.replace(str(self.path), str(target))
        except OSError as exc:
            self._log.error(
                "config: could not move %s to %s (%s); original left in place",
                self.path,
                target,
                exc,
            )
            return None
        self.last_backup = target
        return target


def _apply_legacy_aliases(settings: dict) -> tuple[dict, list[str]]:
    """Map the handful of renamed DSH keys, drop everything else (§5.2)."""
    out: dict[str, Any] = {}
    dropped: list[str] = []
    for key, value in settings.items():
        if key in _LEGACY_ALIASES:
            target = _LEGACY_ALIASES[key]
            out[target] = value
            _log.info("config: migrated legacy key %r -> %r", key, target)
        elif key == "rotationEnabled":
            rotation = out.get("rotation")
            if not isinstance(rotation, dict):
                rotation = {}
            if isinstance(value, bool):
                rotation["enabled"] = value
            else:
                _log.warning(
                    "config: legacy rotationEnabled=%r is not a boolean; ignored", value
                )
            out["rotation"] = rotation
            _log.info("config: migrated legacy key %r -> 'rotation.enabled'", key)
        elif key in SETTINGS_DEFAULTS:
            out[key] = value
        else:
            dropped.append(key)
    if dropped:
        _log.info(
            "config: dropped %d deprecated settings key(s): %s",
            len(dropped),
            ", ".join(sorted(dropped)),
        )
    return out, dropped


# ---------------------------------------------------------------------------
# process-wide singleton (what plugin_api.py uses)
# ---------------------------------------------------------------------------

_store: Optional[ConfigStore] = None
_store_guard = threading.Lock()


def get_store() -> ConfigStore:
    """The process-wide store on :data:`DEFAULT_CONFIG_PATH`."""
    global _store
    with _store_guard:
        if _store is None:
            _store = ConfigStore(DEFAULT_CONFIG_PATH)
        return _store


def set_store(store: Optional[ConfigStore]) -> None:
    """Swap the singleton (tests, and a future configurable data dir)."""
    global _store
    with _store_guard:
        _store = store


def reset_store() -> None:
    """Drop the singleton so the next :func:`get_store` re-reads the file."""
    set_store(None)


def get_config() -> dict[str, Any]:
    return get_store().get()


def put_config(body: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    return get_store().apply_patch(body)


def reconcile_current(valid_ids: Any) -> Optional[str]:
    return get_store().reconcile_current(valid_ids)

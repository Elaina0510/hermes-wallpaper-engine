"""MOD-004 §D — FastAPI router for the wallpaper-engine plugin (T1.3).

The gateway imports this file as ``dashboard/plugin_api.py``, reads the
module-level ``router`` and mounts it at ``/api/plugins/wallpaper-engine/``
(F5, ``web_server_dashboard.py:805-883``). Everything here therefore lives
*outside* the import path Hermes knows about, which shapes two decisions:

Import strategy
    ``spec_from_file_location`` does **not** put the file's directory on
    ``sys.path`` and gives the module no package (``__package__ == ""``), so
    neither ``from . import scan`` nor ``import scan`` is guaranteed to work in
    the gateway. :func:`_load_sibling` first tries the package form (that is
    what the tests use: ``from dashboard import plugin_api``), then reuses an
    already-imported module that really came from this directory, and finally
    loads the file by path under the unambiguous name
    ``we_wallpaper_engine_<name>``. ``media_server`` is additionally aliased to
    its bare name because ``scan.py`` falls back to ``import media_server``.

Eager media server (§3.2)
    :func:`start_media_server` is called **once, synchronously, at import**
    (bottom of this file) — never on first request. Lazy start would make the
    first concurrent visitor block on the start lock while ``/status`` has no
    "starting" state to report (§6.1). The call is idempotent and cannot raise:
    ``media_server.start_media_server`` holds a lock and returns the existing
    instance, so a second import — or a second plugin module instance — gets
    the same port instead of a second listener. Routes additionally call
    :func:`_ensure_media_server`, which is the §3.2 "enabled=false then the
    user opens the panel" recovery path (and the only way back after a test
    calls ``shutdown()``).

Dependency injection
    The default wiring is process-wide (one :class:`dashboard.scan.Scanner`,
    ``dashboard.config.get_store()``, ``media_server.media_origin``), but every
    route resolves its collaborators from :func:`_deps` on **each request**.
    :func:`set_deps` / :func:`reset_deps` swap them for tests, which is how the
    whole file is exercised without a real Steam library and without touching
    ``data/config.json``.

Contracts implemented verbatim:

* ``GET /status`` — §6.1, exactly seven keys, no "starting" state.
* ``GET /library?refresh=0|1`` — §6.2: 30 s cache by default, ``refresh=1``
  forces a rescan, one scan is capped at 5 s and a timeout answers 200 with the
  previous payload plus an ``errors`` entry (never a 500, never a fabricated
  empty list).
* ``GET/PUT /config`` — §6.3: JSON Merge Patch, ``clamped`` receipt
  ``{field: [requested, effective]}``, and 400
  ``{"ok": false, "error": "INVALID_BODY", "detail": ...}`` for a structurally
  unusable body.
* A ``currentId`` whose wallpaper is gone after a rescan is normalised to
  ``null`` **and persisted** (§5.2) via ``config.reconcile_current`` — no
  silent fallback to another wallpaper.
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
import os
import sys
import threading
from typing import Any, Callable, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

__all__ = [
    "PLUGIN_NAME",
    "PLUGIN_VERSION",
    "LOGGER_NAME",
    "router",
    "set_deps",
    "reset_deps",
    "deps",
    "get_scanner",
    "ensure_media_server",
]

PLUGIN_NAME = "wallpaper-engine"
#: §6.1 ``version`` — the plugin's own API version, not Hermes's.
PLUGIN_VERSION = "1.0.0"
LOGGER_NAME = "wallpaper-engine.api"

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGIN_ROOT = os.path.dirname(_HERE)

log = logging.getLogger(LOGGER_NAME)


# ---------------------------------------------------------------------------
# sibling modules (see "Import strategy" above)
# ---------------------------------------------------------------------------


def _from_this_dir(module: Any) -> bool:
    path = getattr(module, "__file__", None)
    if not path:
        return False
    return os.path.normcase(os.path.dirname(os.path.abspath(path))) == os.path.normcase(_HERE)


def _load_sibling(name: str) -> Any:
    """Import ``dashboard/<name>.py`` exactly once, whatever the host context."""
    package = __package__ or (__name__.rpartition(".")[0] if "." in __name__ else "")
    if package:
        try:
            return importlib.import_module(f".{name}", package)
        except ImportError:  # pragma: no cover - only when loaded without a package
            pass

    existing = sys.modules.get(name)
    if existing is not None and _from_this_dir(existing):
        return existing

    key = f"we_wallpaper_engine_{name}"
    module = sys.modules.get(key)
    if module is not None:
        return module

    spec = importlib.util.spec_from_file_location(key, os.path.join(_HERE, f"{name}.py"))
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise ImportError(f"cannot load sibling module {name!r} from {_HERE}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:  # pragma: no cover - keep sys.modules clean on failure
        sys.modules.pop(key, None)
        raise
    # ``scan.py`` falls back to a bare ``import media_server`` when it has no
    # package; publishing it under its plain name is what makes that resolve.
    sys.modules.setdefault(name, module)
    return module


media_server = _load_sibling("media_server")
config = _load_sibling("config")
scan = _load_sibling("scan")


# ---------------------------------------------------------------------------
# process-wide defaults + injectable dependencies
# ---------------------------------------------------------------------------


def ensure_media_server() -> None:
    """Start the media server if it is not running. Never raises.

    Idempotent by construction: ``start_media_server`` holds its own lock and
    returns the existing instance, so the import-time call below, a second
    import, and this per-request safety net all converge on one listener.
    """
    try:
        if media_server.server() is None:
            media_server.start_media_server()
    except Exception:  # noqa: BLE001 - the plugin degrades, the gateway lives
        log.exception("media server start failed")


_scanner: Any = None
_scanner_lock = threading.Lock()

_deps_lock = threading.Lock()
_deps: dict[str, Any] = {
    "scanner": None,
    "store": None,
    "media_origin_provider": None,
    "media_error_provider": None,
}


def get_scanner() -> Any:
    """The process-wide :class:`dashboard.scan.Scanner` (one per gateway)."""
    global _scanner
    with _scanner_lock:
        if _scanner is None:
            _scanner = scan.Scanner(
                data_dir=os.path.join(_PLUGIN_ROOT, "data"),
                media_origin_provider=media_origin,
            )
        return _scanner


def set_deps(
    *,
    scanner: Any = None,
    store: Any = None,
    media_origin_provider: Optional[Callable[[], Optional[str]]] = None,
    media_error_provider: Optional[Callable[[], Optional[str]]] = None,
) -> None:
    """Swap the collaborators used by every route (tests, not production)."""
    with _deps_lock:
        _deps["scanner"] = scanner
        _deps["store"] = store
        _deps["media_origin_provider"] = media_origin_provider
        _deps["media_error_provider"] = media_error_provider


def reset_deps() -> None:
    """Restore the process-wide defaults."""
    set_deps()


def deps() -> dict[str, Any]:
    """A snapshot of the current collaborator overrides (``None`` = default)."""
    with _deps_lock:
        return dict(_deps)


def api_scanner() -> Any:
    return deps()["scanner"] or get_scanner()


def api_store() -> Any:
    return deps()["store"] or config.get_store()


def media_origin() -> Optional[str]:
    """``mediaOrigin`` for ``/status`` and for every ``WallpaperItem.play.url``."""
    provider = deps()["media_origin_provider"]
    if provider is not None:
        return provider()
    ensure_media_server()
    return media_server.media_origin()


def _media_state() -> tuple[Optional[str], Optional[str]]:
    """``(mediaOrigin, mediaError)`` — §6.1: no origin must come with a string."""
    origin = media_origin()
    provider = deps()["media_error_provider"]
    error = provider() if provider is not None else media_server.media_error()
    if origin is None and not error:
        error = "媒体服务器未启动"
    return origin, error


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

_TRUTHY = frozenset({"1", "true", "yes", "on"})


def _flag(value: Any) -> bool:
    """``?refresh=`` parsing that never fails a request (§6.2 says ``0|1``).

    Garbage and absence both mean "use the cache": a mistyped query string is
    not worth a 422 when the cost of being permissive is one extra scan.
    """
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in _TRUTHY


def _extra_library_roots() -> list[str]:
    """``settings.extraLibraryRoots`` — a broken config yields ``[]``, not a 500."""
    try:
        doc = api_store().get()
    except Exception:  # noqa: BLE001
        log.warning("could not read config for extraLibraryRoots", exc_info=True)
        return []
    settings = (doc or {}).get("settings") or {}
    roots = settings.get("extraLibraryRoots") or []
    return [root for root in roots if isinstance(root, str) and root.strip()]


def _invalid(detail: str) -> JSONResponse:
    """§6.3 400 body, shared by every structural rejection."""
    return JSONResponse(
        status_code=400,
        content={"ok": False, "error": "INVALID_BODY", "detail": detail},
    )


def _reconcile(payload: dict[str, Any]) -> None:
    """Normalise a vanished ``currentId`` to ``null`` and persist it (§5.2).

    Guard: when a scan found *nothing at all* (``engineFound`` false **and** no
    items) the result is indistinguishable from "the probe failed this time",
    and clearing the user's selection on a transient probe failure would be
    worse than leaving a dangling id one cycle longer. A timeout is unaffected —
    it replays the previous payload, whose ids are still real.
    """
    items = payload.get("items") or []
    if not items and not payload.get("engineFound"):
        return
    valid = [item.get("id") for item in items if item.get("id")]
    try:
        dropped = api_store().reconcile_current(valid)
    except Exception:  # noqa: BLE001 - a library response must not depend on it
        log.warning("currentId reconcile failed", exc_info=True)
        return
    if dropped:
        log.warning("currentId %r is gone after the rescan; cleared to null", dropped)


# ---------------------------------------------------------------------------
# routes — prefixed by the gateway (§F5), so paths here are suffix-relative
# ---------------------------------------------------------------------------

router = APIRouter(tags=[PLUGIN_NAME])


@router.get("/status")
def get_status() -> dict[str, Any]:
    """§6.1 — engine + media health, exactly seven keys, always 200.

    ``engineFound=false`` may carry ``installDir: null``; ``mediaOrigin: null``
    always comes with a string ``mediaError``. There is no "starting" state:
    the media server is started at import (§3.2).
    """
    origin, media_error = _media_state()
    try:
        found = api_scanner().discovery()
    except Exception:  # noqa: BLE001 - /status must answer even if a probe dies
        log.warning("/status discovery failed", exc_info=True)
        found = {"engineFound": False, "installDir": None, "libraryDirs": []}
    return {
        "ok": True,
        "version": PLUGIN_VERSION,
        "engineFound": bool(found.get("engineFound")),
        "installDir": found.get("installDir"),
        "libraryDirs": list(found.get("libraryDirs") or []),
        "mediaOrigin": origin,
        "mediaError": media_error,
    }


@router.get("/library")
def get_library(refresh: Optional[str] = None) -> dict[str, Any]:
    """§6.2 — cached library, ``refresh=1`` forces a rescan.

    The scan itself enforces the 5 s budget and its own 30 s cache; a timeout
    comes back here as "previous payload + an ``errors`` entry" and is served
    as 200. Items are already title-sorted by the scanner (§6.2 ordering).
    """
    force = _flag(refresh)
    extra = _extra_library_roots()
    try:
        payload = api_scanner().scan(force=force, extra_library_roots=extra)
    except Exception as exc:  # noqa: BLE001 - §6.2/T3: never a 500
        log.exception("/library scan failed")
        payload = {
            "engineFound": False,
            "mediaOrigin": media_origin(),
            "scannedAt": scan._now_iso(),
            "items": [],
            "errors": [{"path": "<scan>", "message": f"扫描失败: {type(exc).__name__}: {exc}"}],
        }
    _reconcile(payload)
    return payload


@router.get("/config")
def get_config() -> dict[str, Any]:
    """§6.3 GET — ``{"ok": true, "config": ConfigDoc}`` (envelope, like PUT)."""
    return {"ok": True, "config": api_store().get()}


@router.put("/config")
async def put_config(request: Request) -> Any:
    """§6.3 PUT — JSON Merge Patch in, ``config`` + ``clamped`` receipt out."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - undecodable body is a 400, not a 422
        return _invalid("body 不是合法 JSON")
    try:
        doc, clamped = api_store().apply_patch(body)
    except config.InvalidBody as exc:
        return _invalid(str(exc))
    return {"ok": True, "config": doc, "clamped": clamped}


# ---------------------------------------------------------------------------
# §3.2 — eager start, at import, exactly once per process
# ---------------------------------------------------------------------------

_started_at_import = False
try:  # pragma: no cover - exercised by test_import_starts_the_media_server_eagerly
    ensure_media_server()
    _started_at_import = media_server.server() is not None
except Exception:  # noqa: BLE001 - an import side effect must never break the host
    log.exception("eager media server start failed at import")

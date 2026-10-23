"""Media server for the wallpaper-engine plugin (MOD-002 §B).

This module is deliberately framework-free: a ``ThreadingHTTPServer`` on
``127.0.0.1:0`` in its own daemon thread, so the media routes live and die with
the gateway process instead of riding FastAPI's lifespan. ``plugin_api.py``
mounts nothing here — it only calls :func:`start_media_server` and hands
``media_origin()`` to the rest of the plugin.

Routes:

===========================  =================================================
``GET /gl/<rel>``            static files from ``vendor/webwallgl/``
``GET /s/<token>/<rel>``     files inside the directory (or next to the file)
                             registered under ``<token>``
``GET /m/<token>``           the single file registered under ``<token>``
                             (T1.4 — no ``rel`` segment, see below)
``GET /health``              ``{"ok":true}`` — used by ``/status`` probing
===========================  =================================================

``/m`` vs ``/s`` (design §5.3 security note)
    ``/s`` and ``/gl`` are *rooted* routes: ``rel`` is fenced by
    :func:`safe_join` against a root. ``/m`` has neither ``rel`` nor a root, so
    there is no root fence to apply and pretending otherwise ("the token is a
    capability, therefore treat it as a path fence") is the mistake DSH made.
    ``/m`` does exactly three checks — token→table lookup, ``realpath``,
    existence + non-symlink of the final component (see
    :func:`resolve_single_file`). The capability *is* the token; the checks
    exist so a dead token is a 404 rather than a file handle to something that
    moved, and so a token minted for a link cannot be used to serve a link.

HTML injection (§10.2, anchors T7)
    Any ``.html``/``.htm`` served **through a token route** (``/s`` or ``/m``)
    is rewritten on the way out: ``web-shim.js`` (inline, verbatim) + the
    ``__weSeedProps`` seed script are spliced in immediately after the opening
    ``<head>`` tag, i.e. before any author script. ``/gl`` is deliberately
    *not* injected — ``host.html`` there is the renderer page (parent), not an
    author page (child). See :func:`build_injection` / :func:`inject_html`.

Still not here: config read/write (that is ``dashboard/config.py``).

Invariants shared by every response
-----------------------------------
* ``Cache-Control: no-store`` — DSH got bitten by Electron caching 404s; a
  stale 404 outlives the file it describes.
* ``Access-Control-Allow-Origin: *`` — the renderer is ``file://`` so every
  fetch is cross-origin.

Path fence (``safe_join``, shared by ``/s`` and ``/gl`` — one implementation,
not two copies):

1. percent-decode first (``..%2f`` must not sneak past a literal ``..`` check);
2. reject ``..`` segments, absolute paths, drive letters, NUL bytes — on both
   separators, because ``\\`` is a separator on Windows;
3. reject the root itself / anything that does not string-prefix inside it;
4. reject symlinks at *any* component below the root (``lstat``, fail-closed);
5. reject anything whose ``realpath`` lands outside ``realpath(root)``.

Steps 4 and 5 overlap on purpose: 4 catches a link that points *inside* the root
(which 5 alone would allow), 5 catches a link that 4 could not see because it
was deleted between the two calls. A missing file is **not** a fence violation —
it falls through to 404, per DSH's own comment, so debugging does not get
pointed at the wrong layer.

Tokens: ``base64url(absPath)`` with no padding and no case folding, byte-for-byte
what DSH's ``tokenFor`` does (``Buffer.toString('base64url')``, lib/index.js
:2593). Two spellings of the same Windows path therefore produce two tokens that
resolve to the same file. Harmless; it only makes the map one entry longer.
"""

from __future__ import annotations

import base64
import importlib
import json
import logging
import mimetypes
import os
import ntpath
import re
import stat
import sys
import threading
import time
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

__all__ = [
    "HOST",
    "DEFAULT_VENDOR_ROOT",
    "ForbiddenPath",
    "MediaServerError",
    "MediaHTTPServer",
    "MediaRequestHandler",
    "safe_join",
    "parse_range_header",
    "resolve_single_file",
    "token_for",
    "register_path",
    "lookup_token",
    "clear_tokens",
    "set_user_props_provider",
    "reset_user_props_provider",
    "seed_props_for",
    "project_props",
    "record_diag",
    "recent_diag",
    "shim_js",
    "build_injection",
    "inject_html",
    "start_media_server",
    "shutdown",
    "media_origin",
    "media_port",
    "media_error",
    "server",
]

log = logging.getLogger("wallpaper-engine.media")

# ---------------------------------------------------------------------------
# renderer diagnostics (vendor CONTRACT §4.1)
# ---------------------------------------------------------------------------

#: The vendor renderer's only error channel is a fire-and-forget HTTP GET to
#: ``${mediaBase}/diag?msg=…&lvl=…`` (CONTRACT §4.1). A scene iframe is
#: cross-origin and posts no heartbeat, so without this endpoint a black scene
#: leaves no evidence anywhere. Keep the last entries for ``/status``/the panel.
_DIAG_LOCK = threading.Lock()
_DIAG_ENTRIES: list[dict[str, Any]] = []
_DIAG_LIMIT = 50


def record_diag(message: str, level: str = "info") -> dict[str, Any]:
    """Record one renderer diagnostic line (bounded ring, never raises)."""
    entry = {
        "ts": int(time.time() * 1000),
        "level": level if level in ("error", "warn", "info") else "info",
        "message": str(message)[:2000],
    }
    with _DIAG_LOCK:
        _DIAG_ENTRIES.append(entry)
        if len(_DIAG_ENTRIES) > _DIAG_LIMIT:
            del _DIAG_ENTRIES[: len(_DIAG_ENTRIES) - _DIAG_LIMIT]
    log.warning("renderer diag [%s] %s", entry["level"], entry["message"][:300])
    return entry


def recent_diag(limit: int = 20) -> list[dict[str, Any]]:
    """Copy of the last ``limit`` diagnostics, oldest first."""
    try:
        count = max(1, int(limit))
    except (TypeError, ValueError):
        count = 20
    with _DIAG_LOCK:
        return [dict(item) for item in _DIAG_ENTRIES[-count:]]

HOST = "127.0.0.1"

# dashboard/media_server.py -> plugin root -> vendor/webwallgl
_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VENDOR_ROOT = _PLUGIN_ROOT / "vendor" / "webwallgl"

CHUNK_SIZE = 64 * 1024
START_RETRIES = 3

# Content-Type for the extensions a wallpaper tree actually contains. Explicit
# first, mimetypes as the fallback (the Windows registry can hand back surprises
# like audio/x-wav for .wav; that is fine for the fallback path).
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    # Wallpaper Engine scene/tex packages: opaque blobs, never sniff them.
    ".pkg": "application/octet-stream",
    ".tex": "application/octet-stream",
}


class ForbiddenPath(Exception):
    """``safe_join`` refused the request — the caller answers 403."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class MediaServerError(RuntimeError):
    """The listener could not be created (all retries exhausted)."""


# ---------------------------------------------------------------------------
# token table (§5.3) — process-local, never persisted, never cleaned up except
# on dispose. A dead token (file moved/deleted) is a 404, not a 403.
# ---------------------------------------------------------------------------

_tokens: dict[str, dict] = {}
_tokens_lock = threading.Lock()


def token_for(abs_path: os.PathLike | str) -> str:
    """``base64url(absPath)`` without padding — DSH's ``tokenFor`` (F21).

    No normalisation of any kind: not case, not separators, not ``..``. The
    token is a capability for exactly the string it was minted from.
    """
    raw = os.fspath(abs_path)
    encoded = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")
    return encoded.rstrip("=")


def register_path(
    abs_path: os.PathLike | str,
    kind: Optional[str] = None,
    entry: Optional[str] = None,
) -> str:
    """Mint/reuse a token for ``abs_path`` and remember what it points at.

    ``kind`` defaults to ``"dir"``/``"file"`` from the filesystem; ``entry`` is
    the relative entry file for directory tokens (``scene.pkg``, ``index.html``)
    and is what ``/s/<token>`` with an empty ``rel`` serves.
    """
    raw = os.fspath(abs_path)
    token = token_for(raw)
    if kind is None:
        kind = "dir" if os.path.isdir(raw) else "file"
    with _tokens_lock:
        _tokens[token] = {"kind": kind, "path": raw, "entry": entry}
    return token


def lookup_token(token: str) -> Optional[dict]:
    with _tokens_lock:
        return _tokens.get(token)


def clear_tokens() -> None:
    with _tokens_lock:
        _tokens.clear()


# ---------------------------------------------------------------------------
# path fence
# ---------------------------------------------------------------------------


def _is_absolute_or_drive(rel: str) -> bool:
    if rel.startswith(("/", "\\")):
        return True
    drive, _ = ntpath.splitdrive(rel)
    return bool(drive)


def safe_join(root: os.PathLike | str, rel: str) -> Path:
    """Resolve ``rel`` under ``root`` or raise :class:`ForbiddenPath`.

    Returns a :class:`Path` that may or may not exist — existence is the
    caller's business (404), because "not there" and "tried to escape" are
    different failures and deserve different answers.
    """
    if "\x00" in rel:
        raise ForbiddenPath("nul")

    # 1. decode once, here — never earlier, so the token segment is untouched.
    try:
        decoded = urllib.parse.unquote(rel, encoding="utf-8", errors="strict")
    except (UnicodeDecodeError, ValueError):
        raise ForbiddenPath("decode") from None

    # 2. Windows accepts both separators; normalise before inspecting segments.
    decoded = decoded.replace("\\", "/")

    # %00 decodes to NUL, which os.lstat rejects with ValueError (not OSError),
    # so it has to be refused here rather than in the component walk.
    if "\x00" in decoded:
        raise ForbiddenPath("nul")

    if _is_absolute_or_drive(decoded):
        raise ForbiddenPath("absolute")

    parts = [p for p in decoded.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ForbiddenPath("dotdot")

    root_path = Path(os.fspath(root))
    try:
        root_real = Path(os.path.realpath(str(root_path)))
    except (OSError, ValueError):
        raise ForbiddenPath("unresolved-root") from None

    if not parts:
        raise ForbiddenPath("root-itself")

    candidate = root_real.joinpath(*parts)
    candidate_abs = Path(os.path.abspath(str(candidate)))
    if not _inside(candidate_abs, root_real):
        raise ForbiddenPath("prefix")

    # 3. no symlink anywhere on the way down. lstat, not stat: we want the link
    #    itself, and we want to fail closed if it cannot be inspected.
    cur = root_real
    for part in parts:
        cur = cur / part
        try:
            st = os.lstat(str(cur))
        except FileNotFoundError:
            break  # missing -> 404 downstream, not a fence violation
        except (OSError, ValueError):
            raise ForbiddenPath("unresolved") from None
        if stat.S_ISLNK(st.st_mode):
            raise ForbiddenPath("symlink")

    # 4. realpath containment — catches anything the component walk could not
    #    see (e.g. a junction resolved only by the OS).
    try:
        target_real = Path(os.path.realpath(str(candidate_abs)))
    except (OSError, ValueError):
        raise ForbiddenPath("unresolved") from None
    if not _inside(target_real, root_real, allow_equal=True):
        raise ForbiddenPath("realpath")
    return target_real


def _inside(path: Path, root: Path, allow_equal: bool = False) -> bool:
    p = os.path.normcase(os.path.abspath(str(path)))
    r = os.path.normcase(os.path.abspath(str(root)))
    if p == r:
        return allow_equal
    return p.startswith(r + os.sep)


# ---------------------------------------------------------------------------
# Range
# ---------------------------------------------------------------------------


def parse_range_header(value: str, size: int) -> Optional[tuple[int, int]]:
    """Parse a single-range ``bytes=`` header into inclusive ``(start, end)``.

    Returns ``None`` when the header cannot be satisfied or is not understood —
    the caller answers 416 with ``Content-Range: bytes */<size>``.

    Supported: ``bytes=a-b``, ``bytes=a-`` (open ended — video players send
    this), ``bytes=-N`` (suffix). Not supported on purpose:

    * multiple ranges (``bytes=0-1,5-6``) — a wallpaper is one blob; the
      multipart/byteranges response buys nothing and costs a parser;
    * non-``bytes`` units — we answer 416 rather than silently ignoring the
      header, so a client that asked for something we cannot do finds out.
    """
    if size <= 0 or value is None:
        return None
    header = value.strip()
    unit, _, spec = header.partition("=")
    if unit.strip().lower() != "bytes" or not spec:
        return None
    if "," in spec:
        return None  # multi-range: unsupported
    spec = spec.strip()
    if "-" not in spec:
        return None
    first, _, last = spec.partition("-")
    first, last = first.strip(), last.strip()

    if not first:
        if not last.isdigit():
            return None
        suffix = int(last)
        if suffix <= 0:
            return None
        start = max(0, size - suffix)
        return start, size - 1

    if not first.isdigit():
        return None
    start = int(first)
    if last:
        if not last.isdigit():
            return None
        end = int(last)
    else:
        end = size - 1
    if start > end or start >= size:
        return None
    return start, min(end, size - 1)


# ---------------------------------------------------------------------------
# /m — single-file resolution: three checks, no root fence (§5.3)
# ---------------------------------------------------------------------------


class FileGone(Exception):
    """The token resolves to nothing servable — the caller answers 404."""


def resolve_single_file(raw_path: os.PathLike | str) -> Path:
    """Resolve a ``/m`` token target. Raises, never silently degrades.

    1. ``lstat`` the registered path — a **link** is refused
       (:class:`ForbiddenPath`, → 403). ``lstat``, not ``stat``: the question is
       "is this entry a link", not "what does it point at".
    2. ``realpath`` — the 8.3 short name / case-insensitive filesystem / any
       reparse point below the final component is resolved to the one real
       path (this is the check that makes "exists" mean the same thing to us
       and to the OS).
    3. existence — a regular file, after resolution. A directory token, a
       vanished file and a token minted for a path that never existed all land
       here as 404.

    Deliberately **not** checked: whether the resolved path is inside some
    root. ``/m`` has no root; the token is the capability and it was minted by
    our own scanner for one absolute path. Adding a root here would mean
    inventing one (a library dir? the plugin tree?) and would break the
    legitimate ``extraLibraryRoots`` case — and it would still not be a fence,
    because there is no ``rel`` a caller could steer. The three checks above
    answer the questions that actually matter for a capability URL: is the
    capability live, and does it still name the same kind of thing it named
    when it was minted.
    """
    raw = os.fspath(raw_path)
    if "\x00" in raw:
        raise ForbiddenPath("nul")
    try:
        st = os.lstat(raw)
    except (FileNotFoundError, NotADirectoryError):
        raise FileGone(raw) from None
    except (OSError, ValueError):
        raise FileGone(raw) from None
    if stat.S_ISLNK(st.st_mode):
        raise ForbiddenPath("symlink")
    try:
        real = Path(os.path.realpath(raw))
    except (OSError, ValueError):
        raise FileGone(raw) from None
    try:
        if not real.is_file():
            raise FileGone(raw)
    except OSError:
        raise FileGone(raw) from None
    return real


# ---------------------------------------------------------------------------
# HTML injection (§10.2) — shim + seed, first segment of <head>
# ---------------------------------------------------------------------------

#: Marker attribute carried by the injected shim <script>. Doubles as the
#: idempotency key: a page that already carries it is never injected twice
#: (shim L28-33 — a double install halves the frame cap, 15 -> 7.5 fps).
INJECT_ATTR = 'data-we-inject="web-shim"'
INJECT_MARKER = INJECT_ATTR.encode("ascii")

HTML_EXTS = frozenset({".html", ".htm"})

#: Spliced in front of the shim body so the injected frame is identifiable in
#: devtools and in a served response without reading 77 KB.
_SHIM_BANNER = b"/* webwallgl 2.0.2 web-shim (injected by wallpaper-engine) */\n"

_HEAD_RE = re.compile(rb"<head\b[^>]*>", re.IGNORECASE)
_HTML_OPEN_RE = re.compile(rb"<html\b[^>]*>", re.IGNORECASE)
_DOCTYPE_RE = re.compile(rb"<!doctype\b[^>]*>", re.IGNORECASE)
_BOM = b"\xef\xbb\xbf"

_shim_cache: dict[tuple[str, int, int], bytes] = {}
_shim_lock = threading.Lock()


def shim_js(vendor_root: os.PathLike | str = DEFAULT_VENDOR_ROOT) -> Optional[bytes]:
    """``vendor/webwallgl/web-shim.js`` as bytes, cached by (path, mtime, size).

    Returns ``None`` when the file is unreadable — the handler then serves the
    author page untouched instead of 500ing or injecting a broken script.
    """
    path = Path(vendor_root) / "web-shim.js"
    try:
        st = path.stat()
    except OSError:
        log.warning("web-shim.js missing at %s; HTML served un-injected", path)
        return None
    key = (str(path), st.st_mtime_ns, st.st_size)
    with _shim_lock:
        cached = _shim_cache.get(key)
    if cached is not None:
        return cached
    try:
        data = path.read_bytes()
    except OSError:
        log.warning("web-shim.js unreadable at %s; HTML served un-injected", path)
        return None
    if b"</script" in data.lower():
        # An inline <script> cannot contain its own end tag. Escaping it would
        # corrupt the script (that sequence is only legal inside a string), so
        # refuse to inject and let the page run without a shim — visible, and
        # it cannot happen with the vendored 2.0.2 file (0 occurrences).
        log.error("web-shim.js contains '</script'; refusing inline injection")
        return None
    with _shim_lock:
        _shim_cache.clear()
        _shim_cache[key] = data
    return data


def _js_json(value: Any) -> str:
    """JSON safe to embed inside an inline ``<script>``.

    ``ensure_ascii=True`` on purpose: the author page may declare any charset
    (gbk is common in workshop uploads) and the injected text must survive it,
    so nothing non-ASCII leaves this function. ``<`` is escaped because
    ``"</script>"`` inside a string would end the script element early.
    """
    text = json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    return text.replace("<", "\\u003c")


def _seed_script(props: Mapping[str, Any]) -> bytes:
    """The ``__weSeedProps`` call, as a classic inline script (runs in order).

    Guarded by ``typeof`` because it must not throw when the shim is absent
    (see :func:`shim_js`). Nothing else is emitted: the shim owns the pending
    queue (L1143-1150) and replays it once the author registers the listener.
    """
    return (
        b"(function(){try{var s=window.__weSeedProps;"
        b"if(typeof s===\"function\"){s(" + _js_json(dict(props)).encode("ascii") + b");}"
        b"}catch(e){}})();"
    )


def build_injection(
    shim: bytes,
    props: Optional[Mapping[str, Any]] = None,
    site_root: Optional[str] = None,
) -> bytes:
    """The three script blocks, in execution order: site root, shim, seed.

    ``window.__weSiteRoot`` is set *before* the shim because the shim reads it
    at install time (CONTRACT §2.3, shim L284-308); our token routes have the
    shape ``/s/<token>/``, which the shim's segment heuristic does not
    recognise, so declaring it is the supported way to make its ``..`` clamp
    fire for the right root.
    """
    blocks: list[bytes] = []
    if site_root:
        blocks.append(
            b'<script data-we-inject="site-root">window.__weSiteRoot='
            + _js_json(site_root).encode("ascii")
            + b";</script>"
        )
    blocks.append(b"<script " + INJECT_MARKER + b">" + _SHIM_BANNER + shim + b"\n</script>")
    blocks.append(
        b'<script data-we-inject="seed">' + _seed_script(props or {}) + b"</script>"
    )
    return b"\n".join(blocks) + b"\n"


def inject_html(body: bytes, block: bytes) -> bytes:
    """Splice ``block`` in at the first segment of ``<head>`` (§10.2).

    Placement ladder, in order — the first hit wins:

    1. right after the opening ``<head ...>`` tag (the normal case: ahead of
       every author ``<script>``, which is what §10.2 requires);
    2. right after ``<html ...>``   — no ``<head>`` written but the document is
       still well-formed; the browser's implied head starts before the body;
    3. right after ``<!DOCTYPE ...>``;
    4. at the very top (after a UTF-8 BOM, if any) — fragments and pages whose
       first tag is ``<body>`` or a bare element.

    Rungs 2-4 still put the shim before any author script, which is the actual
    requirement; they only give up "inside head" for documents that have no
    head. A page that already carries :data:`INJECT_MARKER` is returned
    unchanged (idempotent — double injection halves the frame cap).
    """
    if INJECT_MARKER in body:
        return body
    if not body.strip():
        return block
    start = len(_BOM) if body.startswith(_BOM) else 0
    for pattern in (_HEAD_RE, _HTML_OPEN_RE, _DOCTYPE_RE):
        match = pattern.search(body, start)
        if match is not None:
            at = match.end()
            return body[:at] + b"\n" + block + body[at:]
    return body[:start] + block + b"\n" + body[start:]


# ---------------------------------------------------------------------------
# seed properties: project.json defaults + config.userProps[weId] overrides
# ---------------------------------------------------------------------------

#: ``callable() -> Mapping[str, Mapping[str, Any]]`` — ``config.userProps``,
#: i.e. ``{weId: {prop: value}}``. ``None`` (the default) means "read it from
#: ``dashboard/config.py`` lazily"; tests inject a fake here.
_user_props_provider: Optional[Callable[[], Any]] = None
_user_props_lock = threading.Lock()

_props_cache: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}
_props_lock = threading.Lock()


def set_user_props_provider(provider: Optional[Callable[[], Any]]) -> None:
    """Wire (or clear) the ``config.userProps`` source used by the seed script."""
    global _user_props_provider
    with _user_props_lock:
        _user_props_provider = provider


def reset_user_props_provider() -> None:
    set_user_props_provider(None)


def _same_dir(module: Any) -> bool:
    path = getattr(module, "__file__", None)
    if not path:
        return False
    return os.path.normcase(os.path.dirname(os.path.abspath(path))) == os.path.normcase(
        os.path.dirname(os.path.abspath(__file__))
    )


def _config_module() -> Any:
    """``dashboard/config.py`` however the host happened to load it.

    ``plugin_api.py`` loads its siblings by path under ``we_wallpaper_engine_*``
    names and publishes ``media_server`` under its bare name only, so there is
    no single import spelling to rely on. Same-directory check keeps us from
    picking up an unrelated module that happens to be called ``config``.
    """
    for candidate in ("dashboard.config", "config", "we_wallpaper_engine_config"):
        module = sys.modules.get(candidate)
        if module is not None and _same_dir(module):
            return module
    try:
        module = importlib.import_module("dashboard.config")
    except Exception:  # noqa: BLE001 - no config module is not an error here
        return None
    return module if _same_dir(module) else None


def _user_props() -> dict[str, Any]:
    with _user_props_lock:
        provider = _user_props_provider
    if provider is not None:
        try:
            value = provider()
        except Exception:  # noqa: BLE001 - a broken provider degrades to defaults
            log.warning("userProps provider failed; seeding project defaults only", exc_info=True)
            return {}
        return dict(value) if isinstance(value, Mapping) else {}
    module = _config_module()
    if module is None:
        return {}
    try:
        doc = module.get_config()
    except Exception:  # noqa: BLE001 - corrupt config must not break playback
        log.warning("could not read config for userProps", exc_info=True)
        return {}
    if not isinstance(doc, Mapping):
        return {}
    # §6.3: the ConfigDoc nests it as settings.userProps ({weId: {prop: value}}).
    # The top-level spelling is tolerated for a caller that hands over a bare
    # `{weId: {...}}` map; it is never written by this plugin.
    settings = doc.get("settings")
    props = settings.get("userProps") if isinstance(settings, Mapping) else None
    if props is None:
        props = doc.get("userProps")
    return dict(props) if isinstance(props, Mapping) else {}


def project_props(project_dir: os.PathLike | str | None) -> dict[str, Any]:
    """``project.json`` → ``general.properties[*].value`` (WE's defaults).

    Mirrors ``scan._props_defaults`` (duplicated rather than imported:
    ``scan`` imports this module, so importing it back would be a cycle). A
    missing/broken ``project.json`` yields ``{}`` — the seed script still runs,
    with an empty object, so the page sees a listener call rather than nothing.
    Cached by ``(mtime_ns, size)``; ``project.json`` is read per HTML request.
    """
    if project_dir is None:
        return {}
    path = Path(project_dir) / "project.json"
    try:
        st = path.stat()
    except OSError:
        return {}
    key = str(path)
    stamp = (st.st_mtime_ns, st.st_size)
    with _props_lock:
        cached = _props_cache.get(key)
    if cached is not None and cached[0] == stamp:
        return dict(cached[1])
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, UnicodeDecodeError):
        log.warning("unreadable project.json at %s; seeding {} ", path)
        return {}
    out: dict[str, Any] = {}
    general = data.get("general") if isinstance(data, Mapping) else None
    properties = general.get("properties") if isinstance(general, Mapping) else None
    if isinstance(properties, Mapping):
        for name, spec in properties.items():
            out[str(name)] = spec.get("value") if isinstance(spec, Mapping) else spec
    with _props_lock:
        if len(_props_cache) > 64:  # bounded: a big library re-scans, not grows
            _props_cache.clear()
        _props_cache[key] = (stamp, dict(out))
    return out


def seed_props_for(project_dir: os.PathLike | str | None) -> dict[str, Any]:
    """Defaults from ``project.json``, overlaid by ``config.userProps[weId]``.

    ``weId`` is the project directory's name — the same value ``scan.py`` puts
    on ``WallpaperItem.weId`` — so the panel's override keys and the seed's
    lookup keys cannot drift apart.
    """
    props = project_props(project_dir)
    if project_dir is None:
        return props
    we_id = Path(project_dir).name
    if not we_id:
        return props
    overrides = _user_props().get(we_id)
    if isinstance(overrides, Mapping):
        for name, value in overrides.items():
            props[str(name)] = value
    return props


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class MediaRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "WeMedia/0.1"
    sys_version = ""

    def version_string(self) -> str:
        # BaseHTTPRequestHandler joins server_version + " " + sys_version, which
        # leaves a trailing space when sys_version is blank. Keep it clean.
        return self.server_version

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        if getattr(self.server, "log_requests", False):
            super().log_message(fmt, *args)

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch(send_body=True)

    def do_HEAD(self) -> None:  # noqa: N802
        self._dispatch(send_body=False)

    # -- routing ----------------------------------------------------------

    def _dispatch(self, send_body: bool) -> None:
        target = self.path
        try:
            path = urllib.parse.urlsplit(target).path
        except ValueError:
            self._fail(HTTPStatus.BAD_REQUEST, "bad-request", send_body)
            return

        if path in ("/health", "/health/"):
            self._health(send_body)
            return

        # Renderer beacon (CONTRACT §4.1): fire-and-forget, must stay cheap and
        # must never affect the render. 204 with no body.
        if path in ("/diag", "/diag/"):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(target).query)
            message = (query.get("msg") or [""])[0]
            level = (query.get("lvl") or ["info"])[0]
            if message:
                record_diag(message, level)
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if path in ("/diag/recent", "/diag/recent/"):
            try:
                limit = int((urllib.parse.parse_qs(urllib.parse.urlsplit(target).query).get("limit") or ["20"])[0])
            except (TypeError, ValueError):
                limit = 20
            body = json.dumps({"ok": True, "entries": recent_diag(limit)}, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if send_body:
                self.wfile.write(body)
            return

        if path == "/gl" or path.startswith("/gl/"):
            rel = path[len("/gl/"):] if path.startswith("/gl/") else ""
            root = getattr(self.server, "vendor_root", DEFAULT_VENDOR_ROOT)
            self._serve_under(Path(root), rel or "index.html", send_body)
            return

        if path.startswith("/s/"):
            rest = path[len("/s/"):]
            token, _, rel = rest.partition("/")
            token = urllib.parse.unquote(token)
            record = lookup_token(token)
            if record is None:
                # Dead/unknown token: 404 (never 403) so a stale bookmark does
                # not look like a security event. no-store is mandatory here.
                self._fail(HTTPStatus.NOT_FOUND, "unknown-token", send_body)
                return
            entry_path = Path(record["path"])
            if record["kind"] == "dir":
                root = entry_path
                project_dir = entry_path
                if not rel:
                    rel = record.get("entry") or "index.html"
            else:
                root = entry_path.parent
                project_dir = entry_path.parent
                if not rel:
                    rel = entry_path.name
            # Site root for the shim's `..` clamp (CONTRACT §2.3): this route's
            # own token directory, never the process-wide one.
            self._serve_under(
                root,
                rel,
                send_body,
                project_dir=project_dir,
                site_root=f"/s/{token}/",
            )
            return

        if path.startswith("/m/"):
            # Single-file route: no rel, no root fence (§5.3). A token is
            # base64url, so a second path segment can never be part of one.
            token = urllib.parse.unquote(path[len("/m/"):])
            if not token or "/" in token:
                self._fail(HTTPStatus.NOT_FOUND, "no-route", send_body)
                return
            record = lookup_token(token)
            if record is None:
                self._fail(HTTPStatus.NOT_FOUND, "unknown-token", send_body)
                return
            try:
                target = resolve_single_file(record["path"])
            except ForbiddenPath as exc:
                self._fail(HTTPStatus.FORBIDDEN, f"forbidden[{exc.reason}]", send_body)
                return
            except FileGone:
                self._fail(HTTPStatus.NOT_FOUND, "not-found", send_body)
                return
            # §10.2: project.json lives in the token's directory; for a file
            # token that is the file's parent. /m carries no site root: it names
            # one file, and claiming a root it cannot serve would mis-clamp the
            # shim's relative-URL rewrite.
            self._serve_file(
                target,
                send_body,
                project_dir=Path(record["path"]).parent,
                site_root=None,
                inject=True,
            )
            return

        self._fail(HTTPStatus.NOT_FOUND, "no-route", send_body)

    def _health(self, send_body: bool) -> None:
        body = b'{"ok":true}'
        self._start(HTTPStatus.OK, "application/json; charset=utf-8", len(body))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _serve_under(
        self,
        root: Path,
        rel: str,
        send_body: bool,
        *,
        project_dir: Optional[Path] = None,
        site_root: Optional[str] = None,
    ) -> None:
        """Rooted route (``/s``, ``/gl``). ``inject`` is on only for token routes.

        ``/gl`` passes neither ``project_dir`` nor ``site_root``: it serves the
        vendor tree, whose ``host.html`` is the renderer page (the shim's
        *parent*), not an author page — injecting the shim there would install
        a child-side control surface into the page that drives it.
        """
        try:
            target = safe_join(root, rel)
        except ForbiddenPath as exc:
            self._fail(HTTPStatus.FORBIDDEN, f"forbidden[{exc.reason}]", send_body)
            return
        if not target.is_file():
            self._fail(HTTPStatus.NOT_FOUND, "not-found", send_body)
            return
        self._serve_file(
            target,
            send_body,
            project_dir=project_dir,
            site_root=site_root,
            inject=project_dir is not None or site_root is not None,
        )

    # -- body -------------------------------------------------------------

    def _serve_file(
        self,
        target: Path,
        send_body: bool,
        *,
        project_dir: Optional[Path] = None,
        site_root: Optional[str] = None,
        inject: bool = False,
    ) -> None:
        if inject and target.suffix.lower() in HTML_EXTS:
            self._serve_html(target, send_body, project_dir, site_root)
            return

        try:
            size = target.stat().st_size
        except OSError:
            self._fail(HTTPStatus.NOT_FOUND, "not-found", send_body)
            return

        plan = self._plan_file_response(size, _content_type(target))
        if plan is None:
            return
        start, length = plan
        if not send_body or length == 0:
            return

        remaining = length
        try:
            with target.open("rb") as fh:
                fh.seek(start)
                while remaining > 0:
                    chunk = fh.read(min(CHUNK_SIZE, remaining))
                    if not chunk:
                        break  # truncated under us; the length is already sent
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Player seeks constantly and drops the socket mid-body routinely.
            self.close_connection = True

    def _serve_html(
        self,
        target: Path,
        send_body: bool,
        project_dir: Optional[Path],
        site_root: Optional[str],
    ) -> None:
        """Serve an author page with §10.2 injection applied to the bytes.

        The Range/Content-Length arithmetic runs on the **injected** bytes, not
        on the on-disk size: the entity a client can range over is what we send.
        A missing shim degrades to "serve the page as the author wrote it"
        (log + no injection) rather than a 500 or a half-injected page.
        """
        try:
            body = target.read_bytes()
        except OSError:
            self._fail(HTTPStatus.NOT_FOUND, "not-found", send_body)
            return

        shim = shim_js(getattr(self.server, "vendor_root", DEFAULT_VENDOR_ROOT))
        if shim is None:
            data = body
        else:
            try:
                props = seed_props_for(project_dir)
            except Exception:  # noqa: BLE001 - seeding must never break playback
                log.warning("seed props failed for %s", project_dir, exc_info=True)
                props = {}
            data = inject_html(body, build_injection(shim, props, site_root))

        plan = self._plan_file_response(len(data), _content_type(target))
        if plan is None:
            return
        start, length = plan
        if not send_body or length == 0:
            return
        try:
            self.wfile.write(data[start:start + length])
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True

    def _plan_file_response(self, size: int, ctype: str) -> Optional[tuple[int, int]]:
        """Send status line + headers for one entity; ``(start, length)`` back.

        ``None`` means the Range was unsatisfiable and a 416 is already on the
        wire (``Content-Range: bytes */<size>``, empty body).
        """
        range_header = self.headers.get("Range")
        if range_header is not None:
            span = parse_range_header(range_header, size)
            if span is None:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self._common_headers()
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
            start, end = span
            status = HTTPStatus.PARTIAL_CONTENT
            length = end - start + 1
        else:
            start, end = 0, size - 1
            status = HTTPStatus.OK
            length = size

        self._start(status, ctype, length)
        self.send_header("Accept-Ranges", "bytes")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        return start, length

    # -- responses --------------------------------------------------------

    def _start(self, status, ctype: str, length: int) -> None:
        self.send_response(status)
        self._common_headers()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))

    def _common_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")

    def _fail(self, status, reason: str, send_body: bool) -> None:
        body = f"{reason}\n".encode("utf-8")
        self._start(status, "text/plain; charset=utf-8", len(body))
        self.end_headers()
        if send_body:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                self.close_connection = True


def _content_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in _CONTENT_TYPES:
        return _CONTENT_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


# ---------------------------------------------------------------------------
# lifecycle (§3.2) — module-level singleton, started eagerly by plugin_api
# ---------------------------------------------------------------------------


class MediaHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, vendor_root, log_requests: bool = False) -> None:
        # Set before super().__init__: the bind/activate in there can already
        # accept a request on another thread.
        self.vendor_root = Path(vendor_root)
        self.log_requests = log_requests
        super().__init__(address, MediaRequestHandler)


_server: Optional[MediaHTTPServer] = None
_thread: Optional[threading.Thread] = None
_origin: Optional[str] = None
_error: Optional[str] = None
_lock = threading.Lock()


def start_media_server(
    vendor_root: Optional[os.PathLike | str] = None,
    host: str = HOST,
    port: int = 0,
) -> Optional[MediaHTTPServer]:
    """Start (or return) the process-wide media server.

    Idempotent and thread-safe: the second caller gets the same instance and
    therefore the same port — that is what lets ``plugin_api.py`` call this at
    import time without caring whether something already did.

    Never raises: a listen failure is recorded in :func:`media_error` and the
    plugin degrades to "no media origin" instead of taking the gateway's import
    down with it.
    """
    global _server, _thread, _origin, _error
    with _lock:
        if _server is not None:
            return _server

        root = Path(vendor_root) if vendor_root is not None else DEFAULT_VENDOR_ROOT
        last_exc: Optional[BaseException] = None
        for attempt in range(START_RETRIES):
            try:
                srv = MediaHTTPServer((host, port), root)
            except OSError as exc:  # port taken, socket exhaustion, ...
                last_exc = exc
                if attempt + 1 < START_RETRIES:
                    time.sleep(0.05 * (attempt + 1))
                continue
            _server = srv
            _origin = f"http://{host}:{srv.server_address[1]}"
            _error = None
            _thread = threading.Thread(
                target=srv.serve_forever,
                name="we-media-server",
                daemon=True,
            )
            _thread.start()
            return srv

        _error = f"{type(last_exc).__name__}: {last_exc}"
        return None


def shutdown() -> None:
    """Stop the listener and forget it. Process exit is the normal path; this
    exists so tests (and a future ``dispose``) can close the port deterministically."""
    global _server, _thread, _origin
    with _lock:
        srv, thread = _server, _thread
        _server, _thread, _origin = None, None, None
    if srv is None:
        return
    srv.shutdown()
    srv.server_close()
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=5)


def server() -> Optional[MediaHTTPServer]:
    return _server


def media_origin() -> Optional[str]:
    return _origin


def media_port() -> Optional[int]:
    return _server.server_address[1] if _server is not None else None


def media_error() -> Optional[str]:
    return _error

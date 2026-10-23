"""MOD-001 §A — Wallpaper Engine discovery, library enumeration, ``WallpaperItem``.

Pure standard library (plus ``dashboard.media_server`` for token minting). No
FastAPI import: the router in ``plugin_api`` consumes :meth:`Scanner.scan`, so
this module is testable without a gateway.

Four discovery sources are merged and de-duplicated, each individually
disableable through :class:`SteamProbe` (that is how the tests run without a
real Steam registry key — see ``tests/test_scan.py``):

1. registry ``HKCU\\Software\\Valve\\Steam`` value ``SteamPath`` (``reg.exe``,
   5 s timeout, ``null`` anywhere it cannot be read);
2. env ``DSH_WE_STEAM_ROOT`` (comma/semicolon separated, quoted tolerated);
3. fixed candidates (:data:`DEFAULT_PROBE_DIRS`, DSH ``STEAM_PROBE_DIRS``);
4. WSL ``/mnt/<letter>`` DrvFS mounts (only when running on Linux).

Library roots, in DSH order (``locateWallpaperEngineP`` / ``owningLibrariesP``):

* ``<steam>/steamapps/libraryfolders.vdf`` — libraries whose ``apps`` block owns
  ``431960``; the Steam root hosting the vdf is itself a library when
  ``steamapps/common/wallpaper_engine`` exists there;
* install dir = first candidate holding ``wallpaper32.exe``;
* scan roots = ``<install>/projects/{defaultprojects,myprojects}`` +
  ``<library>/steamapps/workshop/content/431960`` + user ``extraLibraryRoots``.

Everything under the plugin's ``data/`` directory (and therefore
``data/uploads/``) is refused as a scan root *and* skipped during enumeration —
imports are not scanned back in (§5.1).

``kind`` follows design §5.1 strictly (``application → scene → web → video →
image → unknown``); see :func:`classify` for the decision table and the
deliberate deviations from DSH (``|| proj.file`` rescue, ``type:"image"``
normalisation to scene) which are documented there.

Acceptance anchors (design §12.1): T1 discovery, T2 scene-entry resolution,
T3 corrupt ``project.json`` (200 + ``errors``, never 500), T4 not installed.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence
from urllib.parse import quote

try:  # package import (plugin runtime: ``dashboard.scan``)
    from . import media_server
except ImportError:  # pragma: no cover - ``dashboard`` dir on sys.path directly
    import media_server  # type: ignore[no-redef]

WE_APPID = "431960"
ENGINE_EXE = "wallpaper32.exe"
STEAM_REG_KEY = "HKCU\\Software\\Valve\\Steam"
STEAM_REG_VALUE = "SteamPath"
STEAM_ROOT_ENV = "DSH_WE_STEAM_ROOT"

#: DSH ``STEAM_PROBE_DIRS`` (lib/index.js:180-186) — probed when no vdf exists.
DEFAULT_PROBE_DIRS: tuple[str, ...] = (
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
    "D:\\Steam",
    "D:\\SteamLibrary",
    "E:\\SteamLibrary",
)

#: Legacy standalone (non-Steam) install, DSH lib/index.js:348.
LEGACY_ENGINE_DIR = "C:\\Program Files (x86)\\Wallpaper Engine"

#: design §6.2: default hits the 30 s cache.
CACHE_TTL_S = 30.0
#: design §6.2: one scan is capped at 5 s, then the previous result is served.
SCAN_TIMEOUT_S = 5.0

VIDEO_EXTS = frozenset({".mp4", ".webm", ".mkv", ".avi", ".mov"})
IMAGE_EXTS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".gif"})
WEB_EXTS = frozenset({".html", ".htm"})
#: Only containers are accepted as a *scene* entry — a declared ``.mp4`` must
#: not be mistaken for a scene by the "declared" level of the resolution.
SCENE_EXTS = frozenset({".pkg", ".json"})

RATINGS = {"everyone": "everyone", "g": "everyone", "pg13": "pg13", "mature": "mature", "r": "mature"}


# ---------------------------------------------------------------------------
# small filesystem / path helpers
# ---------------------------------------------------------------------------


def _abspath(p: os.PathLike | str) -> str:
    return os.path.normpath(os.path.abspath(os.fspath(p)))


def _pathkey(p: os.PathLike | str) -> str:
    """Case-folded absolute path used for de-duplication (Windows semantics)."""
    return os.path.normcase(_abspath(p))


def _within(child: os.PathLike | str, root: os.PathLike | str, *, allow_equal: bool = True) -> bool:
    child_key = _pathkey(child)
    root_key = _pathkey(root)
    if child_key == root_key:
        return allow_equal
    return child_key.startswith(root_key.rstrip(os.sep) + os.sep)


def _is_file(p: os.PathLike | str) -> bool:
    try:
        return os.path.isfile(os.fspath(p))
    except OSError:
        return False


def _is_dir(p: os.PathLike | str) -> bool:
    try:
        return os.path.isdir(os.fspath(p))
    except OSError:
        return False


def _stat_or_none(p: os.PathLike | str) -> Optional[os.stat_result]:
    try:
        return os.stat(os.fspath(p))
    except OSError:
        return None


def _ext(rel: str) -> str:
    return os.path.splitext(rel)[1].lower()


def tree_key(p: os.PathLike | str) -> str:
    """Absolute path used for hashing / display (native separators, no symlink
    resolution so the value is stable across re-scans)."""
    return _abspath(p)


def _clean_root(raw: Any) -> Optional[str]:
    """Normalise one discovered root: strip quotes/space, translate ``C:\\`` on
    POSIX (WSL DrvFS), return ``None`` for junk."""
    if not isinstance(raw, str):
        return None
    value = raw.strip().strip("\"'").strip()
    if not value:
        return None
    if os.name != "nt":
        drive = re.match(r"^([A-Za-z]):[\\/](.*)$", value)
        if drive:
            return os.path.join("/mnt", drive.group(1).lower(), drive.group(2).replace("\\", "/"))
    return value


def _split_env_roots(raw: str) -> list[str]:
    return [chunk.strip().strip("\"'") for chunk in re.split(r"[,;]", raw or "") if chunk.strip()]


# ---------------------------------------------------------------------------
# source 1: registry
# ---------------------------------------------------------------------------


def _reg_exe() -> Optional[str]:
    """``reg.exe`` on Windows; on WSL ``/mnt/<letter>/Windows/System32/reg.exe``."""
    if os.name == "nt":
        return os.path.join(os.environ.get("SystemRoot", "C:\\Windows"), "System32", "reg.exe")
    if not sys.platform.startswith("linux"):
        return None
    try:
        letters = [n for n in os.listdir("/mnt") if re.fullmatch(r"[A-Za-z]", n)]
    except OSError:
        return None
    for letter in letters:
        candidate = os.path.join("/mnt", letter, "Windows", "System32", "reg.exe")
        if os.path.exists(candidate):
            return candidate
    return None


def read_registry_steam_path(*, timeout: float = 5.0) -> Optional[str]:
    """``HKCU\\Software\\Valve\\Steam\\SteamPath`` → normalised path, else ``None``.

    Async-equivalent of DSH ``steamPathFromRegistryP``: a 5 s hard timeout, and
    every failure mode (no reg.exe, non-zero exit, timeout, unparsable output)
    degrades to ``None`` so the other three sources still get their turn.
    """
    exe = _reg_exe()
    if not exe:
        return None
    kwargs: dict[str, Any] = {}
    if os.name == "nt":  # pragma: no cover - Windows only
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run(
            [exe, "query", STEAM_REG_KEY, "/v", STEAM_REG_VALUE],
            capture_output=True,
            timeout=timeout,
            text=True,
            encoding="utf-8",
            errors="replace",
            **kwargs,
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if proc.returncode != 0:
        return None
    match = re.search(r"SteamPath\s+REG_SZ\s+(.+)", proc.stdout or "", re.IGNORECASE)
    if not match:
        return None
    return _clean_root(match.group(1))


# ---------------------------------------------------------------------------
# source 4: WSL mounts
# ---------------------------------------------------------------------------


def wsl_steam_roots(mnt_root: str = "/mnt") -> list[str]:
    """Windows Steam installs visible through WSL DrvFS mounts."""
    if not sys.platform.startswith("linux"):
        return []
    try:
        letters = [n for n in os.listdir(mnt_root) if re.fullmatch(r"[A-Za-z]", n)]
    except OSError:
        return []
    found: list[str] = []
    for letter in letters:
        base = os.path.join(mnt_root, letter)
        for rel in (
            os.path.join("Program Files (x86)", "Steam"),
            os.path.join("Program Files", "Steam"),
            "Steam",
            "SteamLibrary",
        ):
            candidate = os.path.join(base, rel)
            if _is_file(os.path.join(candidate, "steamapps", "libraryfolders.vdf")):
                found.append(candidate)
    return found


# ---------------------------------------------------------------------------
# probe configuration (injectable — one knob per source)
# ---------------------------------------------------------------------------


@dataclass
class SteamProbe:
    """The four Steam discovery sources, each individually switchable.

    ``registry_reader=None`` / ``wsl_probe=None`` / ``probe_dirs=()`` /
    ``env={}`` disable that source; the tests use exactly that to keep the host
    machine out of the picture (this box has no Wallpaper Engine install).
    """

    registry_reader: Optional[Callable[[], Optional[str]]] = field(default=read_registry_steam_path)
    env: Optional[Mapping[str, str]] = None  # None → os.environ
    probe_dirs: Sequence[str] = DEFAULT_PROBE_DIRS
    wsl_probe: Optional[Callable[[], Iterable[str]]] = field(default=wsl_steam_roots)

    def registry_root(self) -> Optional[str]:
        if self.registry_reader is None:
            return None
        try:
            return _clean_root(self.registry_reader())
        except Exception:  # noqa: BLE001 - a probe must never break the scan
            return None

    def env_roots(self) -> list[str]:
        env = os.environ if self.env is None else self.env
        raw = env.get(STEAM_ROOT_ENV) or ""
        return [r for r in (_clean_root(x) for x in _split_env_roots(raw)) if r]

    def wsl_roots(self) -> list[str]:
        if self.wsl_probe is None:
            return []
        try:
            return [r for r in (_clean_root(x) for x in self.wsl_probe()) if r]
        except Exception:  # noqa: BLE001
            return []

    def fixed_roots(self) -> list[str]:
        return [r for r in (_clean_root(x) for x in (self.probe_dirs or ())) if r]

    def roots(self) -> list[str]:
        """Registry, env, fixed candidates, WSL mounts — merged, order kept, deduped."""
        merged: list[str] = []
        seen: set[str] = set()
        for raw in [self.registry_root(), *self.env_roots(), *self.fixed_roots(), *self.wsl_roots()]:
            if not raw:
                continue
            key = _pathkey(raw)
            if key in seen:
                continue
            seen.add(key)
            merged.append(raw)
        return merged


# ---------------------------------------------------------------------------
# libraryfolders.vdf
# ---------------------------------------------------------------------------

_VDF_PATH_RE = re.compile(r'^\s*"path"\s+"([^"]+)"\s*$')


def libraries_from_vdf(vdf_path: os.PathLike | str, steam_root: Optional[str] = None) -> list[str]:
    """Libraries listed in ``libraryfolders.vdf`` that own ``431960``.

    Mirrors DSH ``librariesFromVdfP`` (lib/index.js:319-333): a ``"path"`` entry
    opens a block, and the block only counts when a following line mentions the
    WE appid. Backslash escapes are unescaped. Deviation: a *relative* path is
    resolved against ``steam_root`` (DSH uses the raw string), which keeps
    fixture trees relocatable — real vdf files only ever carry absolute paths.
    """
    try:
        text = Path(vdf_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    found: list[str] = []
    current: Optional[str] = None
    for line in text.splitlines():
        match = _VDF_PATH_RE.match(line)
        if match:
            current = match.group(1).replace("\\\\", "\\")
            continue
        if current is not None and WE_APPID in line:
            resolved = current
            if not os.path.isabs(resolved) and steam_root:
                resolved = os.path.join(steam_root, resolved)
            resolved = _clean_root(resolved)
            if resolved:
                resolved = _abspath(resolved)
            if resolved and _pathkey(resolved) not in {_pathkey(x) for x in found}:
                found.append(resolved)
    return found


# ---------------------------------------------------------------------------
# project.json
# ---------------------------------------------------------------------------


class _ProjectError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _scheme_to_css(value: Any) -> Optional[str]:
    """WE ``schemecolor`` ("0.847 0.725 0.713", 0–1 floats) → CSS ``rgb()``."""
    if not isinstance(value, str):
        return None
    parts: list[float] = []
    for chunk in value.split():
        try:
            parts.append(float(chunk))
        except ValueError:
            return None
    if len(parts) < 3 or any(p != p for p in parts[:3]):  # NaN check
        return None
    rgb = [max(0, min(255, round(p * 255))) for p in parts[:3]]
    return f"rgb({rgb[0]}, {rgb[1]}, {rgb[2]})"


def _normalise_rating(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    return RATINGS.get(value.strip().lower())


def _raw_scheme_color(data: Mapping[str, Any]) -> Any:
    """``general.properties.schemecolor.value`` — WE's 0–1 float triple."""
    general = data.get("general")
    if not isinstance(general, Mapping):
        return None
    properties = general.get("properties")
    if not isinstance(properties, Mapping):
        return None
    spec = properties.get("schemecolor")
    if not isinstance(spec, Mapping):
        return None
    return spec.get("value")


def _props_defaults(data: Mapping[str, Any]) -> dict[str, Any]:
    """``general.properties[*].value`` — the project's default user properties."""
    general = data.get("general")
    if not isinstance(general, Mapping):
        return {}
    properties = general.get("properties")
    if not isinstance(properties, Mapping):
        return {}
    out: dict[str, Any] = {}
    for name, spec in properties.items():
        if isinstance(spec, Mapping):
            out[str(name)] = spec.get("value")
        else:
            out[str(name)] = spec
    return out


def _read_project(project_dir: Path) -> dict[str, Any]:
    """Parse ``<dir>/project.json``; raise :class:`_ProjectError` with a message
    the caller can put into ``errors[]``.

    Returns ``{}`` (no error) when the directory simply has no ``project.json``
    — that is not a wallpaper project, it is noise in a library root.
    """
    pj = project_dir / "project.json"
    if not pj.is_file():
        return {}
    try:
        text = pj.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError) as exc:
        raise _ProjectError(f"project.json 解析失败: {type(exc).__name__}: {exc}") from exc
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise _ProjectError(f"project.json 解析失败: {type(exc).__name__}: {exc}") from exc
    if not isinstance(data, dict):
        raise _ProjectError("project.json 解析失败: 顶层不是 JSON 对象")
    declared = data.get("file")
    if not isinstance(declared, str) or not declared.strip():
        dependency = data.get("dependency")
        if isinstance(dependency, str) and dependency.strip():
            # Wallpaper Engine "preset" submission: it has no file of its own —
            # it re-skins the wallpaper named by `dependency` (project.json then
            # carries only a `preset` block). Not playable standalone and NOT an
            # error: WE's own browser lists the base item, and so do we. Skipping
            # silently keeps errors[] for things the user can actually fix.
            return {"__preset__": True}
        # §5.1: 整条丢弃, no directory re-scan (DSH readProjectP:391 returns null).
        raise _ProjectError("project.json 缺少 file 字段，条目已丢弃")
    return data


# ---------------------------------------------------------------------------
# scene entry: the four-level resolution (§5.1, DSH resolveSceneMainFileP)
# ---------------------------------------------------------------------------


def resolve_scene_entry(project_dir: Path, declared: Optional[str]) -> Optional[str]:
    """``declared → scene.pkg → scene.json → the single *.pkg`` (relative to dir).

    Only ``.pkg``/``.json`` candidates count, so a declared ``index.html`` or
    ``wallpaper.mp4`` never masquerades as a scene container.

    Workshop items routinely declare ``scene.json`` while shipping only the
    packed ``scene.pkg`` (and loose projects the reverse) — hence the probe
    chain instead of trusting ``file``. ``None`` means "nothing on disk", and the
    caller degrades to ``scene`` + ``play=null`` (§5.1) instead of guessing.
    """
    if declared:
        rel = declared.strip().replace("\\", "/")
        if _ext(rel) in SCENE_EXTS and not rel.startswith("../") and _is_file(project_dir / rel):
            return rel
    for name in ("scene.pkg", "scene.json"):
        if _is_file(project_dir / name):
            return name
    try:
        entries = sorted(os.listdir(project_dir))
    except OSError:
        return None
    pkgs = [n for n in entries if n.lower().endswith(".pkg") and _is_file(project_dir / n)]
    return pkgs[0] if len(pkgs) == 1 else None


# ---------------------------------------------------------------------------
# kind classification (§5.1 order)
# ---------------------------------------------------------------------------


def classify(project_type: str, declared_rel: str, declared_exists: bool) -> tuple[str, Optional[str], Optional[str]]:
    """``(kind, entry, note)`` for one project.

    Decision table, applied top-down exactly in §5.1 order:

    =========== ==================================================== ================
    kind        condition                                            entry
    =========== ==================================================== ================
    application ``type == "application"`` (play stays null)          ``None``
    scene       ``type == "scene"`` (entry may be ``None`` → degrade) resolved rel
    web         ``type == "web"`` **and** entry is ``.html/.htm``      declared rel
    video       ``type == "video"``, or ext in :data:`VIDEO_EXTS`      ``None``
    image       ``type == "image"``, or ext in :data:`IMAGE_EXTS`      ``None``
    unknown     nothing matched (unplayable)                          ``None``
    =========== ==================================================== ================

    ``entry`` is only meaningful for directory-shaped wallpapers; for
    video/image §5.1 mandates ``entry = None`` (the entry file is in ``path``).
    """
    ptype = (project_type or "").strip().lower()
    ext = _ext(declared_rel)
    missing = None if declared_exists else f"入口文件缺失（{declared_rel}），play=null"

    if ptype == "application":
        return "application", None, None
    if ptype == "scene":
        return "scene", None, None  # entry resolved by the caller
    if ptype == "web" and ext in WEB_EXTS:
        # A missing entry does not demote a web project to unknown: it is still a
        # web wallpaper, just unplayable (play=null) and reported in errors[].
        return "web", declared_rel, (None if declared_exists else f"web 入口文件缺失（{declared_rel}），play=null")
    if ptype == "video":
        return "video", None, missing
    if ptype == "image":
        return "image", None, missing
    if ext in VIDEO_EXTS:
        return "video", None, missing
    if ext in IMAGE_EXTS:
        return "image", None, missing
    if ext in WEB_EXTS:
        return "web", declared_rel, (None if declared_exists else f"web 入口文件缺失（{declared_rel}），play=null")
    return "unknown", None, None


# ---------------------------------------------------------------------------
# id allocation: full sha256 + explicit collision detection
# ---------------------------------------------------------------------------


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def allocate_id(abs_path: str, taken: dict[str, str]) -> str:
    """``sha256(abs_path)`` as 64 hex chars, salted on collision.

    ``taken`` maps id → the path that owns it, so the same path re-scanning is
    not a collision (ids must be stable across re-scans, §5.1) while two
    *different* paths that somehow hash equal get ``sha256(path + "\\x00<n>")``.
    Allocation is deterministic: projects are visited in sorted order.
    """
    path = tree_key(abs_path)
    salt = 0
    while True:
        candidate = _sha256_hex(path if salt == 0 else f"{path}\x00{salt}")
        owner = taken.get(candidate)
        if owner is None:
            taken[candidate] = path
            return candidate
        if owner == path:  # same directory seen twice (duplicate scan root)
            return candidate
        salt += 1
        if salt > 1024:  # pragma: no cover - defensive, sha256 does not do this
            raise RuntimeError(f"无法为 {path} 分配唯一 id（连续 1024 次碰撞）")


# ---------------------------------------------------------------------------
# timeout helper (threads — Windows has no usable SIGALRM)
# ---------------------------------------------------------------------------


class ScanTimeout(Exception):
    """The 5 s budget expired before the scan finished."""


def call_with_timeout(fn: Callable[[], Any], timeout: Optional[float]):
    """Run ``fn`` in a daemon thread and give up after ``timeout`` seconds.

    ``signal.alarm``/``SIGALRM`` does not exist on Windows and even on POSIX it
    only works on the main thread (FastAPI runs this in a worker thread), so a
    joinable thread is the only portable option. The abandoned worker is a
    daemon: it finishes on its own and its result is discarded, which costs one
    wasted scan but never a hung request.
    """
    if timeout is None or timeout <= 0:
        return fn()
    box: dict[str, Any] = {}
    done = threading.Event()

    def runner() -> None:
        try:
            box["value"] = fn()
        except BaseException as exc:  # noqa: BLE001 - re-raised in the caller
            box["error"] = exc
        finally:
            done.set()

    thread = threading.Thread(target=runner, name="we-scan", daemon=True)
    thread.start()
    if not done.wait(timeout):
        raise ScanTimeout(f"{timeout:g}s")
    if "error" in box:
        raise box["error"]
    return box.get("value")


# ---------------------------------------------------------------------------
# scanner
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


@dataclass
class SourceRoot:
    path: Path
    source: str  # workshop | local


class Scanner:
    """Discover + enumerate + assemble ``WallpaperItem``, with §6.2 caching.

    One instance per plugin process. ``scan()`` returns the ``LibraryResponse``
    body verbatim (``engineFound`` / ``mediaOrigin`` / ``scannedAt`` / ``items``
    / ``errors``) so the router can hand it straight back.
    """

    def __init__(
        self,
        *,
        probe: Optional[SteamProbe] = None,
        data_dir: os.PathLike | str | None = None,
        clock: Callable[[], float] = time.monotonic,
        cache_ttl: float = CACHE_TTL_S,
        scan_timeout: float = SCAN_TIMEOUT_S,
        media_origin_provider: Optional[Callable[[], Optional[str]]] = None,
    ) -> None:
        self.probe = probe or SteamProbe()
        #: plugin ``data/`` (uploads included) — refused as a scan root.
        self.data_dir = _abspath(data_dir) if data_dir is not None else _abspath(
            Path(__file__).resolve().parent.parent / "data"
        )
        self._clock = clock
        self.cache_ttl = cache_ttl
        self.scan_timeout = scan_timeout
        self._media_origin = media_origin_provider or media_server.media_origin

        self._cache: Optional[dict[str, Any]] = None
        self._cache_at = 0.0
        self._cache_key: tuple[str, ...] = ()
        self._lock = threading.Lock()

        #: Last discovery's findings (see :meth:`discovery`), for ``GET /status``.
        self.install_dir: Optional[str] = None
        self.library_dirs: list[str] = []

    # -- discovery ---------------------------------------------------------

    def discovery(self) -> dict[str, Any]:
        """The three §6.1 fields a caller needs *without* enumerating projects.

        ``GET /status`` must answer before the first ``/library`` scan and must
        never wait on a 113-item walk, so discovery (probe roots → vdf →
        ``wallpaper32.exe`` existence) is separated from enumeration. The
        findings are also cached on the instance (``install_dir`` /
        ``library_dirs``) — that is the state ``/status`` reports between calls,
        and :meth:`_run_scan` reuses the very same computation, so the two can
        never disagree.

        The response payload of :meth:`scan` deliberately keeps its five §6.2
        keys (``engineFound``/``mediaOrigin``/``scannedAt``/``items``/``errors``);
        these two extra fields travel here instead of being smuggled into it,
        because ``/library``'s schema is frozen and ``/status`` is their only
        consumer.
        """
        steam_dirs = self.steam_dirs()
        libraries = self.libraries(steam_dirs)
        install_dir = self.locate_engine(steam_dirs, libraries)
        ownings = self.owning_libraries(steam_dirs)
        self.install_dir = install_dir
        self.library_dirs = list(ownings)
        return {
            "engineFound": install_dir is not None,
            "installDir": install_dir,
            "libraryDirs": list(ownings),
        }

    def steam_dirs(self) -> list[str]:
        return self.probe.roots()

    def libraries(self, steam_dirs: Sequence[str]) -> list[str]:
        """Libraries named by any probe's ``libraryfolders.vdf`` that own 431960."""
        found: list[str] = []
        seen: set[str] = set()
        for root in steam_dirs:
            vdf = os.path.join(root, "steamapps", "libraryfolders.vdf")
            if not _is_file(vdf):
                continue
            for lib in libraries_from_vdf(vdf, steam_root=root):
                key = _pathkey(lib)
                if key not in seen:
                    seen.add(key)
                    found.append(lib)
        return found

    def locate_engine(self, steam_dirs: Sequence[str], libraries: Sequence[str]) -> Optional[str]:
        """First candidate directory containing ``wallpaper32.exe``."""
        candidates: list[str] = []
        for root in [*steam_dirs, *libraries]:
            candidates.append(os.path.join(root, "steamapps", "common", "wallpaper_engine"))
        candidates.append(_clean_root(LEGACY_ENGINE_DIR) or LEGACY_ENGINE_DIR)
        seen: set[str] = set()
        for raw in candidates:
            key = _pathkey(raw)
            if key in seen:
                continue
            seen.add(key)
            if _is_file(os.path.join(raw, ENGINE_EXE)):
                return _abspath(raw)
        return None

    def owning_libraries(self, steam_dirs: Sequence[str]) -> list[str]:
        """Steam libraries that may hold workshop content for 431960.

        A vdf only lists *other* libraries, so the Steam root itself is added
        when the engine is installed under it — otherwise a default-library
        install silently loses every workshop wallpaper (DSH lib/index.js:368-373).
        """
        found: list[str] = []
        seen: set[str] = set()

        def add(path: str) -> None:
            key = _pathkey(path)
            if key not in seen:
                seen.add(key)
                found.append(_abspath(path))

        for root in steam_dirs:
            vdf = os.path.join(root, "steamapps", "libraryfolders.vdf")
            if _is_file(vdf):
                for lib in libraries_from_vdf(vdf, steam_root=root):
                    add(lib)
            if _is_dir(os.path.join(root, "steamapps", "common", "wallpaper_engine")):
                add(root)
        return found

    def _is_excluded(self, path: os.PathLike | str) -> bool:
        """``data/`` (hence ``data/uploads/``) never enters a scan (§5.1)."""
        return _within(path, self.data_dir)

    def project_roots(
        self,
        install_dir: Optional[str],
        libraries: Sequence[str],
        extra_library_roots: Sequence[str] = (),
    ) -> list[SourceRoot]:
        roots: list[SourceRoot] = []
        seen: set[str] = set()

        def add(path: os.PathLike | str, source: str) -> None:
            if self._is_excluded(path) or not _is_dir(path):
                return
            key = _pathkey(path)
            if key in seen:
                return
            seen.add(key)
            roots.append(SourceRoot(Path(_abspath(path)), source))

        if install_dir:
            for sub in ("defaultprojects", "myprojects"):
                add(os.path.join(install_dir, "projects", sub), "local")
        for lib in libraries:
            add(os.path.join(lib, "steamapps", "workshop", "content", WE_APPID), "workshop")
        for raw in extra_library_roots or ():
            cleaned = _clean_root(os.fspath(raw))
            if not cleaned:
                continue
            # A user-supplied root is accepted in both shapes: a Steam library
            # (``<root>/steamapps/workshop/content/431960``) or a directory that
            # directly holds project folders.
            add(os.path.join(cleaned, "steamapps", "workshop", "content", WE_APPID), "local")
            add(cleaned, "local")
        return roots

    # -- one wallpaper -----------------------------------------------------

    def _build_item(
        self,
        project_dir: Path,
        source: str,
        taken: dict[str, str],
    ) -> tuple[Optional[dict[str, Any]], list[dict[str, str]]]:
        errors: list[dict[str, str]] = []
        try:
            data = _read_project(project_dir)
        except _ProjectError as exc:
            errors.append({"path": str(project_dir / "project.json"), "message": exc.message})
            return None, errors
        if not data:
            return None, errors  # no project.json → not a project
        if data.get("__preset__"):
            return None, errors  # dependency-preset: not a standalone wallpaper

        declared = str(data["file"]).strip()
        rel = declared.replace("\\", "/")
        declared_abs = project_dir / rel
        if not _within(declared_abs, project_dir):
            errors.append(
                {
                    "path": str(project_dir / "project.json"),
                    "message": f"file 指向项目目录之外（{declared}），条目已丢弃",
                }
            )
            return None, errors

        ptype = data.get("type") if isinstance(data.get("type"), str) else ""
        kind, entry, note = classify(ptype, rel, _is_file(declared_abs))
        if note:
            errors.append({"path": str(project_dir / "project.json"), "message": note})

        # -- scene: four-level entry resolution (§5.1) ---------------------
        if kind == "scene":
            entry = resolve_scene_entry(project_dir, rel)
            if entry is None:
                # Deliberate: degrade to scene + play=null (§5.1), never to video.
                errors.append(
                    {
                        "path": str(project_dir / "project.json"),
                        "message": "场景入口解析失败（declared / scene.pkg / scene.json / 唯一 *.pkg 均未命中），play=null",
                    }
                )
        elif kind == "unknown":
            # No type and no recognised extension: a sole *.pkg may still make it
            # a scene (the extension is the only evidence left).
            entry = resolve_scene_entry(project_dir, rel)
            if entry is not None:
                kind = "scene"

        title = data.get("title")
        title = title.strip() if isinstance(title, str) and title.strip() else project_dir.name

        preview_abs: Optional[str] = None
        declared_preview = data.get("preview")
        if isinstance(declared_preview, str) and declared_preview.strip():
            candidate = project_dir / declared_preview.strip().replace("\\", "/")
            if _within(candidate, project_dir) and _is_file(candidate):
                preview_abs = _abspath(candidate)

        # -- play: relative to mediaOrigin, token from media_server --------
        play: Optional[dict[str, str]] = None
        if kind in ("video", "image"):
            path_abs: Optional[str] = _abspath(declared_abs)
            if _is_file(declared_abs):
                media_server.register_path(path_abs, kind="file")
                play = {"type": kind, "url": f"/m/{_token(path_abs)}"}
        elif kind in ("web", "scene"):
            dir_abs = _abspath(project_dir)
            # directory-shaped wallpaper: §5.1 keeps the file in ``entry``, so
            # ``path`` stays null (it is "文件型壁纸的入口文件" only).
            path_abs = _abspath(project_dir / entry) if entry else None
            if entry and _is_file(project_dir / entry):
                media_server.register_path(dir_abs, kind="dir", entry=entry)
                play = {"type": kind, "url": f"/s/{_token(dir_abs)}/{quote(entry, safe='/')}"}
        else:  # application / unknown — visible in the picker, not playable
            path_abs = _abspath(declared_abs)

        # -- size / mtime of the primary artifact --------------------------
        primary: Optional[Path] = Path(path_abs) if path_abs else None
        st = _stat_or_none(primary) if primary else None
        if st is None:
            st = _stat_or_none(project_dir / "project.json")

        item = {
            "id": allocate_id(project_dir, taken),
            "weId": project_dir.name or None,
            "kind": kind,
            "title": title,
            "source": source,
            "path": None if kind in ("web", "scene") else path_abs,
            "dir": _abspath(project_dir),
            "entry": entry,
            "preview": preview_abs,
            "rating": _normalise_rating(data.get("contentrating")),
            "sizeBytes": int(st.st_size) if st else 0,
            "mtimeMs": int(st.st_mtime * 1000) if st else 0,
            "props": _props_defaults(data),
            "schemeColor": _scheme_to_css(_raw_scheme_color(data)),
            "play": play,
        }
        return item, errors

    # -- full scan ---------------------------------------------------------

    def _run_scan(self, extra_library_roots: Sequence[str]) -> dict[str, Any]:
        found = self.discovery()  # also refreshes install_dir / library_dirs
        roots = self.project_roots(found["installDir"], found["libraryDirs"], extra_library_roots)

        items: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        taken: dict[str, str] = {}
        seen_dirs: set[str] = set()

        for root in roots:
            try:
                children = sorted(os.listdir(root.path))
            except OSError as exc:
                errors.append({"path": str(root.path), "message": f"目录不可读: {exc}"})
                continue
            for name in children:
                project_dir = root.path / name
                if not project_dir.is_dir() or self._is_excluded(project_dir):
                    continue
                key = _pathkey(project_dir)
                if key in seen_dirs:
                    continue
                seen_dirs.add(key)
                try:
                    item, item_errors = self._build_item(project_dir, root.source, taken)
                except Exception as exc:  # noqa: BLE001 - one bad item ≠ failed scan
                    errors.append({"path": str(project_dir), "message": f"处理失败: {type(exc).__name__}: {exc}"})
                    continue
                errors.extend(item_errors)
                if item is not None:
                    items.append(item)

        items.sort(key=lambda it: ((it.get("title") or "").lower(), it["id"]))
        return {
            "engineFound": found["engineFound"],
            "mediaOrigin": self._safe_media_origin(),
            "scannedAt": _now_iso(),
            "items": items,
            "errors": errors,
        }

    def _safe_media_origin(self) -> Optional[str]:
        try:
            return self._media_origin()
        except Exception:  # noqa: BLE001
            return None

    def scan(
        self,
        *,
        force: bool = False,
        now: Optional[float] = None,
        extra_library_roots: Optional[Sequence[str]] = None,
    ) -> dict[str, Any]:
        """``GET /library`` body. ``refresh=1`` → ``force=True``.

        Cache: 30 s TTL keyed on the extra-root set (a config change must not
        serve stale items). The clock is injectable so TTL expiry is testable
        without sleeping. Timeout: one scan gets :data:`SCAN_TIMEOUT_S`; on
        expiry the previous payload is returned with an extra ``errors`` entry
        (§6.2) — never a 500, never a fabricated empty list.
        """
        extra = [os.fspath(p) for p in (extra_library_roots or ()) if os.fspath(p).strip()]
        key = tuple(sorted(_pathkey(p) for p in extra))
        stamp = self._clock() if now is None else now

        with self._lock:
            if (
                not force
                and self._cache is not None
                and self._cache_key == key
                and (stamp - self._cache_at) < self.cache_ttl
            ):
                return _copy_payload(self._cache)

        try:
            payload = call_with_timeout(lambda: self._run_scan(extra), self.scan_timeout)
        except ScanTimeout as exc:
            with self._lock:
                last = self._cache if (self._cache is not None and self._cache_key == key) else None
            if last is None:
                return {
                    "engineFound": False,
                    "mediaOrigin": self._safe_media_origin(),
                    "scannedAt": _now_iso(),
                    "items": [],
                    "errors": [{"path": str(self.data_dir), "message": f"扫描超时（>{exc}），且无上次结果"}],
                }
            payload = _copy_payload(last)
            payload["errors"] = [*payload.get("errors", []), {"path": "<scan>", "message": f"扫描超时（>{exc}），返回上次结果"}]
            return payload

        with self._lock:
            self._cache = payload
            self._cache_at = stamp
            self._cache_key = key
        return _copy_payload(payload)

    def invalidate(self) -> None:
        with self._lock:
            self._cache = None
            self._cache_at = 0.0
            self._cache_key = ()


def _token(abs_path: str) -> str:
    """``base64url(absPath)`` — same table the media server serves from (§5.3)."""
    return media_server.token_for(abs_path)


def _copy_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Deep copy so a caller mutating the body cannot poison the cache."""
    return json.loads(json.dumps(payload))

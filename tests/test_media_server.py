"""T5 / T6 / T6b / T6e / T9 (+ T6c, T6d, lifecycle) — media server acceptance.

Everything here talks real HTTP over a real socket to a real
``ThreadingHTTPServer`` started on port 0: the path fence and the Range parser
are exactly the code that will serve 300 MB ``scene.pkg`` files, so mocking the
handler would test nothing that matters. ``http.client`` is used for the raw
cases because it puts the request target on the wire verbatim — a URL library
that "helpfully" resolves ``..`` would silently turn T6 into a 404 test.

The fixture tree is ``tests/fixtures/media-tree/``::

    media-tree/
      config.json          <- deliberately OUTSIDE the token root
      room/                <- the registered directory ("wallpaper")
        project.json
        scene.pkg          <- fake ASCII payload, only the bytes matter
        preview.jpg
        index.html
        sub/nested.txt

``scene.pkg`` is plain ASCII on purpose: it is a *fixture*, not a real package;
its extension is what drives Content-Type and its bytes are what Range slices.

Anchors (design §12.1):
  T5    ``Range: bytes=0-99`` -> 206 + ``Content-Range: bytes 0-99/<size>``;
        invalid Range -> 416.
  T6    ``/s/<token>/../../config.json`` -> 403.
  T6b   ``..%2f..%2f`` on both ``/s`` and ``/gl`` -> 403.
  T6e   symlink pointing out of the token root -> 403.
  T9    every response carries ``Access-Control-Allow-Origin: *``.

Run with:
  PYTHONDONTWRITEBYTECODE=1 python \
      -m pytest tests/test_media_server.py -v -p no:cacheprovider
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import socket
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

TESTS_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = TESTS_DIR.parent
FIXTURE_TREE = TESTS_DIR / "fixtures" / "media-tree"
ROOM = FIXTURE_TREE / "room"
OUTSIDE_CONFIG = FIXTURE_TREE / "config.json"
VENDOR = PLUGIN_ROOT / "vendor" / "webwallgl"

sys.path.insert(0, str(PLUGIN_ROOT))

from dashboard import media_server as ms  # noqa: E402


# ---------------------------------------------------------------------------
# harness
# ---------------------------------------------------------------------------


def raw_request(port: int, target: str, method: str = "GET", headers=None):
    """Verbatim request target, real socket. Returns (status, headers, body)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        conn.putrequest(method, target, skip_accept_encoding=True)
        for key, value in (headers or {}).items():
            conn.putheader(key, value)
        conn.endheaders()
        resp = conn.getresponse()
        body = resp.read()
        hdrs = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, hdrs, body
    finally:
        conn.close()


@pytest.fixture()
def media():
    """Fresh singleton per test: start on port 0, tear the listener down after."""
    ms.shutdown()
    ms.clear_tokens()
    srv = ms.start_media_server(port=0)
    assert srv is not None, ms.media_error()
    try:
        yield SimpleNamespace(
            srv=srv,
            port=ms.media_port(),
            origin=ms.media_origin(),
            request=lambda target, **kw: raw_request(ms.media_port(), target, **kw),
        )
    finally:
        ms.shutdown()
        ms.clear_tokens()


@pytest.fixture()
def room_token():
    """Token for the fixture wallpaper directory (kind=dir, entry=scene.pkg)."""
    assert ROOM.is_dir()
    return ms.register_path(ROOM, kind="dir", entry="scene.pkg")


def _size(path: Path) -> int:
    return path.stat().st_size


def _symlink_or_skip(link: Path, target: Path, is_dir: bool = False) -> None:
    try:
        os.symlink(target, link, target_is_directory=is_dir)
    except (OSError, NotImplementedError) as exc:  # WinError 1314 without Dev Mode
        pytest.skip(
            f"cannot create symlink on this host ({exc}); "
            "Windows requires Developer Mode or an elevated process. "
            "File-symlink case UNVERIFIED; the directory reparse-point escape "
            "(junction) still runs in test_t6e_*_dir_*"
        )


def _dir_reparse_point_or_skip(link: Path, target: Path) -> str:
    """Create a directory symlink, falling back to a junction.

    A junction is the same threat as a symlink (a reparse point that redirects a
    directory), it just does not need SeCreateSymbolicLinkPrivilege. Returns
    which mechanism was used so the assertion message stays honest.
    """
    try:
        os.symlink(target, link, target_is_directory=True)
        return "symlink"
    except (OSError, NotImplementedError):
        pass
    if os.name != "nt":
        pytest.skip("no directory link could be created on this host - T6e UNVERIFIED")
    cmd = (
        "New-Item -ItemType Junction -Path '{link}' -Target '{target}' | Out-Null".format(
            link=str(link), target=str(target)
        )
    )
    try:
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", cmd],
            check=True,
            capture_output=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        pytest.skip(
            f"neither symlink nor junction could be created here ({exc}) - T6e UNVERIFIED"
        )
    if not os.path.lexists(str(link)):
        pytest.skip("junction creation claimed success but no link exists - T6e UNVERIFIED")
    return "junction"


# ---------------------------------------------------------------------------
# T5 — Range
# ---------------------------------------------------------------------------


def test_t5_range_0_99_returns_206_with_content_range(media, room_token):
    data = (ROOM / "scene.pkg").read_bytes()
    size = len(data)
    assert size > 200, "fixture must be big enough to slice"

    status, hdrs, body = media.request(
        f"/s/{room_token}/scene.pkg", headers={"Range": "bytes=0-99"}
    )
    assert status == 206
    assert hdrs["content-range"] == f"bytes 0-99/{size}"
    assert hdrs["content-length"] == "100"
    assert body == data[:100]
    assert hdrs["accept-ranges"] == "bytes"


def test_t5_full_get_is_200_and_complete(media, room_token):
    data = (ROOM / "scene.pkg").read_bytes()
    status, hdrs, body = media.request(f"/s/{room_token}/scene.pkg")
    assert status == 200
    assert body == data
    assert hdrs["content-length"] == str(len(data))
    assert hdrs["content-type"] == "application/octet-stream"


@pytest.mark.parametrize(
    "range_value",
    [
        "bytes=abc",
        "bytes=5-1",          # start > end
        "bytes=-0",           # empty suffix
        "bytes=0-1,5-6",      # multi-range: unsupported by design
        "items=0-99",         # wrong unit: refuse rather than ignore
        "bytes",
    ],
)
def test_t5_invalid_range_returns_416(media, room_token, range_value):
    size = _size(ROOM / "scene.pkg")
    status, hdrs, body = media.request(
        f"/s/{room_token}/scene.pkg", headers={"Range": range_value}
    )
    assert status == 416, range_value
    assert hdrs["content-range"] == f"bytes */{size}"
    assert hdrs["content-length"] == "0"
    assert body == b""


def test_t5_range_past_eof_returns_416(media, room_token):
    size = _size(ROOM / "scene.pkg")
    status, hdrs, _ = media.request(
        f"/s/{room_token}/scene.pkg", headers={"Range": f"bytes={size}-"}
    )
    assert status == 416
    assert hdrs["content-range"] == f"bytes */{size}"


def test_t5_range_end_beyond_eof_is_clamped(media, room_token):
    data = (ROOM / "scene.pkg").read_bytes()
    size = len(data)
    status, hdrs, body = media.request(
        f"/s/{room_token}/scene.pkg", headers={"Range": f"bytes=0-{size * 4}"}
    )
    assert status == 206
    assert hdrs["content-range"] == f"bytes 0-{size - 1}/{size}"
    assert body == data


def test_t5_open_ended_and_suffix_ranges(media, room_token):
    data = (ROOM / "scene.pkg").read_bytes()
    size = len(data)

    status, hdrs, body = media.request(
        f"/s/{room_token}/scene.pkg", headers={"Range": "bytes=100-"}
    )
    assert status == 206
    assert hdrs["content-range"] == f"bytes 100-{size - 1}/{size}"
    assert body == data[100:]

    status, hdrs, body = media.request(
        f"/s/{room_token}/scene.pkg", headers={"Range": "bytes=-100"}
    )
    assert status == 206
    assert hdrs["content-range"] == f"bytes {size - 100}-{size - 1}/{size}"
    assert body == data[-100:]


# ---------------------------------------------------------------------------
# T6 / T6b — path escape
# ---------------------------------------------------------------------------


def test_t6_escape_dotdot_returns_403(media, room_token):
    assert OUTSIDE_CONFIG.is_file()
    status, hdrs, body = media.request(f"/s/{room_token}/../../config.json")
    assert status == 403
    assert b"secret" not in body, "must not leak the target file"
    assert hdrs["cache-control"] == "no-store"


def test_t6_escape_backslash_dotdot_returns_403(media, room_token):
    status, _, _ = media.request(f"/s/{room_token}/..\\..\\config.json")
    assert status == 403


@pytest.mark.parametrize(
    "rel",
    [
        "..%2f..%2fconfig.json",
        "%2e%2e%2f%2e%2e%2fconfig.json",
        "..%5c..%5cconfig.json",
        "sub%2f..%2f..%2fconfig.json",
    ],
)
def test_t6b_encoded_escape_s_returns_403(media, room_token, rel):
    status, hdrs, body = media.request(f"/s/{room_token}/{rel}")
    assert status == 403, rel
    assert b"secret" not in body
    assert hdrs["cache-control"] == "no-store"


@pytest.mark.parametrize(
    "rel",
    [
        "..%2f..%2fdashboard%2fplugin_api.py",
        "%2e%2e%2f%2e%2e%2fdashboard%2fplugin_api.py",
        "..%2f..%2fdashboard%2fmedia_server.py",
    ],
)
def test_t6b_encoded_escape_gl_returns_403(media, rel):
    # /gl and /s share safe_join; this is the /gl half of T6b.
    status, hdrs, _ = media.request(f"/gl/{rel}")
    assert status == 403, rel
    assert hdrs["cache-control"] == "no-store"


def test_t6b_nul_byte_and_absolute_path_rejected(media, room_token):
    status, _, _ = media.request(f"/s/{room_token}/%00.txt")
    assert status == 403
    # An absolute rel never reaches the filesystem: "/gl//etc/passwd" style is
    # normalised away by the leading-slash strip, so hit it at /s instead.
    status, _, _ = media.request(f"/s/{room_token}//C:%2fwindows%2fwin.ini")
    assert status == 403


# ---------------------------------------------------------------------------
# T6e — symlink
# ---------------------------------------------------------------------------


def test_t6e_symlink_file_outside_root_returns_403(media, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.pkg").write_bytes(b"outside-root secret payload")

    root = tmp_path / "root"
    root.mkdir()
    (root / "real.pkg").write_bytes(b"legit")
    link = root / "evil.pkg"
    _symlink_or_skip(link, outside / "secret.pkg")
    assert os.path.islink(link) and stat.S_ISLNK(os.lstat(link).st_mode)

    token = ms.register_path(root, kind="dir", entry="real.pkg")

    status, hdrs, body = media.request(f"/s/{token}/evil.pkg")
    assert status == 403
    assert b"secret" not in body
    assert hdrs["cache-control"] == "no-store"

    # the honest neighbour still works — the fence must not be a blanket deny
    status, _, body = media.request(f"/s/{token}/real.pkg")
    assert status == 200 and body == b"legit"


def test_t6e_symlink_dir_escape_returns_403(media, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("outside", encoding="utf-8")

    root = tmp_path / "root"
    root.mkdir()
    (root / "keep.txt").write_text("keep", encoding="utf-8")
    mechanism = _dir_reparse_point_or_skip(root / "linkdir", outside)

    token = ms.register_path(root, kind="dir", entry="keep.txt")
    status, _, body = media.request(f"/s/{token}/linkdir/secret.txt")
    assert status == 403, f"escape through a {mechanism} was not fenced"
    assert b"outside" not in body


@pytest.mark.skipif(os.name != "nt", reason="junction is a Windows reparse point")
def test_t6e_junction_is_fenced_by_realpath_not_lstat(media, tmp_path):
    """Which layer stops a junction matters: Python does not report junctions
    through ``S_ISLNK`` on Windows, so if realpath containment were missing the
    lstat check would happily serve the escape."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("outside", encoding="utf-8")

    root = tmp_path / "root"
    root.mkdir()
    (root / "keep.txt").write_text("keep", encoding="utf-8")
    linkdir = root / "linkdir"
    mechanism = _dir_reparse_point_or_skip(linkdir, outside)

    token = ms.register_path(root, kind="dir", entry="keep.txt")
    status, _, body = media.request(f"/s/{token}/linkdir/secret.txt")
    assert status == 403
    assert b"outside" not in body

    if mechanism == "junction":
        assert not stat.S_ISLNK(os.lstat(linkdir).st_mode), (
            "assumption changed: Python now flags junctions as links, so this test "
            "no longer isolates the realpath layer"
        )
        assert os.path.realpath(linkdir).lower() == str(outside).lower()


def test_t6e_symlink_inside_root_still_rejected(media, tmp_path):
    """A link that stays *inside* the root passes realpath but is still refused:
    the lstat layer is what makes "no symlinks" true, not the containment check."""
    root = tmp_path / "root"
    root.mkdir()
    (root / "real.txt").write_text("inside", encoding="utf-8")
    link = root / "alias.txt"
    _symlink_or_skip(link, root / "real.txt")

    token = ms.register_path(root, kind="dir", entry="real.txt")
    status, _, _ = media.request(f"/s/{token}/alias.txt")
    assert status == 403


# ---------------------------------------------------------------------------
# T9 — CORS + caching headers on every response
# ---------------------------------------------------------------------------


def test_t9_cors_and_no_store_on_all_responses(media, room_token):
    size = _size(ROOM / "scene.pkg")
    cases = [
        ("/health", {}, 200),
        ("/gl/host.html", {}, 200),
        (f"/s/{room_token}/scene.pkg", {}, 200),
        (f"/s/{room_token}/scene.pkg", {"Range": "bytes=0-99"}, 206),
        (f"/s/{room_token}/scene.pkg", {"Range": "bytes=abc"}, 416),
        (f"/s/{room_token}/../../config.json", {}, 403),
        (f"/s/{room_token}/missing.pkg", {}, 404),
        (f"/s/{room_token}/", {}, 200),  # entry fallback -> index.html
        ("/nope", {}, 404),
    ]
    for target, headers, expected in cases:
        status, hdrs, _ = media.request(target, headers=headers)
        assert status == expected, target
        assert hdrs["access-control-allow-origin"] == "*", target
        assert hdrs["cache-control"] == "no-store", target
    assert size > 0


def test_t9_cors_via_httpx(media):
    httpx = pytest.importorskip("httpx")
    resp = httpx.get(f"{media.origin}/health", timeout=10)
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "*"
    assert resp.headers["cache-control"] == "no-store"
    assert resp.json() == {"ok": True}


# ---------------------------------------------------------------------------
# /health, /gl static serving, HEAD
# ---------------------------------------------------------------------------


def test_health_returns_ok_json(media):
    status, hdrs, body = media.request("/health")
    assert status == 200
    assert hdrs["content-type"].startswith("application/json")
    assert body == b'{"ok":true}'
    assert ms.media_origin() == f"http://127.0.0.1:{media.port}"


def test_gl_serves_vendor_files(media):
    status, hdrs, body = media.request("/gl/host.html")
    assert status == 200
    assert hdrs["content-type"].startswith("text/html")
    assert b"<html" in body.lower()

    asset = next((VENDOR / "assets").glob("renderer-*.js"))
    status, hdrs, body = media.request(f"/gl/assets/{asset.name}")
    assert status == 200
    assert "javascript" in hdrs["content-type"]
    assert body == asset.read_bytes()

    # /gl/ with no rel falls back to the vendor entry page
    status, _, body = media.request("/gl/")
    assert status == 200 and body == (VENDOR / "index.html").read_bytes()

    status, _, _ = media.request("/gl/does-not-exist.js")
    assert status == 404


def test_s_serves_dir_token_and_nested_rel(media, room_token):
    data = (ROOM / "scene.pkg").read_bytes()
    status, _, body = media.request(f"/s/{room_token}/scene.pkg")
    assert status == 200 and body == data

    status, _, body = media.request(f"/s/{room_token}/sub/nested.txt")
    assert status == 200 and b"nested fixture" in body

    # empty rel serves the token's declared entry; re-declare it as the web page
    html_token = ms.register_path(ROOM, kind="dir", entry="index.html")
    assert html_token == room_token, "same path -> same token, only the entry changes"
    status, hdrs, body = media.request(f"/s/{room_token}/")
    assert status == 200
    assert hdrs["content-type"].startswith("text/html")
    assert b"fixture web wallpaper" in body


def test_s_file_token_serves_its_own_file(media):
    token = ms.register_path(ROOM / "scene.pkg", kind="file")
    status, _, body = media.request(f"/s/{token}/scene.pkg")
    assert status == 200 and body == (ROOM / "scene.pkg").read_bytes()
    status, _, body = media.request(f"/s/{token}/")
    assert status == 200 and body == (ROOM / "scene.pkg").read_bytes()

    # a file token is still a root for its parent dir, so a sibling is reachable;
    # anything leaving that dir is not
    status, _, body = media.request(f"/s/{token}/preview.jpg")
    assert status == 200 and b"fixture preview" in body
    status, _, _ = media.request(f"/s/{token}/../../config.json")
    assert status == 403


def test_head_has_headers_but_no_body(media, room_token):
    size = _size(ROOM / "scene.pkg")
    status, hdrs, body = media.request(f"/s/{room_token}/scene.pkg", method="HEAD")
    assert status == 200
    assert body == b""
    assert hdrs["content-length"] == str(size)
    assert hdrs["accept-ranges"] == "bytes"


# ---------------------------------------------------------------------------
# T6c (T1.4 owns it, kept here because the route already exists) / T6d
# ---------------------------------------------------------------------------


def test_t6c_deadtoken_returns_404_with_no_store(media):
    status, hdrs, body = media.request("/s/bm90LWEtcmVhbC10b2tlbg/scene.pkg")
    assert status == 404
    assert hdrs["cache-control"] == "no-store"
    assert hdrs["access-control-allow-origin"] == "*"
    assert b"secret" not in body


@pytest.mark.skipif(os.name != "nt", reason="case-insensitivity is a Windows behaviour")
def test_t6d_tokensem_token_is_unpadded_base64url_and_not_case_folded(media):
    path = str(ROOM / "scene.pkg")
    token = ms.register_path(path, kind="file")
    assert token == base64.urlsafe_b64encode(path.encode("utf-8")).decode("ascii").rstrip("=")
    assert "=" not in token

    loud = ms.register_path(path.upper(), kind="file")
    assert loud != token, "no case folding: two spellings -> two tokens"
    assert ms.lookup_token(token)["path"] == path
    assert ms.lookup_token(loud)["path"] == path.upper()
    # both resolve to the same bytes
    for tok in (token, loud):
        status, _, body = media.request(f"/s/{tok}/scene.pkg")
        assert status == 200 and body == (ROOM / "scene.pkg").read_bytes()


# ---------------------------------------------------------------------------
# lifecycle (§3.2)
# ---------------------------------------------------------------------------


def test_lifecycle_singleton_start_is_idempotent_and_shutdown_closes_port():
    ms.shutdown()
    ms.clear_tokens()
    srv1 = ms.start_media_server(port=0)
    assert srv1 is not None, ms.media_error()
    port = ms.media_port()

    srv2 = ms.start_media_server(port=0)
    assert srv2 is srv1, "second start must return the same instance"
    assert ms.media_port() == port, "second start must not move the port"
    assert srv2.daemon_threads is True
    assert ms.media_origin() == f"http://127.0.0.1:{port}"

    ms.shutdown()
    assert ms.server() is None
    assert ms.media_origin() is None
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", port), timeout=1).close()

    # a fresh start after shutdown is a new instance on a usable port
    srv3 = ms.start_media_server(port=0)
    assert srv3 is not None and srv3 is not srv1
    status, _, body = raw_request(ms.media_port(), "/health")
    assert status == 200 and body == b'{"ok":true}'
    ms.shutdown()


# --------------------------------------------------------------------------- #
# /diag — the vendor renderer's only error channel (CONTRACT §4.1)
# --------------------------------------------------------------------------- #


def test_diag_beacon_is_accepted_and_readable(media):
    status, headers, body = media.request("/diag?msg=scene%20tok:missing%20texture&lvl=error")
    assert status == 204, "the beacon is fire-and-forget: 204, no body"
    assert body == b""
    assert headers.get("cache-control") == "no-store"
    assert headers.get("access-control-allow-origin") == "*"

    status, headers, body = media.request("/diag/recent?limit=5")
    assert status == 200
    assert headers.get("content-type", "").startswith("application/json")
    payload = json.loads(body)
    assert payload["ok"] is True
    assert isinstance(payload["entries"], list)
    assert any(
        "missing texture" in entry["message"] and entry["level"] == "error"
        for entry in payload["entries"]
    ), "the beacon must survive into /diag/recent"


def test_diag_ring_is_bounded_and_unknown_levels_degrade_to_info(media):
    for index in range(60):
        status, _, _ = media.request(f"/diag?msg=probe-{index}&lvl=shout")
        assert status == 204

    status, _, body = media.request("/diag/recent?limit=200")
    assert status == 200
    entries = json.loads(body)["entries"]
    assert len(entries) == 50, "the ring is capped at 50"
    assert entries[-1]["message"] == "probe-59"
    assert entries[-1]["level"] == "info", "an unknown level must not reach the panel raw"


def test_diag_empty_message_is_not_recorded(media):
    before = len(json.loads(media.request("/diag/recent?limit=200")[2])["entries"])
    status, _, _ = media.request("/diag?msg=&lvl=error")
    assert status == 204
    after = len(json.loads(media.request("/diag/recent?limit=200")[2])["entries"])
    assert after == before, "an empty beacon must not consume a ring slot"

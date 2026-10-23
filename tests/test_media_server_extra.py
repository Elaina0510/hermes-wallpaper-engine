"""T1.4 — ``/m/<token>`` and §10.2 HTML injection (T5 parity, T6c, T6d, T7).

Everything goes over a real socket to a real ``ThreadingHTTPServer`` started on
port 0, and ``http.client`` puts the request target on the wire verbatim — a URL
library that resolves ``..`` or re-encodes a token would quietly turn an
acceptance test into a tautology. No handler is mocked anywhere in this file.

One primitive is faked, and only where the host refuses to provide it: Windows
needs ``SeCreateSymbolicLinkPrivilege`` (Developer Mode or elevation) to create
a file symlink, and this box does not have it (``WinError 1314``, verified).
``test_m_symlink_target_returns_403`` therefore skips honestly, and
``..._faked_lstat`` runs the same request through the real handler with only
``os.lstat`` reporting ``S_IFLNK`` — the decision under test is ours, the
syscall is the part we cannot have.

Fixture tree ``tests/fixtures/web-wallpaper/``::

    web-wallpaper/              <- registered as a dir token (weId = "web-wallpaper")
      project.json              <- general.properties: schemecolor / fps / title
      index.html                <- has <head>, author script after AUTHOR-SCRIPT-START
      headless.html             <- no doctype/html/head at all
      UPPER.HTM                 <- uppercase <HEAD>, .htm extension
      pre-injected.html         <- already carries the shim marker
      plain.txt                 <- non-HTML, big enough to slice with Range
      app.js / style.css        <- non-HTML, must come back byte-identical
      bare/index.html           <- a directory with no project.json

Anchors (§12.1):
  T5   Range semantics also hold on ``/m`` (206 + Content-Range, 416 otherwise).
  T6c  dead token -> 404 **with** ``Cache-Control: no-store``.
  T6d  ``token == base64url(abs_path)``, unpadded, no case folding: two
       spellings -> two tokens -> one resolved path.
  T7   an injected page contains the shim and ``__weSeedProps``, and the shim
       precedes every author script.

Run with:
  PYTHONDONTWRITEBYTECODE=1 python \\
      -m pytest tests/test_media_server_extra.py -v -p no:cacheprovider
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

TESTS_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = TESTS_DIR.parent
WEB_WALL = TESTS_DIR / "fixtures" / "web-wallpaper"
BARE = WEB_WALL / "bare"
VENDOR = PLUGIN_ROOT / "vendor" / "webwallgl"
SHIM_PATH = VENDOR / "web-shim.js"
SHIM = SHIM_PATH.read_bytes()

#: ``weId`` the seed script uses — ``scan.py`` sets it to the project dir name.
WE_ID = WEB_WALL.name

sys.path.insert(0, str(PLUGIN_ROOT))

from dashboard import config as cfg  # noqa: E402
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
    """Fresh singleton per test, seeded from an empty userProps (deterministic)."""
    ms.shutdown()
    ms.clear_tokens()
    ms.set_user_props_provider(lambda: {})
    srv = ms.start_media_server(port=0)
    assert srv is not None, ms.media_error()
    try:
        yield SimpleNamespace(
            port=ms.media_port(),
            request=lambda target, **kw: raw_request(ms.media_port(), target, **kw),
        )
    finally:
        ms.shutdown()
        ms.clear_tokens()
        ms.reset_user_props_provider()


@pytest.fixture()
def dir_token():
    """Token for the fixture project directory (kind=dir, entry=index.html)."""
    assert WEB_WALL.is_dir()
    return ms.register_path(WEB_WALL, kind="dir", entry="index.html")


@pytest.fixture()
def txt_token():
    return ms.register_path(WEB_WALL / "plain.txt", kind="file")


@pytest.fixture()
def html_token():
    return ms.register_path(WEB_WALL / "index.html", kind="file")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

_SEED_BLOCK_RE = re.compile(rb'<script data-we-inject="seed">(.*?)</script>', re.DOTALL)


def seed_props(body: bytes) -> dict:
    """Parse the props object out of the injected ``__weSeedProps`` call."""
    match = _SEED_BLOCK_RE.search(body)
    assert match is not None, "no seed script in the response"
    block = match.group(1)
    start = block.index(b"s({") + 2
    end = block.index(b"});}}catch") + 1
    return json.loads(block[start:end].decode("utf-8"))


def seed_block(body: bytes) -> bytes:
    match = _SEED_BLOCK_RE.search(body)
    assert match is not None, "no seed script in the response"
    return match.group(1)


def shim_offset(body: bytes) -> int:
    marker = b'data-we-inject="web-shim"'
    assert marker in body, "shim was not injected"
    return body.index(marker)


def _symlink_or_skip(link: Path, target: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=False)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(
            f"cannot create a file symlink on this host ({exc}); Windows needs "
            "Developer Mode or elevation. The symlink decision is still "
            "exercised by test_m_symlink_target_returns_403_faked_lstat"
        )


def _junction_or_skip(link: Path, target: Path) -> None:
    if os.name != "nt":
        pytest.skip("junction is a Windows reparse point")
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
        pytest.skip(f"no junction could be created here ({exc})")
    if not os.path.lexists(str(link)):
        pytest.skip("junction creation claimed success but no link exists")


# ---------------------------------------------------------------------------
# T6c — dead token: 404 + no-store
# ---------------------------------------------------------------------------


def test_t6c_unknown_token_returns_404_with_no_store(media):
    dead = ms.token_for("H:\\no-such-library\\no-such-wallpaper\\scene.pkg")
    assert ms.lookup_token(dead) is None

    status, hdrs, body = media.request(f"/m/{dead}")
    assert status == 404
    assert hdrs["cache-control"] == "no-store"
    assert hdrs["access-control-allow-origin"] == "*"
    assert hdrs["content-type"].startswith("text/plain")
    assert b"no-such-wallpaper" not in body, "404 body must not echo a filesystem path"


def test_t6c_head_on_dead_token_is_404_without_body(media):
    status, hdrs, body = media.request("/m/bm90LWEtcmVhbC10b2tlbg", method="HEAD")
    assert status == 404
    assert hdrs["cache-control"] == "no-store"
    assert body == b""


def test_t6c_token_for_deleted_file_returns_404_with_no_store(media, tmp_path):
    """§5.3: tokens are never cleaned up — a moved file must read as dead, not stale."""
    target = tmp_path / "moved-away.mp4"
    target.write_bytes(b"\x00" * 32)
    token = ms.register_path(target, kind="file")
    assert media.request(f"/m/{token}")[0] == 200

    target.unlink()
    status, hdrs, body = media.request(f"/m/{token}")
    assert status == 404
    assert hdrs["cache-control"] == "no-store"
    assert body == b"not-found\n"


def test_t6c_token_for_a_path_that_never_existed_returns_404(media, tmp_path):
    token = ms.register_path(tmp_path / "never" / "there.mp4", kind="file")
    status, hdrs, body = media.request(f"/m/{token}")
    assert status == 404
    assert hdrs["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# T6d — token semantics: base64url(abs_path), unpadded, no case folding
# ---------------------------------------------------------------------------


def test_t6d_token_is_unpadded_base64url_of_the_absolute_path(media):
    path = str(WEB_WALL / "plain.txt")
    token = ms.register_path(path, kind="file")
    expected = base64.urlsafe_b64encode(path.encode("utf-8")).decode("ascii").rstrip("=")
    assert token == expected
    assert "=" not in token
    assert "/" not in token and "+" not in token, "must be url-safe, not standard base64"
    # decoding the token really gives the path back (byte-for-byte injective)
    padded = token + "=" * (-len(token) % 4)
    assert base64.urlsafe_b64decode(padded).decode("utf-8") == path


@pytest.mark.skipif(os.name != "nt", reason="case-insensitive paths are a Windows behaviour")
def test_t6d_case_spellings_yield_two_tokens_that_resolve_to_one_path(media):
    lower = str(WEB_WALL / "plain.txt")
    upper = lower.upper()
    assert lower != upper

    token_lower = ms.register_path(lower, kind="file")
    token_upper = ms.register_path(upper, kind="file")
    assert token_lower != token_upper, "no case folding: two spellings -> two tokens"
    assert ms.lookup_token(token_lower)["path"] == lower
    assert ms.lookup_token(token_upper)["path"] == upper

    resolved = [
        ms.resolve_single_file(ms.lookup_token(tok)["path"])
        for tok in (token_lower, token_upper)
    ]
    assert resolved[0] == resolved[1], "both spellings must resolve to one real path"

    expected = (WEB_WALL / "plain.txt").read_bytes()
    for tok in (token_lower, token_upper):
        status, _, body = media.request(f"/m/{tok}")
        assert status == 200
        assert body == expected


# ---------------------------------------------------------------------------
# T5 on /m — same Range parser, same 206/416 answers
# ---------------------------------------------------------------------------


def test_m_full_get_returns_the_file_bytes(media, txt_token):
    data = (WEB_WALL / "plain.txt").read_bytes()
    status, hdrs, body = media.request(f"/m/{txt_token}")
    assert status == 200
    assert body == data
    assert hdrs["content-length"] == str(len(data))
    assert hdrs["content-type"] == "text/plain; charset=utf-8"
    assert hdrs["accept-ranges"] == "bytes"
    assert hdrs["cache-control"] == "no-store"
    assert hdrs["access-control-allow-origin"] == "*"


def test_m_range_0_99_returns_206_with_content_range(media, txt_token):
    data = (WEB_WALL / "plain.txt").read_bytes()
    size = len(data)
    assert size > 200, "fixture must be big enough to slice"

    status, hdrs, body = media.request(f"/m/{txt_token}", headers={"Range": "bytes=0-99"})
    assert status == 206
    assert hdrs["content-range"] == f"bytes 0-99/{size}"
    assert hdrs["content-length"] == "100"
    assert body == data[:100]
    assert hdrs["accept-ranges"] == "bytes"


def test_m_range_open_ended_and_suffix(media, txt_token):
    data = (WEB_WALL / "plain.txt").read_bytes()
    size = len(data)

    status, hdrs, body = media.request(f"/m/{txt_token}", headers={"Range": "bytes=100-"})
    assert status == 206
    assert hdrs["content-range"] == f"bytes 100-{size - 1}/{size}"
    assert body == data[100:]

    status, hdrs, body = media.request(f"/m/{txt_token}", headers={"Range": "bytes=-50"})
    assert status == 206
    assert hdrs["content-range"] == f"bytes {size - 50}-{size - 1}/{size}"
    assert body == data[-50:]


@pytest.mark.parametrize(
    "range_value",
    [
        "bytes=abc",
        "bytes=5-1",       # start > end
        "bytes=-0",        # empty suffix
        "bytes=0-1,5-6",   # multi-range: unsupported by design
        "items=0-99",      # wrong unit: refuse rather than ignore
        "bytes",
    ],
)
def test_m_invalid_range_returns_416(media, txt_token, range_value):
    size = len((WEB_WALL / "plain.txt").read_bytes())
    status, hdrs, body = media.request(f"/m/{txt_token}", headers={"Range": range_value})
    assert status == 416, range_value
    assert hdrs["content-range"] == f"bytes */{size}"
    assert hdrs["content-length"] == "0"
    assert body == b""


def test_m_head_has_headers_but_no_body(media, txt_token):
    size = len((WEB_WALL / "plain.txt").read_bytes())
    status, hdrs, body = media.request(f"/m/{txt_token}", method="HEAD")
    assert status == 200
    assert body == b""
    assert hdrs["content-length"] == str(size)
    assert hdrs["accept-ranges"] == "bytes"


# ---------------------------------------------------------------------------
# /m routing edges
# ---------------------------------------------------------------------------


def test_m_directory_token_returns_404(media, dir_token):
    """``/m`` is single-file: a directory token has no file to serve."""
    status, hdrs, body = media.request(f"/m/{dir_token}")
    assert status == 404
    assert hdrs["cache-control"] == "no-store"


def test_m_extra_path_segment_returns_404(media, txt_token):
    """No ``rel`` on ``/m`` — a second segment is not a path, it is not routed."""
    status, hdrs, body = media.request(f"/m/{txt_token}/plain.txt")
    assert status == 404
    assert hdrs["cache-control"] == "no-store"


def test_m_empty_token_returns_404(media):
    for target in ("/m/", "/m"):
        status, hdrs, _ = media.request(target)
        assert status == 404, target
        assert hdrs["cache-control"] == "no-store"


# ---------------------------------------------------------------------------
# /m symlink policy (parity with /s: a link is 403, not 404)
# ---------------------------------------------------------------------------


def test_m_symlink_target_returns_403(media, tmp_path):
    secret = tmp_path / "outside-secret.txt"
    secret.write_bytes(b"outside-secret-payload")
    link = tmp_path / "link.txt"
    _symlink_or_skip(link, secret)

    token = ms.register_path(link, kind="file")
    status, hdrs, body = media.request(f"/m/{token}")
    assert status == 403
    assert hdrs["cache-control"] == "no-store"
    assert b"outside-secret-payload" not in body


def test_m_symlink_target_returns_403_faked_lstat(media, tmp_path, monkeypatch):
    """Same request, real handler, ``os.lstat`` faked to report a link.

    ``WinError 1314`` means this host cannot mint a real symlink; the check we
    are testing (``stat.S_ISLNK`` -> :class:`ForbiddenPath`) is ours, so only
    the primitive is replaced. Real symlink coverage: the test above, skipped.
    """
    secret = tmp_path / "outside-secret.txt"
    secret.write_bytes(b"outside-secret-payload")
    token = ms.register_path(secret, kind="file")
    assert media.request(f"/m/{token}")[0] == 200

    real_lstat = os.lstat
    victim = os.path.normcase(str(secret))

    def fake_lstat(path, *args, **kwargs):
        st = real_lstat(path, *args, **kwargs)
        if os.path.normcase(os.fspath(path)) == victim:
            mode = (st.st_mode & ~0o170000) | stat.S_IFLNK
            return os.stat_result(
                (mode, st.st_ino, st.st_dev, st.st_nlink, st.st_uid, st.st_gid,
                 st.st_size, st.st_atime, st.st_mtime, st.st_ctime)
            )
        return st

    monkeypatch.setattr(os, "lstat", fake_lstat)
    status, hdrs, body = media.request(f"/m/{token}")
    assert status == 403
    assert hdrs["cache-control"] == "no-store"
    assert b"outside-secret-payload" not in body


def test_m_junction_above_final_component_is_served_documented_no_root_fence(media, tmp_path):
    """§5.3: ``/m`` has no root, so there is no fence to violate.

    A junction *above* the final component is invisible to a single-file
    capability URL — the token was minted for exactly that path, and whoever
    minted it owns both sides of the link. ``/s`` refuses it (``safe_join``
    walks components and compares realpaths); ``/m`` serves it. That asymmetry
    is the design, not an oversight: adding a root here would break
    ``extraLibraryRoots`` and still would not fence anything steered by a
    caller. A junction *as* the final component is a directory, so ``/m`` 404s.
    """
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_bytes(b"through-the-junction")

    link = tmp_path / "junction"
    _junction_or_skip(link, outside)

    through = ms.register_path(link / "secret.txt", kind="file")
    status, hdrs, body = media.request(f"/m/{through}")
    assert status == 200
    assert body == b"through-the-junction"

    as_dir = ms.register_path(link, kind="dir")
    status, _, _ = media.request(f"/m/{as_dir}")
    assert status == 404, "a junction is a directory: /m serves files only"


# ---------------------------------------------------------------------------
# T7 — HTML injection: shim first, then the seed, both before author scripts
# ---------------------------------------------------------------------------


def test_t7_s_dir_token_index_html_gets_shim_and_seed(media, dir_token):
    status, hdrs, body = media.request(f"/s/{dir_token}/index.html")
    assert status == 200
    assert hdrs["content-type"] == "text/html; charset=utf-8"

    assert b"web-shim" in body
    assert b"__weSeedProps" in body
    assert SHIM in body, "the vendored shim must be inlined verbatim"

    shim_at = shim_offset(body)
    seed_at = body.index(b'data-we-inject="seed"')
    author_at = body.index(b"AUTHOR-SCRIPT-START")
    author_src = body.index(b'<script src="app.js"')

    # §10.2: first segment of <head>
    assert body.index(b"<head>") < shim_at < body.index(b"</head>")
    # ... and therefore before every author script
    assert shim_at < seed_at < author_at < author_src

    # the site root is declared before the shim (the shim reads it at install)
    assert body.index(b"__weSiteRoot") < shim_at
    assert f'"/s/{dir_token}/"'.encode() in body

    # author bytes survive
    assert b"AUTHOR-BODY-MARKER" in body


def test_t7_m_file_token_html_is_injected_too(media, html_token):
    status, hdrs, body = media.request(f"/m/{html_token}")
    assert status == 200
    assert hdrs["content-type"] == "text/html; charset=utf-8"
    assert SHIM in body
    assert b"__weSeedProps" in body

    shim_at = shim_offset(body)
    assert body.index(b"<head>") < shim_at < body.index(b"</head>")
    assert shim_at < body.index(b"AUTHOR-SCRIPT-START")
    # /m names one file, so there is no site root to declare (the shim's own
    # comments mention __weSiteRoot, so assert on the injected block, not the word)
    assert b'data-we-inject="site-root"' not in body


def test_t7_uppercase_head_and_htm_extension(media):
    token = ms.register_path(WEB_WALL / "UPPER.HTM", kind="file")
    status, hdrs, body = media.request(f"/m/{token}")
    assert status == 200
    assert hdrs["content-type"] == "text/html; charset=utf-8"

    shim_at = shim_offset(body)
    assert body.index(b"<HEAD>") < shim_at < body.index(b"</HEAD>")
    assert shim_at < body.index(b"AUTHOR-SCRIPT-START")


def test_t7_page_without_head_still_gets_the_shim_first(media):
    token = ms.register_path(WEB_WALL / "headless.html", kind="file")
    status, _, body = media.request(f"/m/{token}")
    assert status == 200
    assert body.startswith(b'<script data-we-inject="web-shim">')
    assert shim_offset(body) < body.index(b"AUTHOR-SCRIPT-START")
    assert SHIM in body


def test_t7_already_injected_page_is_not_injected_twice(media):
    source = (WEB_WALL / "pre-injected.html").read_bytes()
    token = ms.register_path(WEB_WALL / "pre-injected.html", kind="file")
    status, _, body = media.request(f"/m/{token}")
    assert status == 200
    assert body == source, "a page carrying the marker must be served untouched"
    assert body.count(b'data-we-inject="web-shim"') == 1
    assert SHIM not in body


@pytest.mark.parametrize("name", ["app.js", "style.css", "project.json", "plain.txt"])
def test_t7_non_html_is_byte_identical(media, dir_token, name):
    raw = (WEB_WALL / name).read_bytes()
    status, hdrs, body = media.request(f"/s/{dir_token}/{name}")
    assert status == 200
    assert body == raw
    assert b'data-we-inject="web-shim"' not in body
    assert hdrs["content-length"] == str(len(raw))


def test_t7_gl_host_html_is_not_injected(media):
    """/gl serves the renderer page (the shim's parent) — it must stay untouched."""
    status, _, body = media.request("/gl/host.html")
    assert status == 200
    assert body == (VENDOR / "host.html").read_bytes()
    assert b'data-we-inject="web-shim"' not in body
    assert b"__weSeedProps" not in body


def test_t7_range_on_injected_html_uses_the_injected_size(media, dir_token):
    _, _, full = media.request(f"/s/{dir_token}/index.html")
    on_disk = (WEB_WALL / "index.html").read_bytes()
    assert len(full) > len(on_disk), "injection must actually add bytes"

    status, hdrs, part = media.request(
        f"/s/{dir_token}/index.html", headers={"Range": "bytes=0-9"}
    )
    assert status == 206
    assert hdrs["content-range"] == f"bytes 0-9/{len(full)}"
    assert part == full[:10]

    status, hdrs, _ = media.request(
        f"/s/{dir_token}/index.html", headers={"Range": f"bytes={len(full)}-"}
    )
    assert status == 416
    assert hdrs["content-range"] == f"bytes */{len(full)}"


def test_t7_head_html_reports_injected_length_without_body(media, dir_token):
    _, _, full = media.request(f"/s/{dir_token}/index.html")
    status, hdrs, body = media.request(f"/s/{dir_token}/index.html", method="HEAD")
    assert status == 200
    assert body == b""
    assert hdrs["content-length"] == str(len(full))


# ---------------------------------------------------------------------------
# seed script — project.json defaults + config.userProps[weId] overrides (§10.2)
# ---------------------------------------------------------------------------


def test_seed_defaults_come_from_project_json(media, dir_token):
    status, _, body = media.request(f"/s/{dir_token}/index.html")
    assert status == 200
    assert seed_props(body) == {
        "schemecolor": "0.1 0.2 0.3",
        "fps": "30",
        "title": "default-title",
    }


def test_seed_props_are_ascii_only_so_any_page_charset_survives(media, dir_token):
    ms.set_user_props_provider(lambda: {WE_ID: {"title": "封面标题"}})
    status, _, body = media.request(f"/s/{dir_token}/index.html")
    assert status == 200
    assert seed_props(body)["title"] == "封面标题"
    assert seed_block(body).decode("ascii")  # never a bare UTF-8 byte


def test_seed_userprops_override_project_defaults_via_provider(media, dir_token):
    ms.set_user_props_provider(lambda: {WE_ID: {"fps": "144", "title": "user-title"}})
    status, _, body = media.request(f"/s/{dir_token}/index.html")
    assert status == 200
    props = seed_props(body)
    assert props["fps"] == "144", "userProps must win over project.json"
    assert props["title"] == "user-title"
    assert props["schemecolor"] == "0.1 0.2 0.3", "untouched defaults survive"


def test_seed_userprops_override_reads_the_real_config_store(media, dir_token, tmp_path):
    """No hook: the production path really goes through ``dashboard/config.py``.

    ``userProps`` is ``settings.userProps`` in the ConfigDoc (§6.3 nests
    ``rotation``/``userProps`` one level down under ``settings``), so the patch
    goes through ``apply_patch`` exactly like ``PUT /config`` would.
    """
    previous = cfg.get_store()
    store = cfg.ConfigStore(tmp_path / "config.json")
    store.apply_patch({"settings": {"userProps": {WE_ID: {"fps": "60"}}}})
    assert store.get()["settings"]["userProps"][WE_ID]["fps"] == "60"
    cfg.set_store(store)
    ms.set_user_props_provider(None)  # drop the test hook: use the module default
    try:
        status, _, body = media.request(f"/s/{dir_token}/index.html")
    finally:
        cfg.set_store(previous)

    assert status == 200
    props = seed_props(body)
    assert props["fps"] == "60"
    assert props["title"] == "default-title"


def test_seed_is_empty_object_when_project_json_is_missing(media):
    token = ms.register_path(BARE, kind="dir", entry="index.html")
    status, _, body = media.request(f"/s/{token}/index.html")
    assert status == 200
    assert b"__weSeedProps" in body
    assert seed_props(body) == {}


def test_seed_cannot_break_out_of_its_script_tag(media, dir_token):
    evil = "</script><script>alert(1)</script>"
    ms.set_user_props_provider(lambda: {WE_ID: {"title": evil}})
    status, _, body = media.request(f"/s/{dir_token}/index.html")
    assert status == 200
    assert b"</script><script>alert(1)" not in body
    assert seed_props(body)["title"] == evil, "value round-trips unchanged"


def test_seed_works_without_a_config_module(tmp_path, monkeypatch):
    """A missing/broken config must degrade to project defaults, not 500."""
    monkeypatch.setattr(ms, "_config_module", lambda: None)
    ms.reset_user_props_provider()
    assert ms.seed_props_for(WEB_WALL) == {
        "schemecolor": "0.1 0.2 0.3",
        "fps": "30",
        "title": "default-title",
    }

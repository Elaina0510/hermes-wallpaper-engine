"""T0.3 / MOD-008 — host-page bridge (scene half), acceptance T16 / T16b / T16c.

What is under test
------------------
1. ``tests/harness/bridge.js`` — the origin gate, heartbeat counter, error/timeout
   fallback and sceneLive bookkeeping, as pure logic (node --test, no DOM).
2. The same module inside a real page: ``tests/harness.html`` mounts a WebWallGL
   render page in an iframe and reports bridge state + renderer probe results.
3. The renderer itself, observed through the media server's request log and the
   renderer's own diagnostic beacon (``GET /diag?msg=…&lvl=…``).

Topology of a run
-----------------
    harness static server (origin A)  -> tests/harness.html
    media server          (origin M)  -> /gl/host.html (vendor) + /s/<token>/…
    attacker server       (origin B)  -> tests/harness/attacker.html

Three browser runs, each in its own Vivaldi instance (isolated profile):

* ``same_min``   page served by the media server (origin M) with the synthetic
                 minimal scene.pkg. Same-origin is the only way to read the
                 renderer's ``window.__wp`` / ``capture()``, so the pixel evidence
                 lives here. No sender, no attacker — this is also the run that
                 records how many ``we-frame`` messages the vendor page sends.
* ``cross_attack`` page on origin A, a trusted sender on origin M (genuine
                 ``we-frame`` bytes) and a foreign attacker on origin B (identical
                 payload bytes). This is T16b, two-sided.
* ``same_junk``  page on origin M pointed at the 997-byte fake ``scene.pkg`` from
                 the T0.2 fixtures: the renderer's *failure* path, with the exact
                 error it reports.

Contract observations that shaped these tests (all reproduced from the vendor
bundle, not assumed — see CONTRACT.md §1 for the documented values):

1. The render page does **not** post ``{op:"we-frame"}`` to its parent for a scene.
   The only two ``parent.postMessage({op:"we-frame"})`` sites in
   ``renderer-DTLW1Gf0.js`` (offsets 962871 / 964596, source lines 3073 / 3118)
   sit inside the embedded ``N_`` shim template (``const N_=``` at offset 904959,
   closing backtick at 967429) — that shim is injected into *web wallpaper*
   iframes, so the messages travel iframe -> render page, never render page ->
   plugin host. A scene host therefore receives zero heartbeats.
2. ``type`` must be ``scene``: the dispatch ``Xa()`` (offset 920010) is
   ``(video|gif|image)&&src ? ES : scene&&(source||src) ? v_ : web&&src ? hP :
   onUnhandledType(e)``, and ``Te.onUnhandledType = t => t.type==="canvas" ? pP(Te)
   : Bg(Te)`` — ``canvas`` (the documented default) renders the built-in animated
   "WE WALLPAPER · DESKTOP TEST" card instead of a scene.
3. ``src`` is a *base* and the loader appends candidates itself:
   ``const y = e.source ?? DS(`${e.mediaBase}/${e.src}`)`` with
   ``NS = ["scene.pkg","scenes/scene.pkg","gifscene.pkg"]``. So ``src`` is a
   relative token path (``/s/<token>``) and ``mediaBase`` the media origin.
4. The renderer's error/`{op:"error"}` path is a *diagnostic beacon*, not a
   postMessage: ``le()`` fires ``new Image().src = `${origin(mediaBase)}/diag?msg=…```.
   The media server logs that 404, which is how the tests read the renderer's own
   error text.

T16c honesty
------------
No real scene wallpaper exists on this machine (see
``test_T16c_real_scene_pkg_unavailable``). The synthetic package gets the renderer
all the way to a live WebGL2 canvas, but with no layers: the pixels are the uniform
clear colour. That meets the anchor's literal second clause
(``getContext('webgl2')`` + ``drawingBufferWidth > 0``) and is reported as such,
with ``uniformFill`` recorded so nobody can mistake it for scene content.
"""

from __future__ import annotations

import contextlib
import functools
import io
import json
import re
import shutil
import socket
import subprocess
import sys
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = PLUGIN_ROOT / "tests"
HARNESS_DIR = TESTS_DIR / "harness"
FIXTURES = TESTS_DIR / "fixtures"
VENDOR_ROOT = PLUGIN_ROOT / "vendor" / "webwallgl"
DRIVER = HARNESS_DIR / "cdp_driver.mjs"
BRIDGE_SPEC = HARNESS_DIR / "bridge.spec.mjs"

CHROME_CANDIDATES = [
    Path(r"H:/application/vivaldi/Application/vivaldi.exe"),
    Path(r"C:/Program Files/Vivaldi/Application/vivaldi.exe"),
    Path(r"C:/Program Files (x86)/Vivaldi/Application/vivaldi.exe"),
]

NODE = shutil.which("node")

# Attacker cadence: 12 rounds x 3 forged messages.
ATTACK_ROUNDS = 12
ATTACK_MESSAGES_PER_ROUND = 3

sys.path.insert(0, str(PLUGIN_ROOT))
sys.path.insert(0, str(FIXTURES / "scene_pkg"))

from dashboard import media_server as ms  # noqa: E402

import build_min_scene_pkg  # noqa: E402  (tests/fixtures/scene_pkg/)


# ---------------------------------------------------------------------------
# infrastructure
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _QuietStaticServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):  # noqa: D401 - quiet
        """Connections dropped by a killed browser are normal here."""


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: A003 - silence
        pass


def _serve(directory: Path, port: int = 0) -> ThreadingHTTPServer:
    handler = functools.partial(_QuietHandler, directory=str(directory))
    srv = _QuietStaticServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True, name=f"static-{port}").start()
    return srv


def _chrome() -> Path:
    for candidate in CHROME_CANDIDATES:
        if candidate.is_file():
            return candidate
    pytest.skip("no Chromium-family browser found (Vivaldi expected at %s)" % CHROME_CANDIDATES[0])


REQUEST_RE = re.compile(r'"(GET|HEAD) (\S+) HTTP/1\.1" (\d{3})')


def _requests_from_log(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        m = REQUEST_RE.search(line)
        if not m:
            continue
        out.append({"method": m.group(1), "path": m.group(2), "status": int(m.group(3))})
    return out


def _decode_diag(path: str) -> dict:
    """Turn ``/diag?msg=…&lvl=…`` into ``{'lvl': …, 'msg': …}``."""
    query = path.split("?", 1)[1] if "?" in path else ""
    params = urllib.parse.parse_qs(query)
    return {
        "lvl": (params.get("lvl") or [""])[0],
        "msg": urllib.parse.unquote((params.get("msg") or [""])[0]),
    }


@pytest.fixture(scope="session")
def scene_pkg(tmp_path_factory) -> Path:
    """Synthetic minimal wallpaper folder: ``<dir>/scene.pkg``.

    A *directory* token is what the renderer needs, because it appends
    ``scene.pkg`` itself (see NS in the module docstring).
    """
    root = FIXTURES / "scene_pkg" / "wallpaper"
    path = root / "scene.pkg"
    built = build_min_scene_pkg.write_minimal_scene_pkg(path)
    assert built.stat().st_size > 0
    return built


@pytest.fixture(scope="session")
def servers(scene_pkg):
    """Media server + harness origin + attacker origin, all real processes."""
    ms.clear_tokens()
    srv = ms.start_media_server(vendor_root=str(VENDOR_ROOT))
    if srv is None:  # pragma: no cover - port exhaustion
        pytest.fail(f"media server refused to start: {ms.media_error()}")
    srv.log_requests = True  # request log is evidence; handler reads it per request

    origin = ms.media_origin()
    assert origin

    tokens = {
        "pkg": ms.register_path(scene_pkg.parent, kind="dir", entry="scene.pkg"),
        "tests": ms.register_path(TESTS_DIR, kind="dir", entry="harness.html"),
        "junk": ms.register_path(FIXTURES / "media-tree" / "room" / "scene.pkg", kind="file"),
        "preview": ms.register_path(FIXTURES / "media-tree" / "room" / "preview.jpg", kind="file"),
    }

    harness_srv = _serve(TESTS_DIR)  # serves /harness.html + /harness/bridge.js
    attack_srv = _serve(HARNESS_DIR)  # serves /attacker.html

    info = {
        "origin": origin,
        "tokens": tokens,
        "harness_origin": f"http://127.0.0.1:{harness_srv.server_address[1]}",
        "attack_origin": f"http://127.0.0.1:{attack_srv.server_address[1]}",
    }
    yield info
    harness_srv.shutdown()
    harness_srv.server_close()
    attack_srv.shutdown()
    attack_srv.server_close()
    ms.shutdown()
    ms.clear_tokens()


def _run_browser(url: str, wait_ms: int) -> dict:
    """One isolated browser run. Returns the evidence bundle + request log."""
    stderr_buf = io.StringIO()
    with contextlib.redirect_stderr(stderr_buf):
        proc = subprocess.run(
            [
                NODE,
                str(DRIVER),
                f"--chrome={_chrome()}",
                f"--url={url}",
                f"--wait-ms={wait_ms}",
                "--report-expr=window.HARNESS.evidence().then(e => JSON.stringify(e))",
                f"--port={_free_port()}",
            ],
            capture_output=True,
            text=True,
            timeout=240,
        )
    log = stderr_buf.getvalue()
    if proc.returncode != 0:
        pytest.fail(
            "cdp_driver failed (rc=%s)\nurl: %s\nstderr:\n%s\nstdout:\n%s"
            % (proc.returncode, url, proc.stderr[-3000:], proc.stdout[-2000:])
        )
    payload = json.loads(proc.stdout)
    report = payload.get("report")
    if not isinstance(report, str):
        pytest.fail(f"driver produced no report string: {report!r}\n{proc.stdout[-2000:]}")
    evidence = json.loads(report)
    evidence["_driver"] = {
        "browser": payload.get("browser"),
        "console": payload.get("console"),
        "exceptions": payload.get("exceptions"),
        "url": url,
    }
    evidence["_http"] = _requests_from_log(log)
    return evidence


def _harness_url(servers, *, same_origin: bool, src: str, extra: dict | None = None) -> str:
    origin = servers["origin"]
    params = {
        "media": origin,
        "src": src,
        "preview": f"{origin}/s/{servers['tokens']['preview']}/preview.jpg",
    }
    params.update(extra or {})
    query = urllib.parse.urlencode(params)
    if same_origin:
        return f"{origin}/s/{servers['tokens']['tests']}/harness.html?{query}"
    return f"{servers['harness_origin']}/harness.html?{query}"


@pytest.fixture(scope="session")
def same_min(servers) -> dict:
    """Origin M, minimal scene.pkg, no attacker, no sender. Waits past the 10 s
    watchdog so the timeout fallback is observed rather than assumed."""
    src = f"/s/{servers['tokens']['pkg']}"
    return _run_browser(_harness_url(servers, same_origin=True, src=src), wait_ms=11500)


@pytest.fixture(scope="session")
def cross_attack(servers) -> dict:
    src = f"/s/{servers['tokens']['pkg']}"
    sender = f"{servers['origin']}/s/{servers['tokens']['tests']}/harness/sender.html"
    url = _harness_url(
        servers,
        same_origin=False,
        src=src,
        extra={
            "attack": f"{servers['attack_origin']}/attacker.html?rounds={ATTACK_ROUNDS}&gap=120",
            "sender": sender,
        },
    )
    return _run_browser(url, wait_ms=8000)


@pytest.fixture(scope="session")
def same_junk(servers) -> dict:
    """Origin M, the T0.2 997-byte fake scene.pkg: the renderer's failure path."""
    src = f"/s/{servers['tokens']['junk']}"
    return _run_browser(_harness_url(servers, same_origin=True, src=src), wait_ms=6000)


# ---------------------------------------------------------------------------
# 1. pure bridge logic (node --test)
# ---------------------------------------------------------------------------


def test_bridge_unit_suite_passes():
    """Every origin/fallback rule exercised without a DOM."""
    proc = subprocess.run(
        [NODE, "--test", str(BRIDGE_SPEC)],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(PLUGIN_ROOT),
    )
    out = proc.stdout + proc.stderr
    pass_n = re.search(r"^# pass (\d+)$", out, re.M) or re.search(r"^ℹ pass (\d+)$", out, re.M)
    fail_n = re.search(r"^# fail (\d+)$", out, re.M) or re.search(r"^ℹ fail (\d+)$", out, re.M)
    assert pass_n, f"could not parse node --test summary:\n{out[-3000:]}"
    print(f"\nnode --test: pass={pass_n.group(1)} fail={(fail_n.group(1) if fail_n else '?')}")
    assert proc.returncode == 0, out[-3000:]
    if fail_n:
        assert int(fail_n.group(1)) == 0, out[-3000:]
    assert int(pass_n.group(1)) >= 23, "expected at least the 23 bridge specs to run"


# ---------------------------------------------------------------------------
# 2. the fixture scene.pkg (container-level, no browser)
# ---------------------------------------------------------------------------


def test_min_scene_pkg_matches_parser_expectations(scene_pkg):
    """Byte-level check against the vendor's own ``ox(t)`` reader."""
    import struct

    data = scene_pkg.read_bytes()
    assert len(data) >= 16

    magic_len = struct.unpack_from("<I", data, 0)[0]
    assert 4 <= magic_len <= 16, "renderer rejects magicLen outside 4..16"
    magic = data[4 : 4 + magic_len]
    assert magic.startswith(b"PKGV"), magic

    count = struct.unpack_from("<I", data, 4 + magic_len)[0]
    assert count == 1, "fixture carries exactly one entry"

    pos = 4 + magic_len + 4
    name_len = struct.unpack_from("<I", data, pos)[0]
    pos += 4
    name = data[pos : pos + name_len].decode("utf-8")
    pos += name_len
    offset, size = struct.unpack_from("<II", data, pos)
    pos += 8
    data_start = pos

    assert name == "scene.json"
    body = data[data_start + offset : data_start + offset + size]
    assert len(body) == size
    doc = json.loads(body)
    assert doc["general"]["clearenabled"] is True
    assert doc["objects"] == []


# ---------------------------------------------------------------------------
# 3. T16 — heartbeat channel + liveness
# ---------------------------------------------------------------------------


def test_T16_vendor_renderer_sends_no_we_frame_for_a_scene(same_min):
    """T16's premise, measured: the scene render page emits **zero** heartbeats.

    Not a failure of the bridge — the vendor simply has no render->host
    postMessage for scenes (module docstring, observation 1). The bridge's
    origin-gated counter therefore stays at 0 and the 10 s watchdog is what
    actually drives the fallback, which is what we observe here.
    """
    before = same_min["before"]
    assert before["frames"] == 0, (
        "if this ever becomes non-zero, the vendor grew a heartbeat and T16 can be "
        f"asserted directly; got {before['frames']}"
    )
    assert before["lastFrameAt"] is None

    assert before["phase"] == "fallback", before["phase"]
    assert before["fallbackReason"] == "heartbeat-timeout"
    assert before["failures"] == 1
    assert before["sceneLive"] is True, "one failure must not mark the wallpaper dead"

    # The DOM the harness renders for assertion purposes agrees with the state it
    # reports (the page is what a human would inspect in DevTools).
    report = same_min["report"]
    dom = report["dom"]
    assert dom["phase"] == report["bridge"]["phase"] == "fallback"
    assert dom["frames"] == "0"
    assert dom["rejected"] == "0"
    # The adversarial tail of evidence() leaves sceneLive=false; the DOM must
    # track whatever the final state is, not a stale snapshot.
    assert dom["sceneLive"] == str(report["bridge"]["sceneLive"]).lower()


def test_T16_renderer_mounted_and_fetched_the_scene(same_min, scene_pkg):
    """The bridge's URL construction is right: the render page loaded and asked
    the media server for the package the harness pointed it at."""
    reqs = same_min["_http"]
    statuses = {(r["path"].split("?")[0], r["status"]) for r in reqs}

    assert ("/gl/host.html", 200) in statuses
    assert ("/gl/assets/renderer-DTLW1Gf0.js", 200) in statuses
    assert ("/gl/assets/modulepreload-polyfill-B5Qt9EMX.js", 200) in statuses

    pkg_hits = [r for r in reqs if r["path"].endswith("/scene.pkg")]
    assert pkg_hits, f"renderer never requested scene.pkg; requests={reqs}"
    assert pkg_hits[0]["status"] == 200

    diags = [_decode_diag(r["path"]) for r in reqs if r["path"].startswith("/diag")]
    messages = [d["msg"] for d in diags]
    assert any("mountScene start" in m for m in messages), messages
    assert any(f"pkg body: {scene_pkg.stat().st_size} bytes" in m for m in messages), messages
    assert any("renderer started: 0 layers" in m for m in messages), messages
    assert not any("failed:" in m for m in messages), f"unexpected renderer failure: {messages}"


# ---------------------------------------------------------------------------
# 4. T16b — origin gate, adversarial
# ---------------------------------------------------------------------------


def test_T16b_foreign_origin_heartbeats_are_rejected(cross_attack):
    before = cross_attack["before"]
    after = cross_attack["afterForgery"]
    report = cross_attack["report"]

    expected_forged = ATTACK_ROUNDS * ATTACK_MESSAGES_PER_ROUND + cross_attack["selfForgedMessages"]
    assert after["rejected"]["total"] >= expected_forged, (
        f"expected >= {expected_forged} rejections, saw {after['rejected']}"
    )
    # every rejection is an origin mismatch; none is counted as a usable op
    assert after["rejected"]["byReason"].get("origin-mismatch") == after["rejected"]["total"]
    assert "unknown-op" not in after["rejected"]["byReason"]

    # the origins that got rejected are the attacker + harness origins, never M
    media_origin = report["mode"]["mediaOrigin"]
    seen = set(after["rejected"]["origins"])
    assert media_origin not in seen, seen
    assert report["mode"]["attackOrigin"].startswith("http://127.0.0.1:")
    assert any(o.startswith("http://127.0.0.1:") for o in seen), seen


def test_T16b_forged_error_frame_cannot_force_the_fallback(cross_attack):
    """The attacker also posts ``{op:"error"}`` every round. If the gate were
    missing, the bridge would have flipped to the preview immediately."""
    after = cross_attack["afterForgery"]
    assert after["errors"] == [], after["errors"]
    assert after["phase"] == "live", after["phase"]
    assert after["fallbackReason"] is None
    assert after["sceneLive"] is True


def test_T16b_trusted_origin_heartbeats_are_accepted(cross_attack):
    """Same payload bytes, origin M: accepted. This is the other half of T16b —
    the gate must not simply drop everything."""
    before = cross_attack["before"]
    assert before["frames"] >= 3, before["frames"]
    assert before["phase"] == "live", before["phase"]
    # Only the attacker's traffic is rejected; not one of the trusted heartbeats.
    assert before["rejected"]["total"] == ATTACK_ROUNDS * ATTACK_MESSAGES_PER_ROUND, before["rejected"]
    assert before["rejected"]["byReason"] == {"origin-mismatch": before["rejected"]["total"]}

    report = cross_attack["report"]
    assert report["mode"]["sender"].startswith(report["mode"]["mediaOrigin"])
    dom = report["dom"]
    assert dom["phase"] == "fallback", "the adversarial tail ends in a forced fallback"
    assert dom["frames"] == str(report["bridge"]["frames"])


def test_T16b_two_consecutive_failures_mark_scene_live_false(cross_attack):
    first = cross_attack["failure1"]
    second = cross_attack["failure2"]
    assert first["phase"] == "fallback"
    assert first["failures"] == 1
    assert first["sceneLive"] is True
    assert second["failures"] == 2
    assert second["sceneLive"] is False


# ---------------------------------------------------------------------------
# 5. T16c — canvas pixels
# ---------------------------------------------------------------------------


def test_T16c_canvas_is_live_with_non_empty_pixels(same_min):
    """The anchor's own two criteria, both checked, plus the honest extra:
    the pixels are a *uniform* clear colour because the fixture has no layers."""
    probe = same_min["report"]["probe"]
    assert probe["sameOrigin"] is True

    canvas = probe["canvas"]
    assert canvas and canvas["count"] == 1, canvas
    assert canvas["width"] > 0 and canvas["height"] > 0
    assert canvas["contextType"] == "webgl2", canvas
    assert canvas["drawingBufferWidth"] > 0 and canvas["drawingBufferHeight"] > 0, canvas
    assert canvas["contextLost"] is False
    assert canvas["dataUrlLength"] > 1000, canvas

    pixels = probe["pixels"]
    assert pixels["nonBlackPixels"] == pixels["sampled"], pixels
    assert pixels["nonBlackRatio"] == 1

    capture = probe["capture"]
    assert capture and capture["length"] > 1000
    assert capture["prefix"].startswith("data:image/jpeg;base64,")

    # Honest label: this is the clear colour, not scene content.
    assert pixels["uniformFill"] is True, (
        "the minimal fixture has no layers, so a non-uniform canvas would mean the "
        "renderer invented something — investigate before trusting it"
    )
    assert pixels["distinctQuantisedColors"] == 1


def test_T16c_renderer_reports_zero_layers(same_min):
    """Confirms the pixel result is explainable: the scene parsed into 0 layers."""
    probe = same_min["report"]["probe"]
    assert probe["wpState"]["type"] == "scene"
    assert probe["wpState"]["webError"] is None
    assert "capture" in probe["wpKeys"] and "getState" in probe["wpKeys"]


def test_T16c_real_scene_pkg_unavailable():
    """T16c cannot be closed against real content on this machine.

    Skipping (not xfailing) because the missing input is environmental, and the
    passing assertions above already cover the anchor's mechanical criteria.
    """
    known = Path(r"Z:/SteamLibrary/steamapps/workshop/content/431960/3571376089/scene.pkg")
    if known.is_file():
        pytest.skip(f"real scene.pkg appeared at {known}; re-run the harness against it")
    pytest.skip(
        "no real scene.pkg on this machine: Wallpaper Engine is not installed under "
        "H:/application/steam/steamapps/common and the DSH wallpaper id=3571376089 "
        "resolves to Z: (offline). T16c's pixel assertion is therefore demonstrated on a "
        "synthetic container-valid package with 0 layers, not on real wallpaper content."
    )


# ---------------------------------------------------------------------------
# 6. failure path — invalid package
# ---------------------------------------------------------------------------


def test_renderer_reports_pkg_parse_failure_and_bridge_falls_back(same_junk):
    """Negative control: junk bytes in scene.pkg. The renderer says exactly why,
    and the host side ends up on the preview without any heartbeat."""
    diags = [_decode_diag(r["path"]) for r in same_junk["_http"] if r["path"].startswith("/diag")]
    errors = [d["msg"] for d in diags if d["lvl"] == "error"]
    assert errors, f"renderer reported no error; diags={diags}"
    assert any("魔数长度异常" in m for m in errors), errors

    probe = same_junk["report"]["probe"]
    assert probe["canvas"]["count"] == 0, "no canvas is created when the package is unreadable"

    before = same_junk["before"]
    assert before["frames"] == 0
    assert before["errors"] == [], "the vendor never sends an error *frame*, only a beacon"

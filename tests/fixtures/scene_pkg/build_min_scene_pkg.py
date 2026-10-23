"""Build a minimal WebWallGL-compatible `scene.pkg` for the T0.3 harness.

Why this exists
---------------
The machine has no real Wallpaper Engine scene wallpaper (no `scene.pkg`, and the
one referenced by the old DSH config lives on an offline Z: drive), so T16c
("canvas has non-empty pixels") cannot be exercised against real content. This
module builds the smallest *container-valid* package so the renderer's scene path
gets past its own file-format gate — and so the point where it still fails is a
property of the missing content, not of the bridge.

Container format, transcribed from the vendor bundle (renderer-DTLW1Gf0.js,
`function ox(t)` — byte-identical to how the upstream parses it):

    uint32  magicLen            # little-endian, must be 4..16
    u8[]    magic               # must start with "PKGV"; rest is the version
    uint32  count               # number of entries
    repeat count times:
        uint32  nameLen
        u8[]    name            # utf-8
        uint32  offset          # relative to dataStart
        uint32  size
    dataStart = current position
    entry payloads follow, in any order, addressed by (offset, size)

`getEntry(pkg, "scene.json")` then returns `buf[dataStart+offset : +size]`, and
the loader requires a `scene.json` (or `gifscene.json`) entry:
`if(!A)throw new Error("pkg 中没有 scene.json（不是场景壁纸？）")`.

This is deliberately NOT a real wallpaper: no textures, no materials, no
shaders. It is documented as such wherever it is used.
"""

from __future__ import annotations

import json
import struct
from pathlib import Path
from typing import Mapping

MAGIC = b"PKGV0001"

# Smallest scene description that still looks like a wallpaper scene to the
# parser: a general block with a clear colour, and no objects. Kept as a plain
# dict so callers can add fields while investigating parser requirements.
MINIMAL_SCENE = {
    "camera": {
        "center": "0 0 0",
        "eye": "0 0 1",
        "up": "0 1 0",
    },
    "general": {
        "ambientcolor": "1 1 1",
        "clearcolor": "0.10 0.45 0.90",
        "clearenabled": True,
        "orthogonalprojection": {"width": 1920, "height": 1080},
    },
    "objects": [],
    "version": 4,
}


def build_pkg(entries: Mapping[str, bytes], magic: bytes = MAGIC) -> bytes:
    """Serialise ``{name: payload}`` into the PKG layout above."""
    if not 4 <= len(magic) <= 16:
        raise ValueError("magic length must be within 4..16 (renderer gate)")
    if not magic.startswith(b"PKGV"):
        raise ValueError('magic must start with "PKGV"')

    names = list(entries)
    table = bytearray()
    payload = bytearray()
    for name in names:
        raw_name = name.encode("utf-8")
        data = entries[name]
        table += struct.pack("<I", len(raw_name))
        table += raw_name
        table += struct.pack("<II", len(payload), len(data))
        payload += data

    header = struct.pack("<I", len(magic)) + magic + struct.pack("<I", len(names))
    return bytes(header + table + payload)


def minimal_scene_pkg(scene: Mapping | None = None) -> bytes:
    document = dict(MINIMAL_SCENE if scene is None else scene)
    body = json.dumps(document, separators=(",", ":")).encode("utf-8")
    return build_pkg({"scene.json": body})


def write_minimal_scene_pkg(path: Path, scene: Mapping | None = None) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(minimal_scene_pkg(scene))
    return path


if __name__ == "__main__":  # pragma: no cover - manual fixture regeneration
    out = Path(__file__).with_name("minimal-scene.pkg")
    write_minimal_scene_pkg(out)
    print(f"wrote {out} ({out.stat().st_size} bytes)")

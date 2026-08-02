"""Generate Tauri bundle icons: dark '#16181d' square with a white vertical bar.

Pure-stdlib PNG writer (zlib + struct); the .ico wraps a 256x256 PNG
(PNG-compressed ICO entries are supported since Windows Vista).
"""
import struct
import zlib
from pathlib import Path

BG = (0x16, 0x18, 0x1D)
FG = (0xFF, 0xFF, 0xFF)

OUT = Path(__file__).parent


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def make_png(size: int) -> bytes:
    rows = bytearray()
    # White bar: centered, 1/4 of width, 5/8 of height.
    x0, x1 = size * 3 // 8, size * 5 // 8
    y0, y1 = size * 3 // 16, size * 13 // 16
    for y in range(size):
        rows.append(0)  # filter: none
        for x in range(size):
            px = FG if (x0 <= x < x1 and y0 <= y < y1) else BG
            rows.extend(px)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
        + chunk(b"IEND", b"")
    )


def make_ico(png256: bytes) -> bytes:
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack(
        "<BBBBHHII",
        0,  # width 256 -> 0
        0,  # height 256 -> 0
        0,  # palette
        0,  # reserved
        1,  # planes
        32,  # bpp
        len(png256),
        6 + 16,  # offset
    )
    return header + entry + png256


def main() -> None:
    sizes = {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon.png": 512,
    }
    for name, size in sizes.items():
        (OUT / name).write_bytes(make_png(size))
        print(f"wrote {name} ({size}x{size})")
    (OUT / "icon.ico").write_bytes(make_ico(make_png(256)))
    print("wrote icon.ico (256x256 PNG entry)")


if __name__ == "__main__":
    main()

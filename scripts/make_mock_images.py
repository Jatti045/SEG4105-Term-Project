"""Generate the mock recognition model's sample images.

Usage: python scripts/make_mock_images.py

The mock model (backend/recognition.py) recognizes exactly the PNGs in
backend/mock_model/images/: each image has one set output in
backend/mock_model/outputs.json. This script draws one image per entry in
outputs.json: a shelf holding three of the product's food icons, cut from the
dashboard's sprite sheet (frontend/public/sprites/food.png, with each
product's tile set in frontend/src/foodSprites.json), or a bare shelf for an
empty row. The output is the same on every run, so the committed images stay
valid. Uses only the Python standard library.
"""

import json
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "backend" / "mock_model"
SHEET = ROOT / "frontend" / "public" / "sprites" / "food.png"
SPRITES = ROOT / "frontend" / "src" / "foodSprites.json"

WIDTH, HEIGHT = 160, 80
SCALE = 3  # 16 px icons drawn at 48 px
BACKGROUND = (244, 247, 245)
SHELF = (201, 211, 204)


def read_png(path: Path) -> tuple[int, int, list[list[tuple[int, int, int, int]]]]:
    """Decode an 8-bit RGBA or RGB, non-interlaced PNG into rows of RGBA pixels."""
    data = path.read_bytes()
    pos, idat = 8, b""
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or colour not in (2, 6) or interlace:
                raise ValueError(f"{path} must be an 8-bit RGB(A) PNG without interlacing")
        elif kind == b"IDAT":
            idat += body
        pos += 12 + length

    channels = 4 if colour == 6 else 3
    stride = width * channels
    raw = zlib.decompress(idat)
    rows, previous = [], bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind, line = raw[start], bytearray(raw[start + 1 : start + 1 + stride])
        for i in range(stride):  # undo the PNG row filter
            left = line[i - channels] if i >= channels else 0
            up = previous[i]
            corner = previous[i - channels] if i >= channels else 0
            if kind == 1:
                line[i] = (line[i] + left) & 0xFF
            elif kind == 2:
                line[i] = (line[i] + up) & 0xFF
            elif kind == 3:
                line[i] = (line[i] + (left + up) // 2) & 0xFF
            elif kind == 4:
                p = left + up - corner
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - corner)
                line[i] = (line[i] + (left if pa <= pb and pa <= pc else up if pb <= pc else corner)) & 0xFF
        previous = line
        pixels = [tuple(line[x * channels : x * channels + channels]) for x in range(width)]
        rows.append([p if channels == 4 else (*p, 255) for p in pixels])
    return width, height, rows


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def write_png(pixels: list[list[tuple[int, int, int]]]) -> bytes:
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in pixels)
    return b"".join([
        b"\x89PNG\r\n\x1a\n",
        chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0)),
        chunk(b"IDAT", zlib.compress(raw, 9)),
        chunk(b"IEND", b""),
    ])


def draw(icon: list[list[tuple[int, int, int, int]]] | None) -> list[list[tuple[int, int, int]]]:
    pixels = [[BACKGROUND] * WIDTH for _ in range(HEIGHT)]
    for y in range(HEIGHT - 10, HEIGHT):
        pixels[y] = [SHELF] * WIDTH
    if icon:
        size = len(icon) * SCALE
        top = HEIGHT - 10 - size
        for n in range(3):  # three items standing on the shelf
            left = 8 + n * (size + 4)
            for y in range(size):
                for x in range(size):
                    r, g, b, a = icon[y // SCALE][x // SCALE]
                    if a:
                        under = pixels[top + y][left + x]
                        pixels[top + y][left + x] = tuple(
                            (c * a + u * (255 - a)) // 255 for c, u in zip((r, g, b), under)
                        )
    return pixels


def main() -> None:
    outputs = json.loads((MODEL_DIR / "outputs.json").read_text(encoding="utf-8"))
    sprites = json.loads(SPRITES.read_text(encoding="utf-8"))
    _, _, sheet = read_png(SHEET)
    tile = sprites["tile"]

    images = MODEL_DIR / "images"
    images.mkdir(exist_ok=True)
    for name, output in outputs.items():
        icon = None
        if output["label"]:
            row, col = sprites["products"][output["label"]]
            icon = [line[col * tile : (col + 1) * tile] for line in sheet[row * tile : (row + 1) * tile]]
        (images / name).write_bytes(write_png(draw(icon)))
        print(f"wrote {images / name}")


if __name__ == "__main__":
    main()

"""Image recognition for shelf images: a mock model.

There is no trained model yet. The mock recognizes a fixed set of sample
images: each PNG in mock_model/images/ has one set output in
mock_model/outputs.json. An uploaded image is matched to a sample by its exact
bytes (SHA-256), and any other image is not recognized.

`recognize_image` is the one place a real model would plug in; the readings
API and the endpoints below won't need to change.
"""

import hashlib
import json
from functools import cache
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from psycopg import Connection

from db import get_db

MODEL_DIR = Path(__file__).parent / "mock_model"
IMAGES_DIR = MODEL_DIR / "images"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_IMAGE_BYTES = 10 * 1024 * 1024

router = APIRouter(prefix="/api/recognition", tags=["recognition"])


class InvalidImage(ValueError):
    pass


@cache
def samples() -> dict[str, dict]:
    """Sample images by SHA-256: {"sample": file name, "label": ..., "confidence": ...}."""
    outputs = json.loads((MODEL_DIR / "outputs.json").read_text(encoding="utf-8"))
    return {
        hashlib.sha256((IMAGES_DIR / name).read_bytes()).hexdigest(): {"sample": name, **output}
        for name, output in outputs.items()
    }


def recognize_image(png: bytes) -> dict:
    """What the model sees in a shelf image.

    Returns {"recognized", "sample", "label", "confidence"}. label is the
    product's recognition label, or None for an empty row or an unrecognized image.
    """
    if not png.startswith(PNG_SIGNATURE):
        raise InvalidImage("not a PNG file")
    match = samples().get(hashlib.sha256(png).hexdigest())
    if match is None:
        return {"recognized": False, "sample": None, "label": None, "confidence": 0.0}
    return {"recognized": True, **match}


def recognize(png: bytes) -> str | None:
    """The recognition label of the product in the image, or None."""
    return recognize_image(png)["label"]


def product_names(db: Connection) -> dict[str, str]:
    return {
        r["recognition_label"]: r["name"]
        for r in db.execute("SELECT recognition_label, name FROM products").fetchall()
    }


@router.post("")
async def run_recognition(image: UploadFile = File(...), db: Connection = Depends(get_db)):
    """Run the model on one PNG and return what it sees."""
    data = await image.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Image is larger than 10 MB.")
    try:
        result = recognize_image(data)
    except InvalidImage as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{e}.") from e
    result["product"] = product_names(db).get(result["label"])
    return result


@router.get("/samples")
def list_samples(db: Connection = Depends(get_db)):
    """The images the mock model knows, each with its set output."""
    names = product_names(db)
    return [
        {
            **output,
            "product": names.get(output["label"]),
            "url": f"/api/recognition/samples/{output['sample']}",
        }
        for output in samples().values()
    ]


@router.get("/samples/{name}")
def sample_image(name: str):
    """One sample image."""
    if name not in {s["sample"] for s in samples().values()}:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such sample image.")
    return FileResponse(IMAGES_DIR / name, media_type="image/png")

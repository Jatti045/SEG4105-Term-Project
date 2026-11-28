"""Fridge-facing API.

Level-0 process 2.0, Recognize Items and Update Inventory. A fridge:

1. Pulls the product catalog (GET /api/products) so staff can set up its rows.
2. Sends back its configuration: which product each row holds
   (PUT /api/fridges/{id}/configuration).
3. Each time its door closes, sends a complete snapshot of its rows (ADR-002):
   for each row, the weight on its scale and a PNG image. The fridge does no
   processing (ADR-001). The backend estimates the item count from the weight
   of the row's configured product, and checks the image against it.

There is no device authentication yet, like the rest of the API.
"""

import math
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from psycopg import Connection
from pydantic import BaseModel, Field, ValidationError, field_validator
from starlette.datastructures import UploadFile

from checks import WEIGHT_TOLERANCE_G, run_all_checks
from db import get_db
from recognition import MAX_IMAGE_BYTES, InvalidImage, recognize_image

router = APIRouter(prefix="/api/fridges", tags=["fridges"])

MAX_ROWS = 200


def unprocessable(detail) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def unique_row_ids(rows: list) -> list:
    ids = [r.row_id for r in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("Each row can appear only once.")
    return rows


# ---------------------------------------------------------------------------
# Fridges and their configuration
# ---------------------------------------------------------------------------
@router.get("")
def list_fridges(db: Connection = Depends(get_db)):
    """Fridges and their rows, with each row's product and latest reading."""
    fridges = db.execute(
        "SELECT fridge_id, name, location, status, last_reading_at FROM fridges ORDER BY fridge_id"
    ).fetchall()
    rows = db.execute(
        """
        SELECT r.fridge_id, r.row_id, r.label, r.product_id, r.current_count,
               r.current_weight_g, r.updated_at, p.name AS product, p.recognition_label
        FROM rows r
        LEFT JOIN products p ON p.product_id = r.product_id
        ORDER BY r.fridge_id, r.label
        """
    ).fetchall()
    by_fridge = {f["fridge_id"]: {**f, "rows": []} for f in fridges}
    for row in rows:
        by_fridge[row.pop("fridge_id")]["rows"].append(row)
    return list(by_fridge.values())


def fridge_rows(db: Connection, fridge_id: int, lock: bool = False) -> dict[int, dict]:
    """A fridge's rows by ID, with how many items each lists. 404 if there's no such fridge."""
    if db.execute("SELECT 1 FROM fridges WHERE fridge_id = %s", (fridge_id,)).fetchone() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fridge not found.")
    return {
        r["row_id"]: r
        for r in db.execute(
            f"""
            SELECT r.row_id, r.label, r.product_id,
                   (SELECT count(*)::int FROM stock_items s
                    WHERE s.row_id = r.row_id AND s.status = 'in_stock') AS listed
            FROM rows r
            WHERE r.fridge_id = %s
            ORDER BY r.label
            {"FOR UPDATE OF r" if lock else ""}
            """,
            (fridge_id,),
        ).fetchall()
    }


@router.get("/{fridge_id}/configuration")
def get_configuration(fridge_id: int, db: Connection = Depends(get_db)):
    """Which product each of the fridge's rows is set up for (null if unassigned)."""
    rows = fridge_rows(db, fridge_id)
    return {
        "fridge_id": fridge_id,
        "rows": [
            {"row_id": r["row_id"], "label": r["label"], "product_id": r["product_id"]}
            for r in rows.values()
        ],
    }


class RowSetup(BaseModel):
    row_id: int
    product_id: int | None = Field(description="Product the row holds, or null to unassign it.")


class FridgeConfiguration(BaseModel):
    rows: list[RowSetup] = Field(min_length=1, max_length=MAX_ROWS)

    @field_validator("rows")
    @classmethod
    def unique_rows(cls, rows):
        return unique_row_ids(rows)


def retire_items(db: Connection, row_id: int, at: datetime) -> int:
    """Mark a row's in-stock items as removed and clear their alerts. Returns how many."""
    removed = [
        r["item_id"]
        for r in db.execute(
            """
            UPDATE stock_items SET status = 'removed', removed_at = %s
            WHERE row_id = %s AND status = 'in_stock'
            RETURNING item_id
            """,
            (at, row_id),
        ).fetchall()
    ]
    if removed:
        db.execute(
            "UPDATE alerts SET status = 'cleared' WHERE item_id = ANY(%s) AND status = 'active'",
            (removed,),
        )
    return len(removed)


@router.put("/{fridge_id}/configuration")
def set_configuration(fridge_id: int, config: FridgeConfiguration, db: Connection = Depends(get_db)):
    """Set which product each row holds. Rows left out keep their product.

    When a row switches product, its listed items are marked removed: they had
    to come out for the new product to go in. The next reading adds the new
    product's items from the row's weight.
    """
    now = datetime.now(timezone.utc)
    with db.transaction():
        rows = fridge_rows(db, fridge_id, lock=True)
        catalog = {
            p["product_id"]: p
            for p in db.execute("SELECT product_id, name, active FROM products").fetchall()
        }
        problems = []
        for r in config.rows:
            if r.row_id not in rows:
                problems.append(f"Row {r.row_id} is not in fridge {fridge_id}.")
            elif r.product_id is not None and r.product_id not in catalog:
                problems.append(f"Row {r.row_id}: there's no product {r.product_id}.")
            elif r.product_id is not None and not catalog[r.product_id]["active"]:
                problems.append(
                    f"Row {r.row_id}: {catalog[r.product_id]['name']} was removed from the catalog."
                )
        if problems:
            raise unprocessable(problems)

        changes = []
        for r in config.rows:
            row = rows[r.row_id]
            change = {
                "row_id": r.row_id,
                "label": row["label"],
                "product_id": r.product_id,
                "product": catalog[r.product_id]["name"] if r.product_id else None,
                "changed": r.product_id != row["product_id"],
                "removed_items": 0,
            }
            if change["changed"]:
                change["removed_items"] = retire_items(db, r.row_id, now)
                db.execute(
                    "UPDATE rows SET product_id = %s WHERE row_id = %s", (r.product_id, r.row_id)
                )
                # The old reading was for the old product, so its mismatch alert no longer applies.
                db.execute(
                    """
                    UPDATE alerts SET status = 'cleared'
                    WHERE row_id = %s AND alert_type = 'stock_mismatch' AND status = 'active'
                    """,
                    (r.row_id,),
                )
            changes.append(change)
    return {"fridge_id": fridge_id, "rows": changes}


# ---------------------------------------------------------------------------
# Readings
# ---------------------------------------------------------------------------
class RowReading(BaseModel):
    row_id: int
    weight_g: int = Field(ge=0, le=1_000_000, description="Weight on the row's scale, in grams.")


class FridgeReading(BaseModel):
    taken_at: datetime | None = Field(
        None, description="When the fridge took the reading (UTC). Defaults to now."
    )
    rows: list[RowReading] = Field(min_length=1, max_length=MAX_ROWS)

    @field_validator("rows")
    @classmethod
    def unique_rows(cls, rows):
        return unique_row_ids(rows)


@dataclass
class ReadingUpload:
    reading: FridgeReading
    # What the model saw in each row's image: {"recognized": bool, "label": str | None}.
    seen: dict[int, dict]


async def parse_upload(request: Request) -> ReadingUpload:
    """Read the multipart form: a `reading` JSON field plus an `image_<row_id>` PNG per row."""
    form = await request.form(max_files=MAX_ROWS, max_fields=MAX_ROWS)
    raw = form.get("reading")
    if not isinstance(raw, str):
        raise unprocessable(
            "Send multipart/form-data with a 'reading' field (JSON with 'rows') "
            "and an 'image_<row_id>' PNG for each row."
        )
    try:
        reading = FridgeReading.model_validate_json(raw)
    except ValidationError as e:
        raise unprocessable(e.errors(include_url=False, include_context=False)) from e

    seen, problems = {}, []
    for r in reading.rows:
        image = form.get(f"image_{r.row_id}")
        if not isinstance(image, UploadFile):
            problems.append(f"Row {r.row_id}: missing the 'image_{r.row_id}' file.")
            continue
        data = await image.read(MAX_IMAGE_BYTES + 1)
        if len(data) > MAX_IMAGE_BYTES:
            problems.append(f"Row {r.row_id}: image is larger than {MAX_IMAGE_BYTES // 2**20} MB.")
            continue
        try:
            seen[r.row_id] = recognize_image(data)
        except InvalidImage as e:
            problems.append(f"Row {r.row_id}: {e}.")
    if problems:
        raise unprocessable(problems)
    return ReadingUpload(reading, seen)


def estimate_count(weight_g: int, unit_weight_g: int) -> int:
    """Items on a row from its weight, allowing for one opened item and scale noise.

    n full units weigh n x unit weight; with one opened item the weight drops
    toward (n - 1) units plus an empty package. Rounding up after taking off
    the tolerance counts the opened item and ignores a few grams of noise.
    """
    return max(0, math.ceil((weight_g - WEIGHT_TOLERANCE_G) / unit_weight_g))


def remove_items(db: Connection, row_id: int, count: int | None, taken_at: datetime) -> dict:
    """Take `count` items (all if None) out of a row, soonest expiry first.

    Items past their expiry date were thrown out, so they're logged as waste
    detected by the system. The rest were used. Returns how many of each.
    """
    removed = db.execute(
        """
        UPDATE stock_items
        SET status = CASE WHEN expiry_date < %(day)s THEN 'wasted' ELSE 'consumed' END,
            removed_at = %(at)s
        WHERE item_id IN (
            SELECT item_id
            FROM stock_items
            WHERE row_id = %(row)s AND status = 'in_stock'
            ORDER BY expiry_date, added_at, item_id
            LIMIT %(n)s
        )
        RETURNING item_id, status
        """,
        {"day": taken_at.date(), "at": taken_at, "row": row_id, "n": count},
    ).fetchall()
    wasted = [r["item_id"] for r in removed if r["status"] == "wasted"]
    if wasted:
        db.execute(
            """
            INSERT INTO waste_records (item_id, user_id, reason, recorded_at)
            SELECT item_id, NULL, 'expired', %s FROM unnest(%s::int[]) AS item_id
            """,
            (taken_at, wasted),
        )
    if removed:
        # The items are gone, so their expiry alerts no longer need attention.
        db.execute(
            "UPDATE alerts SET status = 'cleared' WHERE item_id = ANY(%s) AND status = 'active'",
            ([r["item_id"] for r in removed],),
        )
    return {"used": len(removed) - len(wasted), "thrown_out": len(wasted)}


@router.post(
    "/{fridge_id}/readings",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["reading"],
                        "properties": {
                            "reading": {
                                "type": "string",
                                "description": 'JSON, e.g. {"taken_at": "2026-11-27T14:04:58Z", '
                                '"rows": [{"row_id": 4, "weight_g": 14700}]}. '
                                "taken_at is optional and defaults to now.",
                            }
                        },
                        "additionalProperties": {
                            "type": "string",
                            "format": "binary",
                            "description": "image_<row_id>: PNG image of that row.",
                        },
                    }
                }
            },
        }
    },
)
def receive_reading(
    fridge_id: int,
    upload: ReadingUpload = Depends(parse_upload),
    db: Connection = Depends(get_db),
):
    """Bring a fridge's stock in line with a new reading. All rows are applied, or none.

    For each row, the product is the one the row is configured for. An
    unassigned row takes the product the image shows, if it's in the catalog.
    The item count is estimated from the weight, then items are added or
    removed so the records match. The image is checked against the configured
    product, and any disagreement is reported (image_matches: false).
    """
    reading = upload.reading
    taken_at = reading.taken_at or datetime.now(timezone.utc)
    if taken_at.tzinfo is None:
        taken_at = taken_at.replace(tzinfo=timezone.utc)

    with db.transaction():
        fridge = db.execute(
            "SELECT fridge_id, last_reading_at FROM fridges WHERE fridge_id = %s FOR UPDATE",
            (fridge_id,),
        ).fetchone()
        if fridge is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Fridge not found.")
        if fridge["last_reading_at"] and taken_at < fridge["last_reading_at"]:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"A newer reading was already received at {fridge['last_reading_at'].isoformat()}.",
            )

        rows = fridge_rows(db, fridge_id, lock=True)
        problems = [
            f"Row {r.row_id} is not in fridge {fridge_id}." for r in reading.rows if r.row_id not in rows
        ]
        if problems:
            raise unprocessable(problems)

        catalog = db.execute(
            "SELECT product_id, name, recognition_label, unit_weight_g, active FROM products"
        ).fetchall()
        by_id = {p["product_id"]: p for p in catalog}
        by_label = {p["recognition_label"]: p for p in catalog if p["active"]}

        changes = []
        for r in reading.rows:
            row = rows[r.row_id]
            seen = upload.seen[r.row_id]
            empty = r.weight_g <= WEIGHT_TOLERANCE_G
            configured = by_id.get(row["product_id"])
            recognized = by_label.get(seen["label"])
            product = configured or recognized

            # Does the camera agree with the row's configuration? None when it can't tell.
            image_matches = None
            if configured and seen["recognized"]:
                if seen["label"] is None:  # the model saw an empty shelf
                    image_matches = empty
                else:
                    image_matches = seen["label"] == configured["recognition_label"]

            change = {
                "row_id": r.row_id,
                "label": row["label"],
                "product": product["name"] if product else None,
                "configured": configured is not None,
                "recognized_label": seen["label"],
                "image_matches": image_matches,
                "estimated_count": None,
                "added": 0,
                "used": 0,
                "thrown_out": 0,
                "product_changed": False,
                "unrecognized": False,
            }

            if product is None:
                # Unassigned row, and the image isn't a catalog product: record the weight only.
                change["unrecognized"] = not empty
                db.execute(
                    "UPDATE rows SET current_weight_g = %s, updated_at = %s WHERE row_id = %s",
                    (r.weight_g, taken_at, r.row_id),
                )
                changes.append(change)
                continue

            if configured is None:
                # An unassigned row takes the product the camera recognized.
                db.execute(
                    "UPDATE rows SET product_id = %s WHERE row_id = %s",
                    (product["product_id"], r.row_id),
                )
                change["product_changed"] = True
                if row["listed"]:
                    gone = remove_items(db, r.row_id, None, taken_at)
                    change["used"] += gone["used"]
                    change["thrown_out"] += gone["thrown_out"]
                    row["listed"] = 0

            count = 0 if empty else estimate_count(r.weight_g, product["unit_weight_g"])
            change["estimated_count"] = count

            if count > row["listed"]:
                change["added"] = count - row["listed"]
                db.execute(
                    """
                    INSERT INTO stock_items (product_id, row_id, added_at, expiry_date)
                    SELECT p.product_id, %s, %s, %s::date + p.shelf_life_days
                    FROM products p
                    CROSS JOIN generate_series(1, %s)
                    WHERE p.product_id = %s
                    """,
                    (r.row_id, taken_at, taken_at.date(), change["added"], product["product_id"]),
                )
            elif count < row["listed"]:
                gone = remove_items(db, r.row_id, row["listed"] - count, taken_at)
                change["used"] += gone["used"]
                change["thrown_out"] += gone["thrown_out"]

            db.execute(
                """
                UPDATE rows
                SET current_weight_g = %s, current_count = %s, updated_at = %s
                WHERE row_id = %s
                """,
                (r.weight_g, count, taken_at, r.row_id),
            )
            changes.append(change)

        db.execute(
            "UPDATE fridges SET status = 'online', last_reading_at = %s WHERE fridge_id = %s",
            (taken_at, fridge_id),
        )
        alerts_raised = sum(run_all_checks(db).values())

    sent = {r.row_id for r in reading.rows}
    return {
        "fridge_id": fridge_id,
        "taken_at": taken_at,
        "rows": changes,
        # Each reading should cover every row (ADR-002); list any that were left out.
        "missing_rows": sorted(set(rows) - sent),
        "alerts_raised": alerts_raised,
    }

"""Manager API routes."""

from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from psycopg import Connection, sql
from pydantic import BaseModel, Field, field_validator

from auth import require_manager
from checks import DEFAULT_EXPIRY_WARNING_DAYS, ROW_READINGS, run_all_checks
from db import get_db

router = APIRouter(prefix="/api/manager", dependencies=[Depends(require_manager)])

FRIDGE_COLUMNS = (
    "fridge_id, name, location, status, last_reading_at, plan_x, plan_y, plan_w, plan_h"
)

# Number of in-stock items per product, for joining into other queries.
IN_STOCK_COUNTS = """
    SELECT product_id, count(*)::int AS qty
    FROM stock_items
    WHERE status = 'in_stock'
    GROUP BY product_id
"""


def expiry_status(days_left: int, warning_days: int) -> str:
    if days_left < 0:
        return "expired"
    if days_left <= warning_days:
        return "expiring"
    return "fresh"


def group_by_category(rows: list[dict]) -> list[dict]:
    """Group rows that carry category_id and category into [{category_id, name, items}]."""
    groups: dict[int, dict] = {}
    for row in rows:
        category_id = row.pop("category_id")
        name = row.pop("category")
        groups.setdefault(category_id, {"category_id": category_id, "name": name, "items": []})
        groups[category_id]["items"].append(row)
    return list(groups.values())


STATUS_RANK = {"fresh": 0, "expiring": 1, "expired": 2}


@router.get("/stock")
def stock(db: Connection = Depends(get_db)):
    """Products grouped by category, each with its total and its in-stock items."""
    categories = db.execute(
        "SELECT category_id, name FROM categories ORDER BY name"
    ).fetchall()
    products = db.execute(
        """
        SELECT p.category_id, p.product_id, p.name, p.unit, t.low_stock_threshold
        FROM products p
        LEFT JOIN alert_thresholds t ON t.product_id = p.product_id
        -- Removed products drop out once their last item is gone.
        WHERE p.active OR EXISTS (
            SELECT 1 FROM stock_items s WHERE s.product_id = p.product_id AND s.status = 'in_stock'
        )
        ORDER BY p.name
        """
    ).fetchall()
    items = db.execute(
        """
        SELECT s.product_id,
               s.item_id,
               s.row_id,
               f.name                      AS fridge,
               r.label                     AS row_label,
               s.added_at::date            AS added_on,
               s.expiry_date,
               s.expiry_date - current_date AS days_left,
               coalesce(t.expiry_warning_days, %s) AS warning_days
        FROM stock_items s
        JOIN rows r                  ON r.row_id = s.row_id
        JOIN fridges f               ON f.fridge_id = r.fridge_id
        LEFT JOIN alert_thresholds t ON t.product_id = s.product_id
        WHERE s.status = 'in_stock'
        ORDER BY s.expiry_date, s.item_id
        """,
        (DEFAULT_EXPIRY_WARNING_DAYS,),
    ).fetchall()

    by_product = {p["product_id"]: {**p, "items": []} for p in products}
    summary = {"total": len(items), "expiring": 0, "expired": 0}
    for item in items:
        item["status"] = expiry_status(item["days_left"], item.pop("warning_days"))
        if item["status"] in summary:
            summary[item["status"]] += 1
        by_product[item.pop("product_id")]["items"].append(item)

    by_category = {c["category_id"]: {**c, "products": []} for c in categories}
    for product in by_product.values():
        product_items = product["items"]
        threshold = product.pop("low_stock_threshold")
        product["in_stock"] = len(product_items)
        product["expiring"] = sum(i["status"] == "expiring" for i in product_items)
        product["expired"] = sum(i["status"] == "expired" for i in product_items)
        # Items are sorted by expiry, so the first one expires soonest.
        product["next_expiry"] = product_items[0]["expiry_date"] if product_items else None
        product["status"] = max(
            (i["status"] for i in product_items), key=STATUS_RANK.get, default=None
        )
        product["low_stock"] = threshold is not None and len(product_items) <= threshold
        by_category[product.pop("category_id")]["products"].append(product)

    return {"summary": summary, "categories": list(by_category.values())}


class ThrowOutRequest(BaseModel):
    reason: Literal["expired", "spoiled", "damaged", "other"]


@router.post("/items/{item_id}/throw-out")
def throw_out(
    item_id: int,
    body: ThrowOutRequest,
    user: dict = Depends(require_manager),
    db: Connection = Depends(get_db),
):
    """Record that an in-stock item was thrown out."""
    with db.transaction():
        item = db.execute(
            """
            UPDATE stock_items SET status = 'wasted', removed_at = now()
            WHERE item_id = %s AND status = 'in_stock'
            RETURNING item_id, product_id, row_id
            """,
            (item_id,),
        ).fetchone()
        if item is None:
            if db.execute("SELECT 1 FROM stock_items WHERE item_id = %s", (item_id,)).fetchone():
                raise HTTPException(status.HTTP_409_CONFLICT, "Item is no longer in stock.")
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")

        db.execute(
            "INSERT INTO waste_records (item_id, user_id, reason) VALUES (%s, %s, %s)",
            (item_id, user["user_id"], body.reason),
        )
        # The item is gone, so its expiry alerts no longer need attention.
        db.execute(
            "UPDATE alerts SET status = 'cleared' WHERE item_id = %s AND status = 'active'",
            (item_id,),
        )
        # Until the fridge simulator sends real readings, update the row the way
        # its sensor would after the item is taken out.
        db.execute(
            """
            UPDATE rows r
            SET current_count    = greatest(r.current_count - 1, 0),
                current_weight_g = greatest(r.current_weight_g - p.unit_weight_g, 0),
                updated_at       = now()
            FROM products p
            WHERE r.row_id = %s AND p.product_id = %s
            """,
            (item["row_id"], item["product_id"]),
        )
        # Throwing an item out can leave its product low on stock.
        run_all_checks(db)
    return {"item_id": item_id, "status": "wasted"}


Period = Literal["day", "week", "month", "year"]

# Most waste records to list in a report; totals still count all of them.
WASTE_LOG_LIMIT = 50


def period_bounds(period: Period, anchor: date) -> tuple[date, date]:
    """First and last day of the period containing `anchor`. Weeks start on Monday."""
    if period == "day":
        return anchor, anchor
    if period == "week":
        start = anchor - timedelta(days=anchor.weekday())
        return start, start + timedelta(days=6)
    if period == "month":
        start = anchor.replace(day=1)
        next_month = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        return start, next_month - timedelta(days=1)
    return date(anchor.year, 1, 1), date(anchor.year, 12, 31)


def period_buckets(period: Period, start: date, end: date) -> list[tuple[date, date]]:
    """How to break a period down: by day for weeks and months, by month for years."""
    if period == "day":
        return []
    if period == "year":
        return [period_bounds("month", date(start.year, m, 1)) for m in range(1, 13)]
    days = [start + timedelta(days=n) for n in range((end - start).days + 1)]
    return [(d, d) for d in days]


def counts_by_product(db: Connection, query: str, params: tuple) -> dict[int, int]:
    return {r["product_id"]: r["n"] for r in db.execute(query, params).fetchall()}


@router.get("/history")
def history(
    period: Period = "week",
    anchor: date | None = Query(None, alias="date"),
    db: Connection = Depends(get_db),
):
    """Stock report for the day, week, month, or year containing `date` (default today).

    Per product: stock at the start (the previous day's snapshot), items added,
    used, and thrown out, and stock at the end. Usage follows the data
    dictionary: opening + added - closing - thrown out. Weeks and months are
    also broken down into end-of-day stock, years into end-of-month stock.
    """
    today = db.execute("SELECT current_date AS today").fetchone()["today"]
    start, end = period_bounds(period, min(anchor or today, today))
    last = min(end, today)  # No data after today.
    range_params = (start, last + timedelta(days=1))

    snapshots = db.execute(
        """
        SELECT product_id, snapshot_date, quantity
        FROM stock_snapshots
        WHERE snapshot_date BETWEEN %s AND %s
        """,
        (start - timedelta(days=1), last),
    ).fetchall()
    snapshot = {(s["product_id"], s["snapshot_date"]): s["quantity"] for s in snapshots}
    live = counts_by_product(
        db, "SELECT product_id, count(*)::int AS n FROM stock_items "
            "WHERE status = 'in_stock' GROUP BY product_id", ()
    )
    added = counts_by_product(
        db,
        """
        SELECT product_id, count(*)::int AS n
        FROM stock_items
        WHERE added_at >= %s AND added_at < %s
        GROUP BY product_id
        """,
        range_params,
    )
    wasted = counts_by_product(
        db,
        """
        SELECT s.product_id, count(*)::int AS n
        FROM waste_records w
        JOIN stock_items s ON s.item_id = w.item_id
        WHERE w.recorded_at >= %s AND w.recorded_at < %s
        GROUP BY s.product_id
        """,
        range_params,
    )

    first_snapshot = db.execute(
        "SELECT min(snapshot_date) AS first FROM stock_snapshots"
    ).fetchone()["first"]

    def stock_on(product_id: int, day: date) -> int | None:
        """End-of-day stock. Today's is the live count, and before tracking began
        it's 0. None if a day inside the tracked range has no snapshot."""
        if day >= today:
            return live.get(product_id, 0)
        if first_snapshot is None or day < first_snapshot:
            return 0
        return snapshot.get((product_id, day))

    buckets = period_buckets(period, start, end)
    products = db.execute(
        """
        SELECT c.category_id, c.name AS category, p.product_id, p.name AS product, p.unit,
               p.active
        FROM products p
        JOIN categories c ON c.category_id = p.category_id
        ORDER BY c.name, p.name
        """
    ).fetchall()
    totals = {"added": 0, "used": 0, "wasted": 0}
    for p in products:
        pid = p["product_id"]
        p["opening"] = stock_on(pid, start - timedelta(days=1))
        p["closing"] = stock_on(pid, last)
        p["added"] = added.get(pid, 0)
        p["wasted"] = wasted.get(pid, 0)
        p["used"] = (
            p["opening"] + p["added"] - p["closing"] - p["wasted"]
            if p["opening"] is not None and p["closing"] is not None
            else None
        )
        # Stock at the end of each bucket; None for buckets that haven't started.
        p["levels"] = [
            stock_on(pid, min(b_end, today)) if b_start <= today else None
            for b_start, b_end in buckets
        ]
        for key in totals:
            totals[key] += p[key] or 0

    waste_params = range_params + (WASTE_LOG_LIMIT,)
    waste = db.execute(
        """
        SELECT w.waste_id, w.recorded_at, w.reason, w.item_id,
               p.name AS product, u.name AS logged_by
        FROM waste_records w
        JOIN stock_items s ON s.item_id = w.item_id
        JOIN products p    ON p.product_id = s.product_id
        LEFT JOIN users u  ON u.user_id = w.user_id
        WHERE w.recorded_at >= %s AND w.recorded_at < %s
        ORDER BY w.recorded_at DESC
        LIMIT %s
        """,
        waste_params,
    ).fetchall()

    return {
        "period": period,
        "start": start,
        "end": end,
        "today": today,
        "previous": start - timedelta(days=1),
        "next": end + timedelta(days=1) if end < today else None,
        "buckets": [b_start for b_start, _ in buckets],
        "totals": totals,
        "categories": group_by_category(products),
        "waste": waste,
    }


@router.get("/alerts")
def alerts(db: Connection = Depends(get_db)):
    """Active alerts, then cleared ones, newest first."""
    rows = db.execute(
        f"""
        SELECT a.alert_id, a.alert_type, a.status, a.raised_at,
               a.product_id, a.item_id, r.row_id,
               p.name AS product,
               s.expiry_date,
               s.expiry_date - current_date AS days_left,
               f.name  AS fridge,
               r.label AS row_label,
               t.low_stock_threshold,
               coalesce(n.qty, 0) AS in_stock,
               rr.current_count,
               rr.current_weight_g,
               rr.listed_count,
               rr.min_weight_g,
               rr.max_weight_g
        FROM alerts a
        JOIN products p              ON p.product_id = a.product_id
        LEFT JOIN stock_items s      ON s.item_id = a.item_id
        -- Expiry alerts are located by their item's row; mismatch alerts name the row.
        LEFT JOIN rows r             ON r.row_id = coalesce(a.row_id, s.row_id)
        LEFT JOIN fridges f          ON f.fridge_id = r.fridge_id
        LEFT JOIN alert_thresholds t ON t.product_id = a.product_id
        LEFT JOIN ({IN_STOCK_COUNTS}) n ON n.product_id = a.product_id
        LEFT JOIN ({ROW_READINGS}) rr   ON rr.row_id = a.row_id
        ORDER BY a.raised_at DESC, a.alert_id DESC
        """
    ).fetchall()
    return {
        "active": [a for a in rows if a["status"] == "active"],
        "cleared": [a for a in rows if a["status"] == "cleared"],
    }


@router.post("/alerts/check")
def run_checks(db: Connection = Depends(get_db)):
    """Run the expiry, low-stock, and weight checks, and raise any new alerts.

    Readings, throw-outs, and rule changes run them too. The dashboard also runs
    them before showing alerts, since items reach their warning window with time.
    """
    counts = run_all_checks(db)
    return {"raised": sum(counts.values()), **counts}


@router.post("/alerts/{alert_id}/clear")
def clear_alert(alert_id: int, db: Connection = Depends(get_db)):
    """Mark an alert as seen. Clearing an already-cleared alert is a no-op."""
    alert = db.execute(
        "UPDATE alerts SET status = 'cleared' WHERE alert_id = %s RETURNING alert_id, status",
        (alert_id,),
    ).fetchone()
    if alert is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Alert not found.")
    return alert


@router.get("/rules")
def rules(db: Connection = Depends(get_db)):
    """Each product's alert limits, grouped by category."""
    rows = db.execute(
        """
        SELECT c.category_id, c.name AS category, p.product_id, p.name AS product, p.unit,
               t.low_stock_threshold,
               t.expiry_warning_days,
               t.updated_at
        FROM products p
        JOIN categories c            ON c.category_id = p.category_id
        LEFT JOIN alert_thresholds t ON t.product_id = p.product_id
        WHERE p.active
        ORDER BY c.name, p.name
        """
    ).fetchall()
    return {"default_expiry_warning_days": DEFAULT_EXPIRY_WARNING_DAYS,
            "categories": group_by_category(rows)}


class RuleUpdate(BaseModel):
    low_stock_threshold: int = Field(ge=0, le=10_000)
    expiry_warning_days: int = Field(ge=0, le=365)


@router.put("/rules/{product_id}")
def update_rule(product_id: int, body: RuleUpdate, db: Connection = Depends(get_db)):
    """Set a product's alert limits, creating them if the product has none yet."""
    if db.execute("SELECT 1 FROM products WHERE product_id = %s", (product_id,)).fetchone() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found.")
    with db.transaction():
        rule = db.execute(
            """
            INSERT INTO alert_thresholds (product_id, low_stock_threshold, expiry_warning_days, updated_at)
            VALUES (%s, %s, %s, now())
            ON CONFLICT (product_id) DO UPDATE
            SET low_stock_threshold = EXCLUDED.low_stock_threshold,
                expiry_warning_days = EXCLUDED.expiry_warning_days,
                updated_at          = now()
            RETURNING product_id, low_stock_threshold, expiry_warning_days, updated_at
            """,
            (product_id, body.low_stock_threshold, body.expiry_warning_days),
        ).fetchone()
        # New limits can put items in their warning window or the product below its threshold.
        run_all_checks(db)
    return rule


@router.delete("/rules/{product_id}")
def delete_rule(product_id: int, db: Connection = Depends(get_db)):
    """Remove a product's alert limits. It then gets no low-stock alerts, and expiry
    alerts use the default warning window."""
    deleted = db.execute(
        "DELETE FROM alert_thresholds WHERE product_id = %s RETURNING product_id", (product_id,)
    ).fetchone()
    if deleted is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That product has no alert rule.")
    return {"product_id": product_id, "deleted": True}


@router.get("/floor")
def floor(db: Connection = Depends(get_db)):
    """Every fridge with its rows and the items in each, for the floor plan and search."""
    fridges = db.execute(
        f"SELECT {FRIDGE_COLUMNS} FROM fridges ORDER BY fridge_id"
    ).fetchall()
    rows = db.execute(
        """
        SELECT r.fridge_id, r.row_id, r.label, r.current_weight_g, r.current_count,
               p.product_id, p.name AS product, p.unit, p.recognition_label, p.icon,
               c.name AS category
        FROM rows r
        LEFT JOIN products p   ON p.product_id = r.product_id
        LEFT JOIN categories c ON c.category_id = p.category_id
        ORDER BY r.fridge_id, r.label
        """
    ).fetchall()
    items = db.execute(
        """
        SELECT s.row_id, s.item_id, s.product_id, s.added_at::date AS added_on, s.expiry_date,
               s.expiry_date - current_date AS days_left,
               coalesce(t.expiry_warning_days, %s) AS warning_days
        FROM stock_items s
        LEFT JOIN alert_thresholds t ON t.product_id = s.product_id
        WHERE s.status = 'in_stock'
        ORDER BY s.expiry_date, s.item_id
        """,
        (DEFAULT_EXPIRY_WARNING_DAYS,),
    ).fetchall()
    alerts = db.execute(
        f"""
        SELECT a.alert_id, a.alert_type, a.product_id, a.item_id,
               coalesce(a.row_id, s.row_id) AS row_id,
               s.expiry_date - current_date AS days_left,
               t.low_stock_threshold,
               coalesce(n.qty, 0) AS in_stock,
               rr.current_weight_g, rr.min_weight_g, rr.max_weight_g
        FROM alerts a
        LEFT JOIN stock_items s      ON s.item_id = a.item_id
        LEFT JOIN alert_thresholds t ON t.product_id = a.product_id
        LEFT JOIN ({IN_STOCK_COUNTS}) n ON n.product_id = a.product_id
        LEFT JOIN ({ROW_READINGS}) rr   ON rr.row_id = a.row_id
        WHERE a.status = 'active'
        ORDER BY a.raised_at DESC, a.alert_id DESC
        """
    ).fetchall()

    by_row = {r["row_id"]: {**r, "items": [], "alerts": []} for r in rows}
    for item in items:
        item["status"] = expiry_status(item["days_left"], item.pop("warning_days"))
        by_row[item.pop("row_id")]["items"].append(item)
    # Expiry and mismatch alerts belong to one row; low-stock alerts to every
    # row holding the product.
    for alert in alerts:
        if alert["row_id"] is not None:
            targets = [by_row[alert["row_id"]]] if alert["row_id"] in by_row else []
        else:
            targets = [r for r in by_row.values() if r["product_id"] == alert["product_id"]]
        for row in targets:
            row["alerts"].append(alert)

    by_fridge = {f["fridge_id"]: {**f, "rows": []} for f in fridges}
    for row in by_row.values():
        by_fridge[row.pop("fridge_id")]["rows"].append(row)
    for fridge in by_fridge.values():
        fridge["active_alerts"] = len(
            {a["alert_id"] for row in fridge["rows"] for a in row["alerts"]}
        )
    return list(by_fridge.values())


# The kitchen floor plan's size, in plan units. Fridges must fit inside it.
PLAN_WIDTH = 1000
PLAN_HEIGHT = 620


class FridgeUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=60)
    location: str | None = Field(None, min_length=1, max_length=60)
    plan_x: int | None = Field(None, ge=0, le=PLAN_WIDTH)
    plan_y: int | None = Field(None, ge=0, le=PLAN_HEIGHT)
    plan_w: int | None = Field(None, ge=20, le=PLAN_WIDTH)
    plan_h: int | None = Field(None, ge=20, le=PLAN_HEIGHT)

    @field_validator("name", "location")
    @classmethod
    def not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("can't be blank")
        return value.strip() if value else value


@router.patch("/fridges/{fridge_id}")
def update_fridge(fridge_id: int, body: FridgeUpdate, db: Connection = Depends(get_db)):
    """Rename a fridge, or move or resize it on the floor plan."""
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Nothing to change.")
    with db.transaction():
        fridge = db.execute(
            f"SELECT {FRIDGE_COLUMNS} FROM fridges WHERE fridge_id = %s FOR UPDATE", (fridge_id,)
        ).fetchone()
        if fridge is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Fridge not found.")
        placed = {**fridge, **changes}
        if (
            placed["plan_x"] + placed["plan_w"] > PLAN_WIDTH
            or placed["plan_y"] + placed["plan_h"] > PLAN_HEIGHT
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"The fridge must fit inside the {PLAN_WIDTH} x {PLAN_HEIGHT} floor plan.",
            )
        assignments = sql.SQL(", ").join(
            sql.SQL("{} = %s").format(sql.Identifier(column)) for column in changes
        )
        return db.execute(
            sql.SQL("UPDATE fridges SET {} WHERE fridge_id = %s RETURNING {}").format(
                assignments, sql.SQL(FRIDGE_COLUMNS)
            ),
            (*changes.values(), fridge_id),
        ).fetchone()


class FridgeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    location: str = Field(min_length=1, max_length=60)
    plan_x: int = Field(ge=0, le=PLAN_WIDTH)
    plan_y: int = Field(ge=0, le=PLAN_HEIGHT)
    plan_w: int = Field(ge=20, le=PLAN_WIDTH)
    plan_h: int = Field(ge=20, le=PLAN_HEIGHT)
    shelves: int = Field(ge=1, le=10)
    rows_per_shelf: int = Field(ge=1, le=10)

    @field_validator("name", "location")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("can't be blank")
        return value.strip()


@router.post("/fridges", status_code=status.HTTP_201_CREATED)
def create_fridge(body: FridgeCreate, db: Connection = Depends(get_db)):
    """Add a fridge to the floor plan, with its shelves of empty rows.

    It stays offline until it sends its first reading.
    """
    if body.plan_x + body.plan_w > PLAN_WIDTH or body.plan_y + body.plan_h > PLAN_HEIGHT:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"The fridge must fit inside the {PLAN_WIDTH} x {PLAN_HEIGHT} floor plan.",
        )
    with db.transaction():
        fridge = db.execute(
            f"""
            INSERT INTO fridges (name, location, plan_x, plan_y, plan_w, plan_h)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING {FRIDGE_COLUMNS}
            """,
            (body.name, body.location, body.plan_x, body.plan_y, body.plan_w, body.plan_h),
        ).fetchone()
        db.execute(
            """
            INSERT INTO rows (fridge_id, label)
            SELECT %s, format('Shelf %%s, Row %%s', shelf, position)
            FROM generate_series(1, %s) AS shelf
            CROSS JOIN generate_series(1, %s) AS position
            ORDER BY shelf, position
            """,
            (fridge["fridge_id"], body.shelves, body.rows_per_shelf),
        )
    return {**fridge, "rows": body.shelves * body.rows_per_shelf}

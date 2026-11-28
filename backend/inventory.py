"""Product catalog management for managers: add, edit, remove, and restore products.

A product that has ever been stocked is archived rather than deleted when it's
removed (active = false), so stock history, waste records, and alerts keep
pointing at it. It leaves the catalog, its rows are unassigned, and the
recognition model's label for it stops matching.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from psycopg import Connection, errors, sql
from pydantic import BaseModel, Field, field_validator, model_validator

from auth import require_manager
from checks import run_all_checks
from db import get_db

router = APIRouter(
    prefix="/api/manager/products", tags=["inventory"], dependencies=[Depends(require_manager)]
)

PRODUCT_COLUMNS = """
    p.product_id, p.name, p.unit, p.unit_weight_g, p.package_weight_g, p.shelf_life_days,
    p.recognition_label, p.icon, p.active, p.category_id, c.name AS category
"""


@router.get("")
def list_products(db: Connection = Depends(get_db)):
    """Every product, active or removed, with what it's used for, plus the categories."""
    products = db.execute(
        f"""
        SELECT {PRODUCT_COLUMNS},
               t.low_stock_threshold, t.expiry_warning_days,
               (SELECT count(*)::int FROM stock_items s
                WHERE s.product_id = p.product_id AND s.status = 'in_stock') AS in_stock,
               (SELECT count(*)::int FROM rows r WHERE r.product_id = p.product_id) AS rows
        FROM products p
        JOIN categories c            ON c.category_id = p.category_id
        LEFT JOIN alert_thresholds t ON t.product_id = p.product_id
        ORDER BY c.name, p.name
        """
    ).fetchall()
    categories = db.execute("SELECT category_id, name FROM categories ORDER BY name").fetchall()
    return {"products": products, "categories": categories}


def clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        raise ValueError("can't be blank")
    return value


class ProductFields(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    category_id: int | None = None
    new_category: str | None = Field(None, max_length=60, description="Create this category instead.")
    unit: str | None = Field(None, min_length=1, max_length=30)
    unit_weight_g: int | None = Field(None, ge=1, le=100_000)
    package_weight_g: int | None = Field(None, ge=0, le=100_000)
    shelf_life_days: int | None = Field(None, ge=0, le=3650)
    recognition_label: str | None = Field(
        None, min_length=1, max_length=80, pattern=r"^[a-z0-9_]+$",
        description="Lowercase letters, digits, and underscores.",
    )
    icon: int | None = Field(
        None, ge=0, le=63,
        description="Tile in the food sprite sheet, row by row. Send null to clear it.",
    )

    @field_validator("name", "unit", "new_category", "recognition_label", mode="before")
    @classmethod
    def strip_text(cls, value):
        return clean_text(value) if isinstance(value, str) else value


class ProductCreate(ProductFields):
    name: str = Field(min_length=1, max_length=80)
    unit: str = Field(min_length=1, max_length=30)
    unit_weight_g: int = Field(ge=1, le=100_000)
    package_weight_g: int = Field(ge=0, le=100_000)
    shelf_life_days: int = Field(ge=0, le=3650)
    recognition_label: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_]+$")
    # Optional alert rule for the new product.
    low_stock_threshold: int | None = Field(None, ge=0, le=10_000)
    expiry_warning_days: int | None = Field(None, ge=0, le=365)

    @model_validator(mode="after")
    def needs_category(self):
        if (self.category_id is None) == (self.new_category is None):
            raise ValueError("Choose a category, or name a new one.")
        if (self.low_stock_threshold is None) != (self.expiry_warning_days is None):
            raise ValueError("Set both alert limits, or neither.")
        return self


def resolve_category(db: Connection, body: ProductFields) -> int | None:
    """The category ID to use: an existing one, or a new one created by name."""
    if body.new_category:
        existing = db.execute(
            "SELECT category_id FROM categories WHERE lower(name) = lower(%s)", (body.new_category,)
        ).fetchone()
        if existing:
            return existing["category_id"]
        return db.execute(
            "INSERT INTO categories (name) VALUES (%s) RETURNING category_id", (body.new_category,)
        ).fetchone()["category_id"]
    if body.category_id is not None:
        if db.execute(
            "SELECT 1 FROM categories WHERE category_id = %s", (body.category_id,)
        ).fetchone() is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That category doesn't exist.")
    return body.category_id


def fetch_product(db: Connection, product_id: int) -> dict:
    product = db.execute(
        f"""
        SELECT {PRODUCT_COLUMNS}
        FROM products p JOIN categories c ON c.category_id = p.category_id
        WHERE p.product_id = %s
        """,
        (product_id,),
    ).fetchone()
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Product not found.")
    return product


def check_weights(unit_weight_g: int, package_weight_g: int) -> None:
    if unit_weight_g <= package_weight_g:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "A full unit must weigh more than its empty packaging.",
        )


def label_taken() -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT, "Another product already uses that recognition label."
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_product(body: ProductCreate, db: Connection = Depends(get_db)):
    """Add a product to the catalog, with an alert rule if limits are given."""
    check_weights(body.unit_weight_g, body.package_weight_g)
    try:
        with db.transaction():
            category_id = resolve_category(db, body)
            product_id = db.execute(
                """
                INSERT INTO products (category_id, name, unit, unit_weight_g, package_weight_g,
                                      shelf_life_days, recognition_label, icon)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING product_id
                """,
                (category_id, body.name, body.unit, body.unit_weight_g, body.package_weight_g,
                 body.shelf_life_days, body.recognition_label, body.icon),
            ).fetchone()["product_id"]
            if body.low_stock_threshold is not None:
                db.execute(
                    """
                    INSERT INTO alert_thresholds (product_id, low_stock_threshold, expiry_warning_days)
                    VALUES (%s, %s, %s)
                    """,
                    (product_id, body.low_stock_threshold, body.expiry_warning_days),
                )
    except errors.UniqueViolation as e:
        raise label_taken() from e
    return fetch_product(db, product_id)


@router.patch("/{product_id}")
def update_product(product_id: int, body: ProductFields, db: Connection = Depends(get_db)):
    """Change a product's details."""
    if body.category_id is not None and body.new_category is not None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a category, or name a new one, not both."
        )
    try:
        with db.transaction():
            current = fetch_product(db, product_id)
            changes = body.model_dump(exclude_none=True, exclude={"new_category"})
            # An icon sent as null means "no icon", not "unchanged".
            if "icon" in body.model_fields_set:
                changes["icon"] = body.icon
            category_id = resolve_category(db, body)
            if category_id is not None:
                changes["category_id"] = category_id
            if not changes:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Nothing to change.")
            check_weights(
                changes.get("unit_weight_g", current["unit_weight_g"]),
                changes.get("package_weight_g", current["package_weight_g"]),
            )
            db.execute(
                sql.SQL("UPDATE products SET {} WHERE product_id = %s").format(
                    sql.SQL(", ").join(
                        sql.SQL("{} = %s").format(sql.Identifier(k)) for k in changes
                    )
                ),
                (*changes.values(), product_id),
            )
            # New weights change what the scales should read.
            run_all_checks(db)
    except errors.UniqueViolation as e:
        raise label_taken() from e
    return fetch_product(db, product_id)


@router.delete("/{product_id}")
def remove_product(product_id: int, db: Connection = Depends(get_db)):
    """Remove a product from the catalog.

    Refused while items are in stock. A product with history is archived;
    one that was never stocked is deleted.
    """
    with db.transaction():
        product = fetch_product(db, product_id)
        in_stock = db.execute(
            "SELECT count(*)::int AS n FROM stock_items WHERE product_id = %s AND status = 'in_stock'",
            (product_id,),
        ).fetchone()["n"]
        if in_stock:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"{product['name']} still has {in_stock} item{'s' if in_stock != 1 else ''} in stock. "
                "Take them out of the fridges first.",
            )
        has_history = db.execute(
            """
            SELECT EXISTS (SELECT 1 FROM stock_items WHERE product_id = %(id)s)
                OR EXISTS (SELECT 1 FROM stock_snapshots WHERE product_id = %(id)s)
                OR EXISTS (SELECT 1 FROM alerts WHERE product_id = %(id)s) AS has_history
            """,
            {"id": product_id},
        ).fetchone()["has_history"]

        db.execute("UPDATE rows SET product_id = NULL WHERE product_id = %s", (product_id,))
        if has_history:
            db.execute("UPDATE products SET active = false WHERE product_id = %s", (product_id,))
            db.execute(
                "UPDATE alerts SET status = 'cleared' WHERE product_id = %s AND status = 'active'",
                (product_id,),
            )
            return {"product_id": product_id, "removed": "archived"}
        db.execute("DELETE FROM products WHERE product_id = %s", (product_id,))  # cascades its rule
        return {"product_id": product_id, "removed": "deleted"}


@router.post("/{product_id}/restore")
def restore_product(product_id: int, db: Connection = Depends(get_db)):
    """Put a removed product back in the catalog."""
    fetch_product(db, product_id)
    db.execute("UPDATE products SET active = true WHERE product_id = %s", (product_id,))
    return fetch_product(db, product_id)

"""Product catalog API."""

from fastapi import APIRouter, Depends
from psycopg import Connection

from db import get_db

router = APIRouter(prefix="/api/products", tags=["catalog"])


@router.get("")
def list_products(db: Connection = Depends(get_db)):
    """The catalog: every active product with its category, weights, and recognition label.

    Fridges pull this to set up which product each row holds.
    """
    return db.execute(
        """
        SELECT p.product_id, p.name, p.unit, p.unit_weight_g, p.package_weight_g,
               p.shelf_life_days, p.recognition_label, p.icon, c.name AS category
        FROM products p
        JOIN categories c ON c.category_id = p.category_id
        WHERE p.active
        ORDER BY c.name, p.name
        """
    ).fetchall()

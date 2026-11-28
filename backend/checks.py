"""Stock checks that raise alerts: Level-0 process 3.0, Manage Expiry and Stock Alerts.

Alerts stay active until a manager clears it (data dictionary), so the checks
only raise them. Each is safe to run often and at the same time as itself.
"""

from psycopg import Connection

# Allowance for scale noise, in grams.
WEIGHT_TOLERANCE_G = 20

# Used when a product has no alert threshold set.
DEFAULT_EXPIRY_WARNING_DAYS = 2

# Each assigned row's latest sensor reading next to the items listed in it.
# A row holds at most one opened item, so n listed items weigh between
# (n - 1) full units plus one empty package, and n full units.
ROW_READINGS = """
    SELECT r.row_id,
           r.product_id,
           r.current_count,
           r.current_weight_g,
           r.updated_at,
           coalesce(n.listed, 0) AS listed_count,
           CASE WHEN coalesce(n.listed, 0) = 0 THEN 0
                ELSE (n.listed - 1) * p.unit_weight_g + p.package_weight_g
           END AS min_weight_g,
           coalesce(n.listed, 0) * p.unit_weight_g AS max_weight_g
    FROM rows r
    JOIN products p ON p.product_id = r.product_id
    LEFT JOIN (
        SELECT row_id, count(*)::int AS listed
        FROM stock_items
        WHERE status = 'in_stock'
        GROUP BY row_id
    ) n ON n.row_id = r.row_id
"""

# True when a ROW_READINGS row's reading doesn't fit its listed items.
IS_MISMATCH = f"""
    (current_count <> listed_count
     OR current_weight_g < min_weight_g - {WEIGHT_TOLERANCE_G}
     OR current_weight_g > max_weight_g + {WEIGHT_TOLERANCE_G})
"""


def check_stock_mismatches(db: Connection) -> int:
    """Raise a stock_mismatch alert for each row whose reading doesn't match its listed items.

    A row isn't flagged again while it has an active mismatch alert, or after
    an alert for its current reading was cleared. A new reading (a later
    updated_at) can flag it again. Returns the number of alerts raised.
    """
    return db.execute(
        f"""
        INSERT INTO alerts (product_id, row_id, alert_type)
        SELECT rr.product_id, rr.row_id, 'stock_mismatch'
        FROM ({ROW_READINGS}) rr
        WHERE {IS_MISMATCH}
          AND NOT EXISTS (
              SELECT 1
              FROM alerts a
              WHERE a.row_id = rr.row_id
                AND a.alert_type = 'stock_mismatch'
                AND (a.status = 'active' OR a.raised_at >= rr.updated_at)
          )
        -- Another check running at the same moment may have just raised it.
        ON CONFLICT (row_id) WHERE status = 'active' AND alert_type = 'stock_mismatch'
        DO NOTHING
        """
    ).rowcount


def check_expiry(db: Connection) -> int:
    """Raise an expiry alert for each in-stock item inside its product's warning window.

    Each item gets at most one expiry alert, even after it's cleared.
    """
    return db.execute(
        """
        INSERT INTO alerts (product_id, item_id, alert_type)
        SELECT s.product_id, s.item_id, 'expiry'
        FROM stock_items s
        LEFT JOIN alert_thresholds t ON t.product_id = s.product_id
        WHERE s.status = 'in_stock'
          AND s.expiry_date - current_date <= coalesce(t.expiry_warning_days, %s)
          AND NOT EXISTS (
              SELECT 1 FROM alerts a WHERE a.item_id = s.item_id AND a.alert_type = 'expiry'
          )
        ON CONFLICT (item_id) WHERE status = 'active' AND alert_type = 'expiry'
        DO NOTHING
        """,
        (DEFAULT_EXPIRY_WARNING_DAYS,),
    ).rowcount


def check_low_stock(db: Connection) -> int:
    """Raise a low_stock alert for each product at or below its threshold.

    A product isn't flagged again while it has an active low-stock alert. Once
    cleared, it's flagged again only after new stock arrives and runs low again.
    Products without a threshold are never flagged.
    """
    return db.execute(
        """
        INSERT INTO alerts (product_id, alert_type)
        SELECT t.product_id, 'low_stock'
        FROM alert_thresholds t
        JOIN products p ON p.product_id = t.product_id AND p.active
        LEFT JOIN (
            SELECT product_id, count(*) AS qty
            FROM stock_items
            WHERE status = 'in_stock'
            GROUP BY product_id
        ) n ON n.product_id = t.product_id
        WHERE coalesce(n.qty, 0) <= t.low_stock_threshold
          AND NOT EXISTS (
              SELECT 1
              FROM alerts a
              WHERE a.product_id = t.product_id
                AND a.alert_type = 'low_stock'
                AND (a.status = 'active'
                     OR a.raised_at >= coalesce(
                         (SELECT max(x.added_at) FROM stock_items x WHERE x.product_id = t.product_id),
                         '-infinity'))
          )
        ON CONFLICT (product_id) WHERE status = 'active' AND alert_type = 'low_stock'
        DO NOTHING
        """
    ).rowcount


def run_all_checks(db: Connection) -> dict[str, int]:
    """Run every check. Returns how many alerts of each type were raised."""
    return {
        "expiry": check_expiry(db),
        "low_stock": check_low_stock(db),
        "stock_mismatch": check_stock_mismatches(db),
    }

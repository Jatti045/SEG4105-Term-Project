-- Sample data for local development.
-- Dates are relative to when the database is first created, so the dashboard
-- shows a mix of fresh, expiring, and expired items. Reset with
-- `docker compose down -v` to refresh them.

BEGIN;

-- Users ----------------------------------------------------------------------

INSERT INTO users (name, email, role) VALUES
    ('Morgan Lee',  'morgan.lee@example.com',  'manager'),
    ('Sam Patel',   'sam.patel@example.com',   'kitchen_staff'),
    ('Jordan Kim',  'jordan.kim@example.com',  'purchasing_staff');

INSERT INTO notification_preferences (user_id, alert_type, channel)
SELECT u.user_id, t.alert_type, c.channel
FROM users u
CROSS JOIN (VALUES ('expiry'), ('low_stock')) AS t (alert_type)
CROSS JOIN (VALUES ('email'), ('dashboard')) AS c (channel)
WHERE u.role = 'manager';

-- Product catalog ------------------------------------------------------------

INSERT INTO categories (name) VALUES
    ('Dairy'), ('Produce'), ('Meat & Seafood'), ('Prepared Foods');

INSERT INTO products (category_id, name, unit, unit_weight_g, package_weight_g, shelf_life_days, recognition_label)
SELECT c.category_id, p.name, p.unit, p.unit_weight_g, p.package_weight_g, p.shelf_life_days, p.label
FROM (VALUES
    ('Dairy',          'Milk 2L',             'carton',    2100, 60, 10, 'milk_2l'),
    ('Dairy',          'Greek Yogurt 750g',   'tub',        800, 40, 21, 'greek_yogurt_750g'),
    ('Dairy',          'Cheddar Block 400g',  'pack',       420, 15, 30, 'cheddar_block_400g'),
    ('Produce',        'Baby Spinach 312g',   'bag',        330, 18,  5, 'baby_spinach_312g'),
    ('Produce',        'Romaine Lettuce',     'head',       650,  5,  7, 'romaine_lettuce'),
    ('Produce',        'Fresh Basil',         'bunch',       60,  5,  4, 'fresh_basil'),
    ('Meat & Seafood', 'Chicken Breast 1kg',  'pack',      1050, 50,  3, 'chicken_breast_1kg'),
    ('Meat & Seafood', 'Salmon Fillet 500g',  'pack',       530, 30,  2, 'salmon_fillet_500g'),
    ('Prepared Foods', 'Tomato Sauce 1L',     'container', 1080, 80,  5, 'tomato_sauce_1l')
) AS p (category, name, unit, unit_weight_g, package_weight_g, shelf_life_days, label)
JOIN categories c ON c.name = p.category;

-- Icons: tiles in frontend/public/sprites/food.png, numbered row by row (row * 8 + column).
UPDATE products p
SET icon = i.icon
FROM (VALUES
    ('milk_2l', 2), ('greek_yogurt_750g', 5), ('cheddar_block_400g', 24),
    ('baby_spinach_312g', 14), ('romaine_lettuce', 39), ('fresh_basil', 29),
    ('chicken_breast_1kg', 50), ('salmon_fillet_500g', 42), ('tomato_sauce_1l', 8)
) AS i (label, icon)
WHERE p.recognition_label = i.label;

INSERT INTO alert_thresholds (product_id, low_stock_threshold, expiry_warning_days)
SELECT product_id,
       2,
       CASE WHEN shelf_life_days <= 3 THEN 1 ELSE 2 END
FROM products;

-- Fridges and rows -----------------------------------------------------------

INSERT INTO fridges (name, location, status, last_reading_at, plan_x, plan_y, plan_w, plan_h) VALUES
    ('Walk-in 1', 'Main kitchen', 'online', now(), 820, 36, 150, 120),
    ('Reach-in 2', 'Prep line',   'online', now(), 880, 410, 90, 170);

INSERT INTO rows (fridge_id, product_id, label)
SELECT f.fridge_id, p.product_id, r.label
FROM (VALUES
    ('Walk-in 1',  'Shelf 1, Row 1', 'Milk 2L'),
    ('Walk-in 1',  'Shelf 1, Row 2', 'Greek Yogurt 750g'),
    ('Walk-in 1',  'Shelf 2, Row 1', 'Cheddar Block 400g'),
    ('Walk-in 1',  'Shelf 2, Row 2', 'Chicken Breast 1kg'),
    ('Walk-in 1',  'Shelf 3, Row 1', 'Salmon Fillet 500g'),
    ('Walk-in 1',  'Shelf 3, Row 2', NULL),
    ('Reach-in 2', 'Shelf 1, Row 1', 'Baby Spinach 312g'),
    ('Reach-in 2', 'Shelf 1, Row 2', 'Romaine Lettuce'),
    ('Reach-in 2', 'Shelf 2, Row 1', 'Fresh Basil'),
    ('Reach-in 2', 'Shelf 2, Row 2', 'Tomato Sauce 1L')
) AS r (fridge, label, product)
JOIN fridges f ON f.name = r.fridge
LEFT JOIN products p ON p.name = r.product;

-- Stock items ----------------------------------------------------------------
-- Each lot is `qty` items added `days_ago` days ago. Expiry = entry date + shelf life.

INSERT INTO stock_items (product_id, row_id, added_at, expiry_date)
SELECT r.product_id,
       r.row_id,
       now() - make_interval(days => l.days_ago),
       (current_date - l.days_ago) + p.shelf_life_days
FROM (VALUES
    ('Walk-in 1',  'Shelf 1, Row 1', 9, 2),   -- milk, expires tomorrow
    ('Walk-in 1',  'Shelf 1, Row 1', 2, 4),
    ('Walk-in 1',  'Shelf 1, Row 2', 5, 3),
    ('Walk-in 1',  'Shelf 2, Row 1', 10, 2),
    ('Walk-in 1',  'Shelf 2, Row 2', 3, 2),   -- chicken, expires today
    ('Walk-in 1',  'Shelf 2, Row 2', 1, 3),
    ('Walk-in 1',  'Shelf 3, Row 1', 3, 1),   -- salmon, expired yesterday
    ('Reach-in 2', 'Shelf 1, Row 1', 3, 2),
    ('Reach-in 2', 'Shelf 1, Row 2', 1, 4),
    ('Reach-in 2', 'Shelf 2, Row 1', 5, 1),   -- basil, expired yesterday
    ('Reach-in 2', 'Shelf 2, Row 2', 1, 3)
) AS l (fridge, row_label, days_ago, qty)
JOIN fridges f ON f.name = l.fridge
JOIN rows r ON r.fridge_id = f.fridge_id AND r.label = l.row_label
JOIN products p ON p.product_id = r.product_id
CROSS JOIN generate_series(1, l.qty);

-- Older stock that has since been used up: for each product, 3 items added
-- 12 days ago and used 9, 7, and 5 days ago. Gives the history a rise and fall.
INSERT INTO stock_items (product_id, row_id, added_at, expiry_date, status, removed_at)
SELECT r.product_id, r.row_id, now() - interval '12 days',
       current_date - 12 + p.shelf_life_days, 'consumed',
       now() - make_interval(days => 3 + n * 2)
FROM rows r
JOIN products p ON p.product_id = r.product_id
CROSS JOIN generate_series(1, 3) AS n;

-- A little more history: one milk carton used up, one spinach bag thrown out.
INSERT INTO stock_items (product_id, row_id, added_at, expiry_date, status, removed_at)
SELECT r.product_id, r.row_id, now() - interval '6 days',
       current_date - 6 + p.shelf_life_days, h.status, now() - interval '1 day'
FROM (VALUES
    ('Walk-in 1',  'Shelf 1, Row 1', 'consumed'),
    ('Reach-in 2', 'Shelf 1, Row 1', 'wasted')
) AS h (fridge, row_label, status)
JOIN fridges f ON f.name = h.fridge
JOIN rows r ON r.fridge_id = f.fridge_id AND r.label = h.row_label
JOIN products p ON p.product_id = r.product_id;

INSERT INTO waste_records (item_id, user_id, reason, recorded_at)
SELECT s.item_id, u.user_id, 'expired', s.removed_at
FROM stock_items s
CROSS JOIN users u
WHERE s.status = 'wasted' AND u.email = 'sam.patel@example.com';

-- Row readings match the items now in each row.
UPDATE rows r
SET current_count    = s.qty,
    current_weight_g = s.qty * p.unit_weight_g
FROM (
    SELECT row_id, count(*)::int AS qty
    FROM stock_items
    WHERE status = 'in_stock'
    GROUP BY row_id
) s,
products p
WHERE s.row_id = r.row_id AND p.product_id = r.product_id;

-- Two readings that don't match the listed items, for the weight check to catch:
-- the yogurt row counts one tub fewer than listed, and the tomato sauce row
-- weighs far less than its three listed containers could.
UPDATE rows r
SET current_count = r.current_count - 1,
    current_weight_g = r.current_weight_g - p.unit_weight_g
FROM products p
WHERE p.product_id = r.product_id AND p.name = 'Greek Yogurt 750g';

UPDATE rows r
SET current_weight_g = 1500
FROM products p
WHERE p.product_id = r.product_id AND p.name = 'Tomato Sauce 1L';

-- A year of older history ---------------------------------------------------
-- Regular deliveries of every product from a year ago until about three weeks
-- ago. Each item is used up within its shelf life (at most 10 days), and about
-- 1 in 12 is thrown out instead. The fixed random seed gives the same history
-- on every reset.

SELECT setseed(0.4105);

WITH deliveries AS (
    SELECT r.row_id,
           p.product_id,
           p.shelf_life_days,
           least(p.shelf_life_days, 10) AS use_days,
           d + make_interval(hours => 6 + floor(random() * 10)::int) AS added_at,
           2 + floor(random() * 4)::int AS qty
    FROM rows r
    JOIN products p ON p.product_id = r.product_id
    CROSS JOIN LATERAL generate_series(
        (current_date - 365)::timestamp,
        (current_date - 13 - least(p.shelf_life_days, 10))::timestamp,
        make_interval(days => greatest(2, least(7, p.shelf_life_days / 2)))
    ) AS d
),
items AS (
    SELECT dl.*, random() < 0.08 AS wasted, random() AS used_after
    FROM deliveries dl
    CROSS JOIN LATERAL generate_series(1, dl.qty)
)
INSERT INTO stock_items (product_id, row_id, added_at, expiry_date, status, removed_at)
SELECT product_id,
       row_id,
       added_at,
       added_at::date + shelf_life_days,
       CASE WHEN wasted THEN 'wasted' ELSE 'consumed' END,
       CASE WHEN wasted THEN added_at + make_interval(days => use_days)
            ELSE added_at + make_interval(secs => (0.15 + 0.85 * used_after) * use_days * 86400)
       END
FROM items;

-- Waste records for those thrown-out items. Every third one was spotted by
-- the system rather than logged by staff.
INSERT INTO waste_records (item_id, user_id, reason, recorded_at)
SELECT s.item_id,
       CASE WHEN s.item_id % 3 = 0 THEN NULL ELSE u.user_id END,
       CASE WHEN s.removed_at::date >= s.expiry_date THEN 'expired'
            WHEN s.item_id % 4 = 0 THEN 'damaged'
            ELSE 'spoiled'
       END,
       s.removed_at
FROM stock_items s
CROSS JOIN users u
WHERE s.status = 'wasted'
  AND u.email = 'sam.patel@example.com'
  AND NOT EXISTS (SELECT 1 FROM waste_records w WHERE w.item_id = s.item_id);

-- Stock history --------------------------------------------------------------
-- End-of-day quantity for each of the last 365 days, rebuilt from the items above.

INSERT INTO stock_snapshots (snapshot_date, product_id, quantity, recorded_at)
SELECT d::date,
       p.product_id,
       count(s.item_id) FILTER (
           WHERE s.added_at < d + interval '1 day'
             AND (s.removed_at IS NULL OR s.removed_at >= d + interval '1 day')
       ),
       d + interval '23 hours 59 minutes'
FROM generate_series((current_date - 365)::timestamp, (current_date - 1)::timestamp, interval '1 day') AS d
CROSS JOIN products p
LEFT JOIN stock_items s ON s.product_id = p.product_id
GROUP BY d, p.product_id;

-- Alerts ---------------------------------------------------------------------
-- What the alert job would have raised for the stock above.

-- Expiry: each in-stock item inside its product's warning window.
INSERT INTO alerts (product_id, item_id, alert_type, raised_at)
SELECT s.product_id, s.item_id, 'expiry',
       greatest(s.added_at, (s.expiry_date - t.expiry_warning_days)::timestamptz)
FROM stock_items s
JOIN alert_thresholds t ON t.product_id = s.product_id
WHERE s.status = 'in_stock'
  AND s.expiry_date - current_date <= t.expiry_warning_days;

-- Low stock: each product at or below its threshold.
INSERT INTO alerts (product_id, alert_type, raised_at)
SELECT t.product_id, 'low_stock', now() - interval '3 hours'
FROM alert_thresholds t
LEFT JOIN (
    SELECT product_id, count(*) AS qty
    FROM stock_items
    WHERE status = 'in_stock'
    GROUP BY product_id
) s ON s.product_id = t.product_id
WHERE coalesce(s.qty, 0) <= t.low_stock_threshold;

-- Cleared: the expiry alert for the spinach bag thrown out yesterday.
INSERT INTO alerts (product_id, item_id, alert_type, status, raised_at)
SELECT product_id, item_id, 'expiry', 'cleared', removed_at - interval '1 day'
FROM stock_items
WHERE status = 'wasted'
ORDER BY removed_at DESC
LIMIT 1;

COMMIT;

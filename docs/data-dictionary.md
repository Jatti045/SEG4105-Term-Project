# Data Dictionary

Smart Inventory Fridge · 0.1-draft. Generated from [diagrams/erd.json](diagrams/erd.json) by `diagrams/build_data_dictionary.py`. Edit the JSON file, not this page.

Each entity belongs to one Level-0 data store, so its tables can be traced back to the data flow diagram.

## Entities

| Entity | Data store | Description |
|---|---|---|
| [Fridge](#fridge) | D1 Inventory | A smart fridge unit (simulated in this project). |
| [Row](#row) | D1 Inventory | One sensor row on a shelf. Holds one product at a time and reports its weight and an image. |
| [StockItem](#stockitem) | D1 Inventory | One physical item in the fridge, e.g. one head of lettuce. Each has its own entry and expiry date. |
| [Category](#category) | D2 Product Catalog | A group of products, used to organize the catalog and reports. |
| [Product](#product) | D2 Product Catalog | A kind of item the system can recognize, e.g. Milk 2L. |
| [AlertThreshold](#alertthreshold) | D3 Alert Settings | Alert limits for one product. |
| [NotificationPreference](#notificationpreference) | D3 Alert Settings | How one user wants to receive one type of alert. |
| [WasteRecord](#wasterecord) | D4 Stock History | An item that was thrown out instead of used, e.g. because it expired. Used for waste tracking and reports. |
| [StockSnapshot](#stocksnapshot) | D4 Stock History | Each product's stock level at the end of a day. Daily usage = previous day's quantity + items added that day - this quantity - items wasted that day. |
| [Alert](#alert) | D5 Alerts | An expiry, low-stock, or stock mismatch alert. A stock mismatch means a row's sensor reading doesn't match the items listed in it. Stays active until a manager clears it. |
| [User](#user) | D6 Users | A staff member who uses the dashboard and receives alerts. |

## Data types

| Type | Format |
|---|---|
| `int` | Whole number. Single-column `*_id` primary keys are assigned automatically. |
| `string` | Text (UTF-8). |
| `date` | Calendar date, `YYYY-MM-DD`. |
| `datetime` | Timestamp in UTC, ISO 8601, e.g. `2026-11-27T14:04:58Z`. |
| `bool` | `true` or `false`. |

**Key:** PK = primary key, FK = foreign key. **Required:** No means the value can be empty.

## Fridge

**Data store:** D1 Inventory  
A smart fridge unit (simulated in this project).

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `fridge_id` | `int` | PK | Yes |  | Unique fridge identifier. |
| `name` | `string` |  | Yes |  | Display name, e.g. Walk-in 1. |
| `location` | `string` |  | Yes |  | Room the fridge is in, e.g. Main kitchen. Set from where it sits on the floor plan. |
| `status` | `string` |  | Yes |  | online or offline, based on when the last reading arrived. |
| `last_reading_at` | `datetime` |  | No |  | When the last reading arrived. Empty until the first reading. |
| `plan_x` | `int` |  | Yes |  | Left edge on the kitchen floor plan, in plan units (the plan is 1000 x 620). |
| `plan_y` | `int` |  | Yes |  | Top edge on the kitchen floor plan, in plan units. |
| `plan_w` | `int` |  | Yes |  | Width on the kitchen floor plan, in plan units. |
| `plan_h` | `int` |  | Yes |  | Height on the kitchen floor plan, in plan units. |

## Row

**Data store:** D1 Inventory  
One sensor row on a shelf. Holds one product at a time and reports its weight and an image.

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `row_id` | `int` | PK | Yes |  | Unique row identifier. |
| `fridge_id` | `int` | FK | Yes | Fridge.fridge_id | Fridge the row is in. |
| `product_id` | `int` | FK | No | Product.product_id | Product the row is set up for, from the fridge's configuration. Empty if the row is unassigned. |
| `label` | `string` |  | Yes |  | Physical position, e.g. Shelf 2, Row 3. |
| `current_weight_g` | `int` |  | Yes |  | Latest weight reading in grams. |
| `current_count` | `int` |  | Yes |  | Item count estimated from the latest weight reading. |
| `updated_at` | `datetime` |  | Yes |  | When the latest reading was applied. |

## StockItem

**Data store:** D1 Inventory  
One physical item in the fridge, e.g. one head of lettuce. Each has its own entry and expiry date.

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `item_id` | `int` | PK | Yes |  | Unique item identifier. |
| `product_id` | `int` | FK | Yes | Product.product_id | What the item is, from the product catalog. |
| `row_id` | `int` | FK | Yes | Row.row_id | Row the item is stored in. |
| `added_at` | `datetime` |  | Yes |  | Entry date: when the item was first detected in the fridge. |
| `expiry_date` | `date` |  | Yes |  | Entry date plus the product's shelf life, unless staff enter a different date. |
| `status` | `string` |  | Yes |  | in_stock, consumed, wasted, or removed (taken out when the row was set up for another product). |
| `removed_at` | `datetime` |  | No |  | When the item left the fridge. Empty while in stock. |

## Category

**Data store:** D2 Product Catalog  
A group of products, used to organize the catalog and reports.

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `category_id` | `int` | PK | Yes |  | Unique category identifier. |
| `name` | `string` |  | Yes |  | Category name, e.g. Dairy or Produce. |

## Product

**Data store:** D2 Product Catalog  
A kind of item the system can recognize, e.g. Milk 2L.

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `product_id` | `int` | PK | Yes |  | Unique product identifier. |
| `category_id` | `int` | FK | Yes | Category.category_id | Category the product belongs to. |
| `name` | `string` |  | Yes |  | Display name, e.g. Milk 2L. |
| `unit` | `string` |  | Yes |  | Counting unit, e.g. carton, tub, or bag. |
| `unit_weight_g` | `int` |  | Yes |  | Weight of one full, unopened unit in grams, including packaging. Used to estimate the item count from a row's weight. |
| `package_weight_g` | `int` |  | Yes |  | Weight of the empty packaging in grams. Used to estimate how much of a partly used item is left: (measured weight - package_weight_g) / (unit_weight_g - package_weight_g). |
| `shelf_life_days` | `int` |  | Yes |  | Typical days until expiry after stocking. Used to estimate a lot's expiry date. |
| `recognition_label` | `string` |  | Yes |  | Label the image recognition model outputs for this product. Unique. |
| `active` | `bool` |  | Yes |  | Whether the product is in the catalog. A removed product keeps its history but can't be assigned to rows. |
| `icon` | `int` |  | No |  | Tile in the food sprite sheet shown for the product: 0 to 63, row by row. Empty for no icon. |

## AlertThreshold

**Data store:** D3 Alert Settings  
Alert limits for one product.

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `product_id` | `int` | PK, FK | Yes | Product.product_id | Product these limits apply to. |
| `low_stock_threshold` | `int` |  | Yes |  | Raise a low-stock alert when the total quantity is at or below this. |
| `expiry_warning_days` | `int` |  | Yes |  | Raise an expiry alert this many days before a lot expires. |
| `updated_at` | `datetime` |  | Yes |  | When the limits were last changed. |

## NotificationPreference

**Data store:** D3 Alert Settings  
How one user wants to receive one type of alert.

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `preference_id` | `int` | PK | Yes |  | Unique preference identifier. |
| `user_id` | `int` | FK | Yes | User.user_id | User the preference belongs to. |
| `alert_type` | `string` |  | Yes |  | expiry, low_stock, or stock_mismatch. |
| `channel` | `string` |  | Yes |  | email or dashboard. |
| `enabled` | `bool` |  | Yes |  | Whether alerts of this type are sent on this channel. |

## WasteRecord

**Data store:** D4 Stock History  
An item that was thrown out instead of used, e.g. because it expired. Used for waste tracking and reports.

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `waste_id` | `int` | PK | Yes |  | Unique waste record identifier. |
| `item_id` | `int` | FK | Yes | StockItem.item_id | Item that was thrown out. |
| `user_id` | `int` | FK | No | User.user_id | Staff member who logged it. Empty when the system detected it, e.g. an expired item removed from the fridge. |
| `reason` | `string` |  | Yes |  | expired, spoiled, damaged, or other. |
| `recorded_at` | `datetime` |  | Yes |  | When the item was thrown out. |

## StockSnapshot

**Data store:** D4 Stock History  
Each product's stock level at the end of a day. Daily usage = previous day's quantity + items added that day - this quantity - items wasted that day.

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `snapshot_date` | `date` | PK | Yes |  | Day the snapshot was taken. |
| `product_id` | `int` | PK, FK | Yes | Product.product_id | Product the quantity is for. |
| `quantity` | `int` |  | Yes |  | Units in stock at the end of the day, across all fridges. |
| `recorded_at` | `datetime` |  | Yes |  | When the snapshot job ran. |

## Alert

**Data store:** D5 Alerts  
An expiry, low-stock, or stock mismatch alert. A stock mismatch means a row's sensor reading doesn't match the items listed in it. Stays active until a manager clears it.

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `alert_id` | `int` | PK | Yes |  | Unique alert identifier. |
| `product_id` | `int` | FK | Yes | Product.product_id | Product the alert is about. |
| `item_id` | `int` | FK | No | StockItem.item_id | Item that is expiring. Empty for other alert types. |
| `row_id` | `int` | FK | No | Row.row_id | Row whose reading doesn't match its listed items. Empty for other alert types. |
| `alert_type` | `string` |  | Yes |  | expiry, low_stock, or stock_mismatch. |
| `status` | `string` |  | Yes |  | active or cleared. |
| `raised_at` | `datetime` |  | Yes |  | When the alert was raised. |

## User

**Data store:** D6 Users  
A staff member who uses the dashboard and receives alerts.

| Attribute | Type | Key | Required | References | Description |
|---|---|---|---|---|---|
| `user_id` | `int` | PK | Yes |  | Unique user identifier. |
| `name` | `string` |  | Yes |  | Full name. |
| `email` | `string` |  | Yes |  | Email address that alerts are sent to. |
| `role` | `string` |  | Yes |  | manager, kitchen_staff, or purchasing_staff. |
| `active` | `bool` |  | Yes |  | Whether the user can sign in and receive alerts. |

## Relationships

| ID | Relationship | Multiplicity |
|---|---|---|
| R1 | Category *groups* Product | Category 1 — 0..* Product |
| R2 | Product *has* AlertThreshold | Product 1 — 0..1 AlertThreshold |
| R3 | Product *stocked as* StockItem | Product 1 — 0..* StockItem |
| R4 | Row *stores* Product | Row 0..* — 0..1 Product |
| R5 | Product *triggers* Alert | Product 1 — 0..* Alert |
| R6 | Fridge *contains* Row | Fridge 1 — 1..* Row |
| R7 | Row *holds* StockItem | Row 1 — 0..* StockItem |
| R8 | StockItem *discarded as* WasteRecord | StockItem 1 — 0..1 WasteRecord |
| R9 | StockItem *flagged by* Alert | StockItem 0..1 — 0..* Alert |
| R10 | User *logs* WasteRecord | User 0..1 — 0..* WasteRecord |
| R12 | User *sets* NotificationPreference | User 1 — 0..* NotificationPreference |
| R13 | Product *recorded in* StockSnapshot | Product 1 — 0..* StockSnapshot |
| R14 | Row *flags* Alert | Row 0..1 — 0..* Alert |

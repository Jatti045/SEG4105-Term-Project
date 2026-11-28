import { useEffect, useMemo, useRef, useState } from "react";
import { createFridge, getFloor, getProducts, runAlertChecks, updateFridge } from "../api.js";
import FoodSprite, { hasFoodSprite } from "../FoodSprite.jsx";
import { formatDateTime, formatGrams, plural } from "../format.js";
import { notifyStockChanged } from "../live.js";
import { Loading, Modal, StatusBadge } from "../ui.jsx";
import { useApi } from "../useApi.js";
import "./floor.css";

// ---------------------------------------------------------------------------
// Restaurant layout, in plan units (viewBox 1000 x 620). Fridge positions come
// from the database and can be changed in the kitchen editor.
// ---------------------------------------------------------------------------
const PLAN_W = 1000;
const PLAN_H = 620;
const WALL = 14; // keeps fridges inside the outer walls
const GRID = 10;

const ROOMS = [
  { name: "Dining room", x: 10, y: 10, w: 590, h: 600 },
  { name: "Main kitchen", x: 600, y: 10, w: 390, h: 370 },
  { name: "Prep line", x: 600, y: 380, w: 390, h: 230 },
];

// The room a point is in, used as a fridge's location.
function roomAt(x, y) {
  return ROOMS.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)?.name;
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const snap = (value) => Math.round(value / GRID) * GRID;

function fitInPlan(x, y, w, h) {
  return {
    x: clamp(snap(x), WALL, PLAN_W - WALL - w),
    y: clamp(snap(y), WALL, PLAN_H - WALL - h),
  };
}

// Kinds of fridge you can add: size on the plan, and default shelves and rows.
const FRIDGE_TYPES = [
  { id: "walk-in", label: "Walk-in cooler", w: 150, h: 120, shelves: 3, rows: 2 },
  { id: "reach-in", label: "Reach-in", w: 90, h: 170, shelves: 2, rows: 2 },
  { id: "under-counter", label: "Under-counter", w: 130, h: 50, shelves: 1, rows: 3 },
];

const overlaps = (a, b, gap = GRID) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

// The first free spot for a w x h fridge, trying the kitchen before the dining room.
function freeSpot(fridges, w, h) {
  const taken = fridges.map((f) => ({ x: f.plan_x, y: f.plan_y, w: f.plan_w, h: f.plan_h }));
  const areas = [ROOMS[1], ROOMS[2], ROOMS[0]];
  for (const room of areas) {
    for (let y = room.y + WALL; y + h <= room.y + room.h - WALL; y += GRID) {
      for (let x = room.x + WALL; x + w <= room.x + room.w - WALL; x += GRID) {
        const spot = { x: snap(x), y: snap(y), w, h };
        if (!taken.some((t) => overlaps(spot, t))) return fitInPlan(spot.x, spot.y, w, h);
      }
    }
  }
  return fitInPlan(PLAN_W / 2 - w / 2, PLAN_H / 2 - h / 2, w, h); // full: drop it in the middle
}

function openFridge(fridgeId, rowId = null, itemId = null) {
  const params = new URLSearchParams({ fridge: fridgeId });
  if (rowId) params.set("row", rowId);
  if (itemId) params.set("item", itemId);
  window.location.hash = `#/floor?${params}`;
}

const itemCount = (fridge) => fridge.rows.reduce((n, r) => n + r.items.length, 0);
const shelfOf = (row) => row.label.split(",")[0];
const positionOf = (row) => row.label.split(", ")[1] ?? row.label;

// ---------------------------------------------------------------------------
// Search: products, categories, fridges, rows, or an item ID like "#16".
// ---------------------------------------------------------------------------
function search(query, fridges, products) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const idMatch = q.match(/^#?(\d+)$/);
  const results = [];
  for (const fridge of fridges) {
    for (const row of fridge.rows) {
      if (idMatch) {
        const item = row.items.find((i) => i.item_id === Number(idMatch[1]));
        if (item) results.push({ kind: "item", fridge, row, item });
        continue;
      }
      if (!row.product) continue;
      const text = [row.product, row.category, row.recognition_label, fridge.name, fridge.location, row.label]
        .join(" ")
        .toLowerCase();
      if (text.includes(q)) results.push({ kind: "row", fridge, row });
    }
  }
  if (!idMatch) {
    const found = new Set(results.map((r) => r.row.product_id));
    for (const product of products) {
      const text = `${product.name} ${product.category}`.toLowerCase();
      if (text.includes(q) && !found.has(product.product_id)) results.push({ kind: "absent", product });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Words for expiry and alerts.
// ---------------------------------------------------------------------------
const STATUS_LABELS = { fresh: "Fresh", expiring: "Expiring soon", expired: "Expired" };

function expiryText(days) {
  if (days < 0) return `expired ${plural(-days, "day")} ago`;
  if (days === 0) return "expires today";
  return `expiring in ${plural(days, "day")}`;
}

function alertKind(alert) {
  if (alert.alert_type === "expiry") return alert.days_left < 0 ? "expired" : "expiring";
  return alert.alert_type === "low_stock" ? "low" : "mismatch";
}

function alertText(alert) {
  switch (alert.alert_type) {
    case "expiry":
      return `Item #${alert.item_id} ${expiryText(alert.days_left)}`;
    case "low_stock":
      return `Low stock: ${alert.in_stock} left (alert at ${alert.low_stock_threshold})`;
    default:
      return `Stock mismatch: the scale reads ${formatGrams(alert.current_weight_g)}, but the listed items weigh ${formatGrams(alert.min_weight_g)}–${formatGrams(alert.max_weight_g)}`;
  }
}

const SEVERITY = { expired: 3, mismatch: 2, expiring: 1, low: 0 };
const worstKind = (alerts) =>
  alerts.map(alertKind).sort((a, b) => SEVERITY[b] - SEVERITY[a])[0];

// ---------------------------------------------------------------------------
// One item on a shelf: its food icon, flagged if expiring or expired.
// ---------------------------------------------------------------------------
function Item({ row, item, focused }) {
  const params = new URLSearchParams({ product: item.product_id, item: item.item_id });
  return (
    <a
      href={`#/stock?${params}`}
      className={`item-sprite ${item.status}${focused ? " focused" : ""}`}
      title={`#${item.item_id} · ${row.product} · ${expiryText(item.days_left)} (${item.expiry_date})`}
      aria-label={`Item ${item.item_id}, ${row.product}, ${STATUS_LABELS[item.status]}`}
    >
      {hasFoodSprite(row.recognition_label, row.icon) ? (
        <FoodSprite label={row.recognition_label} icon={row.icon} size={32} />
      ) : (
        <span className="item-fallback" />
      )}
      {item.status !== "fresh" && <span className="sprite-flag" aria-hidden="true" />}
    </a>
  );
}

// ---------------------------------------------------------------------------
// The floor plan. In edit mode, fridges can be dragged (or moved with the
// arrow keys) and selected for renaming; otherwise clicking opens one.
// ---------------------------------------------------------------------------
function FloorPlan({ fridges, positions, editing, selectedId, matches, onOpen, onSelect, onMove }) {
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const tables = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) tables.push([140 + c * 150, 170 + r * 140]);

  function svgPoint(event) {
    const svg = svgRef.current;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
  }

  return (
    <svg
      ref={svgRef}
      className={`floor-plan${editing ? " editing" : ""}`}
      viewBox={`0 0 ${PLAN_W} ${PLAN_H}`}
      role="group"
      aria-label="Restaurant floor plan"
    >
      <defs>
        <pattern id="fp-grid" width={GRID * 2} height={GRID * 2} patternUnits="userSpaceOnUse">
          <path d={`M${GRID * 2} 0H0V${GRID * 2}`} className="fp-grid-line" />
        </pattern>
        <pattern id="fp-dining-floor" width="40" height="40" patternUnits="userSpaceOnUse">
          <rect width="40" height="40" className="fp-dining-tile" />
          <path d="M0 20h40M20 0v40" className="fp-dining-grout" />
          <rect x="2" y="2" width="16" height="16" className="fp-dining-shine" />
          <rect x="22" y="22" width="16" height="16" className="fp-dining-shine" />
        </pattern>
        <pattern id="fp-kitchen-floor" width="32" height="32" patternUnits="userSpaceOnUse">
          <rect width="32" height="32" className="fp-kitchen-tile" />
          <rect width="16" height="16" className="fp-kitchen-tile-alt" />
          <rect x="16" y="16" width="16" height="16" className="fp-kitchen-tile-alt" />
        </pattern>
        <pattern id="fp-prep-floor" width="32" height="32" patternUnits="userSpaceOnUse">
          <rect width="32" height="32" className="fp-prep-tile" />
          <path d="M0 0h32v32H0zM16 0v32M0 16h32" className="fp-prep-grout" />
        </pattern>
      </defs>

      {/* Rooms */}
      <rect className="fp-room dining" x="10" y="10" width="590" height="600" fill="url(#fp-dining-floor)" />
      <rect className="fp-room kitchen" x="600" y="10" width="390" height="370" fill="url(#fp-kitchen-floor)" />
      <rect className="fp-room prep" x="600" y="380" width="390" height="230" fill="url(#fp-prep-floor)" />
      {editing && <rect x="10" y="10" width="980" height="600" fill="url(#fp-grid)" />}

      {/* Dining room furniture */}
      <rect className="fp-furniture-shadow" x="46" y="42" width="220" height="44" />
      <rect className="fp-counter fp-bar" x="40" y="36" width="220" height="44" />
      <rect className="fp-counter-highlight" x="46" y="42" width="208" height="6" />
      <text className="fp-furniture-label" x="150" y="63">Bar</text>
      {tables.map(([x, y]) => (
        <g className="fp-table-set" key={`${x}-${y}`}>
          {[[-46, 0], [46, 0], [0, -46], [0, 46]].map(([dx, dy]) => (
            <g key={`${dx}${dy}`}>
              <rect className="fp-chair-shadow" x={x + dx - 9 + 4} y={y + dy - 9 + 4} width="18" height="18" />
              <rect className="fp-chair" x={x + dx - 9} y={y + dy - 9} width="18" height="18" />
              <rect className="fp-chair-highlight" x={x + dx - 5} y={y + dy - 5} width="10" height="4" />
            </g>
          ))}
          <rect className="fp-table-shadow" x={x - 25} y={y - 25} width="58" height="58" />
          <rect className="fp-table" x={x - 29} y={y - 29} width="58" height="58" />
          <rect className="fp-table-highlight" x={x - 23} y={y - 23} width="46" height="7" />
        </g>
      ))}

      {/* Kitchen furniture */}
      <rect className="fp-furniture-shadow" x="646" y="296" width="310" height="48" />
      <rect className="fp-counter" x="640" y="290" width="310" height="48" />
      <rect className="fp-counter-highlight" x="646" y="296" width="298" height="6" />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect className="fp-burner" x={667 + i * 70} y="301" width="26" height="26" />
          <rect className="fp-burner-core" x={674 + i * 70} y="308" width="12" height="12" />
        </g>
      ))}
      <text className="fp-furniture-label" x="795" y="360">Cooking line</text>
      <rect className="fp-furniture-shadow" x="646" y="456" width="210" height="44" />
      <rect className="fp-counter" x="640" y="450" width="210" height="44" />
      <rect className="fp-counter-highlight" x="646" y="456" width="198" height="6" />
      <rect className="fp-sink" x="666" y="463" width="44" height="20" />
      <rect className="fp-cutting-board" x="770" y="462" width="58" height="22" />
      <text className="fp-furniture-label" x="745" y="520">Prep table</text>

      {/* Walls, with gaps for doors */}
      <path
        className="fp-wall"
        d="M250 610H10V10h980v600H350 M600 10v240 M600 330v280 M600 380h160 M840 380h150"
      />
      <text className="fp-door-label" x="300" y="600">Entrance</text>
      <text className="fp-door-label" x="600" y="296" transform="rotate(-90 600 296)">Pass</text>

      {/* Room names */}
      <text className="fp-room-label" x="30" y="590">DINING ROOM</text>
      <text className="fp-room-label" x="620" y="250">MAIN KITCHEN</text>
      <text className="fp-room-label" x="620" y="408">PREP LINE</text>

      {/* Fridges */}
      {fridges.map((fridge) => {
        const id = fridge.fridge_id;
        const { plan_w: w, plan_h: h } = fridge;
        const pos =
          drag?.id === id ? drag : (positions[id] ?? { x: fridge.plan_x, y: fridge.plan_y });
        const selected = editing && id === selectedId;
        const classes = [
          "fp-fridge",
          selected && "selected",
          drag?.id === id && drag.moved && "dragging",
          !editing && matches.has(id) && "match",
          fridge.status !== "online" && "offline",
        ]
          .filter(Boolean)
          .join(" ");
        const cx = pos.x + w / 2;
        const cy = pos.y + h / 2;

        const handlers = editing
          ? {
              onPointerDown: (e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                e.currentTarget.focus();
                const p = svgPoint(e);
                setDrag({ id, offX: p.x - pos.x, offY: p.y - pos.y, x: pos.x, y: pos.y, moved: false });
                onSelect(id);
              },
              onPointerMove: (e) => {
                if (drag?.id !== id) return;
                const p = svgPoint(e);
                const next = fitInPlan(p.x - drag.offX, p.y - drag.offY, w, h);
                if (next.x !== drag.x || next.y !== drag.y) setDrag({ ...drag, ...next, moved: true });
              },
              onPointerUp: () => {
                if (drag?.id === id && drag.moved) onMove(fridge, drag.x, drag.y);
                setDrag(null);
              },
              onPointerCancel: () => setDrag(null),
              onKeyDown: (e) => {
                const step = {
                  ArrowLeft: [-GRID, 0],
                  ArrowRight: [GRID, 0],
                  ArrowUp: [0, -GRID],
                  ArrowDown: [0, GRID],
                }[e.key];
                if (step) {
                  e.preventDefault();
                  onSelect(id);
                  const next = fitInPlan(pos.x + step[0], pos.y + step[1], w, h);
                  if (next.x !== pos.x || next.y !== pos.y) onMove(fridge, next.x, next.y);
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(id);
                }
              },
            }
          : {
              onClick: () => onOpen(id),
              onKeyDown: (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(id);
                }
              },
            };

        return (
          <g
            key={id}
            className={classes}
            role="button"
            tabIndex={0}
            aria-pressed={editing ? selected : undefined}
            aria-label={
              editing
                ? `${fridge.name}. Drag, or use the arrow keys, to move it.`
                : `Open ${fridge.name}, ${fridge.location}, ${plural(itemCount(fridge), "item")}`
            }
            {...handlers}
          >
            <rect className="fp-fridge-shadow" x={pos.x + 6} y={pos.y + 6} width={w} height={h} />
            <rect className="fp-fridge-body" x={pos.x} y={pos.y} width={w} height={h} />
            <rect className="fp-fridge-highlight" x={pos.x + 6} y={pos.y + 6} width={Math.max(0, w - 12)} height="6" />
            <rect className="fp-fridge-panel" x={pos.x + w - 18} y={pos.y + 8} width="10" height="10" />
            <rect
              className="fp-fridge-handle"
              x={pos.x + 8}
              y={pos.y + 8}
              width="6"
              height={Math.min(30, h - 16)}
            />
            <text className="fp-fridge-name" x={cx} y={cy - 2}>
              {fridge.name}
            </text>
            <text className="fp-fridge-count" x={cx} y={cy + 16}>
              {plural(itemCount(fridge), "item")}
            </text>
            {fridge.active_alerts > 0 && !editing && (
              <g className="fp-alert">
                <circle cx={pos.x + w - 4} cy={pos.y + 4} r="13" />
                <text x={pos.x + w - 4} y={pos.y + 9}>
                  {fridge.active_alerts}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// Rename the fridge selected in the kitchen editor.
function FridgeEditor({ fridge, onSaved }) {
  const [name, setName] = useState(fridge.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setName(fridge.name), [fridge.fridge_id, fridge.name]);

  const trimmed = name.trim();
  const changed = trimmed !== fridge.name;

  async function save(e) {
    e.preventDefault();
    if (!trimmed || !changed) return;
    setBusy(true);
    setError(null);
    try {
      await updateFridge(fridge.fridge_id, { name: trimmed });
      onSaved(`Renamed to ${trimmed}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="fridge-editor" onSubmit={save}>
      <label className="field">
        <span>Name</span>
        <input
          type="text"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={!trimmed}
          disabled={busy}
        />
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy || !trimmed || !changed}>
        {busy ? "Saving…" : "Rename"}
      </button>
      <p className="muted small">
        In the {fridge.location} · {plural(itemCount(fridge), "item")}
      </p>
      {error && <p className="alert-error">{error}</p>}
    </form>
  );
}

// Add a fridge with empty rows, in the first free spot on the plan.
function AddFridgeForm({ fridges, onAdded, onCancel }) {
  const [name, setName] = useState("");
  const [typeId, setTypeId] = useState(FRIDGE_TYPES[1].id);
  const type = FRIDGE_TYPES.find((t) => t.id === typeId);
  const [shelves, setShelves] = useState(String(type.shelves));
  const [rowsPerShelf, setRowsPerShelf] = useState(String(type.rows));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const count = (value) => (/^\d+$/.test(value) && +value >= 1 && +value <= 10 ? +value : null);
  const shelfCount = count(shelves);
  const rowCount = count(rowsPerShelf);
  const placeholder = `Fridge ${fridges.length + 1}`;
  const valid = shelfCount !== null && rowCount !== null;

  function chooseType(id) {
    const next = FRIDGE_TYPES.find((t) => t.id === id);
    setTypeId(id);
    setShelves(String(next.shelves));
    setRowsPerShelf(String(next.rows));
  }

  async function add(e) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    const spot = freeSpot(fridges, type.w, type.h);
    try {
      const fridge = await createFridge({
        name: name.trim() || placeholder,
        location: roomAt(spot.x + type.w / 2, spot.y + type.h / 2) ?? "Main kitchen",
        plan_x: spot.x,
        plan_y: spot.y,
        plan_w: type.w,
        plan_h: type.h,
        shelves: shelfCount,
        rows_per_shelf: rowCount,
      });
      setName("");
      onAdded(fridge);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="fridge-editor" onSubmit={add}>
      <label className="field">
        <span>Name</span>
        <input
          type="text"
          value={name}
          placeholder={placeholder}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </label>
      <label className="field">
        <span>Type</span>
        <select value={typeId} onChange={(e) => chooseType(e.target.value)} disabled={busy}>
          {FRIDGE_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <div className="field-pair">
        <label className="field">
          <span>Shelves</span>
          <input
            type="number"
            min="1"
            max="10"
            className="num-input"
            value={shelves}
            onChange={(e) => setShelves(e.target.value)}
            aria-invalid={shelfCount === null}
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>Rows per shelf</span>
          <input
            type="number"
            min="1"
            max="10"
            className="num-input"
            value={rowsPerShelf}
            onChange={(e) => setRowsPerShelf(e.target.value)}
            aria-invalid={rowCount === null}
            disabled={busy}
          />
        </label>
      </div>
      <p className="muted small">
        {valid
          ? `${plural(shelfCount * rowCount, "empty row")}. It goes in the first free spot on the plan.`
          : "Shelves and rows: 1 to 10 each."}
      </p>
      {error && <p className="alert-error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !valid}>
          {busy ? "Adding…" : "Add fridge"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Inside one fridge: shelves and rows. Hovering (or focusing) a row with
// alerts shows them in a popup.
// ---------------------------------------------------------------------------
function CabinetRow({ row, focus }) {
  const focusedRow = focus?.rowId === row.row_id;
  const { alerts } = row;
  const popupId = `row-${row.row_id}-alerts`;
  const classes = [
    "cabinet-row",
    focusedRow && "focused",
    alerts.length > 0 && `has-alerts ${worstKind(alerts)}`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={classes}
      tabIndex={alerts.length ? 0 : undefined}
      aria-describedby={alerts.length ? popupId : undefined}
    >
      <header>
        <span className="cabinet-row-label">{positionOf(row)}</span>
        <span className="cabinet-row-product">
          {row.product ?? "Unassigned"}
          {alerts.length > 0 && (
            <span className={`row-alert-count ${worstKind(alerts)}`} aria-hidden="true">
              {alerts.length}
            </span>
          )}
        </span>
      </header>
      <div className="cabinet-items">
        {row.items.length === 0 ? (
          <span className="muted small">Empty</span>
        ) : (
          row.items.map((item) => (
            <Item key={item.item_id} row={row} item={item} focused={focus?.itemId === item.item_id} />
          ))
        )}
      </div>
      <footer className="muted small">
        {plural(row.items.length, row.unit ?? "item")} · Scale {formatGrams(row.current_weight_g)}
      </footer>

      {alerts.length > 0 && (
        <div className="row-popup" role="tooltip" id={popupId}>
          <strong>{plural(alerts.length, "alert")}</strong>
          <ul>
            {alerts.map((alert) => (
              <li key={alert.alert_id} className={`popup-alert ${alertKind(alert)}`}>
                {alertText(alert)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function Cabinet({ fridge, focus }) {
  const shelves = [...new Set(fridge.rows.map(shelfOf))];
  return (
    <section className="cabinet-panel" aria-label={`Inside ${fridge.name}`}>
      <a className="back-link" href="#/floor">
        ← Floor plan
      </a>
      <div className="cabinet-head">
        <div>
          <h1>{fridge.name}</h1>
          <p className="muted">
            {fridge.location} · {plural(itemCount(fridge), "item")}
            {fridge.last_reading_at && <> · Last reading {formatDateTime(fridge.last_reading_at)}</>}
          </p>
        </div>
        <span className="badges">
          <StatusBadge kind={fridge.status === "online" ? "fresh" : "expired"}>
            {fridge.status === "online" ? "Online" : "Offline"}
          </StatusBadge>
          {fridge.active_alerts > 0 && (
            <a href="#/alerts" className="status expired">
              {plural(fridge.active_alerts, "active alert")}
            </a>
          )}
        </span>
      </div>

      <div className="cabinet">
        <div className="cabinet-display" aria-hidden="true">
          <span className="cabinet-display-light" />
          <span className="cabinet-display-label">SMART COOLING</span>
        </div>
        {shelves.map((shelf) => (
          <div className="cabinet-shelf" key={shelf}>
            <h2>{shelf}</h2>
            <div className="cabinet-rows">
              {fridge.rows
                .filter((r) => shelfOf(r) === shelf)
                .map((row) => (
                  <CabinetRow key={row.row_id} row={row} focus={focus} />
                ))}
            </div>
          </div>
        ))}
      </div>
      <p className="muted small legend">
        <span className="legend-flag expiring" /> Expiring soon
        <span className="legend-flag expired" /> Expired · Hover over a row to see its alerts.
        Select an item to open it on the stock page.
      </p>
    </section>
  );
}

function ResultRow({ result, onPick }) {
  if (result.kind === "absent") {
    return (
      <li className="result absent">
        <span className="result-title">{result.product.name}</span>
        <span className="muted">{result.product.category} · Not in any fridge</span>
      </li>
    );
  }
  const { fridge, row } = result;
  const next = row.items[0];
  return (
    <li>
      <button type="button" className="result" onClick={() => onPick(result)}>
        <span className="result-title">
          <FoodSprite label={row.recognition_label} icon={row.icon} size={20} />
          {result.kind === "item" ? `Item #${result.item.item_id} · ${row.product}` : row.product}
        </span>
        <span className="result-where">
          {fridge.name} · {row.label}
        </span>
        <span className="muted small">
          {result.kind === "item"
            ? `${STATUS_LABELS[result.item.status]} · ${expiryText(result.item.days_left)}`
            : row.items.length === 0
              ? "Row is empty"
              : `${plural(row.items.length, row.unit ?? "item")} · next ${expiryText(next.days_left)}`}
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The page: the top-down map (#/floor), or one fridge's rows
// (#/floor?fridge=1, optionally &row=4&item=16 to highlight something).
// ---------------------------------------------------------------------------
async function loadFloor() {
  // Raise any alerts that are now due, so the plan and popups are current.
  await runAlertChecks();
  const [fridges, products] = await Promise.all([getFloor(), getProducts()]);
  return { fridges, products };
}

const toNumber = (value) => (value === undefined ? null : Number(value));

export default function FloorPage({ params = {} }) {
  const { data, error, reload } = useApi(loadFloor);
  const [query, setQuery] = useState(params.q ?? "");
  const fridgeId = toNumber(params.fridge);

  if (!data) return <Loading error={error} />;

  if (fridgeId !== null) {
    const fridge = data.fridges.find((f) => f.fridge_id === fridgeId);
    return fridge ? (
      <FridgeView
        fridge={fridge}
        focus={{ rowId: toNumber(params.row), itemId: toNumber(params.item) }}
      />
    ) : (
      <p className="error">
        That fridge doesn't exist. <a href="#/floor">Back to the floor plan</a>
      </p>
    );
  }
  return (
    <MapView
      data={data}
      reload={reload}
      query={query}
      setQuery={setQuery}
      startEditing={params.edit === "1"}
    />
  );
}

function FridgeView({ fridge, focus }) {
  const ref = useRef(null);
  // Bring the highlighted row or item into view, or start at the top.
  useEffect(() => {
    const target = ref.current?.querySelector(".item-sprite.focused, .cabinet-row.focused");
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    else window.scrollTo({ top: 0 });
  }, [fridge.fridge_id, focus.rowId, focus.itemId]);

  return (
    <div ref={ref}>
      <Cabinet fridge={fridge} focus={focus} />
    </div>
  );
}

function MapView({ data, reload, query, setQuery, startEditing }) {
  const [editing, setEditing] = useState(startEditing);
  const [selectedId, setSelectedId] = useState(null);
  // Positions dropped but not yet back from the server, so fridges don't jump.
  const [pending, setPending] = useState({});
  const [notice, setNotice] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [adding, setAdding] = useState(false);

  // Forget pending positions once the server has them.
  useEffect(() => {
    setPending((old) => {
      const next = { ...old };
      for (const f of data.fridges) {
        const p = next[f.fridge_id];
        if (p && p.x === f.plan_x && p.y === f.plan_y) delete next[f.fridge_id];
      }
      return next;
    });
  }, [data]);

  const results = useMemo(() => search(query, data.fridges, data.products), [query, data]);
  const matches = new Set(results.filter((r) => r.fridge).map((r) => r.fridge.fridge_id));
  const selected = data.fridges.find((f) => f.fridge_id === selectedId);

  function saved(message) {
    if (message) setNotice(message);
    reload();
    notifyStockChanged(); // the simulator shows fridge names too
  }

  async function move(fridge, x, y) {
    setPending((old) => ({ ...old, [fridge.fridge_id]: { x, y } }));
    setSaveError(null);
    const location = roomAt(x + fridge.plan_w / 2, y + fridge.plan_h / 2) ?? fridge.location;
    try {
      await updateFridge(fridge.fridge_id, { plan_x: x, plan_y: y, location });
      saved(location !== fridge.location ? `${fridge.name} moved to the ${location}.` : null);
    } catch (e) {
      setPending((old) => {
        const next = { ...old };
        delete next[fridge.fridge_id];
        return next;
      });
      setSaveError(e.message);
    }
  }

  function toggleEditing() {
    setEditing(!editing);
    setSelectedId(null);
    setNotice(null);
    setSaveError(null);
  }

  return (
    <>
      <div className="page-head floor-head">
        <div>
          <h1>Floor plan</h1>
          <p className="summary">
            {editing
              ? "Drag fridges to move them, or select one and use the arrow keys. Select a fridge to rename it. Changes save as you go."
              : "Where every fridge is. Select one to see its rows, or search for a product, category, or item ID."}
          </p>
        </div>
        <div className="floor-actions">
          {editing && (
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              + Add fridge
            </button>
          )}
          <button
            type="button"
            className={`btn${editing ? " btn-primary" : ""}`}
            onClick={toggleEditing}
          >
            {editing ? "Done editing" : "Edit kitchen"}
          </button>
        </div>
      </div>

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {saveError && <p className="error">{saveError}</p>}

      {!editing && (
        <div className="floor-search">
          <label className="visually-hidden" htmlFor="floor-search">
            Search items
          </label>
          <input
            id="floor-search"
            type="search"
            placeholder="Search, e.g. milk, dairy, or #16"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {query.trim() && (
            <div className="results" role="region" aria-live="polite" aria-label="Search results">
              {results.length === 0 ? (
                <p className="muted">Nothing matches “{query.trim()}”.</p>
              ) : (
                <ul>
                  {results.map((r) => (
                    <ResultRow
                      key={
                        r.kind === "absent"
                          ? `p${r.product.product_id}`
                          : `${r.kind}${r.row.row_id}${r.item?.item_id ?? ""}`
                      }
                      result={r}
                      onPick={(picked) =>
                        openFridge(picked.fridge.fridge_id, picked.row.row_id, picked.item?.item_id)
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className={editing ? "editor-layout" : undefined}>
        <FloorPlan
          fridges={data.fridges}
          positions={pending}
          editing={editing}
          selectedId={selectedId}
          matches={matches}
          onOpen={(id) => openFridge(id)}
          onSelect={setSelectedId}
          onMove={move}
        />
        {editing && (
          <aside className="editor-panel">
            {selected ? (
              <>
                <h2>{selected.name}</h2>
                <FridgeEditor fridge={selected} onSaved={saved} />
              </>
            ) : (
              <p className="muted">Select a fridge to rename it.</p>
            )}
          </aside>
        )}
      </div>

      {adding && (
        <AddFridgeDialog
          fridges={data.fridges}
          onClose={() => setAdding(false)}
          onAdded={(fridge) => {
            setAdding(false);
            setSelectedId(fridge.fridge_id);
            saved(`Added ${fridge.name} with ${plural(fridge.rows, "row")}. Drag it where it belongs.`);
          }}
        />
      )}
    </>
  );
}

// The Add fridge form in a modal dialog. Esc or Cancel closes it.
function AddFridgeDialog({ fridges, onClose, onAdded }) {
  return (
    <Modal title="Add a fridge" onClose={onClose}>
      <AddFridgeForm fridges={fridges} onAdded={onAdded} onCancel={onClose} />
    </Modal>
  );
}

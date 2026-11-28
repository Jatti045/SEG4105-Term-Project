import { useEffect, useRef, useState } from "react";
import { getStock, throwOutItem } from "../api.js";
import { daysLeftLabel, plural } from "../format.js";
import { notifyStockChanged } from "../live.js";
import { Loading, StatusBadge } from "../ui.jsx";
import { useApi } from "../useApi.js";

const STATUS_LABELS = {
  fresh: "Fresh",
  expiring: "Expiring soon",
  expired: "Expired",
};

const REASONS = [
  ["expired", "Expired"],
  ["spoiled", "Spoiled"],
  ["damaged", "Damaged"],
  ["other", "Other"],
];

// Columns in the product table; the item sub-table spans all of them.
const PRODUCT_COLUMNS = 7;

function ThrowOut({ item, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState(item.status === "expired" ? "expired" : "spoiled");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!confirming) {
    return (
      <button type="button" className="btn btn-small" onClick={() => setConfirming(true)}>
        Throw out
      </button>
    );
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await throwOutItem(item.item_id, reason);
      onDone(item);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <span className="throw-out">
      <label className="visually-hidden" htmlFor={`reason-${item.item_id}`}>
        Reason
      </label>
      <select
        id={`reason-${item.item_id}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={busy}
      >
        {REASONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-small btn-danger" onClick={confirm} disabled={busy}>
        {busy ? "Saving…" : "Confirm"}
      </button>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => setConfirming(false)}
        disabled={busy}
      >
        Cancel
      </button>
      {error && <span className="alert-error">{error}</span>}
    </span>
  );
}

function ItemTable({ items, isFocused, onThrownOut }) {
  return (
    <table className="sheet sub-sheet">
      <thead>
        <tr>
          <th className="num">ID</th>
          <th>Fridge</th>
          <th>Row</th>
          <th>Added</th>
          <th>Expires</th>
          <th className="num">Days left</th>
          <th>Status</th>
          <th>
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.item_id} className={isFocused(item) ? "focused" : undefined}>
            <td className="num">{item.item_id}</td>
            <td>{item.fridge}</td>
            <td>{item.row_label}</td>
            <td className="date">{item.added_on}</td>
            <td className="date">{item.expiry_date}</td>
            <td className="num">{daysLeftLabel(item.days_left)}</td>
            <td>
              <StatusBadge kind={item.status}>{STATUS_LABELS[item.status]}</StatusBadge>
            </td>
            <td className="actions">
              <ThrowOut item={item} onDone={onThrownOut} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// focus: null, or { item, row } naming what to highlight inside this product.
function ProductRows({ product, focus, onThrownOut }) {
  const hasItems = product.items.length > 0;
  const [open, setOpen] = useState(Boolean(focus) && hasItems);
  const subId = `product-${product.product_id}-items`;

  const isFocused = (item) =>
    Boolean(focus) && (item.item_id === focus.item || item.row_id === focus.row);

  return (
    <>
      <tr
        className={["product-row", open && "open", focus && "focused"].filter(Boolean).join(" ")}
      >
        <td>
          {hasItems ? (
            <button
              type="button"
              className="expander"
              aria-expanded={open}
              aria-controls={subId}
              onClick={() => setOpen(!open)}
            >
              <span className="chevron" aria-hidden="true">
                ▸
              </span>
              {product.name}
            </button>
          ) : (
            <span className="expander-placeholder">{product.name}</span>
          )}
        </td>
        <td>{product.unit}</td>
        <td className="num">{product.in_stock}</td>
        <td className="num">{product.expiring || <span className="muted">–</span>}</td>
        <td className="num">{product.expired || <span className="muted">–</span>}</td>
        <td className="date">{product.next_expiry ?? <span className="muted">–</span>}</td>
        <td>
          <span className="badges">
            {product.in_stock === 0 ? (
              <StatusBadge kind="expired">Out of stock</StatusBadge>
            ) : (
              <StatusBadge kind={product.status}>{STATUS_LABELS[product.status]}</StatusBadge>
            )}
            {product.low_stock && product.in_stock > 0 && (
              <StatusBadge kind="low">Low stock</StatusBadge>
            )}
          </span>
        </td>
      </tr>
      {open && hasItems && (
        <tr className="sub-row" id={subId}>
          <td colSpan={PRODUCT_COLUMNS}>
            <ItemTable items={product.items} isFocused={isFocused} onThrownOut={onThrownOut} />
          </td>
        </tr>
      )}
    </>
  );
}

// Turns #/stock?product=3&item=16 (or &row=5) into numbers, or null when absent.
function parseFocus(params) {
  const num = (v) => (v === undefined ? null : Number(v));
  const product = num(params.product);
  return product === null ? null : { product, item: num(params.item), row: num(params.row) };
}

export default function StockPage({ params = {} }) {
  const { data, error, reload } = useApi(getStock);
  const [notice, setNotice] = useState(null);
  const focus = parseFocus(params);

  // Scroll to whatever the link pointed at, once, after the first load.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!data || !focus || scrolled.current) return;
    scrolled.current = true;
    const target =
      document.querySelector(".sub-sheet tr.focused") ??
      document.querySelector(".product-row.focused");
    target?.scrollIntoView({ block: "center" });
  }, [data, focus]);

  if (!data) return <Loading error={error} />;

  const { summary, categories } = data;

  function handleThrownOut(item) {
    setNotice(`Item #${item.item_id} was thrown out.`);
    reload();
    notifyStockChanged();
  }

  return (
    <>
      <div className="page-head">
        <h1>Current stock</h1>
        <div className="stats">
          <div className="stat">
            <span className="stat-value">{summary.total}</span>
            <span className="stat-label">Items in stock</span>
          </div>
          <div className="stat expiring">
            <span className="stat-value">{summary.expiring}</span>
            <span className="stat-label">Expiring soon</span>
          </div>
          <div className="stat expired">
            <span className="stat-value">{summary.expired}</span>
            <span className="stat-label">Expired</span>
          </div>
        </div>
        <p className="notice" role="status">
          {notice}
        </p>
      </div>

      {categories.map((category) => {
        const itemCount = category.products.reduce((n, p) => n + p.in_stock, 0);
        return (
          <section className="category" key={category.category_id}>
            <h2>
              {category.name}
              <span className="count">
                {plural(category.products.length, "product")} · {plural(itemCount, "item")}
              </span>
            </h2>
            {category.products.length === 0 ? (
              <p className="muted">No products in this category.</p>
            ) : (
              <div className="sheet-wrap">
                <table className="sheet">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Unit</th>
                      <th className="num">In stock</th>
                      <th className="num">Expiring soon</th>
                      <th className="num">Expired</th>
                      <th>Next expiry</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {category.products.map((product) => (
                      <ProductRows
                        product={product}
                        key={product.product_id}
                        focus={focus?.product === product.product_id ? focus : null}
                        onThrownOut={handleThrownOut}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}

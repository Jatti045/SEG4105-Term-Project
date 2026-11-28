import { useState } from "react";
import {
  createProduct,
  getInventory,
  removeProduct,
  restoreProduct,
  updateProduct,
} from "../api.js";
import FoodSprite, { IconPicker, hasFoodSprite } from "../FoodSprite.jsx";
import { formatGrams, plural } from "../format.js";
import { notifyStockChanged } from "../live.js";
import { Loading, Modal } from "../ui.jsx";
import { useApi } from "../useApi.js";

const NEW_CATEGORY = "__new__";

// "Greek Yogurt 750g" -> "greek_yogurt_750g", the recognition label format.
const toLabel = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

const wholeNumber = (value, min, max) =>
  /^\d+$/.test(String(value).trim()) && +value >= min && +value <= max ? +value : null;

function ProductIcon({ product }) {
  return hasFoodSprite(product.recognition_label, product.icon) ? (
    <FoodSprite label={product.recognition_label} icon={product.icon} size={24} />
  ) : (
    <span className="product-icon-blank" aria-hidden="true" />
  );
}

// Add a product, or edit one (product given).
function ProductForm({ product, categories, onSaved, onCancel }) {
  const editing = Boolean(product);
  const [form, setForm] = useState({
    name: product?.name ?? "",
    category: product ? String(product.category_id) : String(categories[0]?.category_id ?? NEW_CATEGORY),
    newCategory: "",
    unit: product?.unit ?? "",
    unitWeight: String(product?.unit_weight_g ?? ""),
    packageWeight: String(product?.package_weight_g ?? ""),
    shelfLife: String(product?.shelf_life_days ?? ""),
    label: product?.recognition_label ?? "",
    withRule: true,
    threshold: "2",
    warning: "2",
  });
  // Until the label is typed in, it follows the name.
  const [labelTouched, setLabelTouched] = useState(editing);
  const [icon, setIcon] = useState(product?.icon ?? null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (field) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => {
      const next = { ...f, [field]: value };
      if (field === "name" && !labelTouched) next.label = toLabel(value);
      return next;
    });
  };

  const unitWeight = wholeNumber(form.unitWeight, 1, 100000);
  const packageWeight = wholeNumber(form.packageWeight, 0, 100000);
  const shelfLife = wholeNumber(form.shelfLife, 0, 3650);
  const threshold = wholeNumber(form.threshold, 0, 10000);
  const warning = wholeNumber(form.warning, 0, 365);
  const problems = [
    !form.name.trim() && "Give the product a name.",
    form.category === NEW_CATEGORY && !form.newCategory.trim() && "Name the new category.",
    !form.unit.trim() && "Give a counting unit, e.g. carton.",
    unitWeight === null && "Unit weight must be a whole number of grams.",
    packageWeight === null && "Package weight must be a whole number of grams.",
    unitWeight !== null && packageWeight !== null && unitWeight <= packageWeight &&
      "A full unit must weigh more than its packaging.",
    shelfLife === null && "Shelf life must be a whole number of days.",
    !/^[a-z0-9_]+$/.test(form.label) && "The recognition label can use a–z, 0–9, and _.",
    !editing && form.withRule && (threshold === null || warning === null) &&
      "Alert limits must be whole numbers.",
  ].filter(Boolean);

  async function save(e) {
    e.preventDefault();
    if (problems.length) return;
    setBusy(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      unit: form.unit.trim(),
      unit_weight_g: unitWeight,
      package_weight_g: packageWeight,
      shelf_life_days: shelfLife,
      recognition_label: form.label,
      icon,
      ...(form.category === NEW_CATEGORY
        ? { new_category: form.newCategory.trim() }
        : { category_id: Number(form.category) }),
    };
    try {
      if (editing) {
        await updateProduct(product.product_id, body);
        onSaved(`Saved ${body.name}.`);
      } else {
        const rule = form.withRule ? { low_stock_threshold: threshold, expiry_warning_days: warning } : {};
        await createProduct({ ...body, ...rule });
        onSaved(`Added ${body.name}.`);
      }
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="product-form" onSubmit={save}>
      <div className="name-row">
        <div className="field">
          <span id="icon-label">Icon</span>
          <button
            type="button"
            className="icon-current"
            aria-labelledby="icon-label"
            aria-expanded={picking}
            onClick={() => setPicking(!picking)}
            title={picking ? "Close the icon picker" : "Choose an icon"}
          >
            {icon === null ? (
              <span className="product-icon-blank" aria-hidden="true" />
            ) : (
              <FoodSprite icon={icon} size={32} />
            )}
          </button>
        </div>
        <label className="field">
          <span>Name</span>
          <input type="text" value={form.name} onChange={set("name")} maxLength={80} autoFocus />
        </label>
      </div>
      {picking && (
        <IconPicker
          value={icon}
          onChange={(choice) => {
            setIcon(choice);
            setPicking(false);
          }}
        />
      )}
      <div className="field-pair">
        <label className="field">
          <span>Category</span>
          <select value={form.category} onChange={set("category")}>
            {categories.map((c) => (
              <option key={c.category_id} value={c.category_id}>
                {c.name}
              </option>
            ))}
            <option value={NEW_CATEGORY}>New category…</option>
          </select>
        </label>
        <label className="field">
          <span>Unit</span>
          <input type="text" value={form.unit} onChange={set("unit")} placeholder="carton" maxLength={30} />
        </label>
      </div>
      {form.category === NEW_CATEGORY && (
        <label className="field">
          <span>New category name</span>
          <input type="text" value={form.newCategory} onChange={set("newCategory")} maxLength={60} />
        </label>
      )}
      <div className="field-trio">
        <label className="field">
          <span>Unit weight (g)</span>
          <input type="number" min="1" className="num-input" value={form.unitWeight} onChange={set("unitWeight")} />
        </label>
        <label className="field">
          <span>Package (g)</span>
          <input type="number" min="0" className="num-input" value={form.packageWeight} onChange={set("packageWeight")} />
        </label>
        <label className="field">
          <span>Shelf life (days)</span>
          <input type="number" min="0" className="num-input" value={form.shelfLife} onChange={set("shelfLife")} />
        </label>
      </div>
      <p className="muted small">
        Unit weight is one full, unopened unit including packaging. The fridge uses both weights to
        count items from a row's weight.
      </p>
      <label className="field">
        <span>Recognition label</span>
        <input
          type="text"
          value={form.label}
          onChange={(e) => {
            setLabelTouched(true);
            set("label")(e);
          }}
          maxLength={80}
          spellCheck={false}
        />
      </label>

      {!editing && (
        <fieldset className="rule-fields">
          <label className="check">
            <input type="checkbox" checked={form.withRule} onChange={set("withRule")} />
            Set alert rules now
          </label>
          {form.withRule && (
            <div className="field-pair">
              <label className="field">
                <span>Low-stock threshold</span>
                <input type="number" min="0" className="num-input" value={form.threshold} onChange={set("threshold")} />
              </label>
              <label className="field">
                <span>Expiry warning (days)</span>
                <input type="number" min="0" className="num-input" value={form.warning} onChange={set("warning")} />
              </label>
            </div>
          )}
        </fieldset>
      )}

      {problems.length > 0 && (form.name || form.unit || form.unitWeight) && (
        <p className="alert-error">{problems[0]}</p>
      )}
      {error && <p className="alert-error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || problems.length > 0}>
          {busy ? "Saving…" : editing ? "Save" : "Add product"}
        </button>
      </div>
    </form>
  );
}

function ProductTable({ products, onEdit, onRemove, onRestore }) {
  return (
    <div className="sheet-wrap">
      <table className="sheet">
        <thead>
          <tr>
            <th>Product</th>
            <th>Unit</th>
            <th className="num" title="One full unit / its empty packaging">
              Full / empty
            </th>
            <th className="num">Shelf life</th>
            <th>Recognition label</th>
            <th className="num">In stock</th>
            <th>Alert rule</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.product_id}>
              <td>
                <span className="product-cell-name">
                  <ProductIcon product={p} />
                  {p.name}
                </span>
              </td>
              <td>{p.unit}</td>
              <td className="num">
                {formatGrams(p.unit_weight_g)} <span className="muted">/ {formatGrams(p.package_weight_g)}</span>
              </td>
              <td className="num">{plural(p.shelf_life_days, "day")}</td>
              <td>
                <code className="label-code">{p.recognition_label}</code>
              </td>
              <td className="num" title={`On ${plural(p.rows, "row")}`}>
                {p.in_stock || <span className="muted">–</span>}
              </td>
              <td>
                {p.low_stock_threshold === null ? (
                  <span className="muted">Not set</span>
                ) : (
                  `Low at ${p.low_stock_threshold} · ${p.expiry_warning_days}d warning`
                )}
              </td>
              <td className="actions">
                <span className="row-actions">
                  {p.active ? (
                    <>
                      <button type="button" className="btn btn-small" onClick={() => onEdit(p)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-small" onClick={() => onRemove(p)}>
                        Remove
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-small" onClick={() => onRestore(p)}>
                      Restore
                    </button>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function InventoryPage() {
  const { data, error, reload } = useApi(getInventory);
  const [dialog, setDialog] = useState(null); // null, { mode: "add" }, or { mode: "edit", product }
  const [notice, setNotice] = useState(null);
  const [actionError, setActionError] = useState(null);

  if (!data) return <Loading error={error} />;

  const active = data.products.filter((p) => p.active);
  const removed = data.products.filter((p) => !p.active);
  const categories = [...new Set(active.map((p) => p.category))];

  function changed(message) {
    setDialog(null);
    setNotice(message);
    setActionError(null);
    reload();
    notifyStockChanged(); // the simulator lists the catalog too
  }

  async function remove(product) {
    const ask = product.in_stock
      ? null
      : `Remove ${product.name} from the catalog?${product.rows ? ` It will be taken off ${plural(product.rows, "row")}.` : ""} Its stock history is kept.`;
    if (ask && !window.confirm(ask)) return;
    try {
      const result = await removeProduct(product.product_id);
      changed(
        result.removed === "archived"
          ? `Removed ${product.name}. Its history is kept, and you can restore it below.`
          : `Deleted ${product.name}.`,
      );
    } catch (e) {
      setNotice(null);
      setActionError(e.message);
    }
  }

  async function restore(product) {
    try {
      await restoreProduct(product.product_id);
      changed(`Restored ${product.name}.`);
    } catch (e) {
      setActionError(e.message);
    }
  }

  const tableProps = {
    onEdit: (product) => setDialog({ mode: "edit", product }),
    onRemove: remove,
    onRestore: restore,
  };

  return (
    <>
      <div className="page-head page-head-row">
        <div>
          <h1>Inventory</h1>
          <p className="summary">
            {plural(active.length, "product")} in the catalog. Fridges pull this list to set up
            their rows.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ mode: "add" })}>
          + Add product
        </button>
      </div>

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {actionError && <p className="error">{actionError}</p>}

      {categories.map((category) => (
        <section className="category" key={category}>
          <h2>
            {category}
            <span className="count">
              {plural(active.filter((p) => p.category === category).length, "product")}
            </span>
          </h2>
          <ProductTable products={active.filter((p) => p.category === category)} {...tableProps} />
        </section>
      ))}

      {removed.length > 0 && (
        <section className="category">
          <details className="removed-products">
            <summary>
              <h2>
                Removed products <span className="count">{removed.length}</span>
              </h2>
            </summary>
            <p className="muted small">Kept for stock history. Restore one to use it again.</p>
            <ProductTable products={removed} {...tableProps} />
          </details>
        </section>
      )}

      {dialog && (
        <Modal
          title={dialog.mode === "add" ? "Add a product" : `Edit ${dialog.product.name}`}
          onClose={() => setDialog(null)}
          wide
        >
          <ProductForm
            product={dialog.product}
            categories={data.categories}
            onSaved={changed}
            onCancel={() => setDialog(null)}
          />
        </Modal>
      )}
    </>
  );
}

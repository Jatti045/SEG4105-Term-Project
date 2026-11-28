import { useState } from "react";
import { deleteRule, getRules, updateRule } from "../api.js";
import { formatDateTime } from "../format.js";
import { Loading, Modal } from "../ui.jsx";
import { useApi } from "../useApi.js";

const NotSet = () => <span className="muted">Not set</span>;

// Same limits the backend enforces.
const LIMITS = { low_stock_threshold: 10000, expiry_warning_days: 365 };

function parseField(value, max) {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return n <= max ? n : null;
}

function RuleRow({ rule, defaultWarning, onSaved, onRemove }) {
  const hasRule = rule.low_stock_threshold !== null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const threshold = draft && parseField(draft.low_stock_threshold, LIMITS.low_stock_threshold);
  const warning = draft && parseField(draft.expiry_warning_days, LIMITS.expiry_warning_days);
  const valid = threshold !== null && warning !== null;

  function startEditing() {
    setDraft({
      low_stock_threshold: String(rule.low_stock_threshold ?? 0),
      expiry_warning_days: String(rule.expiry_warning_days ?? defaultWarning),
    });
    setError(null);
    setEditing(true);
  }

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await updateRule(rule.product_id, {
        low_stock_threshold: threshold,
        expiry_warning_days: warning,
      });
      setEditing(false);
      onSaved(`Saved alert rules for ${rule.product}.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter") save();
    if (e.key === "Escape") setEditing(false);
  }

  const input = (field, label) => (
    <input
      type="number"
      inputMode="numeric"
      min="0"
      max={LIMITS[field]}
      step="1"
      className="num-input"
      aria-label={`${label} for ${rule.product}`}
      aria-invalid={parseField(draft[field], LIMITS[field]) === null}
      value={draft[field]}
      onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
      onKeyDown={onKeyDown}
      disabled={busy}
    />
  );

  return (
    <tr className={editing ? "editing" : undefined}>
      <td>{rule.product}</td>
      <td>{rule.unit}</td>
      <td className="num">
        {editing
          ? input("low_stock_threshold", "Low-stock threshold")
          : hasRule
            ? rule.low_stock_threshold
            : <NotSet />}
      </td>
      <td className="num">
        {editing
          ? input("expiry_warning_days", "Expiry warning days")
          : hasRule
            ? rule.expiry_warning_days
            : <NotSet />}
      </td>
      <td className="date">{rule.updated_at ? formatDateTime(rule.updated_at) : <NotSet />}</td>
      <td className="actions">
        {editing ? (
          <span className="row-actions">
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={save}
              disabled={!valid || busy}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </button>
            {error && <span className="alert-error">{error}</span>}
            {!valid && !error && (
              <span className="alert-error">Whole numbers, 0 or more.</span>
            )}
          </span>
        ) : (
          <span className="row-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={startEditing}
              aria-label={`${hasRule ? "Edit" : "Add"} alert rules for ${rule.product}`}
            >
              {hasRule ? "Edit" : "Add"}
            </button>
            {hasRule && (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => onRemove(rule)}
                aria-label={`Remove alert rules for ${rule.product}`}
              >
                Remove
              </button>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}

// Add a rule for a product that doesn't have one yet.
function AddRuleForm({ products, defaultWarning, onSaved, onCancel }) {
  const [productId, setProductId] = useState(String(products[0]?.product_id ?? ""));
  const [threshold, setThreshold] = useState("2");
  const [warning, setWarning] = useState(String(defaultWarning));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const thresholdValue = parseField(threshold, LIMITS.low_stock_threshold);
  const warningValue = parseField(warning, LIMITS.expiry_warning_days);
  const valid = Boolean(productId) && thresholdValue !== null && warningValue !== null;

  async function save(e) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await updateRule(Number(productId), {
        low_stock_threshold: thresholdValue,
        expiry_warning_days: warningValue,
      });
      const product = products.find((p) => p.product_id === Number(productId));
      onSaved(`Added alert rules for ${product.product}.`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="product-form" onSubmit={save}>
      <label className="field">
        <span>Product</span>
        <select value={productId} onChange={(e) => setProductId(e.target.value)} autoFocus>
          {products.map((p) => (
            <option key={p.product_id} value={p.product_id}>
              {p.product}
            </option>
          ))}
        </select>
      </label>
      <div className="field-pair">
        <label className="field">
          <span>Low-stock threshold</span>
          <input
            type="number"
            min="0"
            className="num-input"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            aria-invalid={thresholdValue === null}
          />
        </label>
        <label className="field">
          <span>Expiry warning (days)</span>
          <input
            type="number"
            min="0"
            className="num-input"
            value={warning}
            onChange={(e) => setWarning(e.target.value)}
            aria-invalid={warningValue === null}
          />
        </label>
      </div>
      <p className="muted small">
        A low-stock alert is raised when stock falls to the threshold; an expiry alert, this many
        days before an item expires.
      </p>
      {error && <p className="alert-error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy || !valid}>
          {busy ? "Saving…" : "Add rule"}
        </button>
      </div>
    </form>
  );
}

export default function RulesPage() {
  const { data, error, reload } = useApi(getRules);
  const [notice, setNotice] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [adding, setAdding] = useState(false);
  if (!data) return <Loading error={error} />;

  const { categories, default_expiry_warning_days: defaultWarning } = data;
  const withoutRules = categories
    .flatMap((c) => c.items)
    .filter((r) => r.low_stock_threshold === null);

  function handleSaved(message) {
    setAdding(false);
    setActionError(null);
    setNotice(message);
    reload();
  }

  async function remove(rule) {
    const ask = `Remove the alert rules for ${rule.product}? It won't get low-stock alerts.`;
    if (!window.confirm(ask)) return;
    try {
      await deleteRule(rule.product_id);
      handleSaved(`Removed the alert rules for ${rule.product}.`);
    } catch (e) {
      setActionError(e.message);
    }
  }

  return (
    <>
      <div className="page-head page-head-row">
        <div>
          <h1>Alert rules</h1>
          <p className="summary">
            A low-stock alert is raised when stock falls to the threshold. An expiry alert is
            raised the set number of days before an item expires ({defaultWarning} days if not
            set).
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setAdding(true)}
          disabled={withoutRules.length === 0}
          title={withoutRules.length === 0 ? "Every product has alert rules" : undefined}
        >
          + Add rule
        </button>
      </div>
      <p className="notice" role="status">
        {notice}
      </p>
      {actionError && <p className="error">{actionError}</p>}

      {adding && (
        <Modal title="Add alert rules" onClose={() => setAdding(false)}>
          <AddRuleForm
            products={withoutRules}
            defaultWarning={defaultWarning}
            onSaved={handleSaved}
            onCancel={() => setAdding(false)}
          />
        </Modal>
      )}

      {categories.map((category) => (
        <section className="category" key={category.category_id}>
          <h2>{category.name}</h2>
          <div className="sheet-wrap">
            <table className="sheet">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Unit</th>
                  <th className="num">Low-stock threshold</th>
                  <th className="num">Expiry warning (days)</th>
                  <th>Last changed</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {category.items.map((rule) => (
                  <RuleRow
                    rule={rule}
                    key={rule.product_id}
                    defaultWarning={defaultWarning}
                    onSaved={handleSaved}
                    onRemove={remove}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

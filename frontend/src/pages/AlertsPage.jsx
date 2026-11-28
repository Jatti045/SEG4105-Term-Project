import { useState } from "react";
import { clearAlert, getAlerts } from "../api.js";
import { formatDateTime, formatGrams, plural } from "../format.js";
import { Loading, StatusBadge } from "../ui.jsx";
import { useApi } from "../useApi.js";

function expiryText(days) {
  if (days < 0) return `Expired ${plural(-days, "day")} ago`;
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}

function mismatchText(alert) {
  const count =
    alert.current_count === alert.listed_count
      ? `Sensor counts ${alert.current_count}, as listed`
      : `Sensor counts ${alert.current_count}, but ${alert.listed_count} listed`;
  const range =
    alert.listed_count === 0
      ? "nothing listed"
      : `listed items weigh ${formatGrams(alert.min_weight_g)}–${formatGrams(alert.max_weight_g)}`;
  return `${count} · Weighs ${formatGrams(alert.current_weight_g)}, ${range}`;
}

// How to show an alert: badge style and label, and a one-line summary.
function describe(alert) {
  switch (alert.alert_type) {
    case "expiry": {
      const expired = alert.days_left < 0;
      return {
        kind: expired ? "expired" : "expiring",
        label: expired ? "Expired" : "Expiring soon",
        detail: `${expiryText(alert.days_left)} · ${alert.expiry_date}`,
      };
    }
    case "stock_mismatch":
      return { kind: "mismatch", label: "Stock mismatch", detail: mismatchText(alert) };
    default:
      return {
        kind: "low",
        label: "Low stock",
        detail: `${alert.in_stock} in stock · alert at ${alert.low_stock_threshold ?? "–"}`,
      };
  }
}

// Where on the stock page an alert points: the item, the row's items, or the product.
function stockLink(alert) {
  const params = new URLSearchParams({ product: alert.product_id });
  if (alert.alert_type === "expiry" && alert.item_id) params.set("item", alert.item_id);
  if (alert.alert_type === "stock_mismatch" && alert.row_id) params.set("row", alert.row_id);
  return `#/stock?${params}`;
}

function whereText(alert) {
  const parts = [];
  if (alert.fridge) parts.push(alert.fridge, alert.row_label);
  if (alert.item_id) parts.push(`Item #${alert.item_id}`);
  return parts.join(" · ");
}

function AlertCard({ alert, onCleared }) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState(null);
  const { kind, label, detail } = describe(alert);
  const where = whereText(alert);

  async function handleClear() {
    setClearing(true);
    setError(null);
    try {
      await clearAlert(alert.alert_id);
      onCleared();
    } catch (e) {
      setError(e.message);
      setClearing(false);
    }
  }

  return (
    <article className={`alert-card ${kind}`}>
      <StatusBadge kind={kind}>{label}</StatusBadge>
      <div className="alert-main">
        <h3>
          {/* Covers the whole card (see .alert-link), so clicking anywhere opens the stock page. */}
          <a className="alert-link" href={stockLink(alert)}>
            {alert.product}
          </a>
        </h3>
        <p className="alert-detail">{detail}</p>
        {where && <p className="alert-meta">{where}</p>}
        {error && <p className="alert-error">{error}</p>}
      </div>
      <div className="alert-side">
        <span className="alert-meta">Raised {formatDateTime(alert.raised_at)}</span>
        <button type="button" className="btn" onClick={handleClear} disabled={clearing}>
          {clearing ? "Clearing…" : "Clear"}
        </button>
      </div>
    </article>
  );
}

function ClearedTable({ alerts }) {
  return (
    <div className="sheet-wrap">
      <table className="sheet">
        <thead>
          <tr>
            <th>Raised</th>
            <th>Type</th>
            <th>Item</th>
            <th>Location</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((alert) => {
            const { kind, label, detail } = describe(alert);
            return (
              <tr key={alert.alert_id}>
                <td className="date">{formatDateTime(alert.raised_at)}</td>
                <td>
                  <StatusBadge kind={kind}>{label}</StatusBadge>
                </td>
                <td>
                  <a href={stockLink(alert)}>{alert.product}</a>
                </td>
                <td>{whereText(alert) || <span className="muted">–</span>}</td>
                <td>{detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function AlertsPage() {
  const { data, error, reload } = useApi(getAlerts);
  if (!data) return <Loading error={error} />;

  const { active, cleared } = data;

  return (
    <>
      <div className="page-head">
        <h1>Alerts</h1>
        <p className="summary">
          {plural(active.length, "active alert")}. Select an alert to see its stock, and clear
          it once you've dealt with it.
        </p>
      </div>

      <section className="category">
        <h2>
          Active <span className="count">{active.length}</span>
        </h2>
        {active.length === 0 ? (
          <p className="muted">No active alerts. You're all caught up.</p>
        ) : (
          <div className="alert-list">
            {active.map((a) => (
              <AlertCard alert={a} key={a.alert_id} onCleared={reload} />
            ))}
          </div>
        )}
      </section>

      <section className="category">
        <h2>
          Cleared <span className="count">{cleared.length}</span>
        </h2>
        {cleared.length === 0 ? (
          <p className="muted">No cleared alerts.</p>
        ) : (
          <ClearedTable alerts={cleared} />
        )}
      </section>
    </>
  );
}

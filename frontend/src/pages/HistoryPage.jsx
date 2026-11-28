import { useCallback } from "react";
import { getHistory } from "../api.js";
import { formatDateTime, parseDate, plural } from "../format.js";
import { Loading } from "../ui.jsx";
import { useApi } from "../useApi.js";

const PERIODS = [
  { id: "day", label: "Daily", noun: "day" },
  { id: "week", label: "Weekly", noun: "week" },
  { id: "month", label: "Monthly", noun: "month" },
  { id: "year", label: "Yearly", noun: "year" },
];

const REASON_LABELS = {
  expired: "Expired",
  spoiled: "Spoiled",
  damaged: "Damaged",
  other: "Other",
};

const fmt = (iso, options) => parseDate(iso).toLocaleDateString(undefined, options);

function periodLabel({ period, start, end }) {
  switch (period) {
    case "day":
      return fmt(start, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    case "week":
      return `${fmt(start, { month: "short", day: "numeric" })} – ${fmt(end, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}`;
    case "month":
      return fmt(start, { month: "long", year: "numeric" });
    default:
      return String(parseDate(start).getFullYear());
  }
}

// Column header for one bucket of the breakdown.
function BucketHeader({ period, iso }) {
  if (period === "year") return fmt(iso, { month: "short" });
  return (
    <span className="bucket-head" title={fmt(iso, { dateStyle: "full" })}>
      <span className="bucket-weekday">{fmt(iso, { weekday: "short" })}</span>
      {parseDate(iso).getDate()}
    </span>
  );
}

const Dash = () => <span className="muted">–</span>;
const show = (n) => (n === null || n === undefined ? <Dash /> : n);

function go(period, date) {
  const params = new URLSearchParams({ period });
  if (date) params.set("date", date);
  window.location.hash = `#/history?${params}`;
}

export default function HistoryPage({ params = {} }) {
  const period = PERIODS.some((p) => p.id === params.period) ? params.period : "week";
  const date = params.date ?? null;

  const load = useCallback(() => getHistory(period, date), [period, date]);
  const { data, error } = useApi(load);
  if (!data) return <Loading error={error} />;

  const { totals, buckets, categories, waste } = data;
  const noun = PERIODS.find((p) => p.id === data.period).noun;
  const isCurrent = data.next === null;
  const handled = totals.used + totals.wasted;
  const wasteRate = handled > 0 ? Math.round((totals.wasted / handled) * 100) : null;
  const breakdownLabel = data.period === "year" ? "Stock at end of month" : "Stock at end of day";

  return (
    <>
      <div className="page-head">
        <h1>Stock history</h1>
        <p className="summary">
          What came in, what was used, and what was thrown out, by {noun}.
        </p>
      </div>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Report period">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === data.period}
              onClick={() => go(p.id, date)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="period-nav">
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => go(period, data.previous)}
            aria-label={`Previous ${noun}`}
          >
            ‹
          </button>
          <span className="period-label" aria-live="polite">
            {periodLabel(data)}
          </span>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => go(period, data.next)}
            disabled={isCurrent}
            aria-label={`Next ${noun}`}
          >
            ›
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => go(period, null)}
            disabled={isCurrent}
          >
            This {noun}
          </button>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <span className="stat-value">{totals.added}</span>
          <span className="stat-label">Items added</span>
        </div>
        <div className="stat">
          <span className="stat-value">{totals.used}</span>
          <span className="stat-label">Items used</span>
        </div>
        <div className="stat expired">
          <span className="stat-value">{totals.wasted}</span>
          <span className="stat-label">Items thrown out</span>
        </div>
        <div className="stat expiring" title="Thrown out ÷ (used + thrown out)">
          <span className="stat-value">{wasteRate === null ? "–" : `${wasteRate}%`}</span>
          <span className="stat-label">Waste rate</span>
        </div>
      </div>

      {categories.map((category) => (
        <section className="category" key={category.category_id}>
          <h2>{category.name}</h2>
          <div className="sheet-wrap">
            <table className="sheet report">
              <thead>
                {buckets.length > 0 && (
                  <tr>
                    <th className="group sticky" colSpan={2} />
                    <th className="group" colSpan={5}>
                      This {noun}
                    </th>
                    <th className="group breakdown-start" colSpan={buckets.length}>
                      {breakdownLabel}
                    </th>
                  </tr>
                )}
                <tr>
                  <th className="sticky">Product</th>
                  <th>Unit</th>
                  <th className="num">Start</th>
                  <th className="num">Added</th>
                  <th className="num">Used</th>
                  <th className="num">Thrown out</th>
                  <th className="num">End</th>
                  {buckets.map((iso, i) => (
                    <th key={iso} className={`num bucket${i === 0 ? " breakdown-start" : ""}`}>
                      <BucketHeader period={data.period} iso={iso} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {category.items.map((p) => (
                  <tr key={p.product_id}>
                    <td className="sticky product-cell">
                      {p.product}
                      {!p.active && <span className="muted small"> · Removed</span>}
                    </td>
                    <td>{p.unit}</td>
                    <td className="num">{show(p.opening)}</td>
                    <td className="num">{p.added || <Dash />}</td>
                    <td className="num">{show(p.used)}</td>
                    <td className={`num${p.wasted ? " wasted" : ""}`}>{p.wasted || <Dash />}</td>
                    <td className="num strong">{show(p.closing)}</td>
                    {p.levels.map((level, i) => (
                      <td
                        key={buckets[i]}
                        className={`num bucket${i === 0 ? " breakdown-start" : ""}`}
                      >
                        {show(level)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="category">
        <h2>
          Waste log
          <span className="count">{plural(totals.wasted, "item")} thrown out this {noun}</span>
        </h2>
        {waste.length === 0 ? (
          <p className="muted">Nothing thrown out this {noun}.</p>
        ) : (
          <>
            <div className="sheet-wrap">
              <table className="sheet">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Item</th>
                    <th className="num">Item ID</th>
                    <th>Reason</th>
                    <th>Logged by</th>
                  </tr>
                </thead>
                <tbody>
                  {waste.map((w) => (
                    <tr key={w.waste_id}>
                      <td className="date">{formatDateTime(w.recorded_at)}</td>
                      <td>{w.product}</td>
                      <td className="num">{w.item_id}</td>
                      <td>{REASON_LABELS[w.reason] ?? w.reason}</td>
                      <td>{w.logged_by ?? <span className="muted">System</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {waste.length < totals.wasted && (
              <p className="muted table-note">Showing the {waste.length} most recent.</p>
            )}
          </>
        )}
      </section>
    </>
  );
}

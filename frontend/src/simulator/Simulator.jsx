import { useEffect, useMemo, useState } from "react";
import {
  getFridges,
  getProducts,
  getRecognitionSamples,
  recognizeImage,
  sendReading,
  setFridgeConfiguration,
} from "../api.js";
import { colorFor } from "../colors.js";
import FoodSprite, { hasFoodSprite } from "../FoodSprite.jsx";
import { formatDateTime, formatGrams } from "../format.js";
import { notifyStockChanged, onStockChanged } from "../live.js";
import { sampleImage, unknownItemImage } from "./png.js";

const UNASSIGNED = "";
const MAX_ITEMS = 40;
const NOISE_G = 8;
const SPRITES_SHOWN = 12;

// A row's state: the product it's set up for (product_id, or null), and how many
// of it are on the scale. Rebuilt from the last reading on record.
function rowFromRecord(row, byId) {
  const base = {
    row_id: row.row_id,
    label: row.label,
    shelf: row.label.split(",")[0],
    position: row.label.split(", ")[1] ?? row.label,
    product: null,
    count: 0,
    remaining: 100,
    dirty: false,
  };
  const product = byId[row.product_id];
  if (!product) return base;
  const count = row.current_count;
  let remaining = 100;
  if (count > 0) {
    // How full the opened item is, from how far the weight falls short of full units.
    const opened = row.current_weight_g - (count - 1) * product.unit_weight_g;
    const fraction =
      (opened - product.package_weight_g) / (product.unit_weight_g - product.package_weight_g);
    remaining = Math.round(Math.min(1, Math.max(0, fraction)) * 10) * 10;
  }
  return { ...base, product: product.product_id, count, remaining };
}

// Rows from the records, keeping any the user has changed but not yet sent.
function buildRows(fridge, byId, previous = []) {
  const changed = Object.fromEntries(previous.filter((r) => r.dirty).map((r) => [r.row_id, r]));
  return fridge.rows.map((r) => changed[r.row_id] ?? rowFromRecord(r, byId));
}

// What the row's scale reads: full units, plus the opened one at `remaining` %.
function rowWeight(row, product) {
  if (!product || row.count === 0) return 0;
  const opened =
    product.package_weight_g +
    ((product.unit_weight_g - product.package_weight_g) * row.remaining) / 100;
  return Math.round((row.count - 1) * product.unit_weight_g + opened);
}

// Badges for what the configuration change and the reading did to a row.
function describeChange(result) {
  const parts = [];
  const { setup, reading } = result;
  if (setup?.changed) {
    parts.push({ kind: "low", text: setup.product ? `Set up for ${setup.product}` : "Unassigned" });
  }
  if (setup?.removed_items) parts.push({ kind: "low", text: `${setup.removed_items} removed` });
  if (reading) {
    if (reading.unrecognized) parts.push({ kind: "mismatch", text: "Not recognized" });
    if (reading.product_changed) parts.push({ kind: "low", text: `Now ${reading.product}` });
    if (reading.image_matches === false) {
      parts.push({ kind: "mismatch", text: "Camera disagrees with setup" });
    }
    if (reading.added) parts.push({ kind: "fresh", text: `+${reading.added} added` });
    if (reading.used) parts.push({ kind: "low", text: `${reading.used} used` });
    if (reading.thrown_out) {
      parts.push({ kind: "expired", text: `${reading.thrown_out} thrown out (expired)` });
    }
  }
  return parts;
}

function Sprites({ row, product }) {
  if (!product || row.count === 0) return <div className="sprites empty">Empty</div>;
  const shown = Math.min(row.count, SPRITES_SHOWN);
  const icon = hasFoodSprite(product.recognition_label, product.icon);
  return (
    <div className="sprites">
      {Array.from({ length: shown }, (_, i) => {
        // The last item is the opened one: it fades as it empties.
        const last = i === shown - 1 && shown === row.count;
        const fill = last ? row.remaining : 100;
        return icon ? (
          <span key={i} className="food-item" style={{ opacity: 0.35 + (0.65 * fill) / 100 }}>
            <FoodSprite label={product.recognition_label} icon={product.icon} size={28} />
          </span>
        ) : (
          <span
            key={i}
            className="sprite"
            style={{ "--sprite": colorFor(product.recognition_label), "--fill": `${fill}%` }}
          />
        );
      })}
      {row.count > shown && <span className="sprite-more">+{row.count - shown}</span>}
    </div>
  );
}

function RowCard({ row, products, byId, hasSample, result, image, onChange }) {
  const product = byId[row.product];
  const categories = [...new Set(products.map((p) => p.category))];

  function chooseProduct(value) {
    const id = value === UNASSIGNED ? null : Number(value);
    if (id === row.product) return;
    // Setting a row up for a new product: its old items come out, one new one goes in.
    onChange({ product: id, count: id === null ? 0 : 1, remaining: 100 });
  }

  return (
    <article className={`sim-row${row.dirty ? " dirty" : ""}`}>
      <header className="sim-row-head">
        <span className="sim-row-label">{row.position}</span>
        {row.dirty && <span className="status expiring">Changed</span>}
      </header>

      <Sprites row={row} product={product} />

      <label className="field">
        <span>Row set up for</span>
        <select value={row.product ?? UNASSIGNED} onChange={(e) => chooseProduct(e.target.value)}>
          <option value={UNASSIGNED}>Unassigned</option>
          {categories.map((category) => (
            <optgroup key={category} label={category}>
              {products
                .filter((p) => p.category === category)
                .map((p) => (
                  <option key={p.product_id} value={p.product_id}>
                    {p.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      {product && !hasSample(product) && (
        <p className="muted small sim-hint">
          The mock model has no image for this product, so readings rely on the row's setup.
        </p>
      )}

      {product && (
        <div className="stepper" role="group" aria-label={`Items in ${row.label}`}>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Take one out"
            disabled={row.count === 0}
            onClick={() => onChange({ count: row.count - 1, remaining: 100 })}
          >
            −
          </button>
          <span className="stepper-value">
            {row.count} {product.unit}
            {row.count === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Put one in"
            disabled={row.count >= MAX_ITEMS}
            onClick={() => onChange({ count: row.count + 1 })}
          >
            +
          </button>
        </div>
      )}

      {product && row.count > 0 && (
        <label className="field">
          <span>Opened item: {row.remaining}% left</span>
          <input
            type="range"
            min="0"
            max="100"
            step="10"
            value={row.remaining}
            onChange={(e) => onChange({ remaining: Number(e.target.value) })}
          />
        </label>
      )}

      <footer className="sim-row-foot">
        <span className="muted">Scale ≈ {formatGrams(rowWeight(row, product))}</span>
        {image && <img src={image} alt={`Last image sent for ${row.label}`} className="sim-thumb" />}
      </footer>

      {result && !row.dirty && (
        <div className="badges wrap">
          {describeChange(result).map((part) => (
            <span key={part.text} className={`status ${part.kind}`}>
              {part.text}
            </span>
          ))}
          {describeChange(result).length === 0 && <span className="muted small">No change</span>}
        </div>
      )}
    </article>
  );
}

// Upload any PNG and see what the mock model makes of it, next to the images it knows.
function RecognizerPanel({ samples }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(file) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setResult({ file: file.name, ...(await recognizeImage(file)) });
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  async function runSample(sample) {
    const blob = await sampleImage(sample.url);
    run(new File([blob], sample.sample, { type: "image/png" }));
  }

  return (
    <details className="recognizer">
      <summary>Image recognition (mock)</summary>
      <p className="muted small">
        The mock model knows one image per product, plus an empty shelf. Each image has one set
        output; any other image isn't recognized.
      </p>
      <label className="field">
        <span>Try a PNG</span>
        <input
          type="file"
          accept="image/png"
          onChange={(e) => run(e.target.files[0])}
          disabled={busy}
        />
      </label>
      {error && <p className="alert-error">{error}</p>}
      {result && (
        <div className="recognizer-result">
          <strong>{result.file}</strong>
          <span>
            {result.recognized
              ? result.label
                ? `${result.product ?? result.label} (${Math.round(result.confidence * 100)}%)`
                : `Empty shelf (${Math.round(result.confidence * 100)}%)`
              : "Not recognized"}
          </span>
          <code>{JSON.stringify({ label: result.label, confidence: result.confidence })}</code>
        </div>
      )}
      <ul className="sample-list">
        {samples.map((s) => (
          <li key={s.sample}>
            <button
              type="button"
              className="sample"
              onClick={() => runSample(s)}
              title="Run the model on this image"
            >
              <img src={s.url} alt="" />
              <span>{s.product ?? "Empty shelf"}</span>
            </button>
            <a href={s.url} download={s.sample} className="small">
              Download
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function Simulator() {
  const [products, setProducts] = useState(null);
  const [samples, setSamples] = useState([]);
  const [fridges, setFridges] = useState(null);
  const [fridgeId, setFridgeId] = useState(null);
  const [rows, setRows] = useState([]);
  const [noise, setNoise] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState({});
  const [images, setImages] = useState({});
  const [log, setLog] = useState([]);

  const byId = useMemo(
    () => Object.fromEntries((products ?? []).map((p) => [p.product_id, p])),
    [products],
  );
  const sampleFor = (product) => samples.find((s) => s.label === product.recognition_label);
  const fridge = fridges?.find((f) => f.fridge_id === fridgeId);

  // First load: the catalog the fridge pulls, the fridges, and the model's sample images.
  useEffect(() => {
    Promise.all([getProducts(), getFridges(), getRecognitionSamples()]).then(([p, f, s]) => {
      const ids = Object.fromEntries(p.map((x) => [x.product_id, x]));
      setProducts(p);
      setSamples(s);
      setFridges(f);
      setFridgeId(f[0]?.fridge_id ?? null);
      setRows(f[0] ? buildRows(f[0], ids) : []);
    }, (e) => setError(e.message));
  }, []);

  // When the dashboard changes stock or the catalog (e.g. throws an item out, or
  // adds a product), the real fridge would see it: reload the catalog and the
  // rows that haven't been changed here.
  useEffect(() => {
    if (fridgeId === null) return undefined;
    return onStockChanged(async () => {
      const [p, f] = await Promise.all([getProducts(), getFridges()]);
      const ids = Object.fromEntries(p.map((x) => [x.product_id, x]));
      setProducts(p);
      setFridges(f);
      const current = f.find((x) => x.fridge_id === fridgeId);
      if (current) setRows((prev) => buildRows(current, ids, prev));
    });
  }, [fridgeId]);

  const changedCount = rows.filter((r) => r.dirty).length;

  async function chooseFridge(id) {
    if (id === fridgeId) return;
    if (changedCount && !window.confirm("Discard the changes you haven't sent?")) return;
    const f = await getFridges();
    setFridges(f);
    setFridgeId(id);
    setRows(buildRows(f.find((x) => x.fridge_id === id), byId));
    setResults({});
    setImages((old) => {
      Object.values(old).forEach(URL.revokeObjectURL);
      return {};
    });
  }

  function updateRow(rowId, changes) {
    setRows((rs) => rs.map((r) => (r.row_id === rowId ? { ...r, ...changes, dirty: true } : r)));
  }

  async function closeDoor() {
    setSending(true);
    setError(null);
    const urls = {};
    try {
      // 1. The fridge passes back its configuration: which product each row holds.
      const setup = await setFridgeConfiguration(
        fridgeId,
        rows.map((r) => ({ row_id: r.row_id, product_id: r.product })),
      );

      // 2. Then the reading: a PNG and a weight for every row.
      const empty = samples.find((s) => s.label === null);
      const form = new FormData();
      const payload = [];
      for (const row of rows) {
        const product = byId[row.product];
        let weight = rowWeight(row, product);
        if (noise && weight > 0) {
          weight = Math.max(0, weight + Math.round((Math.random() * 2 - 1) * NOISE_G));
        }
        // The camera sees the product's sample image, or a bare shelf. A product the
        // mock model has no image for comes out as an image it can't recognize.
        let png;
        if (!product || row.count === 0) png = await sampleImage(empty.url);
        else if (sampleFor(product)) png = await sampleImage(sampleFor(product).url);
        else png = await unknownItemImage();
        form.append(`image_${row.row_id}`, png, `row-${row.row_id}.png`);
        urls[row.row_id] = URL.createObjectURL(png);
        payload.push({ row_id: row.row_id, weight_g: weight });
      }
      form.append("reading", JSON.stringify({ rows: payload }));
      const response = await sendReading(fridgeId, form);

      setImages((old) => {
        Object.values(old).forEach(URL.revokeObjectURL);
        return urls;
      });
      const setups = Object.fromEntries(setup.rows.map((c) => [c.row_id, c]));
      const combined = Object.fromEntries(
        response.rows.map((c) => [c.row_id, { setup: setups[c.row_id], reading: c }]),
      );
      setResults(combined);
      setRows((rs) => rs.map((r) => ({ ...r, dirty: false })));
      const changed = response.rows
        .map((c) => ({ label: c.label, parts: describeChange(combined[c.row_id]) }))
        .filter((c) => c.parts.length);
      setLog((entries) =>
        [
          {
            id: `${response.taken_at}-${fridgeId}`,
            at: response.taken_at,
            fridge: fridge.name,
            changed,
            alerts: response.alerts_raised,
          },
          ...entries,
        ].slice(0, 20),
      );
      notifyStockChanged();
    } catch (e) {
      Object.values(urls).forEach(URL.revokeObjectURL);
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  const shelves = [...new Set(rows.map((r) => r.shelf))];

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <rect x="6" y="2.5" width="12" height="19" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M6 10h12M9 6v2M9 13v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            Fridge Simulator
          </span>
          <a className="topbar-link" href="/" target="_blank" rel="noreferrer">
            Open dashboard ↗
          </a>
        </div>
      </header>

      <main className="sim">
        <div className="page-head">
          <h1>Fridge simulator</h1>
          <p className="summary">
            Set up which product each row holds, stock it like a real fridge, then close the
            door. The fridge sends its row setup, then a reading with a PNG image and a weight
            for every row, and the dashboard updates.
          </p>
        </div>

        {error && <p className="error">{error}</p>}

        {!fridges || !products ? (
          !error && <p className="muted">Loading fridges…</p>
        ) : (
          <div className="sim-layout">
            <section>
              <div className="segmented" role="group" aria-label="Fridge">
                {fridges.map((f) => (
                  <button
                    key={f.fridge_id}
                    type="button"
                    aria-pressed={f.fridge_id === fridgeId}
                    onClick={() => chooseFridge(f.fridge_id)}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
              {fridge && <p className="muted sim-location">{fridge.location}</p>}

              <div className="fridge-body">
                <div className="sim-cabinet-display" aria-hidden="true">
                  <span className="sim-display-light" />
                  <span>SMART INVENTORY UNIT</span>
                </div>
                {shelves.map((shelf) => (
                  <div className="shelf" key={shelf}>
                    <h2 className="shelf-name">{shelf}</h2>
                    <div className="shelf-rows">
                      {rows
                        .filter((r) => r.shelf === shelf)
                        .map((row) => (
                          <RowCard
                            key={row.row_id}
                            row={row}
                            products={products}
                            byId={byId}
                            hasSample={(p) => Boolean(sampleFor(p))}
                            result={results[row.row_id]}
                            image={images[row.row_id]}
                            onChange={(changes) => updateRow(row.row_id, changes)}
                          />
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <aside className="sim-panel">
              <div className={`door ${changedCount ? "open" : ""}`}>
                <span className="door-dot" aria-hidden="true" />
                {changedCount
                  ? `Door open · ${changedCount} row${changedCount === 1 ? "" : "s"} changed`
                  : "Door closed"}
              </div>
              <label className="check">
                <input type="checkbox" checked={noise} onChange={(e) => setNoise(e.target.checked)} />
                Add scale noise (±{NOISE_G} g)
              </label>
              <button
                type="button"
                className="btn btn-primary btn-block"
                onClick={closeDoor}
                disabled={sending || !fridge}
              >
                {sending ? "Sending…" : "Close door & send reading"}
              </button>

              <RecognizerPanel samples={samples} />

              <h3>Readings sent</h3>
              {log.length === 0 ? (
                <p className="muted small">None yet.</p>
              ) : (
                <ol className="sim-log">
                  {log.map((entry) => (
                    <li key={entry.id}>
                      <div className="sim-log-head">
                        <strong>{entry.fridge}</strong>
                        <span className="muted small">{formatDateTime(entry.at)}</span>
                      </div>
                      {entry.changed.length === 0 ? (
                        <span className="muted small">No changes</span>
                      ) : (
                        <ul>
                          {entry.changed.map((c) => (
                            <li key={c.label}>
                              {c.label}: {c.parts.map((p) => p.text).join(", ")}
                            </li>
                          ))}
                        </ul>
                      )}
                      {entry.alerts > 0 && (
                        <span className="status mismatch">
                          {entry.alerts} new alert{entry.alerts === 1 ? "" : "s"}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </aside>
          </div>
        )}
      </main>
    </>
  );
}

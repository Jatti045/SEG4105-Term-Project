async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // detail is a message, or a list of messages / validation errors.
    const detail = Array.isArray(body.detail)
      ? body.detail.map((d) => (typeof d === "string" ? d : d.msg)).join(" ")
      : typeof body.detail === "string"
        ? body.detail
        : null;
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return res.json();
}

const getJson = (path) => request(path);
const send = (method, path, body) =>
  request(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
const post = (path, body) => send("POST", path, body);
const put = (path, body) => send("PUT", path, body);

export const getCurrentUser = () => getJson("/api/me");
export const getStock = () => getJson("/api/manager/stock");
export function getHistory(period, date) {
  const params = new URLSearchParams({ period });
  if (date) params.set("date", date);
  return getJson(`/api/manager/history?${params}`);
}
export const getRules = () => getJson("/api/manager/rules");
export const getFloor = () => getJson("/api/manager/floor");

// Raises any alerts that are now due (items reach their warning window with time).
export const runAlertChecks = () => post("/api/manager/alerts/check");

export async function getAlerts() {
  await runAlertChecks();
  return getJson("/api/manager/alerts");
}

export const createFridge = (fridge) => post("/api/manager/fridges", fridge);

// Inventory: the product catalog, managed by managers.
export const getInventory = () => getJson("/api/manager/products");
export const createProduct = (product) => post("/api/manager/products", product);
export const updateProduct = (productId, changes) =>
  send("PATCH", `/api/manager/products/${productId}`, changes);
export const removeProduct = (productId) => send("DELETE", `/api/manager/products/${productId}`);
export const restoreProduct = (productId) => post(`/api/manager/products/${productId}/restore`);
export const deleteRule = (productId) => send("DELETE", `/api/manager/rules/${productId}`);

// Fridge configuration: which product each row holds.
export const setFridgeConfiguration = (fridgeId, rows) =>
  send("PUT", `/api/fridges/${fridgeId}/configuration`, { rows });
export const updateFridge = (fridgeId, changes) =>
  send("PATCH", `/api/manager/fridges/${fridgeId}`, changes);

export const clearAlert = (alertId) => post(`/api/manager/alerts/${alertId}/clear`);
// Fridge simulator: the catalog, fridge layout, and readings API.
export const getProducts = () => getJson("/api/products");
export const getFridges = () => getJson("/api/fridges");
export const sendReading = (fridgeId, form) =>
  request(`/api/fridges/${fridgeId}/readings`, { method: "POST", body: form });

// Mock recognition model: its sample images, and running it on one PNG.
export const getRecognitionSamples = () => getJson("/api/recognition/samples");
export function recognizeImage(file) {
  const form = new FormData();
  form.append("image", file);
  return request("/api/recognition", { method: "POST", body: form });
}

export const updateRule =(productId, rule) => put(`/api/manager/rules/${productId}`, rule);
export const throwOutItem =(itemId, reason) =>
  post(`/api/manager/items/${itemId}/throw-out`, { reason });

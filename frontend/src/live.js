// Lets the dashboard and the fridge simulator, open in separate tabs, tell each
// other when stock changes, so each can reload. A tab doesn't hear its own messages.
const channel =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("smart-fridge-stock");
const listeners = new Set();

channel?.addEventListener("message", (event) => {
  if (event.data?.type === "stock-changed") listeners.forEach((listener) => listener());
});

export function notifyStockChanged() {
  channel?.postMessage({ type: "stock-changed" });
}

// Returns a function that stops listening.
export function onStockChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

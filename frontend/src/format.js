export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "YYYY-MM-DD" as a local date, so it doesn't shift across time zones.
export function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export const formatDay = (iso) =>
  parseDate(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

export const formatGrams = (g) => `${g.toLocaleString()} g`;

export const formatDateTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function daysLeftLabel(days) {
  if (days === 0) return "Today";
  if (days < 0) return `${-days} ago`;
  return String(days);
}

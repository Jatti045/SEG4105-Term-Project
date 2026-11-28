// A steady colour per product label, so a product looks the same everywhere.
export function colorFor(label) {
  if (!label) return "#c9d3cc";
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 52%)`;
}

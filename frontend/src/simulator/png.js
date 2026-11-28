// Images the simulated fridge camera sends.
//
// The mock recognition model knows a fixed set of sample images, one per
// product plus an empty shelf (backend/mock_model). Rows holding a catalog
// product send that product's sample; an item that isn't in the catalog sends
// an image drawn here, which the model won't recognize.

const cache = new Map();

// The sample image at `url` (from /api/recognition/samples), fetched once.
export async function sampleImage(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url).then((res) => {
        if (!res.ok) throw new Error(`Couldn't load sample image ${url}`);
        return res.blob();
      }),
    );
  }
  return cache.get(url);
}

// A camera image of something the model doesn't know.
export function unknownItemImage() {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 80;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f4f7f5";
  ctx.fillRect(0, 0, 160, 80);
  ctx.fillStyle = "#c9d3cc";
  ctx.fillRect(0, 70, 160, 10);
  ctx.fillStyle = "#6b3fa0";
  ctx.fillRect(56, 22, 48, 48);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 28px system-ui, sans-serif";
  ctx.fillText("?", 72, 57);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

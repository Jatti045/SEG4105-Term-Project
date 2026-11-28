import sprites from "./foodSprites.json";

// Pixel-art food icons, cut from the sprite sheet in public/sprites/food.png.
// A product's icon is the tile number saved with it (0-63, row by row). Older
// callers that only know the recognition label fall back to the tiles in
// foodSprites.json.

export const ICON_COUNT = sprites.columns * sprites.rows;

function tileFor(icon, label) {
  if (Number.isInteger(icon) && icon >= 0 && icon < ICON_COUNT) {
    return [Math.floor(icon / sprites.columns), icon % sprites.columns];
  }
  if (icon === null) return null; // explicitly no icon
  return sprites.products[label] ?? null;
}

export function hasFoodSprite(label, icon) {
  return tileFor(icon, label) !== null;
}

// Returns null when the product has no icon, so callers can draw something else.
export default function FoodSprite({ label, icon, size = 32, className = "" }) {
  const tile = tileFor(icon, label);
  if (!tile) return null;
  const [row, col] = tile;
  return (
    <span
      className={`food-sprite ${className}`}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${sprites.sheet})`,
        backgroundSize: `${sprites.columns * 100}% ${sprites.rows * 100}%`,
        backgroundPosition: `${(col / (sprites.columns - 1)) * 100}% ${(row / (sprites.rows - 1)) * 100}%`,
      }}
    />
  );
}

// A grid of every icon to choose from, plus "no icon".
export function IconPicker({ value, onChange }) {
  return (
    <div className="icon-picker" role="radiogroup" aria-label="Icon">
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        aria-label="No icon"
        className="icon-choice none"
        onClick={() => onChange(null)}
      >
        ∅
      </button>
      {Array.from({ length: ICON_COUNT }, (_, i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={value === i}
          aria-label={`Icon ${i + 1}`}
          className="icon-choice"
          onClick={() => onChange(i)}
        >
          <FoodSprite icon={i} size={24} />
        </button>
      ))}
    </div>
  );
}

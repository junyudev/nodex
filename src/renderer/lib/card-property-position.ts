export type CardPropertyPosition = "top" | "inline" | "bottom";

export const DEFAULT_CARD_PROPERTY_POSITION: CardPropertyPosition = "inline";
export const CARD_PROPERTY_POSITION_STORAGE_KEY = "nodex-card-property-position-v1";

export function normalizeCardPropertyPosition(value: unknown): CardPropertyPosition {
  if (value === "top" || value === "inline" || value === "bottom") {
    return value;
  }

  return DEFAULT_CARD_PROPERTY_POSITION;
}

export function readCardPropertyPosition(): CardPropertyPosition {
  try {
    const raw = localStorage.getItem(CARD_PROPERTY_POSITION_STORAGE_KEY);
    return normalizeCardPropertyPosition(raw);
  } catch {
    return DEFAULT_CARD_PROPERTY_POSITION;
  }
}

export function writeCardPropertyPosition(value: unknown): CardPropertyPosition {
  const normalized = normalizeCardPropertyPosition(value);
  try {
    localStorage.setItem(CARD_PROPERTY_POSITION_STORAGE_KEY, normalized);
  } catch {
    // localStorage may be unavailable.
  }
  return normalized;
}

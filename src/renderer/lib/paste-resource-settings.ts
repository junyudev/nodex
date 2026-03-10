export const PASTE_RESOURCE_SETTINGS_STORAGE_KEY = "nodex-paste-resource-settings-v1";

export const DEFAULT_TEXT_PROMPT_CHAR_THRESHOLD = 100_000;
export const MIN_TEXT_PROMPT_CHAR_THRESHOLD = 1_000;
export const MAX_TEXT_PROMPT_CHAR_THRESHOLD = 1_000_000;

export const DEFAULT_DESCRIPTION_SOFT_LIMIT = 750_000;
export const MIN_DESCRIPTION_SOFT_LIMIT = 10_000;
export const MAX_DESCRIPTION_SOFT_LIMIT = 1_000_000;

export interface PasteResourceSettings {
  textPromptCharThreshold: number;
  descriptionSoftLimit: number;
}

export const DEFAULT_PASTE_RESOURCE_SETTINGS: PasteResourceSettings = {
  textPromptCharThreshold: DEFAULT_TEXT_PROMPT_CHAR_THRESHOLD,
  descriptionSoftLimit: DEFAULT_DESCRIPTION_SOFT_LIMIT,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseInt(value, 10)
      : Number.NaN;

  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function normalizePasteResourceSettings(value: unknown): PasteResourceSettings {
  if (!isRecord(value)) return { ...DEFAULT_PASTE_RESOURCE_SETTINGS };

  return {
    textPromptCharThreshold: normalizeInteger(
      value.textPromptCharThreshold,
      DEFAULT_PASTE_RESOURCE_SETTINGS.textPromptCharThreshold,
      MIN_TEXT_PROMPT_CHAR_THRESHOLD,
      MAX_TEXT_PROMPT_CHAR_THRESHOLD,
    ),
    descriptionSoftLimit: normalizeInteger(
      value.descriptionSoftLimit,
      DEFAULT_PASTE_RESOURCE_SETTINGS.descriptionSoftLimit,
      MIN_DESCRIPTION_SOFT_LIMIT,
      MAX_DESCRIPTION_SOFT_LIMIT,
    ),
  };
}

export function readPasteResourceSettings(): PasteResourceSettings {
  try {
    const raw = localStorage.getItem(PASTE_RESOURCE_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PASTE_RESOURCE_SETTINGS };
    return normalizePasteResourceSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PASTE_RESOURCE_SETTINGS };
  }
}

export function writePasteResourceSettings(value: unknown): PasteResourceSettings {
  const normalized = normalizePasteResourceSettings(value);
  try {
    localStorage.setItem(
      PASTE_RESOURCE_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // localStorage may be unavailable.
  }
  return normalized;
}

export const SANS_FONT_SIZE_STORAGE_KEY = "nodex-sans-font-size-v1";
export const DEFAULT_SANS_FONT_SIZE = 15;
export const MIN_SANS_FONT_SIZE = 11;
export const MAX_SANS_FONT_SIZE = 20;

export const SANS_FONT_SIZE_SCALE_TOKENS = {
  "--vscode-font-size": 15,
  "--text-xs": 12,
  "--text-sm": 14,
  "--text-base": 15,
  "--text-lg": 18,
  "--text-heading-md": 23,
  "--text-heading-lg": 28,
  "--text-xl": 32,
  "--text-2xl": 42,
  "--text-3xl": 55,
  "--text-4xl": 83,
} as const;

export type SansFontSizeScaleToken = keyof typeof SANS_FONT_SIZE_SCALE_TOKENS;

export type SansFontSizeCssVariables = Record<
  SansFontSizeScaleToken | "--sans-font-size" | "--sans-font-scale",
  string
>;

function clampSansFontSize(value: number): number {
  return Math.min(MAX_SANS_FONT_SIZE, Math.max(MIN_SANS_FONT_SIZE, value));
}

function parseStoredSansFontSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }

  return null;
}

export function normalizeSansFontSize(value: unknown): number {
  const parsed = parseStoredSansFontSize(value);
  if (parsed === null) return DEFAULT_SANS_FONT_SIZE;
  return clampSansFontSize(parsed);
}

export function readSansFontSize(): number {
  try {
    return normalizeSansFontSize(localStorage.getItem(SANS_FONT_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_SANS_FONT_SIZE;
  }
}

export function writeSansFontSize(value: number): number {
  const normalized = normalizeSansFontSize(value);

  try {
    localStorage.setItem(SANS_FONT_SIZE_STORAGE_KEY, String(normalized));
  } catch {
    // localStorage may be unavailable.
  }

  return normalized;
}

export function getSansFontSizeCssVariables(value: number): SansFontSizeCssVariables {
  const normalized = normalizeSansFontSize(value);
  const ratio = normalized / DEFAULT_SANS_FONT_SIZE;
  const tokenEntries = Object.entries(SANS_FONT_SIZE_SCALE_TOKENS).map(([token, baseValue]) => [
    token,
    `${Math.round(baseValue * ratio)}px`,
  ]);

  return {
    "--sans-font-size": `${normalized}px`,
    "--sans-font-scale": String(ratio),
    ...Object.fromEntries(tokenEntries),
  } as SansFontSizeCssVariables;
}

export function applySansFontSizeRootVariables(
  root: Pick<HTMLElement, "style">,
  value: number,
): number {
  const normalized = normalizeSansFontSize(value);
  const variables = getSansFontSizeCssVariables(normalized);

  for (const [token, tokenValue] of Object.entries(variables)) {
    root.style.setProperty(token, tokenValue);
  }

  return normalized;
}

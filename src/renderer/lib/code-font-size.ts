export const CODE_FONT_SIZE_STORAGE_KEY = "nodex-code-font-size-v1";
export const DEFAULT_CODE_FONT_SIZE = 14;
export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 20;

function clampCodeFontSize(value: number): number {
  return Math.min(MAX_CODE_FONT_SIZE, Math.max(MIN_CODE_FONT_SIZE, value));
}

function parseStoredCodeFontSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) return Math.round(parsed);
  }

  return null;
}

export function normalizeCodeFontSize(value: unknown): number {
  const parsed = parseStoredCodeFontSize(value);
  if (parsed === null) return DEFAULT_CODE_FONT_SIZE;
  return clampCodeFontSize(parsed);
}

export function readCodeFontSize(): number {
  try {
    return normalizeCodeFontSize(localStorage.getItem(CODE_FONT_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_CODE_FONT_SIZE;
  }
}

export function writeCodeFontSize(value: number): number {
  const normalized = normalizeCodeFontSize(value);

  try {
    localStorage.setItem(CODE_FONT_SIZE_STORAGE_KEY, String(normalized));
  } catch {
    // localStorage may be unavailable.
  }

  return normalized;
}

export function applyCodeFontSizeRootVariable(
  root: Pick<HTMLElement, "style">,
  value: number,
): number {
  const normalized = normalizeCodeFontSize(value);
  root.style.setProperty("--vscode-editor-font-size", `${normalized}px`);
  return normalized;
}

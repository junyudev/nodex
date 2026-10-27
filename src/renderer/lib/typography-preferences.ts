import type { ResolvedTheme } from "./theme-preferences";

export const TYPOGRAPHY_STORAGE_KEY = "nodex-typography-v1";
export const FONT_SIZE_LIMITS = {
  ui: { default: 14, min: 11, max: 16 },
  code: { default: 12, min: 8, max: 24 },
  page: { default: 14, min: 12, max: 24 },
} as const;
export type FontSizeRole = keyof typeof FONT_SIZE_LIMITS;
export type FontFamilyRole = "ui" | "content" | "code";
export interface TypographyFontFamilies {
  readonly ui: string | null;
  readonly content: string | null;
  readonly code: string | null;
}
export interface TypographyPreferences {
  readonly useFontSmoothing: boolean;
  readonly uiFontSize: number;
  readonly codeFontSize: number;
  readonly pageFontSize: number;
  readonly fonts: Readonly<Record<ResolvedTheme, TypographyFontFamilies>>;
}

export const DEFAULT_TYPOGRAPHY_PREFERENCES: TypographyPreferences = {
  useFontSmoothing: true,
  uiFontSize: FONT_SIZE_LIMITS.ui.default,
  codeFontSize: FONT_SIZE_LIMITS.code.default,
  pageFontSize: FONT_SIZE_LIMITS.page.default,
  fonts: {
    light: { ui: null, content: null, code: null },
    dark: { ui: null, content: null, code: null },
  },
};
export const SYSTEM_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const MONO_FONT_FAMILY =
  'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
export const DEFAULT_UI_FONT_WEIGHT = 430;
export const UI_FONT_SCALE_TOKENS = {
  "--vscode-font-size": 14,
  "--text-xs": 12,
  "--text-sm": 13,
  "--text-base": 14,
  "--text-lg": 16,
  "--text-dynamic-isle-row": 14,
  "--text-heading-sm": 18,
  "--text-heading-md": 20,
  "--text-heading-lg": 24,
  "--text-heading-app": 28,
  "--text-xl": 28,
  "--text-2xl": 36,
  "--text-3xl": 48,
  "--text-4xl": 72,
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function normalizeFontSize(role: FontSizeRole, value: unknown): number {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  const limits = FONT_SIZE_LIMITS[role];
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, parsed));
}

const CSS_WIDE_FONT_FAMILIES = new Set([
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
  "default",
]);
const CSS_ESCAPE = String.raw`\\(?:[\da-fA-F]{1,6}[ \t]?|[^\r\n\f])`;
const CSS_IDENTIFIER = String.raw`(?:--|-?(?:[a-zA-Z_]|[^\u0000-\u007f])|${CSS_ESCAPE})(?:[a-zA-Z0-9_-]|[^\u0000-\u007f]|${CSS_ESCAPE})*`;
const FONT_NAME_IDENTIFIERS = new RegExp(`^${CSS_IDENTIFIER}(?:\\s+${CSS_IDENTIFIER})*$`, "u");
const QUOTED_FONT_NAME = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/u;

function isFontFamilyName(value: string): boolean {
  if (QUOTED_FONT_NAME.test(value)) return true;
  return !CSS_WIDE_FONT_FAMILIES.has(value.toLowerCase()) && FONT_NAME_IDENTIFIERS.test(value);
}

/** Validate the list before appending fallbacks; CSS-wide keywords cannot be family names. */
function isFontFamilyList(value: string): boolean {
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && index + 1 === value.length) return false;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote !== null) {
      quote = character === quote ? null : quote;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== ",") continue;
    if (!isFontFamilyName(value.slice(start, index).trim())) return false;
    start = index + 1;
  }
  return quote === null && isFontFamilyName(value.slice(start).trim());
}

export function normalizeFontFamily(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const family = value.trim();
  if (family === "" || family.length > 512 || /[;{}\u0000-\u001f]/u.test(family)) return null;
  if (!isFontFamilyList(family)) return null;
  if (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    !CSS.supports("font-family", `${family}, serif`)
  )
    return null;
  return family;
}

function normalizeFontFamilies(value: unknown): TypographyFontFamilies {
  const record = asRecord(value);
  return {
    ui: normalizeFontFamily(record.ui),
    content: normalizeFontFamily(record.content),
    code: normalizeFontFamily(record.code),
  };
}

export function normalizeTypographyPreferences(value: unknown): TypographyPreferences {
  const record = asRecord(value);
  const fonts = asRecord(record.fonts);
  return {
    useFontSmoothing: typeof record.useFontSmoothing === "boolean" ? record.useFontSmoothing : true,
    uiFontSize: normalizeFontSize("ui", record.uiFontSize),
    codeFontSize: normalizeFontSize("code", record.codeFontSize),
    pageFontSize: normalizeFontSize("page", record.pageFontSize),
    fonts: {
      light: normalizeFontFamilies(fonts.light),
      dark: normalizeFontFamilies(fonts.dark),
    },
  };
}

export function readTypographyPreferences(
  fallback: TypographyPreferences = DEFAULT_TYPOGRAPHY_PREFERENCES,
): TypographyPreferences {
  try {
    const stored = localStorage.getItem(TYPOGRAPHY_STORAGE_KEY);
    return stored === null ? fallback : normalizeTypographyPreferences(JSON.parse(stored));
  } catch {
    return fallback;
  }
}

export function writeTypographyPreferences(value: TypographyPreferences): TypographyPreferences {
  const preferences = normalizeTypographyPreferences(value);
  try {
    localStorage.setItem(TYPOGRAPHY_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // The active window can apply typography when browser storage is unavailable.
  }
  return preferences;
}

export function getTypographyFontFamilies(
  preferences: TypographyPreferences,
  variant: ResolvedTheme,
) {
  const fonts = preferences.fonts[variant];
  const ui = fonts.ui === null ? SYSTEM_FONT_FAMILY : `${fonts.ui}, ${SYSTEM_FONT_FAMILY}`;
  const code = fonts.code === null ? MONO_FONT_FAMILY : `${fonts.code}, ${MONO_FONT_FAMILY}`;
  return { ui, code, content: fonts.content === null ? ui : `${fonts.content}, ${ui}` };
}

export function getTypographyCssVariables(
  value: TypographyPreferences,
  variant: ResolvedTheme,
): Record<string, string> {
  const preferences = normalizeTypographyPreferences(value);
  const ratio = preferences.uiFontSize / FONT_SIZE_LIMITS.ui.default;
  const fonts = getTypographyFontFamilies(preferences, variant);
  return {
    ...Object.fromEntries(
      Object.entries(UI_FONT_SCALE_TOKENS).map(([name, base]) => [
        name,
        `${Math.round(base * ratio)}px`,
      ]),
    ),
    "--sans-font-size": `${preferences.uiFontSize}px`,
    "--sans-font-scale": String(ratio),
    "--font-ui-size": `${preferences.uiFontSize}px`,
    "--font-code-size": `${preferences.codeFontSize}px`,
    "--vscode-editor-font-size": `${preferences.codeFontSize}px`,
    "--text-document": `${preferences.pageFontSize}px`,
    "--codex-chat-font-size": `${preferences.uiFontSize}px`,
    "--codex-chat-font-size-override": `${preferences.uiFontSize}px`,
    "--codex-chat-code-font-size": `${preferences.codeFontSize}px`,
    "--codex-chat-code-font-size-override": `${preferences.codeFontSize}px`,
    "--font-ui-family": fonts.ui,
    "--font-code-family": fonts.code,
    "--codex-content-font-family": fonts.content,
    "--font-sans": fonts.ui,
    "--font-mono": fonts.code,
    "--font-content": fonts.content,
    "--font-ui-weight": String(DEFAULT_UI_FONT_WEIGHT),
    "--font-smoothing": preferences.useFontSmoothing ? "antialiased" : "auto",
  };
}

/** Root and body must both own the values consumed by inherited typography tokens. */
export function applyTypographyPreferences(
  root: Pick<HTMLElement, "style">,
  body: Pick<HTMLElement, "style"> | null,
  preferences: TypographyPreferences,
  variant: ResolvedTheme,
): void {
  const variables = getTypographyCssVariables(preferences, variant);
  const smoothing = variables["--font-smoothing"] ?? "antialiased";
  for (const target of body === null ? [root] : [root, body]) {
    for (const [name, value] of Object.entries(variables)) target.style.setProperty(name, value);
    target.style.setProperty("-webkit-font-smoothing", smoothing);
    target.style.setProperty(
      "-moz-osx-font-smoothing",
      smoothing === "antialiased" ? "grayscale" : "auto",
    );
  }
}

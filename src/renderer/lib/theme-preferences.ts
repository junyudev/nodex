import {
  normalizeCodexAccentColor,
  parseCodexAccent,
  type CodexAccent,
} from "./codex-theme-variant";

export const THEME_STORAGE_KEY = "nodex-theme";
export const ACCENT_COLOR_STORAGE_KEY = "nodex-accent-color-v1";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface AccentColorPreferences {
  readonly light: CodexAccent;
  readonly dark: CodexAccent;
}

const DEFAULT_ACCENT_COLOR_PREFERENCES: AccentColorPreferences = {
  light: { kind: "preset", name: "default" },
  dark: { kind: "preset", name: "default" },
};

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function readThemePreference(): ThemePreference {
  try {
    return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeThemePreference(value: ThemePreference): ThemePreference {
  const theme = normalizeThemePreference(value);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Isolated renderer contexts may not provide writable browser storage.
  }
  return theme;
}

export function decodeAccentColorPreferences(value: unknown): AccentColorPreferences {
  if (typeof value !== "object" || value === null) return DEFAULT_ACCENT_COLOR_PREFERENCES;
  const record = value as Record<string, unknown>;
  const decodeAppearance = (appearance: unknown): CodexAccent => {
    if (typeof appearance === "object" && appearance !== null) return parseCodexAccent(appearance);
    const color = normalizeCodexAccentColor(appearance);
    if (color !== null) return { kind: "custom", color };
    return parseCodexAccent({ kind: "preset", name: record.preset });
  };
  return {
    light: decodeAppearance(record.light),
    dark: decodeAppearance(record.dark),
  };
}

export function readAccentColorPreferences(
  fallback: AccentColorPreferences = DEFAULT_ACCENT_COLOR_PREFERENCES,
): AccentColorPreferences {
  try {
    const stored = localStorage.getItem(ACCENT_COLOR_STORAGE_KEY);
    return stored === null
      ? DEFAULT_ACCENT_COLOR_PREFERENCES
      : decodeAccentColorPreferences(JSON.parse(stored));
  } catch {
    return fallback;
  }
}

export function resolveAccentColorPreference(
  preferences: AccentColorPreferences,
  variant: ResolvedTheme,
): CodexAccent {
  return preferences[variant];
}

/** Every color choice belongs to the appearance being edited. */
export function updateAccentColorPreference(
  preferences: AccentColorPreferences,
  variant: ResolvedTheme,
  value: CodexAccent,
): AccentColorPreferences {
  return { ...preferences, [variant]: parseCodexAccent(value) };
}

export function writeAccentColorPreferences(
  preferences: AccentColorPreferences,
): AccentColorPreferences {
  const normalized = decodeAccentColorPreferences(preferences);
  try {
    localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // The active window can still apply its preference when browser storage is unavailable.
  }
  return normalized;
}

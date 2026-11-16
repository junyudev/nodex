/**
 * Display languages Nodex ships. English is the source language: its copy lives
 * beside the code as each message's `defaultMessage`, so it has no catalog.
 */
export const APP_LOCALES = ["en-US", "zh-CN"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const SOURCE_LOCALE: AppLocale = "en-US";

/** A person's saved choice; `null` follows the operating system's languages. */
export type AppLocalePreference = AppLocale | null;

export interface LanguageSettings {
  readonly preference: AppLocalePreference;
  readonly locale: AppLocale;
}

export const LANGUAGE_SETTINGS_CHANGED_CHANNEL = "settings:language:changed";

/** Read-only display language bridge used by the restricted auxiliary windows. */
export interface LanguageSettingsReader {
  readonly readLanguageSettings: () => Promise<LanguageSettings>;
  readonly onLanguageSettingsChanged: (
    callback: (settings: LanguageSettings) => void,
  ) => () => void;
}

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (APP_LOCALES as readonly string[]).includes(value);
}

/** Accepts only a supported locale or an explicit automatic choice. */
export function parseAppLocalePreference(value: unknown): AppLocalePreference {
  return isAppLocale(value) ? value : null;
}

function normalizeTag(tag: string): string | null {
  const trimmed = tag.trim();
  return trimmed ? trimmed.replace(/_/g, "-").toLowerCase() : null;
}

/**
 * Matches one BCP 47 tag to a shipped locale by language. Every Chinese variant
 * reads the Simplified Chinese catalog because it is the only Chinese one.
 */
export function matchAppLocale(tag: string): AppLocale | null {
  const normalized = normalizeTag(tag);
  if (normalized === null) return null;
  const language = normalized.split("-")[0];
  if (language === "en") return "en-US";
  if (language === "zh") return "zh-CN";
  return null;
}

/**
 * Resolves the display language: a saved choice wins; otherwise the first
 * system language Nodex ships, in the system's preference order.
 */
export function resolveAppLocale(
  preference: AppLocalePreference,
  systemLanguages: readonly string[],
): AppLocale {
  if (preference !== null) return preference;
  for (const tag of systemLanguages) {
    const match = matchAppLocale(tag);
    if (match !== null) return match;
  }
  return SOURCE_LOCALE;
}

const DISPLAY_NAME_TAGS: Record<AppLocale, string> = {
  "en-US": "en",
  "zh-CN": "zh-Hans",
};

/** Names each language in its own script so people can find theirs in any UI language. */
const NATIVE_NAMES: Partial<Record<AppLocale, string>> = {
  "zh-CN": "简体中文",
};

/** Names `locale` in `displayLocale`, falling back to the tag when Intl lacks data. */
export function localeDisplayName(locale: AppLocale, displayLocale: AppLocale): string {
  if (locale === displayLocale) {
    const native = NATIVE_NAMES[locale];
    if (native) return native;
  }
  try {
    const names = new Intl.DisplayNames([displayLocale], {
      type: "language",
      languageDisplay: "standard",
    });
    return names.of(DISPLAY_NAME_TAGS[locale]) ?? locale;
  } catch {
    return locale;
  }
}

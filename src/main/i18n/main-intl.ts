import {
  createIntl,
  createIntlCache,
  IntlErrorCode,
  type IntlShape,
  type OnErrorFn,
} from "@formatjs/intl";
import {
  SOURCE_LOCALE,
  type AppLocale,
  type AppLocalePreference,
  type LanguageSettings,
} from "../../shared/i18n/locales";
import { loadAppMessages, type AppMessages } from "../../shared/i18n/catalog";

export { defineMessage, defineMessages } from "../../shared/i18n/messages";
export type { MessageDescriptor } from "../../shared/i18n/messages";

/**
 * Main formats native copy (menus, dialogs, notifications) in the same display
 * language as the renderer. Read `getMainIntl()` when building the surface, never
 * at import, and rebuild long-lived surfaces from `onMainLocaleChange`.
 */

const cache = createIntlCache();

const reportIntlError: OnErrorFn = (error) => {
  if (error.code === IntlErrorCode.MISSING_TRANSLATION) return;
  console.error(error);
};

function buildIntl(locale: AppLocale, messages: AppMessages): IntlShape {
  return createIntl(
    {
      locale,
      defaultLocale: SOURCE_LOCALE,
      messages: messages as Record<string, string>,
      onError: reportIntlError,
    },
    cache,
  );
}

let current = buildIntl(SOURCE_LOCALE, {});
let languageSettings: LanguageSettings = { preference: null, locale: SOURCE_LOCALE };
let activation = 0;
const listeners = new Set<(locale: AppLocale) => void>();

export function getMainIntl(): IntlShape {
  return current;
}

export function getMainLocale(): AppLocale {
  return languageSettings.locale;
}

export function getMainLanguageSettings(): LanguageSettings {
  return languageSettings;
}

export function onMainLocaleChange(listener: (locale: AppLocale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Loads `locale`'s catalog, then notifies native surfaces to rebuild. */
export async function activateMainLocale(
  locale: AppLocale,
  preference: AppLocalePreference = languageSettings.preference,
): Promise<void> {
  const token = ++activation;
  if (languageSettings.locale === locale) {
    languageSettings = { preference, locale };
    return;
  }
  const messages = await loadAppMessages(locale);
  if (token !== activation) return;
  current = buildIntl(locale, messages);
  languageSettings = { preference, locale };
  for (const listener of listeners) listener(locale);
}

export function resetMainLocaleForTests(): void {
  activation += 1;
  current = buildIntl(SOURCE_LOCALE, {});
  languageSettings = { preference: null, locale: SOURCE_LOCALE };
  listeners.clear();
}

import { SOURCE_LOCALE, type AppLocale } from "../../shared/i18n/locales";
import { loadAppMessages, type AppMessages } from "../../shared/i18n/catalog";

/**
 * The window's display language: one locale and its catalog. It is framework-free so the startup
 * shell can follow it before React or a formatter loads; `@/lib/i18n` derives the React formatter
 * from it, and the startup shell derives its own.
 */
export interface AppLocaleState {
  readonly locale: AppLocale;
  readonly messages: AppMessages;
}

const SOURCE_STATE: AppLocaleState = Object.freeze({ locale: SOURCE_LOCALE, messages: {} });

let current = SOURCE_STATE;
let activation = 0;
const listeners = new Set<() => void>();

export function getAppLocale(): AppLocale {
  return current.locale;
}

/** A value derived from the display language, such as a formatter, rebuilt only when it changes. */
export function deriveFromAppLocale<T>(build: (state: AppLocaleState) => T): () => T {
  let derived: { readonly state: AppLocaleState; readonly value: T } | null = null;
  return () => {
    if (derived?.state !== current) derived = { state: current, value: build(current) };
    return derived.value;
  };
}

export function subscribeAppLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: AppLocaleState): void {
  current = next;
  if (typeof document !== "undefined") document.documentElement.lang = next.locale;
  for (const listener of listeners) listener();
}

/**
 * Loads `locale`'s catalog and switches every subscriber at once. A later activation supersedes an
 * earlier one that is still loading.
 */
export async function activateAppLocale(locale: AppLocale): Promise<void> {
  const token = ++activation;
  if (current.locale === locale) {
    if (typeof document !== "undefined") document.documentElement.lang = locale;
    return;
  }
  const messages = await loadAppMessages(locale);
  if (token !== activation) return;
  publish({ locale, messages });
}

export function resetAppLocaleForTests(): void {
  activation += 1;
  publish(SOURCE_STATE);
}

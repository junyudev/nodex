import { useSyncExternalStore } from "react";
import { SOURCE_LOCALE, type AppLocale, type AppLocalePreference } from "../../shared/i18n/locales";
import { updateRendererLanguagePreference } from "./main-returned-settings";
import {
  getRendererLanguageSettings,
  subscribeRendererLanguageSettings,
} from "./renderer-language-settings";

export function useLanguageSettings(): {
  preference: AppLocalePreference;
  locale: AppLocale;
  isLoading: boolean;
  updatePreference: (preference: AppLocalePreference) => Promise<void>;
} {
  const settings = useSyncExternalStore(
    subscribeRendererLanguageSettings,
    getRendererLanguageSettings,
    getRendererLanguageSettings,
  );
  return {
    preference: settings?.preference ?? null,
    locale: settings?.locale ?? SOURCE_LOCALE,
    isLoading: settings === null,
    updatePreference: updateRendererLanguagePreference,
  };
}

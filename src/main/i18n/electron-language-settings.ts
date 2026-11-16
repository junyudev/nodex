import { app, BrowserWindow } from "electron";
import {
  LANGUAGE_SETTINGS_CHANGED_CHANNEL,
  resolveAppLocale,
  type AppLocalePreference,
  type LanguageSettings,
} from "../../shared/i18n/locales";
import { hasTrustedAppRendererOrigin } from "../app-renderer-ipc-authorization";
import { safeBroadcastToWindows } from "../ipc-safe-send";
import { activateMainLocale, getMainLanguageSettings } from "./main-intl";

let pinnedSystemLanguages: readonly string[] | null = null;

/** Development and test launches can stand in for the operating system's languages. */
export function pinSystemLanguages(languages: readonly string[]): void {
  pinnedSystemLanguages = languages.length > 0 ? languages : null;
}

/** Resolves the Profile choice after Electron is ready. */
export async function activateElectronLanguagePreference(
  preference: AppLocalePreference,
): Promise<LanguageSettings> {
  const preferred = pinnedSystemLanguages ?? app.getPreferredSystemLanguages();
  const locale = resolveAppLocale(preference, preferred.length > 0 ? preferred : [app.getLocale()]);
  await activateMainLocale(locale, preference);
  return getMainLanguageSettings();
}

/** Includes restricted overlays in addition to Workbench windows. */
export function broadcastLanguageSettings(
  settings: LanguageSettings,
  developmentOrigin: string | null,
): void {
  const targets = BrowserWindow.getAllWindows().filter(
    (window) =>
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      hasTrustedAppRendererOrigin(window.webContents.getURL(), developmentOrigin),
  );
  safeBroadcastToWindows(targets, LANGUAGE_SETTINGS_CHANGED_CHANNEL, [settings]);
}

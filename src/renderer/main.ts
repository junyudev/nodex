import { initializeRendererDocument } from "./bootstrap/renderer-document";
import { startStartupController } from "./bootstrap/startup-controller";
import { startupOperations } from "./bootstrap/startup-operations";
import {
  isAppLocale,
  LANGUAGE_SETTINGS_CHANGED_CHANNEL,
  type LanguageSettingsReader,
} from "../shared/i18n/locales";
import { initializeRendererLanguageSettings } from "./lib/renderer-language-settings";

initializeRendererDocument();

function prepareLanguage(bridge: LanguageSettingsReader | undefined): Promise<void> {
  if (!bridge) return Promise.resolve();
  const language = initializeRendererLanguageSettings(bridge);
  import.meta.hot?.dispose(language.dispose);
  return language.ready.catch((error) => {
    console.error("Could not initialize the display language", error);
  });
}

const initialRoute = new URLSearchParams(window.location.search).get("initialRoute");
if (initialRoute === "/avatar-overlay") {
  void Promise.all([
    prepareLanguage(window.avatarOverlay),
    import("./avatar-overlay-renderer"),
  ]).then(([, { mountAvatarOverlayRenderer }]) => mountAvatarOverlayRenderer());
} else if (initialRoute === "/global-dictation") {
  void Promise.all([
    prepareLanguage(window.globalDictation),
    import("./global-dictation-renderer"),
  ]).then(([, { mountGlobalDictationRenderer }]) => mountGlobalDictationRenderer());
} else {
  const api = window.api;
  const languageReady = prepareLanguage(
    api && {
      readLanguageSettings: () => startupOperations.readLanguageSettings(api),
      onLanguageSettingsChanged: (listener) =>
        api.on(LANGUAGE_SETTINGS_CHANGED_CHANNEL, (value: unknown) => {
          if (!value || typeof value !== "object" || !("locale" in value)) return;
          if (!isAppLocale(value.locale) || !("preference" in value)) return;
          if (value.preference !== null && !isAppLocale(value.preference)) return;
          listener({ locale: value.locale, preference: value.preference });
        }),
    },
  );
  startStartupController(languageReady);
}

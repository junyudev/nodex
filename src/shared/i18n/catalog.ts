import type { AppLocale } from "./locales";

/**
 * Translated ICU messages keyed by message id. Loading a catalog needs no formatter, so the
 * renderer's startup shell can follow the display language before one loads.
 */
export type AppMessages = Readonly<Record<string, string>>;

const NO_MESSAGES: AppMessages = Object.freeze({});

/** Loads a locale's catalog; English renders each message's `defaultMessage`. */
export async function loadAppMessages(locale: AppLocale): Promise<AppMessages> {
  switch (locale) {
    case "en-US":
      return NO_MESSAGES;
    case "zh-CN": {
      const [app, cards] = await Promise.all([
        import("./catalogs/zh-CN.json"),
        import("@nodex/insights-cards/catalogs/zh-CN.json"),
      ]);
      return { ...app.default, ...cards.default };
    }
  }
}

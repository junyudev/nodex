import type { AppLocale } from "./locales";

/**
 * Message descriptors live beside the code that shows them: `id` is a stable
 * dotted key, `defaultMessage` is the English ICU message, and `description`
 * tells translators where the text appears when the English is ambiguous.
 */
export { defineMessage, defineMessages } from "@formatjs/intl";
export type { MessageDescriptor } from "@formatjs/intl";

/** Translated ICU messages keyed by message id. */
export type AppMessages = Readonly<Record<string, string>>;

const NO_MESSAGES: AppMessages = Object.freeze({});

/** Loads a locale's catalog; English renders each message's `defaultMessage`. */
export async function loadAppMessages(locale: AppLocale): Promise<AppMessages> {
  switch (locale) {
    case "en-US":
      return NO_MESSAGES;
    case "zh-CN":
      return (await import("./catalogs/zh-CN.json")).default;
  }
}

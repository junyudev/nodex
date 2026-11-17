import { createIntl, createIntlCache, IntlErrorCode } from "@formatjs/intl";
import { SOURCE_LOCALE } from "../../shared/i18n/locales";
import { deriveFromAppLocale } from "../lib/app-locale";
import type { StartupFormat } from "./startup-messages";

/**
 * Formats the startup shell's copy in the display language without React. The shell loads this
 * once the language is ready, so the formatter never weighs on its first paint.
 */

const cache = createIntlCache();
const currentIntl = deriveFromAppLocale(({ locale, messages }) =>
  createIntl(
    {
      locale,
      defaultLocale: SOURCE_LOCALE,
      messages: messages as Record<string, string>,
      onError: (error) => {
        // English renders `defaultMessage`; catalog coverage is enforced by `vp run i18n:check`.
        if (error.code !== IntlErrorCode.MISSING_TRANSLATION) console.error(error);
      },
    },
    cache,
  ),
);

export const formatStartupMessage: StartupFormat = (message, values) =>
  currentIntl().formatMessage(message, values);

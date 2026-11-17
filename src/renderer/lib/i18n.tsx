import { Fragment, useSyncExternalStore, type ReactNode } from "react";
import {
  createIntl,
  createIntlCache,
  ReactIntlErrorCode,
  type IntlConfig,
  type IntlShape,
  type PrimitiveType,
} from "react-intl";
import { SOURCE_LOCALE, type AppLocale } from "../../shared/i18n/locales";
import type { MessageDescriptor } from "../../shared/i18n/messages";
import { deriveFromAppLocale, subscribeAppLocale } from "./app-locale";

export {
  activateAppLocale,
  getAppLocale,
  resetAppLocaleForTests,
  subscribeAppLocale,
} from "./app-locale";
export { defineMessage, defineMessages } from "../../shared/i18n/messages";
export type { MessageDescriptor } from "../../shared/i18n/messages";
export type { IntlShape } from "react-intl";

/**
 * The renderer's formatter for the window's display language. The language itself lives in the
 * framework-free `app-locale` store; this binds it to React, so components read it with
 * `useIntl()`, non-React helpers call `getIntl()`, and neither needs a provider in tests.
 */

const cache = createIntlCache();

const reportIntlError: NonNullable<IntlConfig["onError"]> = (error) => {
  // English renders `defaultMessage`; catalog coverage is enforced by `vp run i18n:check`.
  if (error.code === ReactIntlErrorCode.MISSING_TRANSLATION) return;
  console.error(error);
};

const currentIntl = deriveFromAppLocale(({ locale, messages }) =>
  createIntl(
    {
      locale,
      defaultLocale: SOURCE_LOCALE,
      messages: messages as Record<string, string>,
      onError: reportIntlError,
      textComponent: Fragment,
    },
    cache,
  ),
);

/** The current formatter, for code outside React render. Read it at call time, never at import. */
export function getIntl(): IntlShape {
  return currentIntl();
}

/** Re-renders the caller when the display language changes. */
export function useIntl(): IntlShape {
  return useSyncExternalStore(subscribeAppLocale, getIntl, getIntl);
}

export function useAppLocale(): AppLocale {
  return useIntl().locale as AppLocale;
}

/** ICU arguments; a rich-text tag such as `<link>` maps to a function of its chunks. */
export type FormattedMessageValues = Readonly<
  Record<string, PrimitiveType | ReactNode | ((chunks: ReactNode[]) => ReactNode)>
>;

export interface FormattedMessageProps extends MessageDescriptor {
  readonly values?: FormattedMessageValues;
}

/** Renders one message; rich-text tags in `values` may return React nodes. */
export function FormattedMessage({
  id,
  defaultMessage,
  description,
  values,
}: FormattedMessageProps): ReactNode {
  const intl = useIntl();
  return <>{intl.formatMessage({ id, defaultMessage, description }, values)}</>;
}

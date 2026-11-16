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
import {
  loadAppMessages,
  type AppMessages,
  type MessageDescriptor,
} from "../../shared/i18n/messages";

export { defineMessage, defineMessages } from "../../shared/i18n/messages";
export type { MessageDescriptor } from "../../shared/i18n/messages";
export type { IntlShape } from "react-intl";

/**
 * The renderer's display language is one window-wide value, so it lives in a
 * module store instead of React context: components read it with `useIntl()`,
 * non-React helpers call `getIntl()`, and neither needs a provider in tests.
 */

const cache = createIntlCache();

const reportIntlError: NonNullable<IntlConfig["onError"]> = (error) => {
  // English renders `defaultMessage`; catalog coverage is enforced by `vp run i18n:check`.
  if (error.code === ReactIntlErrorCode.MISSING_TRANSLATION) return;
  console.error(error);
};

function buildIntl(locale: AppLocale, messages: AppMessages): IntlShape {
  return createIntl(
    {
      locale,
      defaultLocale: SOURCE_LOCALE,
      messages: messages as Record<string, string>,
      onError: reportIntlError,
      textComponent: Fragment,
    },
    cache,
  );
}

let current: IntlShape = buildIntl(SOURCE_LOCALE, {});
let activation = 0;
const listeners = new Set<() => void>();

export function subscribeAppLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: IntlShape): void {
  current = next;
  if (typeof document !== "undefined") document.documentElement.lang = next.locale;
  for (const listener of listeners) listener();
}

/** The current formatter, for code outside React render. Read it at call time, never at import. */
export function getIntl(): IntlShape {
  return current;
}

export function getAppLocale(): AppLocale {
  return current.locale as AppLocale;
}

/** Re-renders the caller when the display language changes. */
export function useIntl(): IntlShape {
  return useSyncExternalStore(subscribeAppLocale, getIntl, getIntl);
}

export function useAppLocale(): AppLocale {
  return useIntl().locale as AppLocale;
}

/**
 * Loads `locale`'s catalog and switches every subscribed component at once.
 * A later activation supersedes an earlier one that is still loading.
 */
export async function activateAppLocale(locale: AppLocale): Promise<void> {
  const token = ++activation;
  if (current.locale === locale) {
    if (typeof document !== "undefined") document.documentElement.lang = locale;
    return;
  }
  const messages = await loadAppMessages(locale);
  if (token !== activation) return;
  publish(buildIntl(locale, messages));
}

export function resetAppLocaleForTests(): void {
  activation += 1;
  publish(buildIntl(SOURCE_LOCALE, {}));
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

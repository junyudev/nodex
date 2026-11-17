import type {
  defineMessage as formatjsDefineMessage,
  defineMessages as formatjsDefineMessages,
} from "@formatjs/intl";

/**
 * Message descriptors live beside the code that shows them: `id` is a stable
 * dotted key, `defaultMessage` is the English ICU message, and `description`
 * tells translators where the text appears when the English is ambiguous.
 *
 * Declaring a message is data, not formatting: these keep the formatter's typed
 * signatures without its runtime, so a module that only declares copy (such as
 * one the startup shell loads) never pulls the formatter in, and unused
 * declarations drop out of a bundle.
 */
export type { MessageDescriptor } from "@formatjs/intl";

/* @__NO_SIDE_EFFECTS__ */
export const defineMessage: typeof formatjsDefineMessage = (message: unknown): never =>
  message as never;

/* @__NO_SIDE_EFFECTS__ */
export const defineMessages: typeof formatjsDefineMessages = (messages: unknown): never =>
  messages as never;

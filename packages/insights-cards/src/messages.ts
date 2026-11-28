import type { defineMessage as formatjsDefineMessage } from "@formatjs/intl";

/** Declaring card copy does not load the formatter. */
/* @__NO_SIDE_EFFECTS__ */
export const defineMessage: typeof formatjsDefineMessage = (message: unknown): never =>
  message as never;

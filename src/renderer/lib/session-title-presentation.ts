import { getIntl, type IntlShape } from "@/lib/i18n";
import { commandTitleMessage } from "../../shared/command-keybindings";
import { NEW_CHAT_TITLE } from "../../shared/session-title";

type SessionTitle = { readonly displayTitle: string; readonly noThreadFallbackTitle?: string };

/** Formats a stored Session title for display. Keep the raw title for writes and exports. */
export function presentSessionTitle(
  value: SessionTitle | string | null | undefined,
  intl: IntlShape = getIntl(),
): string {
  const title =
    typeof value === "object" && value !== null
      ? value.displayTitle.trim()
        ? value.displayTitle
        : value.noThreadFallbackTitle
      : value;
  if (title?.trim() && title !== NEW_CHAT_TITLE) return title;
  return intl.formatMessage(commandTitleMessage({ id: "newThread", title: NEW_CHAT_TITLE }));
}

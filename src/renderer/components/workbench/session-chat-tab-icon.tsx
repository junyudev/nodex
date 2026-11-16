import { ChatWaitingIcon } from "@/components/shared/chat-waiting-icon";
import { ActivitySpinnerIcon, ChatIcon } from "@/components/shared/icons";
import { getIntl, type IntlShape } from "@/lib/i18n";
import { sessionLiveIndicatorLabel } from "@/lib/session-execution";
import type { SidebarRowLiveStatus } from "@/lib/sidebar-status";
import { cn } from "@/lib/utils";

export function sessionChatTabStatusLabel(
  status: SidebarRowLiveStatus,
  intl: IntlShape = getIntl(),
): string {
  if (status === "unread")
    return intl.formatMessage({
      id: "workbench.sessionChatTabIcon.unread",
      defaultMessage: "Unread",
    });
  return sessionLiveIndicatorLabel(status === "attention" ? "waiting" : status, intl);
}

/**
 * The Chat tab's bubble. While content hides the conversation it carries the chat's live status
 * as its sidebar row does: a spinner while it works, a question bubble while it waits on its
 * person, and a dot for an unread answer.
 */
export function SessionChatTabIcon({ status }: { readonly status: SidebarRowLiveStatus | null }) {
  if (status === "running" || status === "background") {
    return (
      <span data-chat-tab-status={status} className="flex">
        <ActivitySpinnerIcon
          className={cn(
            "icon-xs shrink-0",
            status === "running"
              ? "text-token-foreground/70"
              : "text-token-description-foreground/70",
          )}
          animationDurationMs={status === "running" ? 2_000 : 5_000}
        />
      </span>
    );
  }
  if (status === "attention") {
    return (
      <span data-chat-tab-status={status} className="flex">
        <ChatWaitingIcon />
      </span>
    );
  }
  return (
    <span data-chat-tab-status={status ?? undefined} className="relative flex">
      <ChatIcon className="icon-xs" />
      {status ? (
        <span className="absolute -end-0.5 -top-0.5 size-1.5 rounded-full bg-info-solid" />
      ) : null}
    </span>
  );
}

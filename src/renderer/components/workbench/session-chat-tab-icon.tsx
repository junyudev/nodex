import { ChatWaitingIcon } from "@/components/shared/chat-waiting-icon";
import { ActivitySpinnerIcon, ConversationIcon } from "@/components/shared/icons";
import { SESSION_LIVE_INDICATOR_LABELS } from "@/lib/session-execution";
import type { SidebarRowLiveStatus } from "@/lib/sidebar-status";
import { cn } from "@/lib/utils";

export const SESSION_CHAT_TAB_STATUS_LABELS: Readonly<Record<SidebarRowLiveStatus, string>> = {
  running: SESSION_LIVE_INDICATOR_LABELS.running,
  background: SESSION_LIVE_INDICATOR_LABELS.background,
  attention: SESSION_LIVE_INDICATOR_LABELS.waiting,
  unread: "Unread",
};

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
      <ConversationIcon className="icon-xs" />
      {status ? (
        <span className="absolute -end-0.5 -top-0.5 size-1.5 rounded-full bg-info-solid" />
      ) : null}
    </span>
  );
}

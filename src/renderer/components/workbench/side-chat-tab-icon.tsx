import { ChatWaitingIcon } from "@/components/shared/chat-waiting-icon";
import { SidePanelSideChatIcon } from "@/components/shared/icons";
import { useAgentRuntimeSessionStatus } from "@/lib/agent-runtime-session-activity";

/**
 * A side chat's tab turns into the waiting glyph while it asks its person something, so the
 * waiting status its source chat shows in the sidebar leads to the tab that needs them.
 */
export function SideChatTabIcon({ sessionId }: { readonly sessionId: string | null }) {
  const status = useAgentRuntimeSessionStatus(sessionId);
  return status === "waiting" ? (
    <span data-side-chat-tab-status="waiting" className="flex">
      <ChatWaitingIcon />
    </span>
  ) : (
    <SidePanelSideChatIcon className="icon-xs shrink-0" />
  );
}

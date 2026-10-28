import { useSyncExternalStore } from "react";
import { ActivitySpinnerIcon, MoreActionsIcon } from "@/components/shared/icons";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { useAgentRuntimeSessionActivity } from "@/lib/agent-runtime-session-activity";
import { sideChatSaveStore } from "@/lib/side-chat-save";
import type { SideChatPanelTab } from "@/lib/workbench-panel-tab-model";

export function SideChatTabActions({
  tab,
  onSave,
}: {
  readonly tab: SideChatPanelTab;
  readonly onSave: (tab: SideChatPanelTab) => Promise<void>;
}) {
  const sessionId = tab.runtimeSession?.id ?? "";
  const saving = useSyncExternalStore(sideChatSaveStore.subscribe, () =>
    sideChatSaveStore.pending(sessionId),
  );
  const activity = useAgentRuntimeSessionActivity(sessionId);
  const disabled = saving || tab.status !== "ready" || !tab.threadId || Boolean(activity);
  return (
    <NodexDropdownMenu
      align="end"
      finalFocus={false}
      triggerTooltipContent="Side chat actions"
      triggerButton={
        <button
          type="button"
          aria-label="Side chat actions"
          aria-busy={saving}
          className="flex size-5 items-center justify-center rounded-md text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:bg-token-list-hover-background"
        >
          {saving ? (
            <ActivitySpinnerIcon className="icon-2xs" />
          ) : (
            <MoreActionsIcon className="icon-xs" />
          )}
        </button>
      }
    >
      <NodexDropdownItem disabled={disabled} onSelect={() => void onSave(tab)}>
        {saving ? "Saving…" : "Save as chat"}
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

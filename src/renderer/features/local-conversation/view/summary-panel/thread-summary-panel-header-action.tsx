import { useMemo } from "react";
import type {
  ThreadStageActions,
  ThreadSummaryPanelMode,
  ThreadSummaryPanelAutomationRow,
} from "../../thread-stage-types";
import {
  ThreadSummaryPanelPopover,
  threadSummaryBackgroundCount,
} from "./thread-floating-summary-panel";
import { useThreadSummaryContent } from "./thread-summary-content";
import { ThreadSummaryPanelToggle } from "./thread-summary-panel-toggle";

export interface ThreadSummaryPanelHeaderActionProps {
  activeThreadId: string | null;
  activeThreadIsManagedWorktree?: boolean;
  onPopoverOpenChange?: (open: boolean) => void;
  mode: ThreadSummaryPanelMode;
  pinnedOpen: boolean;
  onPinnedOpenToggle?: () => void;
  popoverOpen?: boolean;
  clockAutomation?: ThreadSummaryPanelAutomationRow | null;
  actions?: Pick<ThreadStageActions, "onOpenSummaryAutomation" | "onOpenSubagentsPanel">;
}

export function ThreadSummaryPanelHeaderAction({
  activeThreadId,
  activeThreadIsManagedWorktree = false,
  onPopoverOpenChange,
  mode,
  pinnedOpen,
  onPinnedOpenToggle,
  popoverOpen,
  clockAutomation,
  actions,
}: ThreadSummaryPanelHeaderActionProps) {
  // The conversation stage owns the summary; the popover presents that same content.
  const content = useThreadSummaryContent(activeThreadId);
  const contentProps = useMemo(
    () =>
      content && {
        ...content,
        activeThreadIsManagedWorktree:
          Boolean(content.activeThreadIsManagedWorktree) || activeThreadIsManagedWorktree,
        clockAutomation: clockAutomation ?? content.clockAutomation ?? null,
        // Header actions close the popover before navigating away from it.
        actions: { ...content.actions, ...actions },
      },
    [actions, activeThreadIsManagedWorktree, content, clockAutomation],
  );

  if (mode === "hidden") return null;
  if (mode === "popover") {
    if (!contentProps) return null;
    return (
      <ThreadSummaryPanelPopover
        {...contentProps}
        open={popoverOpen}
        onOpenChange={onPopoverOpenChange}
      />
    );
  }

  return (
    <ThreadSummaryPanelToggle
      label="Toggle pinned summary"
      backgroundCount={content ? threadSummaryBackgroundCount(content) : 0}
      pressed={pinnedOpen}
      onClick={onPinnedOpenToggle}
    />
  );
}

import { useMemo } from "react";
import { useBackgroundSubagentRows } from "../../use-background-subagent-rows";
import { resolveCodexElectronDisplayThreadTitle } from "../../../../../shared/codex-thread-title";
import type {
  ThreadStageActions,
  ThreadSummaryPanelMode,
  ThreadSummaryPanelScheduledAutomationRow,
} from "../../thread-stage-types";
import {
  useConversationBackgroundTerminalRows,
  useConversationCwd,
  useConversationSummaryFields,
  useConversationTurns,
} from "../../local-conversation-store";
import {
  ThreadSummaryPanelPopover,
  type ThreadSummaryPanelContentProps,
} from "./thread-floating-summary-panel";
import { ThreadSummaryPanelToggle } from "./thread-summary-panel-toggle";

export interface ThreadSummaryPanelHeaderActionProps {
  activeThreadId: string | null;
  preferredHostId?: string | null;
  activeThreadIsManagedWorktree?: boolean;
  onPopoverOpenChange?: (open: boolean) => void;
  projectWorkspacePath: string | null;
  mode: ThreadSummaryPanelMode;
  pinnedOpen: boolean;
  onPinnedOpenToggle?: () => void;
  popoverOpen?: boolean;
  scheduledAutomation?: ThreadSummaryPanelScheduledAutomationRow | null;
  actions?: Pick<
    ThreadStageActions,
    "onOpenSummaryOutputInSidePanel" | "onOpenSummaryScheduledAutomation" | "onOpenSubagentsPanel"
  >;
}

export function ThreadSummaryPanelHeaderAction({
  activeThreadId,
  preferredHostId,
  activeThreadIsManagedWorktree = false,
  onPopoverOpenChange,
  projectWorkspacePath,
  mode,
  pinnedOpen,
  onPinnedOpenToggle,
  popoverOpen,
  scheduledAutomation,
  actions,
}: ThreadSummaryPanelHeaderActionProps) {
  const cwd = useConversationCwd(activeThreadId);
  const backgroundAgentRows = useBackgroundSubagentRows(activeThreadId, preferredHostId);
  const turns = useConversationTurns(activeThreadId);
  const backgroundTerminalRows = useConversationBackgroundTerminalRows(activeThreadId);
  const summaryFields = useConversationSummaryFields(activeThreadId);
  const activeThreadProjectless = summaryFields.threadId ? summaryFields.projectId === null : false;
  const contentProps = useMemo<ThreadSummaryPanelContentProps>(
    () => ({
      activeThreadId,
      activeThreadTitle:
        resolveCodexElectronDisplayThreadTitle({
          threadName: summaryFields.threadName,
          threadPreview: summaryFields.threadPreview,
          fallback: "",
        }) || null,
      activeThreadIsManagedWorktree:
        Boolean(summaryFields.managedWorktreePath) || activeThreadIsManagedWorktree,
      activeThreadProjectless,
      cwd,
      projectlessOutputDirectory: summaryFields.projectlessOutputDirectory,
      projectWorkspacePath,
      turns,
      backgroundTerminalRows,
      backgroundAgentRows,
      scheduledAutomation: scheduledAutomation ?? null,
      actions,
      onErrorMessage: () => undefined,
    }),
    [
      actions,
      activeThreadIsManagedWorktree,
      activeThreadId,
      activeThreadProjectless,
      backgroundTerminalRows,
      backgroundAgentRows,
      cwd,
      projectWorkspacePath,
      scheduledAutomation,
      summaryFields.threadName,
      summaryFields.threadPreview,
      summaryFields.managedWorktreePath,
      summaryFields.projectlessOutputDirectory,
      turns,
    ],
  );

  if (mode === "hidden") return null;
  if (mode === "popover") {
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
      pressed={pinnedOpen}
      onClick={onPinnedOpenToggle}
    />
  );
}

import { ThreadSummaryPanelHeaderAction } from "@/features/local-conversation";
import type { WorkbenchThreadSummaryModel } from "@/lib/use-workbench-thread-summary";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import { resolveSessionExecution } from "@/lib/session-execution";
import { useRuntimeExecutionLocation } from "@/lib/use-session-execution";

interface WorkbenchThreadSummaryHeaderProps {
  readonly activeSession: WorkbenchSessionRenderProjection | null;
  readonly pinnedOpen: boolean;
  readonly onTogglePinnedOpen: () => void;
  readonly onOpenSubagentsPanel?: () => void;
  readonly summary: WorkbenchThreadSummaryModel;
}

export function WorkbenchThreadSummaryHeader({
  activeSession,
  pinnedOpen,
  onTogglePinnedOpen,
  onOpenSubagentsPanel,
  summary,
}: WorkbenchThreadSummaryHeaderProps) {
  const execution = activeSession ? resolveSessionExecution(activeSession) : null;
  const runtimeLocation = useRuntimeExecutionLocation(
    execution?.kind === "runtime" && summary.mode !== "hidden" ? execution.rootThreadId : null,
    "on-demand",
  );
  if (summary.mode === "hidden" || !activeSession || !execution || execution.kind === "unstarted")
    return null;

  return (
    <ThreadSummaryPanelHeaderAction
      activeThreadId={execution.rootThreadId}
      activeThreadIsManagedWorktree={Boolean(
        execution.kind === "native"
          ? execution.location.managedWorktreePath
          : runtimeLocation?.managedWorktreePath,
      )}
      onPopoverOpenChange={summary.setPopoverOpen}
      mode={summary.mode}
      pinnedOpen={pinnedOpen}
      onPinnedOpenToggle={onTogglePinnedOpen}
      popoverOpen={summary.popoverOpen}
      scheduledAutomation={summary.scheduledAutomation}
      actions={{
        ...summary.headerActions,
        onOpenSubagentsPanel: onOpenSubagentsPanel
          ? () => {
              summary.setPopoverOpen(false);
              onOpenSubagentsPanel();
            }
          : undefined,
      }}
    />
  );
}

import { ThreadSummaryPanelHeaderAction } from "@/features/local-conversation";
import type { Project } from "@/lib/types";
import { projectWorkspaceRootOrNull } from "@/lib/workbench-workspace-context";
import type { WorkbenchThreadSummaryModel } from "@/lib/use-workbench-thread-summary";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";

interface WorkbenchThreadSummaryHeaderProps {
  readonly activeProject: Project | null;
  readonly activeSession: WorkbenchSessionRenderProjection | null;
  readonly pinnedOpen: boolean;
  readonly onTogglePinnedOpen: () => void;
  readonly onOpenSubagentsPanel?: () => void;
  readonly summary: WorkbenchThreadSummaryModel;
}

export function WorkbenchThreadSummaryHeader({
  activeProject,
  activeSession,
  pinnedOpen,
  onTogglePinnedOpen,
  onOpenSubagentsPanel,
  summary,
}: WorkbenchThreadSummaryHeaderProps) {
  if (summary.mode === "hidden" || !activeSession) return null;

  return (
    <ThreadSummaryPanelHeaderAction
      activeThreadId={activeSession.thread?.threadId ?? null}
      preferredHostId={activeSession.thread?.executionHostId}
      activeThreadIsManagedWorktree={Boolean(activeSession.thread?.managedWorktreePath)}
      onPopoverOpenChange={summary.setPopoverOpen}
      projectWorkspacePath={projectWorkspaceRootOrNull(activeProject)}
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

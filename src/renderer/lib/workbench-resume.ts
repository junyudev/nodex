import { invoke } from "./api";
import type {
  StageId,
  StageNavDirection,
  WorkbenchView,
} from "./use-workbench-state";
import type {
  CardStageState,
} from "./use-card-stage";
import type {
  RecentCardSession,
} from "./use-workbench-state";
import type { WorkbenchResumeSnapshot } from "./types";

export interface BuildWorkbenchResumeSnapshotInput {
  dbProjectId: string;
  threadsProjectId: string;
  viewsByProject: Record<string, WorkbenchView>;
  focusedStage: StageId;
  stageNavDirection: StageNavDirection;
  activeCardsTabId: string;
  activeRecentSessionId: string | null;
  activeThreadsTabId: string;
  recentCardSessions: RecentCardSession[];
  cardStageState: CardStageState;
}

export function buildWorkbenchResumeSnapshot(
  input: BuildWorkbenchResumeSnapshotInput,
): WorkbenchResumeSnapshot {
  return {
    version: 1,
    dbProjectId: input.dbProjectId,
    threadsProjectId: input.threadsProjectId,
    viewsByProject: input.viewsByProject,
    focusedStage: input.focusedStage,
    stageNavDirection: input.stageNavDirection,
    activeCardsTabId: input.activeCardsTabId,
    activeRecentSessionId: input.activeRecentSessionId,
    activeThreadsTabId: input.activeThreadsTabId,
    recentCardSessions: input.recentCardSessions,
    cardStage: {
      open: input.cardStageState.open,
      projectId: input.cardStageState.projectId,
      cardId: input.cardStageState.cardId,
    },
  };
}

export async function consumeWorkbenchResumeSnapshot(): Promise<WorkbenchResumeSnapshot | null> {
  return (await invoke("workbench:resume:consume")) as WorkbenchResumeSnapshot | null;
}

export async function saveWorkbenchResumeSnapshot(snapshot: WorkbenchResumeSnapshot): Promise<boolean> {
  return (await invoke("workbench:resume:save", snapshot)) as boolean;
}

export type WorkbenchResumeView = "kanban" | "list" | "toggle-list" | "canvas" | "calendar";
export type WorkbenchResumeStageId = "db" | "cards" | "threads" | "files";
export type WorkbenchResumeStageNavDirection = "left" | "right";

export interface WorkbenchRecentCardSession {
  id: string;
  projectId: string;
  cardId: string;
  titleSnapshot: string;
  lastOpenedAt: string;
}

export interface WorkbenchResumeCardStageState {
  open: boolean;
  projectId: string;
  cardId: string | null;
}

export interface WorkbenchResumeSnapshot {
  version: 1;
  dbProjectId: string;
  threadsProjectId: string;
  viewsByProject: Record<string, WorkbenchResumeView>;
  focusedStage: WorkbenchResumeStageId;
  stageNavDirection: WorkbenchResumeStageNavDirection;
  activeCardsTabId: string;
  activeRecentSessionId: string | null;
  activeThreadsTabId: string;
  recentCardSessions: WorkbenchRecentCardSession[];
  cardStage: WorkbenchResumeCardStageState;
}

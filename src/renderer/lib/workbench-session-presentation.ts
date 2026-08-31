import type {
  PanelId,
  ProjectSession,
  ProjectSessionSummary,
  WorkbenchPanelState,
  WorkbenchTabProjection,
} from "../../shared/types";
import type { WorkbenchSceneSnapshot } from "../../shared/workbench-scene";
import { presentWorkbenchSessionDomainWithScene } from "./workbench-scene-presentation";

/**
 * A Project Session is Core-owned domain state. Its Workbench view belongs to
 * one Window Session. Keeping both records named prevents callers from
 * accidentally treating panel placement as server state.
 */
export interface WorkbenchSessionPresentation {
  readonly domain: ProjectSession;
  readonly scene: WorkbenchSceneSnapshot;
}

/**
 * Read-only compatibility projection for leaf views that have not yet adopted
 * WorkbenchSessionPresentation. Never pass this projection to a mutation API.
 */
export type WorkbenchSessionRenderProjection = ProjectSession & {
  panels: Record<PanelId, WorkbenchPanelState>;
  tabs: WorkbenchTabProjection[];
};

export function projectSessionSummaryToDomain(
  summary: ProjectSessionSummary,
  current?: ProjectSession,
): ProjectSession {
  const thread = summary.thread
    ? current?.thread?.threadId === summary.thread.threadId
      ? { ...current.thread, ...summary.thread }
      : {
          ...summary.thread,
          executionProfile: null,
          managedWorktreePath: null,
          projectlessOutputDirectory: null,
          projectlessWorkspaceBrowserRoot: null,
        }
    : null;

  return {
    ...summary,
    thread,
  };
}

export function presentWorkbenchSession(
  presentation: WorkbenchSessionPresentation,
): WorkbenchSessionRenderProjection {
  return presentWorkbenchSessionDomainWithScene(presentation.domain, presentation.scene);
}

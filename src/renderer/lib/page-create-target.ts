import type { BoardSummary, Project } from "./types";
import type { DatabaseViewRenderModel } from "./database-view-render-model";
import type { PageCreateTarget } from "./page-create-target-registry";

export interface MaterializePageCreateTargetInput {
  readonly surfaceId: string;
  readonly panelTabId: string;
  readonly project: Pick<Project, "id" | "name" | "appearance">;
  readonly databaseView: DatabaseViewRenderModel | null;
  readonly board: BoardSummary | null;
  readonly clientSessionId: string;
}

/**
 * Builds the immutable authoring context shared by mounted Boards and the
 * active Project fallback. The access-context guard prevents a stale store
 * snapshot from ever being registered for a different Project.
 */
export function materializePageCreateTarget({
  surfaceId,
  panelTabId,
  project,
  databaseView,
  board,
  clientSessionId,
}: MaterializePageCreateTargetInput): PageCreateTarget | null {
  if (!databaseView || !board) return null;
  if (databaseView.routingContext.kind !== "project") return null;
  if (databaseView.routingContext.projectId !== project.id) return null;

  return {
    surfaceId,
    panelTabId,
    project: {
      id: project.id,
      name: project.name,
      appearance: project.appearance,
    },
    databaseViewId: databaseView.databaseViewId,
    clientSessionId,
    routingContext: databaseView.routingContext,
    properties: databaseView.query.properties,
    columns: board.columns,
  };
}

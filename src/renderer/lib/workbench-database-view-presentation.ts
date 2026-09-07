import type { WorkbenchSurfaceReference } from "../../shared/nodex-app-tools/workbench";
import type { WorkbenchSceneOwner } from "../../shared/workbench-scene";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";

export type WorkbenchDatabaseViewReference = Extract<
  WorkbenchSurfaceReference,
  { kind: "db_view" }
>;

export interface WorkbenchDatabaseViewPresentationRegistration {
  readonly owner: WorkbenchWindowOwner;
  readonly sceneOwner: WorkbenchSceneOwner;
  readonly surface: WorkbenchDatabaseViewReference;
}

/** Presentation metadata cannot retarget a capability; only the descriptor's semantic identity can. */
export function databaseViewPresentationIdentity(surface: WorkbenchDatabaseViewReference): string {
  const { accessContext, target } = surface.config;
  return JSON.stringify([
    surface.id,
    accessContext.kind,
    accessContext.kind === "project" ? accessContext.projectId : null,
    target.kind,
    target.kind === "database-view"
      ? target.databaseViewId
      : target.kind === "database-default"
        ? target.databaseId
        : null,
  ]);
}

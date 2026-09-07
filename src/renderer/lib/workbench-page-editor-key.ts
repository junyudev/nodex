import { makeWorkbenchSceneKey, type WorkbenchSceneOwner } from "../../shared/workbench-scene";

/** The exact PageTab lease used by each Workbench Scene's mounted Page body. */
export function workbenchPageEditorKey(sceneOwner: WorkbenchSceneOwner, tabId: string): string {
  if (sceneOwner.kind === "pages") return `library-page:${tabId}`;
  const ownerKey =
    sceneOwner.kind === "session" ? sceneOwner.sessionId : makeWorkbenchSceneKey(sceneOwner);
  return `${ownerKey}\u0000${tabId}`;
}

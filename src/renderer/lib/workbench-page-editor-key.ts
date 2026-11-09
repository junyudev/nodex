import { makeWorkbenchSceneKey, type WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { rendererSpaceId } from "./renderer-space";

/** The exact PageTab lease used by each Workbench Scene's mounted Page body. */
export function workbenchPageEditorKey(sceneOwner: WorkbenchSceneOwner, tabId: string): string {
  // The Library and Library Inbox Scenes mount Library Pages through the same Page surface.
  if (sceneOwner.kind === "library" || sceneOwner.kind === "inbox")
    return `${rendererSpaceId()}\u0000library-page:${tabId}`;
  const ownerKey =
    sceneOwner.kind === "session" ? sceneOwner.sessionId : makeWorkbenchSceneKey(sceneOwner);
  return `${rendererSpaceId()}\u0000${ownerKey}\u0000${tabId}`;
}

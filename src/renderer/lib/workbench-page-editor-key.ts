import { makeWorkbenchSceneKey, type WorkbenchSceneOwner } from "../../shared/workbench-scene";
import { rendererSpaceId } from "./renderer-space";

/** The exact PageTab lease used by each Workbench Scene's mounted Page body. */
export function workbenchPageEditorKey(sceneOwner: WorkbenchSceneOwner, tabId: string): string {
  return `${rendererSpaceId()}\u0000${makeWorkbenchSceneKey(sceneOwner)}\u0000${tabId}`;
}

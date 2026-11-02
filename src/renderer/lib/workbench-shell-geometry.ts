import { WORKBENCH_TITLEBAR_HEIGHT_PX } from "../../shared/workbench-window-chrome";
export {
  WORKBENCH_NAVIGATION_RAIL_WIDTH_PX,
  WORKBENCH_TITLEBAR_HEIGHT_PX,
  WORKBENCH_SURFACE_GUTTER_PX,
} from "../../shared/workbench-window-chrome";

/** Only workspace content reserves a header below the Windows application row. */
export function resolveWorkbenchWorkspaceInsets(
  applicationMenu: boolean,
  workspaceHeader: boolean,
) {
  return {
    workspaceTop: applicationMenu ? 0 : WORKBENCH_TITLEBAR_HEIGHT_PX,
    contentTop: applicationMenu ? (workspaceHeader ? WORKBENCH_TITLEBAR_HEIGHT_PX : 8) : 0,
    surfaceTop: applicationMenu ? (workspaceHeader ? 0 : 8) : WORKBENCH_TITLEBAR_HEIGHT_PX,
  };
}

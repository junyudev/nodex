import { WORKBENCH_TITLEBAR_HEIGHT_PX } from "../../shared/workbench-window-chrome";
export {
  WORKBENCH_NAVIGATION_RAIL_WIDTH_PX,
  WORKBENCH_TITLEBAR_HEIGHT_PX,
  WORKBENCH_SURFACE_GUTTER_PX,
} from "../../shared/workbench-window-chrome";

/**
 * Vertical placement of the workspace row, in pixels from its top edge. The rail and sidebar
 * start at `workspaceTop`; the content surface starts at `surfaceTop` and its content at
 * `workspaceTop + contentTop`. On macOS the surface rises to the window's top edge, so each
 * pane's titlebar row sits on the surface it heads. Below the Windows application row, only
 * workspace content reserves a header.
 */
export function resolveWorkbenchWorkspaceInsets(
  applicationMenu: boolean,
  workspaceHeader: boolean,
) {
  return {
    workspaceTop: applicationMenu ? 0 : WORKBENCH_TITLEBAR_HEIGHT_PX,
    contentTop: applicationMenu ? (workspaceHeader ? WORKBENCH_TITLEBAR_HEIGHT_PX : 8) : 0,
    surfaceTop: applicationMenu ? (workspaceHeader ? 0 : 8) : 0,
  };
}

/** CSS custom properties that place the content surface and its header band in the workspace row. */
export function resolveWorkbenchSurfaceStyle(insets: {
  readonly workspaceTop: number;
  readonly contentTop: number;
  readonly surfaceTop: number;
}) {
  return {
    "--app-shell-workspace-top-inset": `${insets.workspaceTop}px`,
    "--app-shell-surface-top-inset": `${insets.surfaceTop}px`,
    "--app-shell-content-top-inset": `${insets.contentTop}px`,
    /** How far the surface rises above the sidebar's top edge. */
    "--app-shell-surface-lift": `${insets.workspaceTop - insets.surfaceTop}px`,
    /** The surface's titlebar band, above its content. */
    "--app-shell-surface-header-height": `${insets.workspaceTop + insets.contentTop - insets.surfaceTop}px`,
  };
}

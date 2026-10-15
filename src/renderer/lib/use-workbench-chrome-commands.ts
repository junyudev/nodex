import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { MotionValue } from "motion/react";
import { toast } from "@/components/ui/toast";
import { makeWorkbenchPanelSlotKey } from "./workbench-panel-slot-key";
import type { WorkbenchPanelController } from "./use-workbench-panel-controller";
import type { WorkbenchPanelState } from "../../shared/workbench-session-view";

export const RIGHT_PANEL_DEFAULT_WIDTH = 600;
const RIGHT_PANEL_MIN_WIDTH = 320;
const RIGHT_PANEL_MAIN_MIN_WIDTH = 352;
export const AUTOMATION_DETAIL_RAIL_DEFAULT_WIDTH = 820;
const AUTOMATION_DETAIL_RAIL_MIN_WIDTH = 360;
const AUTOMATION_DETAIL_RAIL_MAIN_MIN_WIDTH = 420;
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 280;
const BOTTOM_PANEL_MIN_HEIGHT = 160;

export function clampRegularRightPanelWidth(width: number, sessionWidth: number): number {
  const maxWidth =
    sessionWidth > 0
      ? Math.max(RIGHT_PANEL_MIN_WIDTH, sessionWidth - RIGHT_PANEL_MAIN_MIN_WIDTH)
      : RIGHT_PANEL_DEFAULT_WIDTH;
  return Math.min(maxWidth, Math.max(RIGHT_PANEL_MIN_WIDTH, width));
}

export function clampAutomationDetailRailWidth(width: number, shellWidth: number): number {
  const roundedWidth = Math.round(width);
  if (!Number.isFinite(shellWidth) || shellWidth <= 0) {
    return Math.max(AUTOMATION_DETAIL_RAIL_MIN_WIDTH, roundedWidth);
  }
  const maxWidth = Math.max(
    AUTOMATION_DETAIL_RAIL_MIN_WIDTH,
    Math.floor(shellWidth - AUTOMATION_DETAIL_RAIL_MAIN_MIN_WIDTH),
  );
  return Math.min(maxWidth, Math.max(AUTOMATION_DETAIL_RAIL_MIN_WIDTH, roundedWidth));
}

export function clampBottomPanelHeight(height: number, sessionHeight: number): number {
  const maxHeight =
    sessionHeight > 0
      ? Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.floor(sessionHeight / 2))
      : BOTTOM_PANEL_DEFAULT_HEIGHT;
  return Math.min(maxHeight, Math.max(BOTTOM_PANEL_MIN_HEIGHT, height));
}

function readCodexWindowZoom(root: HTMLElement | null): number {
  const rawZoom = root ? window.getComputedStyle(root).getPropertyValue("--codex-window-zoom") : "";
  const parsedZoom = Number.parseFloat(rawZoom);
  return Number.isFinite(parsedZoom) && parsedZoom > 0 ? parsedZoom : 1;
}

interface PanelLifecycle {
  readonly setActivePanelCollapsed: (
    panelId: "right" | "bottom",
    collapsed: boolean,
  ) => Promise<unknown>;
  readonly updateActivePanel: (
    panelId: "right" | "bottom",
    input: Partial<WorkbenchPanelState>,
  ) => Promise<unknown>;
}

interface WorkbenchChromeCommandsInput {
  readonly activePanelOwner: {
    readonly key: string;
    readonly panels: Readonly<Record<"right" | "bottom", WorkbenchPanelState>>;
  } | null;
  readonly controller: WorkbenchPanelController;
  readonly lifecycle: PanelLifecycle;
  readonly navigateBack: () => void;
  readonly navigateForward: () => void;
  readonly workbenchRootRef: RefObject<HTMLDivElement | null>;
  readonly shellMainContentWidth: MotionValue<number>;
  readonly shellBodyHeight: MotionValue<number>;
  readonly regularRightPanelWidth: MotionValue<number>;
  readonly rightPanelRequestedWidth: MotionValue<number>;
  readonly bottomPanelHeight: MotionValue<number>;
  readonly bottomPanelRequestedHeight: MotionValue<number>;
  readonly automationsDetailRailRequestedWidth: MotionValue<number>;
}

/**
 * Owns panel show/hide/full-width commands and pointer resize lifecycles.
 * High-frequency pointer samples stay in MotionValues and only settled sizes
 * cross the durable panel command Seam.
 */
export function useWorkbenchChromeCommands({
  activePanelOwner,
  controller,
  lifecycle,
  navigateBack,
  navigateForward,
  workbenchRootRef,
  shellMainContentWidth,
  shellBodyHeight,
  regularRightPanelWidth,
  rightPanelRequestedWidth,
  bottomPanelHeight,
  bottomPanelRequestedHeight,
  automationsDetailRailRequestedWidth,
}: WorkbenchChromeCommandsInput) {
  const panelControllerRef = useRef(controller);
  panelControllerRef.current = controller;
  const { setActivePanelCollapsed, updateActivePanel } = lifecycle;
  const showActiveRightPanel = useCallback(async () => {
    if (!activePanelOwner) return;
    await setActivePanelCollapsed("right", false);
  }, [activePanelOwner, setActivePanelCollapsed]);

  const hideActiveRightPanel = useCallback(async () => {
    if (!activePanelOwner) return;
    await setActivePanelCollapsed("right", true);
  }, [activePanelOwner, setActivePanelCollapsed]);

  const showActiveBottomPanel = useCallback(async () => {
    if (!activePanelOwner) return;
    await setActivePanelCollapsed("bottom", false);
  }, [activePanelOwner, setActivePanelCollapsed]);

  const hideActiveBottomPanel = useCallback(async () => {
    if (!activePanelOwner) return;
    await setActivePanelCollapsed("bottom", true);
  }, [activePanelOwner, setActivePanelCollapsed]);

  const setActiveRightPanelFullWidth = useCallback(
    (fullWidth: boolean) => {
      if (!activePanelOwner) return;
      const overrideKey = makeWorkbenchPanelSlotKey(activePanelOwner.key, "right");
      panelControllerRef.current.updatePanelCollapsedOverrides((current) => ({
        ...current,
        [overrideKey]: false,
      }));
      void (async () => {
        try {
          await updateActivePanel("right", {
            collapsed: false,
            size: {
              ...activePanelOwner.panels.right.size,
              fullWidth,
            },
          });
        } catch (error) {
          toast.danger(error instanceof Error ? error.message : "Unable to update panel");
        } finally {
          panelControllerRef.current.updatePanelCollapsedOverrides((current) => {
            if (!(overrideKey in current)) return current;
            const next = { ...current };
            delete next[overrideKey];
            return next;
          });
        }
      })();
    },
    [activePanelOwner, updateActivePanel],
  );

  const executeShellNavigation = useCallback(
    (direction: "back" | "forward") => {
      if (direction === "back") {
        navigateBack();
        return;
      }
      navigateForward();
    },
    [navigateBack, navigateForward],
  );

  const resizeRightPanel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const root = workbenchRootRef.current;
      const windowZoom = readCodexWindowZoom(root);
      const resizeHandle = event.currentTarget;
      const pointerId = event.pointerId;
      const sizingWidth = shellMainContentWidth.get();
      const startX = event.clientX / windowZoom;
      const startWidth = regularRightPanelWidth.get();
      const restoreRequestedWidth = () => {
        rightPanelRequestedWidth.set(
          clampRegularRightPanelWidth(
            activePanelOwner?.panels.right.size.widthPx ?? RIGHT_PANEL_DEFAULT_WIDTH,
            sizingWidth,
          ),
        );
      };

      let latestWidth = startWidth;
      let closedByResize = false;
      rightPanelRequestedWidth.set(startWidth);
      const onPointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        if (closedByResize) return;
        const pointerX = moveEvent.clientX / windowZoom;
        const rawWidth = startWidth + startX - pointerX;
        if (rawWidth < RIGHT_PANEL_MIN_WIDTH) {
          closedByResize = true;
          latestWidth = RIGHT_PANEL_MIN_WIDTH;
          restoreRequestedWidth();
          void setActivePanelCollapsed("right", true);
          return;
        }

        const nextWidth = clampRegularRightPanelWidth(rawWidth, sizingWidth);
        latestWidth = nextWidth;
        rightPanelRequestedWidth.set(nextWidth);
      };

      const cleanupPointerResize = () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
        if (resizeHandle.hasPointerCapture?.(pointerId)) {
          resizeHandle.releasePointerCapture(pointerId);
        }
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        upEvent.preventDefault();
        cleanupPointerResize();
        void (async () => {
          try {
            if (!activePanelOwner || closedByResize) {
              restoreRequestedWidth();
              return;
            }
            await updateActivePanel("right", {
              size: {
                ...activePanelOwner.panels.right.size,
                widthPx: latestWidth,
              },
            });
          } catch (error) {
            restoreRequestedWidth();
            toast.danger(error instanceof Error ? error.message : "Unable to resize panel");
          }
        })();
      };
      const onPointerCancel = () => {
        cleanupPointerResize();
        restoreRequestedWidth();
      };

      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
    },
    [
      activePanelOwner,
      regularRightPanelWidth,
      rightPanelRequestedWidth,
      setActivePanelCollapsed,
      shellMainContentWidth,
      updateActivePanel,
      workbenchRootRef,
    ],
  );

  const resizeAutomationDetailRail = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const root = workbenchRootRef.current;
      const windowZoom = readCodexWindowZoom(root);
      const resizeHandle = event.currentTarget;
      const pointerId = event.pointerId;
      const sizingWidth = shellMainContentWidth.get();
      const startX = event.clientX / windowZoom;
      const startWidth = clampAutomationDetailRailWidth(
        automationsDetailRailRequestedWidth.get(),
        sizingWidth,
      );

      const onPointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        const pointerX = moveEvent.clientX / windowZoom;
        const rawWidth = startWidth + startX - pointerX;
        automationsDetailRailRequestedWidth.set(
          clampAutomationDetailRailWidth(rawWidth, sizingWidth),
        );
      };

      const cleanupPointerResize = () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
        if (resizeHandle.hasPointerCapture?.(pointerId)) {
          resizeHandle.releasePointerCapture(pointerId);
        }
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        upEvent.preventDefault();
        cleanupPointerResize();
      };
      const onPointerCancel = () => {
        cleanupPointerResize();
      };

      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
    },
    [automationsDetailRailRequestedWidth, shellMainContentWidth, workbenchRootRef],
  );

  const resizeBottomPanel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const root = workbenchRootRef.current;
      const windowZoom = readCodexWindowZoom(root);
      const resizeHandle = event.currentTarget;
      const pointerId = event.pointerId;
      const startY = event.clientY / windowZoom;
      const sizingHeight = shellBodyHeight.get();
      const startHeight = bottomPanelHeight.get();
      const restoreRequestedHeight = () => {
        bottomPanelRequestedHeight.set(
          clampBottomPanelHeight(
            activePanelOwner?.panels.bottom.size.heightPx ?? BOTTOM_PANEL_DEFAULT_HEIGHT,
            sizingHeight,
          ),
        );
      };
      let latestHeight = startHeight;
      let closedByResize = false;
      bottomPanelRequestedHeight.set(startHeight);

      const onPointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        if (closedByResize) return;
        const pointerY = moveEvent.clientY / windowZoom;
        const rawHeight = startHeight + startY - pointerY;
        if (rawHeight < BOTTOM_PANEL_MIN_HEIGHT) {
          closedByResize = true;
          latestHeight = BOTTOM_PANEL_MIN_HEIGHT;
          restoreRequestedHeight();
          void setActivePanelCollapsed("bottom", true);
          return;
        }

        const nextHeight = clampBottomPanelHeight(rawHeight, sizingHeight);
        latestHeight = nextHeight;
        bottomPanelRequestedHeight.set(nextHeight);
      };

      const cleanupPointerResize = () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
        if (resizeHandle.hasPointerCapture?.(pointerId)) {
          resizeHandle.releasePointerCapture(pointerId);
        }
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        upEvent.preventDefault();
        cleanupPointerResize();
        void (async () => {
          try {
            if (!activePanelOwner || closedByResize) {
              restoreRequestedHeight();
              return;
            }
            await updateActivePanel("bottom", {
              size: {
                ...activePanelOwner.panels.bottom.size,
                heightPx: latestHeight,
              },
            });
          } catch (error) {
            restoreRequestedHeight();
            toast.danger(error instanceof Error ? error.message : "Unable to resize panel");
          }
        })();
      };
      const onPointerCancel = () => {
        cleanupPointerResize();
        restoreRequestedHeight();
      };

      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
    },
    [
      activePanelOwner,
      bottomPanelHeight,
      bottomPanelRequestedHeight,
      setActivePanelCollapsed,
      shellBodyHeight,
      updateActivePanel,
      workbenchRootRef,
    ],
  );

  return {
    showActiveRightPanel,
    hideActiveRightPanel,
    showActiveBottomPanel,
    hideActiveBottomPanel,
    setActiveRightPanelFullWidth,
    executeShellNavigation,
    resizeRightPanel,
    resizeAutomationDetailRail,
    resizeBottomPanel,
  };
}

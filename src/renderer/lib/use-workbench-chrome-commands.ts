import { getIntl } from "@/lib/i18n";
import { runWithCleanup } from "./run-with-cleanup";
import { usePointerDrag } from "./pointer-drag";
import {
  useLayoutEffect,
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { MotionValue } from "motion/react";
import { toast } from "@/components/ui/toast";
import { makeWorkbenchPanelSlotKey } from "./workbench-panel-slot-key";
import type { WorkbenchPanelController } from "./use-workbench-panel-controller";
import type { WorkbenchPanelState } from "../../shared/workbench-session-view";

export const RIGHT_PANEL_DEFAULT_WIDTH = 600;
const RIGHT_PANEL_MIN_WIDTH = 320;
const RIGHT_PANEL_MAIN_MIN_WIDTH = 352;
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 280;
const BOTTOM_PANEL_MIN_HEIGHT = 160;

export function clampRegularRightPanelWidth(width: number, sessionWidth: number): number {
  const maxWidth =
    sessionWidth > 0
      ? Math.max(RIGHT_PANEL_MIN_WIDTH, sessionWidth - RIGHT_PANEL_MAIN_MIN_WIDTH)
      : RIGHT_PANEL_DEFAULT_WIDTH;
  return Math.min(maxWidth, Math.max(RIGHT_PANEL_MIN_WIDTH, width));
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
  /** The content panel's physical side; its resize handle sits on the edge facing the Chat. */
  readonly rightPanelSide: "left" | "right";
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
  rightPanelSide,
}: WorkbenchChromeCommandsInput) {
  const panelControllerRef = useRef(controller);
  useLayoutEffect(() => {
    panelControllerRef.current = controller;
  }, [controller]);
  const { setActivePanelCollapsed, updateActivePanel } = lifecycle;
  const showActiveRightPanel = useCallback(async () => {
    if (!activePanelOwner) return;
    await setActivePanelCollapsed("right", false);
  }, [activePanelOwner, setActivePanelCollapsed]);

  const hideActiveRightPanel = useCallback(async () => {
    if (!activePanelOwner) return;
    await updateActivePanel("right", {
      collapsed: true,
      size: { ...activePanelOwner.panels.right.size, fullWidth: false },
    });
  }, [activePanelOwner, updateActivePanel]);

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
      void runWithCleanup(
        async () => {
          await updateActivePanel("right", {
            collapsed: false,
            size: {
              ...activePanelOwner.panels.right.size,
              fullWidth,
            },
          });
        },
        {
          onError: (error) => {
            toast.danger(
              error instanceof Error
                ? error.message
                : getIntl().formatMessage({
                    id: "lib.useWorkbenchChromeCommands.toast.updateFailed",
                    defaultMessage: "Unable to update panel",
                  }),
            );
          },
          cleanup: () => {
            panelControllerRef.current.updatePanelCollapsedOverrides((current) => {
              if (!(overrideKey in current)) return current;
              const next = { ...current };
              delete next[overrideKey];
              return next;
            });
          },
        },
      );
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

  const startPointerDrag = usePointerDrag();
  const persistResizedPanel = useCallback(
    (panelId: "right" | "bottom", size: WorkbenchPanelState["size"], restore: () => void) => {
      void runWithCleanup(
        async () => {
          await updateActivePanel(panelId, { size });
        },
        {
          onError: (error) => {
            restore();
            toast.danger(
              error instanceof Error
                ? error.message
                : getIntl().formatMessage({
                    id: "lib.useWorkbenchChromeCommands.toast.resizeFailed",
                    defaultMessage: "Unable to resize panel",
                  }),
            );
          },
        },
      );
    },
    [updateActivePanel],
  );

  const resizeRightPanel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const windowZoom = readCodexWindowZoom(workbenchRootRef.current);
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
      const started = startPointerDrag(event, {
        onMove: (moveEvent) => {
          if (closedByResize) return;
          const pointerX = moveEvent.clientX / windowZoom;
          const rawWidth =
            rightPanelSide === "left"
              ? startWidth + pointerX - startX
              : startWidth + startX - pointerX;
          if (rawWidth < RIGHT_PANEL_MIN_WIDTH) {
            closedByResize = true;
            restoreRequestedWidth();
            void hideActiveRightPanel();
            return;
          }
          latestWidth = clampRegularRightPanelWidth(rawWidth, sizingWidth);
          rightPanelRequestedWidth.set(latestWidth);
        },
        onEnd: (end) => {
          if (end !== "release" || closedByResize || !activePanelOwner) {
            restoreRequestedWidth();
            return;
          }
          persistResizedPanel(
            "right",
            { ...activePanelOwner.panels.right.size, widthPx: latestWidth },
            restoreRequestedWidth,
          );
        },
      });
      if (started) rightPanelRequestedWidth.set(startWidth);
    },
    [
      activePanelOwner,
      regularRightPanelWidth,
      rightPanelRequestedWidth,
      rightPanelSide,
      hideActiveRightPanel,
      persistResizedPanel,
      shellMainContentWidth,
      startPointerDrag,
      workbenchRootRef,
    ],
  );

  const resizeBottomPanel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const windowZoom = readCodexWindowZoom(workbenchRootRef.current);
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
      const started = startPointerDrag(event, {
        onMove: (moveEvent) => {
          if (closedByResize) return;
          const rawHeight = startHeight + startY - moveEvent.clientY / windowZoom;
          if (rawHeight < BOTTOM_PANEL_MIN_HEIGHT) {
            closedByResize = true;
            restoreRequestedHeight();
            void setActivePanelCollapsed("bottom", true);
            return;
          }
          latestHeight = clampBottomPanelHeight(rawHeight, sizingHeight);
          bottomPanelRequestedHeight.set(latestHeight);
        },
        onEnd: (end) => {
          if (end !== "release" || closedByResize || !activePanelOwner) {
            restoreRequestedHeight();
            return;
          }
          persistResizedPanel(
            "bottom",
            { ...activePanelOwner.panels.bottom.size, heightPx: latestHeight },
            restoreRequestedHeight,
          );
        },
      });
      if (started) bottomPanelRequestedHeight.set(startHeight);
    },
    [
      activePanelOwner,
      bottomPanelHeight,
      bottomPanelRequestedHeight,
      persistResizedPanel,
      setActivePanelCollapsed,
      shellBodyHeight,
      startPointerDrag,
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
    resizeBottomPanel,
  };
}

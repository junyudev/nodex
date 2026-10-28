import type { Dispatch, PointerEvent as ReactPointerEvent, ReactNode, SetStateAction } from "react";
import { motion, type MotionStyle, type MotionValue } from "motion/react";
import { APP_SHELL_RIGHT_PANEL_LAYER_CLASS } from "@/lib/app-shell-layers";
import type { AppShellMainContentLayout } from "@/lib/codex-panel-motion";
import { cn } from "@/lib/utils";
import { ConversationContentFrame } from "@/components/ui/conversation-content-frame";

export interface WorkbenchSceneFrameProps {
  readonly ownerKey: string;
  readonly primary: ReactNode;
  readonly primaryTestId: string;
  readonly primaryHidden: boolean;
  readonly rightPanelTestId?: string;
  readonly bottomPanelTestId?: string;
  readonly layout: {
    readonly appShellMainContentLayout: AppShellMainContentLayout;
    readonly rightPanelTargetWidth: MotionValue<number>;
    readonly bottomPanelHeight: MotionValue<number>;
    readonly rightPanel: {
      readonly mounted: boolean;
      readonly open: boolean;
      readonly fullWidth: boolean;
      readonly opacity: MotionValue<number>;
      readonly animatedSize: MotionValue<number>;
      readonly content: ReactNode;
    };
    readonly bottomPanel: {
      readonly mounted: boolean;
      readonly open: boolean;
      readonly opacity: MotionValue<number>;
      readonly animatedSize: MotionValue<number>;
      readonly content: ReactNode;
    };
  };
  readonly chrome: {
    readonly bottomPanelGlobalHeaderControls: ReactNode;
    readonly setRightPanelComposerOverlayTarget: Dispatch<SetStateAction<HTMLElement | null>>;
    readonly resizeRightPanel: (event: ReactPointerEvent<HTMLDivElement>) => void;
    readonly resizeBottomPanel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  };
}

/**
 * Placement-only Workbench frame shared by Project and Session Scenes.
 * Surface identity, authority, and lifecycle stay outside this component.
 */
export function WorkbenchSceneFrame({
  ownerKey,
  primary,
  primaryTestId,
  primaryHidden,
  rightPanelTestId = "scene-right-panel",
  bottomPanelTestId = "scene-bottom-panel",
  layout,
  chrome,
}: WorkbenchSceneFrameProps) {
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      data-workbench-scene-owner={ownerKey}
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <section
          data-testid={primaryTestId}
          data-workbench-primary-hidden={primaryHidden ? "true" : "false"}
          data-session-thread-page-hidden={
            primaryTestId === "session-thread-page" ? (primaryHidden ? "true" : "false") : undefined
          }
          data-app-shell-main-content-layout={layout.appShellMainContentLayout}
          aria-hidden={primaryHidden ? "true" : undefined}
          className={cn(
            "app-shell-main-content-viewport relative flex min-h-0 min-w-0 flex-col",
            primaryHidden ? "w-0 flex-none overflow-hidden" : "flex-1",
          )}
        >
          <ConversationContentFrame
            className="app-shell-main-content-frame mt-(--app-shell-main-content-frame-top-offset) flex flex-1 flex-col"
            topFade={layout.appShellMainContentLayout === "thread-edge-scroll"}
          >
            {primary}
          </ConversationContentFrame>
        </section>

        {layout.rightPanel.mounted ? (
          <motion.aside
            key={ownerKey}
            data-app-shell-focus-area="right-panel"
            data-testid={rightPanelTestId}
            data-right-panel-width-mode={layout.rightPanel.fullWidth ? "full" : "regular"}
            className={cn(
              "relative ml-auto h-full min-h-0 min-w-0 shrink-0 overflow-visible",
              APP_SHELL_RIGHT_PANEL_LAYER_CLASS,
            )}
            style={{
              opacity: layout.rightPanel.opacity,
              width: layout.rightPanel.animatedSize,
            }}
          >
            {layout.rightPanel.open && !layout.rightPanel.fullWidth ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize right panel"
                className="group absolute top-0 bottom-0 left-0 z-40 flex w-4 -translate-x-2 cursor-col-resize touch-none select-none active:cursor-col-resize"
                onPointerDown={chrome.resizeRightPanel}
              >
                <div className="pointer-events-none m-auto h-full w-px bg-linear-to-b from-transparent via-token-foreground/25 to-transparent opacity-0 group-hover:opacity-100 group-active:opacity-100" />
              </div>
            ) : null}

            <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden">
              <motion.div
                ref={chrome.setRightPanelComposerOverlayTarget}
                data-right-panel-composer-overlay-host="true"
                className={cn(
                  "absolute top-0 right-0 bottom-0 min-w-0 bg-token-main-surface-primary",
                  !layout.rightPanel.fullWidth && "border-l border-token-border",
                )}
                style={
                  {
                    width: layout.rightPanelTargetWidth,
                    "--thread-content-top-inset": "calc(var(--spacing) * 8)",
                  } as MotionStyle
                }
              >
                {layout.rightPanel.content}
              </motion.div>
            </div>
          </motion.aside>
        ) : null}
      </div>

      {layout.bottomPanel.mounted ? (
        <motion.section
          data-app-shell-focus-area="bottom-panel"
          data-testid={bottomPanelTestId}
          className="relative min-h-0 w-full shrink-0 overflow-visible"
          style={{
            opacity: layout.bottomPanel.opacity,
            height: layout.bottomPanel.animatedSize,
          }}
        >
          {layout.bottomPanel.open ? (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize bottom panel"
              className="group absolute top-0 left-0 right-0 z-40 flex h-4 -translate-y-2 cursor-row-resize touch-none select-none active:cursor-row-resize"
              onPointerDown={chrome.resizeBottomPanel}
            >
              <div className="pointer-events-none mx-auto h-px w-full bg-linear-to-r from-transparent via-token-foreground/25 to-transparent opacity-0 group-hover:opacity-100 group-active:opacity-100" />
            </div>
          ) : null}
          <div className="absolute inset-0 min-h-0 overflow-hidden">
            <motion.div
              className="absolute inset-x-0 top-0 min-h-0 border-t border-token-border bg-token-main-surface-primary"
              style={{
                height: layout.bottomPanelHeight,
                minHeight: layout.bottomPanelHeight,
              }}
            >
              {layout.bottomPanel.content}
              {chrome.bottomPanelGlobalHeaderControls ? (
                <div
                  data-testid="bottom-panel-global-header-actions"
                  className="pointer-events-none absolute top-0 right-0 z-30 flex h-toolbar items-center justify-end pr-2"
                >
                  <div className="pointer-events-none flex h-full items-center gap-1">
                    {chrome.bottomPanelGlobalHeaderControls}
                  </div>
                </div>
              ) : null}
            </motion.div>
          </div>
        </motion.section>
      ) : null}
    </div>
  );
}

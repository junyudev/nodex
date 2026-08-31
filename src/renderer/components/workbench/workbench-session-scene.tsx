import {
  type ComponentProps,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { type MotionValue } from "motion/react";
import { filterAvailablePanelActions, PANEL_NEW_TAB_ACTIONS } from "@/lib/workbench-panel-actions";
import type { AppShellMainContentLayout } from "@/lib/codex-panel-motion";
import type { useWorkbenchPanelCommandRouter } from "@/lib/use-workbench-panel-command-router";
import type { useWorkbenchPanelLifecycle } from "@/lib/use-workbench-panel-lifecycle";
import { projectWorkspaceRootOrNull } from "@/lib/workbench-workspace-context";
import type { SessionPanelRenderModel } from "@/lib/workbench-panel-projection";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import type { PanelId, Project } from "@/lib/types";
import { makeWorkbenchSceneKey } from "../../../shared/workbench-scene";
import {
  createThreadScopeIdentityRegistry,
  promoteThreadScopeToPending,
  WorkbenchSessionScopePath,
  resolveProjectSessionThreadScopeDescriptor,
} from "@/lib/workbench-ui-scopes";
import type { PanelGroupTabsByPanel } from "./use-workbench-panel-projection";
import { ReviewRouteOpenAdapter } from "./workbench-review-route-adapter";
import { SessionThreadPage } from "./workbench-session-thread-route";
import { WorkbenchPanelHost } from "./workbench-panel-host";
import { WorkbenchSceneFrame } from "./workbench-scene-frame";

type ProjectSession = WorkbenchSessionRenderProjection;
type ThreadPageProps = Omit<
  ComponentProps<typeof SessionThreadPage>,
  "onOpenSummaryGitReview" | "onOpenTurnDiffReview"
>;
type PanelLifecycle = Pick<
  ReturnType<typeof useWorkbenchPanelLifecycle>,
  | "activatePanelGroup"
  | "closePanelTab"
  | "moveTabToPanel"
  | "pinPreviewTab"
  | "reorderTabs"
  | "resizePanelGroup"
  | "selectPanelTab"
  | "splitPanelGroup"
>;
type PanelCommands = Pick<
  ReturnType<typeof useWorkbenchPanelCommandRouter>,
  "dispatchPanelAction" | "openPanelDestinationFromPicker" | "rememberFocusedPanelGroup"
>;

interface WorkbenchSessionSceneProps {
  readonly session: ProjectSession;
  readonly model: SessionPanelRenderModel;
  readonly projects: Project[];
  readonly project: Project | null;
  readonly sessionError: string | null;
  readonly threadScopeIdentityRegistry: ReturnType<typeof createThreadScopeIdentityRegistry>;
  readonly threadPageProps: ThreadPageProps;
  readonly activateReviewTab: ComponentProps<typeof ReviewRouteOpenAdapter>["activateReviewTab"];
  readonly panelGroupTabs: PanelGroupTabsByPanel;
  readonly panelLifecycle: PanelLifecycle;
  readonly panelCommands: PanelCommands;
  readonly layout: {
    readonly appShellMainContentLayout: AppShellMainContentLayout;
    readonly frameBorderVisible: boolean;
    readonly rightPanelTargetWidth: MotionValue<number>;
    readonly bottomPanelHeight: MotionValue<number>;
    readonly rightPanel: {
      readonly mounted: boolean;
      readonly opacity: MotionValue<number>;
      readonly animatedSize: MotionValue<number>;
    };
    readonly bottomPanel: {
      readonly mounted: boolean;
      readonly opacity: MotionValue<number>;
      readonly animatedSize: MotionValue<number>;
    };
    readonly rightPanelHeaderStartInsetWidth: number;
    readonly panelTabScrollEndPaddingPx: number;
    readonly bottomPanelGlobalHeaderInsetWidth: number;
  };
  readonly chrome: {
    readonly isMac: boolean;
    readonly commandKeymapState: ComponentProps<typeof WorkbenchPanelHost>["commandKeymapState"];
    readonly rightPanelHeaderAfterList: ReactNode;
    readonly bottomPanelGlobalHeaderControls: ReactNode;
    readonly setRightPanelComposerOverlayTarget: Dispatch<SetStateAction<HTMLElement | null>>;
    readonly resizeRightPanel: (event: ReactPointerEvent<HTMLDivElement>) => void;
    readonly resizeBottomPanel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  };
}

function hasProjectDbView(session: ProjectSession, projectId: string): boolean {
  return session.tabs.some(
    (tab) =>
      tab.kind === "db_view" && "projectId" in tab.config && tab.config.projectId === projectId,
  );
}

/**
 * Session route Implementation. It owns the thread/panel composition and maps
 * lifecycle/feature command ports into the two panel hosts.
 */
export function WorkbenchSessionScene({
  session,
  model,
  projects,
  project,
  sessionError,
  threadScopeIdentityRegistry,
  threadPageProps,
  activateReviewTab,
  panelGroupTabs,
  panelLifecycle,
  panelCommands,
  layout,
  chrome,
}: WorkbenchSessionSceneProps) {
  const sceneKey = makeWorkbenchSceneKey({
    kind: "session",
    sessionId: session.id,
  });
  const availableRightPanelActions = filterAvailablePanelActions(
    PANEL_NEW_TAB_ACTIONS,
    session.tabs,
    "right",
    {
      kind: "session",
      backendKind: session.thread?.backendBinding.kind ?? "codex",
      projectId: session.projectId,
      hasAttachedThread: Boolean(session.thread),
      cwd: session.thread?.cwd,
      projectWorkspaceRoot: projectWorkspaceRootOrNull(project),
    },
  );
  const availableBottomPanelActions = filterAvailablePanelActions(
    PANEL_NEW_TAB_ACTIONS,
    session.tabs,
    "bottom",
    {
      kind: "session",
      backendKind: session.thread?.backendBinding.kind ?? "codex",
      projectId: session.projectId,
      hasAttachedThread: Boolean(session.thread),
      cwd: session.thread?.cwd,
      projectWorkspaceRoot: projectWorkspaceRootOrNull(project),
    },
  );
  const threadScopeDescriptor = resolveProjectSessionThreadScopeDescriptor(
    threadScopeIdentityRegistry,
    session,
  );
  const {
    activatePanelGroup,
    closePanelTab,
    moveTabToPanel,
    pinPreviewTab,
    reorderTabs,
    resizePanelGroup,
    selectPanelTab,
    splitPanelGroup,
  } = panelLifecycle;
  const { dispatchPanelAction, openPanelDestinationFromPicker, rememberFocusedPanelGroup } =
    panelCommands;

  const renderPanelHost = (panelId: PanelId) => {
    const panel = model[panelId === "right" ? "rightPanel" : "bottomPanel"];
    const availableActions =
      panelId === "right" ? availableRightPanelActions : availableBottomPanelActions;
    return (
      <WorkbenchPanelHost
        sessionId={sceneKey}
        sessionProjectId={session.projectId}
        panelId={panelId}
        layout={panel.layout}
        tabItemsByLeafId={panelGroupTabs[panelId].itemsByLeafId}
        activeTabIdsByLeafId={panelGroupTabs[panelId].activeTabIdsByLeafId}
        availableActions={availableActions}
        projects={projects}
        isMac={chrome.isMac}
        commandKeymapState={chrome.commandKeymapState}
        currentProjectDbViewExists={
          panelId === "right" &&
          session.projectId !== null &&
          hasProjectDbView(session, session.projectId)
        }
        renderAfterList={panelId === "right" ? () => chrome.rightPanelHeaderAfterList : undefined}
        headerStartInsetPx={
          panelId === "right" ? layout.rightPanelHeaderStartInsetWidth : undefined
        }
        headerEndInsetPx={
          panelId === "bottom" ? layout.bottomPanelGlobalHeaderInsetWidth : undefined
        }
        tabScrollEndPaddingPx={layout.panelTabScrollEndPaddingPx}
        commands={{
          selectTab: (leafId, tabId) => {
            void selectPanelTab(panelId, tabId, leafId);
          },
          closeTab: (leafId, tabId) => {
            void closePanelTab(panelId, tabId, leafId);
          },
          pinTab: (leafId, tabId) => {
            void pinPreviewTab(panelId, tabId, leafId);
          },
          reorderTab: (leafId, tabId, targetIndex) => {
            void reorderTabs(panelId, tabId, targetIndex, leafId);
          },
          moveTab: (tabId, targetPanelId, targetLeafId, targetIndex, splitTarget) => {
            void moveTabToPanel(tabId, targetPanelId, targetLeafId, targetIndex, splitTarget);
          },
          splitGroup: (leafId, side, tabId) => {
            void splitPanelGroup(panelId, leafId, side, tabId);
          },
          focusGroup: (leafId) => {
            rememberFocusedPanelGroup(panelId, leafId);
          },
          activateGroup: (leafId, tabId) => {
            void activatePanelGroup(panelId, leafId, tabId);
          },
          resizeGroup: (branchId, ratio) => resizePanelGroup(panelId, branchId, ratio),
          openAction: (kind, leafId) => {
            void dispatchPanelAction(kind, {
              panelId,
              leafId,
            });
          },
          openDestination: async (destination, leafId) => {
            await openPanelDestinationFromPicker(destination, panelId, leafId);
          },
        }}
      />
    );
  };

  return (
    <WorkbenchSessionScopePath
      thread={threadScopeDescriptor}
      route={{ routeKey: "/thread", kind: "thread" }}
      selected
    >
      <WorkbenchSceneFrame
        ownerKey={sceneKey}
        primaryTestId="session-thread-page"
        primaryHidden={model.rightPanelFullWidth}
        rightPanelTestId="session-right-panel"
        bottomPanelTestId="session-bottom-panel"
        primary={
          <>
            {sessionError ? (
              <div className="border-b border-token-border px-3 py-2 text-xs text-token-text-secondary">
                {sessionError}
              </div>
            ) : null}
            <ReviewRouteOpenAdapter activateReviewTab={activateReviewTab}>
              {({ onOpenTurnDiffReview, onOpenSummaryGitReview }) => (
                <SessionThreadPage
                  {...threadPageProps}
                  onOpenPendingWorktree={(clientThreadId, projectSessionId) => {
                    promoteThreadScopeToPending(
                      threadScopeIdentityRegistry,
                      threadScopeDescriptor,
                      clientThreadId,
                      projectSessionId,
                    );
                    threadPageProps.onOpenPendingWorktree(clientThreadId, projectSessionId);
                  }}
                  onOpenTurnDiffReview={onOpenTurnDiffReview}
                  onOpenSummaryGitReview={onOpenSummaryGitReview}
                />
              )}
            </ReviewRouteOpenAdapter>
          </>
        }
        layout={{
          appShellMainContentLayout: layout.appShellMainContentLayout,
          frameBorderVisible: layout.frameBorderVisible,
          rightPanelTargetWidth: layout.rightPanelTargetWidth,
          bottomPanelHeight: layout.bottomPanelHeight,
          rightPanel: {
            ...layout.rightPanel,
            open: model.sidePanelOpen,
            fullWidth: model.rightPanelFullWidth,
            content: renderPanelHost("right"),
          },
          bottomPanel: {
            ...layout.bottomPanel,
            open: model.bottomPanelOpen,
            content: renderPanelHost("bottom"),
          },
        }}
        chrome={chrome}
      />
    </WorkbenchSessionScopePath>
  );
}

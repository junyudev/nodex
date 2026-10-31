import type { ComponentProps, MutableRefObject, RefObject } from "react";
import type { MotionValue } from "motion/react";
import type { PageStageSessionSnapshot } from "@/components/board/page-stage/types";
import {
  WorkspaceFilesPanel,
  type WorkspaceFilesReview,
  type WorkspaceFilesTab,
} from "@/features/workspace-files";
import { ReviewRouteOpenAdapter } from "./workbench-review-route-adapter";
import type { BrowserSettingsDestination } from "@/features/browser-sidebar/browser-settings-pages";
import type { BrowserSidebarOpenNewTabRequest } from "../../../shared/browser-sidebar";
import { ConnectedReviewDiffPanel } from "@/features/local-conversation";
import { resolveLeafIdForPanelTab } from "@/lib/workbench-panel-placement";
import type { WorkbenchTabProjectionPanelTab } from "@/lib/workbench-panel-tab-model";
import {
  projectWorkspaceRootOrNull,
  resolveSessionTerminalCwd,
} from "@/lib/workbench-workspace-context";
import type { PanelId, Project, WorkbenchTabProjection } from "@/lib/types";
import type { OpenCanvasStageHandler } from "@/lib/use-workbench-panel-openers";
import type { OpenPageInNewChatInput, SendPageToChatInput } from "@/lib/page-chat-actions";
import type { WorkbenchSurfaceUpdatePatch } from "@/lib/workbench-scene-presentation";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import { DbViewSessionTab } from "./workbench-db-view-panel";
import { WorkbenchCanvasStagePanel } from "./workbench-canvas-stage-panel";
import {
  PageStageSessionTab,
  type OpenPageTabHandler,
  type PageStageHistoryModalContext,
} from "./workbench-page-stage-panel";
import { TerminalPanel } from "./workbench-terminal-panel";
import { WorkbenchBrowserSidebarPanel } from "./workbench-new-tab-page";
import { projectSessionThreadLinkToSummary } from "./thread-summary-projection";
import { hasSessionConversation, resolveSessionPageSendTarget } from "@/lib/session-execution";
import { resolveNfmSendToThreadPreferredTarget } from "@/components/board/editor/nfm-send-to-thread-menu-model";
import { presentChatTitle } from "@/lib/page-stage-related-chat-candidates";
import { resolveWorkbenchPanelCapabilities } from "@/lib/workbench-panel-capabilities";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { readWorkbenchAgentContext } from "@/lib/workbench-agent-context";
import type { LibraryRouteTarget } from "../../../shared/library-module";
import type { WorkbenchSceneOwner } from "../../../shared/workbench-scene";
import { WorkbenchLibraryResourceSurface } from "./workbench-library-resource-surface";
import { WorkbenchDatabaseViewSurface } from "./workbench-database-view-surface";
import { readWorkbenchReviewOpen, consumeWorkbenchReviewOpen } from "@/lib/workbench-review-open";

export function WorkbenchTabProjectionPanel({
  tab,
  activeSession,
  windowSessionId,
  browserViewScopeId,
  projects,
  relatedChatCandidates,
  activeSearchQuery,
  searchByProject,
  presentedPageIds,
  pageStageCloseRef,
  pageStagePersistRef,
  pageStageSessionSnapshotRef,
  taskSearchOpenTick,
  setSearchQuery,
  onLeavePageStage,
  onOpenPageTab,
  onOpenPageInNewChat,
  onOpenRelatedChat,
  onLinkPageToChat,
  onResolveChatSessionForThread,
  onSendPageToChat,
  onOpenCanvasStage,
  onOpenLibraryTarget,
  onOpenFileTab,
  onEnsureDefaultDraftSessionForProject,
  onRefreshSessions,
  onCloseTab,
  onUpdateTab,
  onOpenBrowserTab,
  onCreateTerminalTab,
  onActivateReviewTab,
  onSearchInFiles,
  onOpenThread,
  pageStageHistoryModal,
  onTogglePageStageHistoryModal,
  browserBoundsSyncTrigger,
  onOpenBrowserSettings,
  isActivePanelTab,
}: {
  tab: WorkbenchTabProjectionPanelTab;
  activeSession: WorkbenchSessionRenderProjection;
  windowSessionId: string;
  browserViewScopeId: string;
  projects: Project[];
  relatedChatCandidates: ComponentProps<typeof PageStageSessionTab>["relatedChatCandidates"];
  activeSearchQuery: string;
  searchByProject: Record<string, string>;
  presentedPageIds: ReadonlySet<string>;
  pageStageCloseRef: RefObject<(() => Promise<void>) | null>;
  pageStagePersistRef?: MutableRefObject<(() => Promise<void>) | null>;
  pageStageSessionSnapshotRef?: MutableRefObject<PageStageSessionSnapshot | null>;
  taskSearchOpenTick: number;
  setSearchQuery: (projectId: string, value: string) => void;
  onLeavePageStage: (snapshot: PageStageSessionSnapshot) => void;
  onOpenPageTab: OpenPageTabHandler;
  onOpenPageInNewChat?: (input: OpenPageInNewChatInput) => Promise<void> | void;
  onOpenRelatedChat?: (sessionId: string) => Promise<void> | void;
  onLinkPageToChat: (input: {
    readonly pageId: string;
    readonly sessionId: string;
  }) => Promise<void>;
  onResolveChatSessionForThread: (
    threadId: string,
  ) => Promise<{ readonly id: string; readonly projectId: string | null }>;
  onSendPageToChat?: (input: SendPageToChatInput) => Promise<void> | void;
  onOpenCanvasStage: OpenCanvasStageHandler;
  onOpenLibraryTarget: (
    target: LibraryRouteTarget,
    options: {
      readonly owner: WorkbenchSceneOwner;
      readonly sourceSurfaceId: string;
      readonly targetPanelId: PanelId;
      readonly titleSnapshot?: string;
      readonly mode?: "durable" | "preview";
    },
  ) => Promise<boolean>;
  onOpenFileTab: (input: {
    hostId?: string;
    cwd?: string | null;
    workspaceRoot?: string | null;
    path: string;
    title: string;
    panelId: PanelId;
    mode?: "preview" | "durable";
  }) => Promise<unknown>;
  onEnsureDefaultDraftSessionForProject: (
    projectId: string,
    options?: { select?: boolean },
  ) => Promise<WorkbenchSessionRenderProjection>;
  onRefreshSessions: (projectId: string | null) => Promise<WorkbenchSessionRenderProjection[]>;
  onCloseTab: (tabId: string) => Promise<void>;
  onUpdateTab: (tabId: string, patch: WorkbenchSurfaceUpdatePatch) => WorkbenchTabProjection | null;
  onOpenBrowserTab?: (request: BrowserSidebarOpenNewTabRequest) => void | Promise<void>;
  onCreateTerminalTab: (panelId: PanelId, leafId: string) => Promise<void> | void;
  /** Opens the Session's Review tab; Files offers All changes through it. */
  onActivateReviewTab?: () => Promise<boolean>;
  onSearchInFiles?: () => void;
  onOpenThread: (threadId: string) => Promise<void>;
  pageStageHistoryModal: PageStageHistoryModalContext | null;
  onTogglePageStageHistoryModal: (context: PageStageHistoryModalContext) => void;
  browserBoundsSyncTrigger?: MotionValue<number>;
  onOpenBrowserSettings: (sectionId: BrowserSettingsDestination) => void;
  isActivePanelTab: boolean;
}) {
  const workbenchOwner = useWorkbenchWindowOwner();
  const sceneOwner = { kind: "session" as const, sessionId: activeSession.id };
  // A bound Runtime Session is an existing chat; only an unstarted Session can launch here.
  const sessionSendTarget = (projectId: string) =>
    resolveSessionPageSendTarget(
      activeSession,
      projectId,
      activeSession.thread ? projectSessionThreadLinkToSummary(activeSession.thread) : null,
    );
  const canonicalSurface = readWorkbenchAgentContext(workbenchOwner.read(), sceneOwner)?.tabs.find(
    (item) => item.tabId === tab.id,
  )?.surface;
  if (
    (tab.kind === "db_view" || tab.kind === "page_stage" || tab.kind === "canvas_stage") &&
    tab.config.routingContext.kind === "library"
  ) {
    if (
      !canonicalSurface ||
      (canonicalSurface.kind !== "db_view" &&
        canonicalSurface.kind !== "page_stage" &&
        canonicalSurface.kind !== "canvas_stage")
    )
      return null;
    return (
      <WorkbenchLibraryResourceSurface
        surface={{ ...canonicalSurface, state: tab.state, stateKey: tab.stateKey }}
        owner={workbenchOwner}
        sceneOwner={sceneOwner}
        windowSessionId={windowSessionId}
        active={isActivePanelTab}
        presentedPageIds={presentedPageIds}
        onClose={() => {
          void onCloseTab(tab.id);
        }}
        onTitleChange={(title) => {
          onUpdateTab(tab.id, { title });
        }}
        onOpenTarget={(target, options) => {
          void onOpenLibraryTarget(target, {
            owner: sceneOwner,
            sourceSurfaceId: tab.id,
            targetPanelId: tab.panelId,
            ...options,
          });
        }}
        {...(onOpenRelatedChat
          ? {
              pageChats: {
                candidates: relatedChatCandidates,
                openChat: onOpenRelatedChat,
                linkPage: onLinkPageToChat,
              },
            }
          : {})}
      />
    );
  }
  if (tab.kind === "db_view") {
    const routingContext = tab.config.routingContext;
    if (routingContext.kind !== "project") return null;
    const projectId = routingContext.projectId;
    const workbenchPresentation =
      canonicalSurface?.kind === "db_view"
        ? { owner: workbenchOwner, sceneOwner, surface: canonicalSurface }
        : undefined;
    if (tab.config.target.kind === "database-default")
      return (
        <WorkbenchDatabaseViewSurface
          isActivePanelTab={isActivePanelTab}
          workbenchPresentation={workbenchPresentation}
          routingContext={routingContext}
          target={tab.config.target}
          presentedPageIds={presentedPageIds}
          onOpenPage={(pageId, titleSnapshot, openMode) => {
            void onOpenPageTab(projectId, pageId, titleSnapshot, {
              openMode,
              placement: { kind: "same-group", sourceSurfaceId: tab.id },
            });
          }}
        />
      );
    const databaseViewId =
      tab.config.target.kind === "database-view"
        ? tab.config.target.databaseViewId
        : projects.find((project) => project.id === projectId)?.defaultDatabaseViewId;
    if (!databaseViewId) return <div role="status">Database View is unavailable</div>;
    const sendTarget = sessionSendTarget(projectId);
    return (
      <DbViewSessionTab
        isActivePanelTab={isActivePanelTab}
        workbenchPresentation={workbenchPresentation}
        sessionId={activeSession.id}
        tab={{
          ...tab,
          config: { routingContext, target: { kind: "database-view", databaseViewId } },
        }}
        projects={projects}
        activeSearchQuery={activeSearchQuery}
        searchByProject={searchByProject}
        presentedPageIds={presentedPageIds}
        pageStageCloseRef={pageStageCloseRef}
        taskSearchOpenTick={taskSearchOpenTick}
        setSearchQuery={setSearchQuery}
        onOpenPageTab={onOpenPageTab}
        onOpenPageInNewChat={onOpenPageInNewChat}
        onOpenRelatedChat={onOpenRelatedChat}
        onSendPageToChat={onSendPageToChat}
        currentChat={resolveNfmSendToThreadPreferredTarget({
          sessionId: activeSession.id,
          sessionThread: sendTarget.kind === "thread" ? sendTarget.thread : null,
          canStartThreadInSession: sendTarget.kind === "launch",
          sessionTitle: presentChatTitle(activeSession),
        })}
        onOpenCanvasStage={onOpenCanvasStage}
        onSelectDatabaseView={(databaseViewId, title) => {
          onUpdateTab(tab.id, {
            title,
            config: { routingContext, target: { kind: "database-view", databaseViewId } },
          });
        }}
        targetLeafId={resolveLeafIdForPanelTab(activeSession, tab.panelId, tab.id)}
      />
    );
  }

  if (tab.kind === "canvas_stage") {
    const routingContext = tab.config.routingContext;
    if (routingContext.kind !== "project") return null;
    const surface = {
      id: tab.id,
      kind: "canvas_stage" as const,
      titleSnapshot: tab.title,
      config: tab.config,
      stateKey: tab.stateKey,
      state: tab.state,
    };
    return (
      <WorkbenchCanvasStagePanel
        surface={surface}
        windowSessionId={windowSessionId}
        presentationOwnerId={activeSession.id}
        isActivePanelTab={isActivePanelTab}
        onClose={() => void onCloseTab(tab.id)}
        onTitleChange={(title) => {
          onUpdateTab(tab.id, { title });
        }}
        onOpenPage={({ pageId, titleSnapshot }) => {
          void onOpenPageTab(routingContext.projectId, pageId, titleSnapshot, {
            openMode: "durable",
            placement: { kind: "same-group", sourceSurfaceId: tab.id },
          });
        }}
      />
    );
  }

  if (tab.kind === "page_stage") {
    if (tab.config.routingContext.kind !== "project") return null;
    const pageAccessProjectId = tab.config.routingContext.projectId;
    const pageTab = tab;
    const sendTarget = sessionSendTarget(pageAccessProjectId);
    return (
      <PageStageSessionTab
        tab={pageTab}
        project={projects.find((item) => item.id === pageAccessProjectId) ?? null}
        closeRef={pageStageCloseRef}
        persistRef={pageStagePersistRef}
        sessionSnapshotRef={pageStageSessionSnapshotRef}
        sessionId={activeSession.id}
        sessionThread={sendTarget.kind === "thread" ? sendTarget.thread : null}
        canStartThreadInSession={sendTarget.kind === "launch"}
        sessionTitle={presentChatTitle(activeSession)}
        onLeavePage={onLeavePageStage}
        onClose={() => void onCloseTab(tab.id)}
        onOpenTerminal={async () => {
          await onCreateTerminalTab("bottom", activeSession.panels.bottom.layout.activeLeafId);
        }}
        onEnsureDefaultDraftSessionForProject={onEnsureDefaultDraftSessionForProject}
        onRefreshSessions={onRefreshSessions}
        onOpenPageTab={onOpenPageTab}
        onOpenCanvasStage={onOpenCanvasStage}
        onOpenThread={onOpenThread}
        onOpenRelatedChat={onOpenRelatedChat}
        onOpenPageInNewChat={onOpenPageInNewChat}
        onLinkPageToChat={onLinkPageToChat}
        relatedChatCandidates={relatedChatCandidates}
        onResolveChatSessionForThread={onResolveChatSessionForThread}
        historyPanelActive={Boolean(
          pageStageHistoryModal &&
          pageStageHistoryModal.sessionId === activeSession.id &&
          pageStageHistoryModal.tabId === pageTab.id &&
          pageStageHistoryModal.projectId === pageAccessProjectId &&
          pageStageHistoryModal.pageId === pageTab.config.pageId,
        )}
        onToggleHistoryPanel={onTogglePageStageHistoryModal}
        isActivePanelTab={isActivePanelTab}
      />
    );
  }

  if (tab.kind === "terminal" && "terminalSessionId" in tab.config) {
    const cwd = resolveSessionTerminalCwd(activeSession, tab, projects);
    const leafId = resolveLeafIdForPanelTab(activeSession, tab.panelId, tab.id);
    if (!cwd) {
      return (
        <div className="flex h-full min-h-0 items-center justify-center bg-token-main-surface-primary px-3 text-sm text-token-text-secondary">
          Terminal workspace is unavailable
        </div>
      );
    }
    return (
      <div className="h-full min-h-0 bg-token-main-surface-primary">
        <TerminalPanel
          terminalId={tab.config.terminalSessionId}
          cwd={cwd}
          conversationId={activeSession.thread?.threadId ?? null}
          projectSessionId={activeSession.id}
          onNewTerminalTab={() => {
            void onCreateTerminalTab(tab.panelId, leafId);
          }}
        />
      </div>
    );
  }

  if (tab.kind === "review") {
    const project = projects.find((item) => item.id === tab.projectId) ?? null;
    return (
      <ConnectedReviewDiffPanel
        threadId={activeSession.executionRef?.threadId ?? activeSession.thread?.threadId ?? null}
        runtimeTarget={
          activeSession.executionRef
            ? { sessionId: activeSession.id, threadId: activeSession.executionRef.threadId }
            : undefined
        }
        projectWorkspacePath={projectWorkspaceRootOrNull(project)}
        searchOpenTick={0}
        pendingOpen={readWorkbenchReviewOpen(tab.state)}
        onOpenConsumed={(operationId) =>
          consumeWorkbenchReviewOpen(
            workbenchOwner,
            { kind: "session", sessionId: activeSession.id },
            tab.id,
            operationId,
          )
        }
      />
    );
  }

  if (tab.kind === "browser") {
    return (
      <WorkbenchBrowserSidebarPanel
        owner={{ kind: "session", sessionId: activeSession.id }}
        surfaceId={tab.id}
        panelId={tab.panelId}
        tab={tab}
        activeSession={activeSession}
        browserViewScopeId={browserViewScopeId}
        onRefreshSessions={onRefreshSessions}
        onUpdateTab={onUpdateTab}
        onOpenNewTab={onOpenBrowserTab}
        boundsSyncTrigger={browserBoundsSyncTrigger}
        onOpenBrowserSettings={onOpenBrowserSettings}
        activeForContentSearch={isActivePanelTab}
        isVisible={isActivePanelTab}
      />
    );
  }

  if (tab.kind === "files") {
    const project = projects.find((item) => item.id === tab.projectId) ?? null;
    const renderFiles = (review?: WorkspaceFilesReview) => (
      <WorkspaceFilesPanel
        tab={tab as WorkspaceFilesTab}
        activeSession={activeSession}
        project={project}
        onOpenFileTab={onOpenFileTab}
        onSearchInFiles={onSearchInFiles}
        review={review}
        onUpdateTabState={(state) => {
          onUpdateTab(tab.id, { state });
        }}
      />
    );
    // All changes opens Review, so it is offered only where this Session can show Review.
    const reviewAvailable = resolveWorkbenchPanelCapabilities({
      panelId: "right",
      owner: {
        kind: "session",
        backendKind: activeSession.thread?.backendBinding.kind ?? "codex",
        projectId: activeSession.projectId,
        hasAttachedThread: hasSessionConversation(activeSession),
        cwd: activeSession.thread?.cwd,
        projectWorkspaceRoot: projectWorkspaceRootOrNull(project),
      },
    }).actions.review.available;
    if (!onActivateReviewTab || !reviewAvailable) return renderFiles();
    // Review reads a runtime-backed conversation's working directory, else the project root.
    const reviewCwd = activeSession.executionRef
      ? (activeSession.thread?.cwd ?? null)
      : projectWorkspaceRootOrNull(project);
    return (
      <ReviewRouteOpenAdapter activateReviewTab={onActivateReviewTab}>
        {({ onOpenTurnDiffReview }) =>
          renderFiles({ cwd: reviewCwd, open: (intent) => void onOpenTurnDiffReview(intent) })
        }
      </ReviewRouteOpenAdapter>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-token-main-surface-primary text-sm text-token-text-secondary">
      Unsupported tab.
    </div>
  );
}

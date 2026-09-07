import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type ComponentType,
  type MutableRefObject,
} from "react";
import { type MotionValue } from "motion/react";
import {
  AutomationsIcon,
  SidePanelSideChatIcon,
  SidePanelTerminalIcon,
  ComposerPlanModeIcon,
  ComposerPluginsIcon,
  ImageEditorTabIcon,
} from "@/components/shared/icons";
import { BrowserTabFavicon } from "@/features/browser-sidebar/browser-tab-favicon";
import {
  restoreNormalizedImageEditorOptions,
  UserAttachmentImageEditorSurface,
} from "@/features/user-attachment-image-editor";
import {
  SubagentAvatar,
  SubagentGlyphIcon,
} from "@/features/local-conversation/view/shared/subagent-avatar";
import { resolveFileResourceIcon } from "@/components/shared/file-resource-icon";
import { getWorkspaceFileDomTabId } from "@/features/workspace-files";
import {
  makePageTitleResourceKey,
  type PageTitleProjectionStore,
} from "@/lib/page-title-projection-store";
import { getPanelNewTabAction } from "@/lib/workbench-panel-actions";
import { terminalSessionStore } from "@/lib/terminal-session-store";
import type { WorkbenchPanelController } from "@/lib/use-workbench-panel-controller";
import type { useWorkbenchPanelCommandRouter } from "@/lib/use-workbench-panel-command-router";
import type { useWorkbenchPanelLifecycle } from "@/lib/use-workbench-panel-lifecycle";
import type { useWorkbenchPanelOpeners } from "@/lib/use-workbench-panel-openers";
import type { useWorkbenchSessionCommands } from "@/lib/use-workbench-session-commands";
import {
  collectPanelPresentedPageIds,
  shouldExpandImageEditorPanelForViewChange,
  type SessionPanelRenderModel,
} from "@/lib/workbench-panel-projection";
import { makeWorkbenchSessionPanelSlotKey } from "@/lib/workbench-panel-slot-key";
import {
  isAutomationPanelTab,
  isBackgroundAgentPanelTab,
  isImageEditorPanelTab,
  isMcpAppPanelTab,
  isPanelTabClosable,
  isPlanPanelTab,
  isProcessOutputPanelTab,
  isSideChatPanelTab,
  isSubagentsPanelTab,
  isTransientPanelTab,
  updateImageEditorPanelTabTitle,
  type ProjectSessionRenderableTab,
} from "@/lib/workbench-panel-tab-model";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import type {
  CodexScheduledAutomation,
  PanelId,
  Project,
  WorkbenchTabProjection,
} from "@/lib/types";
import {
  makeBrowserSidebarTabKey,
  type BrowserSidebarTabSnapshot,
} from "../../../shared/browser-sidebar";
import { listWorkbenchPanelLeaves } from "../../../shared/workbench-panel-layout";
import type { AppShellTabItem } from "./app-shell-tabs";
import { buildAutomationsPath } from "./workbench-automations-routes";
import { WorkbenchAutomationSidePanelTab } from "./workbench-automations-overlay";
import {
  BackgroundAgentSessionTab,
  SideChatSessionTab,
  SubagentsPanelSessionTab,
} from "./workbench-auxiliary-conversation-panels";
import { WorkbenchTabProjectionPanel } from "./workbench-panel-surface";
import { McpAppSessionTab, ProcessOutputPanelTabView } from "./workbench-runtime-panel-surfaces";
import { PlanSidePanelTab } from "./plan-side-panel-tab";
import type { PanelTabPresentationRegistry } from "./panel-tab-presentation-registry";
import { ReviewRouteOpenAdapter } from "./workbench-review-route-adapter";

type ProjectSession = WorkbenchSessionRenderProjection;
type SurfaceProps = ComponentProps<typeof WorkbenchTabProjectionPanel>;
type PanelLifecycle = Pick<
  ReturnType<typeof useWorkbenchPanelLifecycle>,
  "closeEphemeralPanelTab" | "closeTab" | "updateActivePanel"
>;
type PanelOpeners = Pick<
  ReturnType<typeof useWorkbenchPanelOpeners>,
  | "openCanvasStage"
  | "openMcpAppSidePanel"
  | "openPageTab"
  | "openWorkspaceFileTab"
  | "recreateSideChatPanelTab"
>;
type SessionCommands = Pick<
  ReturnType<typeof useWorkbenchSessionCommands>,
  | "activateReviewTab"
  | "createManualTab"
  | "ensureDefaultDraftSessionForProject"
  | "openPageInNewChat"
  | "openProjectSessionById"
  | "linkPageToChat"
  | "resolveChatSessionForThread"
  | "openAttachedThreadSession"
  | "openAttachedThreadSessionById"
  | "sendPageToChat"
  | "openSubagentsPanelTab"
  | "openTurnDiffFileInSidePanel"
>;
type PanelCommands = Pick<
  ReturnType<typeof useWorkbenchPanelCommandRouter>,
  "createBrowserTabToRight" | "reloadBrowserTab"
>;

export type PanelGroupTabsByPanel = Record<
  PanelId,
  {
    itemsByLeafId: Record<string, AppShellTabItem[]>;
    activeTabIdsByLeafId: Record<string, string | null>;
  }
>;

interface WorkbenchPanelProjectionInput {
  readonly activeRenderSession: ProjectSession | null;
  readonly activeSessionPanelModel: SessionPanelRenderModel | null;
  readonly projects: Project[];
  readonly pageStageRelatedChatCandidates: SurfaceProps["relatedChatCandidates"];
  readonly pageTitleStore: PageTitleProjectionStore;
  readonly panelTabPresentationRegistry: PanelTabPresentationRegistry;
  readonly panelTabPresentationControllerKeysRef: MutableRefObject<Set<string>>;
  readonly panelGroupTabsRef: MutableRefObject<PanelGroupTabsByPanel>;
  readonly terminalSessionVersion: number;
  readonly browserTabSnapshotByKey: ReadonlyMap<string, BrowserSidebarTabSnapshot>;
  readonly browserBoundsSyncTriggerByPanel: Partial<Record<PanelId, MotionValue<number>>>;
  readonly lifecycle: PanelLifecycle;
  readonly openers: PanelOpeners;
  readonly sessionCommands: SessionCommands;
  readonly panelCommands: PanelCommands;
  readonly controller: WorkbenchPanelController;
  readonly surface: Pick<
    SurfaceProps,
    | "activeSearchQuery"
    | "browserViewScopeId"
    | "onOpenBrowserSettings"
    | "onOpenLibraryTarget"
    | "windowSessionId"
    | "onLeavePageStage"
    | "pageStageCloseRef"
    | "pageStageHistoryModal"
    | "pageStagePersistRef"
    | "pageStageSessionSnapshotRef"
    | "searchByProject"
    | "setSearchQuery"
    | "taskSearchOpenTick"
  >;
  readonly conversation: {
    readonly composerEnterBehavior: ComponentProps<
      typeof SideChatSessionTab
    >["composerEnterBehavior"];
    readonly threadQueueFollowUpsEnabled: boolean;
    readonly onOpenHooksSettings: ComponentProps<typeof SideChatSessionTab>["onOpenHooksSettings"];
    readonly onQueueingEnabledChange: ComponentProps<
      typeof SideChatSessionTab
    >["onQueueingEnabledChange"];
    readonly onRefreshSessions: ComponentProps<typeof SideChatSessionTab>["onRefreshSessions"];
  };
  readonly automation: {
    readonly onOpenAutomations: (path: string) => void;
    readonly onOpenLocalEnvironmentsSettings: ComponentProps<
      typeof WorkbenchAutomationSidePanelTab
    >["onOpenLocalEnvironmentsSettings"];
  };
  readonly onTogglePageStageHistoryModal: SurfaceProps["onTogglePageStageHistoryModal"];
  readonly onUpdateSessionViewTab: SurfaceProps["onUpdateTab"];
}

function getTabIcon(kind: WorkbenchTabProjection["kind"]): ComponentType<{ className?: string }> {
  if (kind === "image_editor") return ImageEditorTabIcon;
  return getPanelNewTabAction(kind).Icon;
}

function resolveProjectTargetTabChromeContext(
  tab: ProjectSessionRenderableTab,
  activeSession: ProjectSession,
  projects: readonly Project[],
): Pick<AppShellTabItem, "contextLabel" | "titleLabel" | "renderTooltip" | "tooltip"> {
  if (
    isSideChatPanelTab(tab) ||
    isMcpAppPanelTab(tab) ||
    isPlanPanelTab(tab) ||
    isAutomationPanelTab(tab) ||
    isBackgroundAgentPanelTab(tab) ||
    isSubagentsPanelTab(tab) ||
    isProcessOutputPanelTab(tab) ||
    isImageEditorPanelTab(tab)
  )
    return {};
  if (tab.kind !== "db_view" && tab.kind !== "page_stage" && tab.kind !== "canvas_stage") return {};
  if (tab.config.accessContext.kind === "library") return { contextLabel: "Library" };
  const targetProjectId = tab.config.accessContext.projectId;
  if (targetProjectId === activeSession.projectId) return {};

  const targetProject = projects.find((project) => project.id === targetProjectId);
  const projectLabel = targetProject?.name.trim() || targetProjectId;

  return {
    contextLabel: projectLabel,
    titleLabel: (title) => `${projectLabel} project, ${title}`,
    renderTooltip: (title) => (
      <div className="flex max-w-80 flex-col gap-0.5">
        <div className="truncate font-medium">{title}</div>
        <div className="truncate text-xs text-token-description-foreground">
          Project: {projectLabel}
        </div>
      </div>
    ),
  };
}

function createBackgroundAgentTabIcon(threadId: string): ComponentType<{ className?: string }> {
  function BackgroundAgentTabIcon({ className }: { className?: string }) {
    return <SubagentAvatar seed={threadId} className={className} />;
  }

  return BackgroundAgentTabIcon;
}

function resolveTerminalTabIndex(session: ProjectSession, tab: WorkbenchTabProjection): number {
  const index = session.tabs
    .filter((candidate) => candidate.kind === "terminal")
    .findIndex((candidate) => candidate.id === tab.id);
  return index >= 0 ? index + 1 : 1;
}

/**
 * Projects panel state and commands into host-ready tab descriptors.
 *
 * This Adapter is the only Workbench module that knows which React surface,
 * icon, context menu, and runtime command belongs to each renderable tab kind.
 */
export function useWorkbenchPanelProjection({
  activeRenderSession,
  activeSessionPanelModel,
  projects,
  pageStageRelatedChatCandidates,
  pageTitleStore,
  panelTabPresentationRegistry,
  panelTabPresentationControllerKeysRef,
  panelGroupTabsRef,
  terminalSessionVersion,
  browserTabSnapshotByKey,
  browserBoundsSyncTriggerByPanel,
  lifecycle,
  openers,
  sessionCommands,
  panelCommands,
  controller,
  surface,
  conversation,
  automation,
  onTogglePageStageHistoryModal,
  onUpdateSessionViewTab,
}: WorkbenchPanelProjectionInput) {
  const panelControllerRef = useRef(controller);
  panelControllerRef.current = controller;
  const { closeEphemeralPanelTab, closeTab, updateActivePanel } = lifecycle;
  const {
    openCanvasStage,
    openMcpAppSidePanel,
    openPageTab,
    openWorkspaceFileTab,
    recreateSideChatPanelTab,
  } = openers;
  const {
    activateReviewTab,
    createManualTab,
    ensureDefaultDraftSessionForProject,
    openPageInNewChat,
    openProjectSessionById,
    linkPageToChat,
    resolveChatSessionForThread,
    openAttachedThreadSession,
    openAttachedThreadSessionById,
    sendPageToChat,
    openSubagentsPanelTab,
    openTurnDiffFileInSidePanel,
  } = sessionCommands;
  const { createBrowserTabToRight, reloadBrowserTab } = panelCommands;
  const {
    composerEnterBehavior,
    threadQueueFollowUpsEnabled,
    onOpenHooksSettings,
    onQueueingEnabledChange,
    onRefreshSessions,
  } = conversation;
  const { onOpenAutomations, onOpenLocalEnvironmentsSettings } = automation;

  const presentedPageIds = useMemo<ReadonlySet<string>>(() => {
    if (!activeRenderSession || !activeSessionPanelModel) return new Set();
    return collectPanelPresentedPageIds(activeRenderSession, activeSessionPanelModel);
  }, [activeRenderSession, activeSessionPanelModel]);

  const buildPanelGroupTabsForSession = useCallback(
    (session: ProjectSession, model: SessionPanelRenderModel): PanelGroupTabsByPanel => {
      void terminalSessionVersion;
      const makeItem = (tab: ProjectSessionRenderableTab): AppShellTabItem => {
        const transientPanelTab = isTransientPanelTab(tab);
        const durableImageEditorTab = !transientPanelTab && tab.kind === "image_editor";
        const title =
          !transientPanelTab && tab.kind === "terminal" && "terminalSessionId" in tab.config
            ? terminalSessionStore.resolveTitle(
                tab.config.terminalSessionId,
                tab.title,
                resolveTerminalTabIndex(session, tab),
              )
            : tab.title;
        const pageStageProject =
          !transientPanelTab && tab.kind === "page_stage"
            ? projects.find(
                (project) =>
                  tab.config.accessContext.kind === "project" &&
                  project.id === tab.config.accessContext.projectId,
              )
            : undefined;
        const pageStageTitleSource =
          !transientPanelTab && tab.kind === "page_stage" && pageStageProject
            ? pageTitleStore.createSource(
                makePageTitleResourceKey(pageStageProject.libraryId, tab.config.pageId),
                title,
              )
            : undefined;
        const chromeContext = resolveProjectTargetTabChromeContext(tab, session, projects);
        const filesIcon =
          !transientPanelTab && tab.kind === "files"
            ? resolveFileResourceIcon("path" in tab.config ? tab.config.path : undefined)
            : null;
        const browserTabSnapshot =
          !transientPanelTab && tab.kind === "browser"
            ? browserTabSnapshotByKey.get(
                makeBrowserSidebarTabKey({
                  browserConversationId: session.id,
                  browserViewScopeId: surface.browserViewScopeId,
                  browserTabId: tab.browserTabId,
                }),
              )
            : undefined;

        return {
          id: tab.id,
          domTabId:
            !transientPanelTab && tab.kind === "review"
              ? "diff"
              : !transientPanelTab && tab.kind === "files" && "path" in tab.config
                ? getWorkspaceFileDomTabId(
                    "hostId" in tab.config ? tab.config.hostId : "local",
                    tab.config.path,
                  )
                : undefined,
          title,
          titleSource: pageStageTitleSource,
          ...(isImageEditorPanelTab(tab)
            ? { tooltip: tab.tooltip }
            : durableImageEditorTab
              ? { tooltip: tab.config.tooltip }
              : chromeContext),
          icon: isSideChatPanelTab(tab)
            ? SidePanelSideChatIcon
            : isMcpAppPanelTab(tab)
              ? ComposerPluginsIcon
              : isPlanPanelTab(tab)
                ? ComposerPlanModeIcon
                : isAutomationPanelTab(tab)
                  ? AutomationsIcon
                  : isBackgroundAgentPanelTab(tab)
                    ? createBackgroundAgentTabIcon(tab.threadId)
                    : isSubagentsPanelTab(tab)
                      ? SubagentGlyphIcon
                      : isProcessOutputPanelTab(tab)
                        ? SidePanelTerminalIcon
                        : isImageEditorPanelTab(tab)
                          ? ImageEditorTabIcon
                          : durableImageEditorTab
                            ? ImageEditorTabIcon
                            : (filesIcon ?? getTabIcon(tab.kind)),
          iconElement:
            !transientPanelTab && tab.kind === "browser" ? (
              <BrowserTabFavicon
                className="icon-xs"
                faviconUrl={browserTabSnapshot?.faviconUrl ?? tab.config.faviconUrl}
                isLoading={browserTabSnapshot?.isLoading ?? false}
                isWaitingForResponse={browserTabSnapshot?.isWaitingForResponse ?? false}
              />
            ) : undefined,
          closable: isPanelTabClosable(tab),
          preview: isImageEditorPanelTab(tab)
            ? tab.preview
            : transientPanelTab
              ? undefined
              : tab.preview,
          pinBehavior: isImageEditorPanelTab(tab) ? tab.pinBehavior : undefined,
          reorderable: transientPanelTab ? false : tab.preview !== true,
          splittable: !transientPanelTab && tab.preview !== true,
          contextMenuItems:
            !transientPanelTab && tab.kind === "browser"
              ? [
                  {
                    id: "browser-new-tab-right",
                    label: "New tab to the right",
                    onSelect: () => void createBrowserTabToRight(tab, false),
                  },
                  {
                    id: "browser-reload",
                    label: "Reload",
                    onSelect: () => reloadBrowserTab(tab),
                  },
                  {
                    id: "browser-duplicate",
                    label: "Duplicate",
                    onSelect: () => void createBrowserTabToRight(tab, true),
                  },
                ]
              : !transientPanelTab && tab.kind === "terminal" && "terminalSessionId" in tab.config
                ? [
                    {
                      id: "terminal-kill",
                      label: "Kill terminal",
                      tone: "destructive",
                      onSelect: () => {
                        terminalSessionStore.kill(tab.config.terminalSessionId);
                      },
                    },
                  ]
                : undefined,
          renderPanel: (_closeTab, panelContext) => {
            if (isSideChatPanelTab(tab)) {
              return (
                <ReviewRouteOpenAdapter activateReviewTab={activateReviewTab}>
                  {({ onOpenTurnDiffReview }) => (
                    <SideChatSessionTab
                      key={`${session.id}:${tab.id}:${tab.stateKey}`}
                      tab={tab}
                      activeSession={session}
                      projects={projects}
                      onRefreshSessions={onRefreshSessions}
                      onRecreateSideChat={() => void recreateSideChatPanelTab(tab.id)}
                      onOpenMcpAppSidePanel={openMcpAppSidePanel}
                      onOpenHooksSettings={onOpenHooksSettings}
                      threadQueueFollowUpsEnabled={threadQueueFollowUpsEnabled}
                      composerEnterBehavior={composerEnterBehavior}
                      onQueueingEnabledChange={onQueueingEnabledChange}
                      onOpenThread={openAttachedThreadSession}
                      onOpenTurnDiffReview={onOpenTurnDiffReview}
                      onOpenTurnDiffFileInSidePanel={openTurnDiffFileInSidePanel}
                      turnDiffHoverPreviewDisabled={model.sidePanelOpen}
                    />
                  )}
                </ReviewRouteOpenAdapter>
              );
            }
            if (isMcpAppPanelTab(tab)) {
              return <McpAppSessionTab key={`${session.id}:${tab.id}:${tab.stateKey}`} tab={tab} />;
            }
            if (isPlanPanelTab(tab)) {
              return (
                <PlanSidePanelTab
                  key={`${session.id}:${tab.id}:${tab.stateKey}`}
                  content={tab.content}
                  cwd={tab.cwd}
                />
              );
            }
            if (isAutomationPanelTab(tab)) {
              return (
                <WorkbenchAutomationSidePanelTab
                  key={`${session.id}:${tab.id}:${tab.stateKey}`}
                  automationId={tab.automationId}
                  createInput={tab.createInput}
                  mode={tab.mode}
                  projects={projects}
                  title={tab.title}
                  updateInput={tab.updateInput}
                  onClose={() => {
                    void closeEphemeralPanelTab(tab.panelId, tab.id);
                  }}
                  onOpenInScheduled={(automationId) => {
                    onOpenAutomations(buildAutomationsPath({ automationId }));
                  }}
                  onOpenLocalEnvironmentsSettings={onOpenLocalEnvironmentsSettings}
                  onSaved={(automationValue: CodexScheduledAutomation) => {
                    panelControllerRef.current.updateAutomationTabsBySession((current) => {
                      const tabs = current[session.id] ?? [];
                      return {
                        ...current,
                        [session.id]: tabs.map((candidate) =>
                          candidate.id === tab.id
                            ? {
                                ...candidate,
                                automationId: automationValue.id,
                                createInput: null,
                                mode: "open",
                                title: automationValue.name,
                                updateInput: null,
                                stateKey: candidate.stateKey + 1,
                              }
                            : candidate,
                        ),
                      };
                    });
                  }}
                  onTitleChange={(titleValue) => {
                    panelControllerRef.current.updateAutomationTabsBySession((current) => {
                      const tabs = current[session.id] ?? [];
                      return {
                        ...current,
                        [session.id]: tabs.map((candidate) =>
                          candidate.id === tab.id ? { ...candidate, title: titleValue } : candidate,
                        ),
                      };
                    });
                  }}
                />
              );
            }
            if (isProcessOutputPanelTab(tab)) {
              return (
                <ProcessOutputPanelTabView
                  key={`${session.id}:${tab.id}:${tab.stateKey}`}
                  tab={tab}
                />
              );
            }
            if (isImageEditorPanelTab(tab)) {
              return (
                <UserAttachmentImageEditorSurface
                  key={`${session.id}:${tab.id}:${tab.stateKey}`}
                  fullWidth={model.rightPanelFullWidth}
                  options={tab.options}
                  onStateChange={(state) => {
                    if (
                      shouldExpandImageEditorPanelForViewChange({
                        panelIsFullWidth: model.rightPanelFullWidth,
                        previousView: tab.options.initialView,
                        view: state.view,
                      })
                    ) {
                      void updateActivePanel("right", {
                        size: {
                          ...model.rightPanel.size,
                          fullWidth: true,
                        },
                      });
                    }
                    panelControllerRef.current.updateImageEditorTabsBySession((current) => {
                      const tabs = current[session.id] ?? [];
                      let changed = false;
                      const nextTabs = tabs.map((candidate) => {
                        if (candidate.id !== tab.id) return candidate;
                        if (
                          candidate.options.initialImageId === state.activeImageId &&
                          candidate.options.initialPlaygroundTool === state.playgroundTool &&
                          candidate.options.initialView === state.view
                        )
                          return candidate;
                        changed = true;
                        return {
                          ...candidate,
                          options: {
                            ...candidate.options,
                            initialImageId: state.activeImageId,
                            initialPlaygroundTool: state.playgroundTool,
                            initialView: state.view,
                          },
                        };
                      });
                      return changed ? { ...current, [session.id]: nextTabs } : current;
                    });
                  }}
                  onTitleChange={(nextTitle: string) => {
                    const title = nextTitle.trim() || tab.options.title;
                    panelControllerRef.current.updateImageEditorTabsBySession((current) => {
                      const tabs = current[session.id] ?? [];
                      const nextTabs = updateImageEditorPanelTabTitle(tabs, tab.id, title);
                      return nextTabs.some((candidate, index) => candidate !== tabs[index])
                        ? { ...current, [session.id]: nextTabs }
                        : current;
                    });
                  }}
                />
              );
            }
            if (durableImageEditorTab) {
              return (
                <UserAttachmentImageEditorSurface
                  key={`${session.id}:${tab.id}:${tab.stateKey}`}
                  fullWidth={model.rightPanelFullWidth}
                  options={restoreNormalizedImageEditorOptions(tab.config, tab.title)}
                  onStateChange={(state) => {
                    if (
                      shouldExpandImageEditorPanelForViewChange({
                        panelIsFullWidth: model.rightPanelFullWidth,
                        previousView: tab.config.initialView,
                        view: state.view,
                      })
                    ) {
                      void updateActivePanel("right", {
                        size: {
                          ...model.rightPanel.size,
                          fullWidth: true,
                        },
                      });
                    }
                    if (
                      tab.config.initialImageId === state.activeImageId &&
                      tab.config.initialPlaygroundTool === state.playgroundTool &&
                      tab.config.initialView === state.view
                    )
                      return;
                    onUpdateSessionViewTab(tab.id, {
                      config: {
                        ...tab.config,
                        initialImageId: state.activeImageId,
                        initialPlaygroundTool: state.playgroundTool,
                        initialView: state.view,
                      },
                    });
                  }}
                  onTitleChange={(nextTitle: string) => {
                    const title = nextTitle.trim() || tab.title;
                    if (title === tab.title) return;
                    onUpdateSessionViewTab(tab.id, { title });
                  }}
                />
              );
            }
            if (isSubagentsPanelTab(tab)) {
              return (
                <ReviewRouteOpenAdapter activateReviewTab={activateReviewTab}>
                  {({ onOpenTurnDiffReview }) => (
                    <SubagentsPanelSessionTab
                      key={`${session.id}:${tab.id}:${tab.stateKey}`}
                      tab={tab}
                      activeSession={session}
                      projects={projects}
                      onRefreshSessions={onRefreshSessions}
                      onOpenMcpAppSidePanel={openMcpAppSidePanel}
                      onOpenHooksSettings={onOpenHooksSettings}
                      threadQueueFollowUpsEnabled={threadQueueFollowUpsEnabled}
                      composerEnterBehavior={composerEnterBehavior}
                      onQueueingEnabledChange={onQueueingEnabledChange}
                      onOpenThread={openAttachedThreadSession}
                      onRouteSubagent={(subagent) =>
                        openSubagentsPanelTab(tab.rootThreadId, subagent)
                      }
                      onOpenTurnDiffReview={onOpenTurnDiffReview}
                      onOpenTurnDiffFileInSidePanel={openTurnDiffFileInSidePanel}
                      turnDiffHoverPreviewDisabled={model.sidePanelOpen}
                    />
                  )}
                </ReviewRouteOpenAdapter>
              );
            }
            if (isBackgroundAgentPanelTab(tab)) {
              return (
                <ReviewRouteOpenAdapter activateReviewTab={activateReviewTab}>
                  {({ onOpenTurnDiffReview }) => (
                    <BackgroundAgentSessionTab
                      key={`${session.id}:${tab.id}:${tab.stateKey}`}
                      tab={tab}
                      activeSession={session}
                      projects={projects}
                      onRefreshSessions={onRefreshSessions}
                      onOpenMcpAppSidePanel={openMcpAppSidePanel}
                      onOpenHooksSettings={onOpenHooksSettings}
                      threadQueueFollowUpsEnabled={threadQueueFollowUpsEnabled}
                      composerEnterBehavior={composerEnterBehavior}
                      onQueueingEnabledChange={onQueueingEnabledChange}
                      onOpenThread={openAttachedThreadSession}
                      onOpenTurnDiffReview={onOpenTurnDiffReview}
                      onOpenTurnDiffFileInSidePanel={openTurnDiffFileInSidePanel}
                      turnDiffHoverPreviewDisabled={model.sidePanelOpen}
                    />
                  )}
                </ReviewRouteOpenAdapter>
              );
            }
            return (
              <WorkbenchTabProjectionPanel
                key={`${session.id}:${tab.id}:${tab.stateKey}`}
                {...surface}
                tab={tab}
                activeSession={session}
                projects={projects}
                relatedChatCandidates={pageStageRelatedChatCandidates}
                presentedPageIds={presentedPageIds}
                onOpenCanvasStage={openCanvasStage}
                onOpenPageTab={openPageTab}
                onOpenPageInNewChat={openPageInNewChat}
                onOpenRelatedChat={openProjectSessionById}
                onLinkPageToChat={linkPageToChat}
                onResolveChatSessionForThread={resolveChatSessionForThread}
                onSendPageToChat={sendPageToChat}
                onOpenFileTab={openWorkspaceFileTab}
                onEnsureDefaultDraftSessionForProject={ensureDefaultDraftSessionForProject}
                onRefreshSessions={onRefreshSessions}
                onCloseTab={closeTab}
                onUpdateTab={onUpdateSessionViewTab}
                {...(tab.kind === "browser"
                  ? {
                      onOpenBrowserTab: (request) => createBrowserTabToRight(tab, false, request),
                    }
                  : {})}
                onCreateTerminalTab={async (panelId, leafId) => {
                  await createManualTab("terminal", panelId, leafId);
                }}
                onOpenThread={async (threadId) => {
                  await openAttachedThreadSessionById(threadId);
                }}
                onTogglePageStageHistoryModal={onTogglePageStageHistoryModal}
                browserBoundsSyncTrigger={browserBoundsSyncTriggerByPanel[tab.panelId]}
                isActivePanelTab={
                  panelContext.active &&
                  (tab.panelId === "right" ? model.sidePanelOpen : model.bottomPanelOpen)
                }
              />
            );
          },
        };
      };

      const buildPanelTabs = (panelId: PanelId) => {
        const panel = session.panels[panelId];
        const leaves = listWorkbenchPanelLeaves(panel.layout);
        const itemsByLeafId: Record<string, AppShellTabItem[]> = {};
        const activeTabIdsByLeafId: Record<string, string | null> = {};

        for (const leaf of leaves) {
          const renderableTabs = model.renderableTabsByPanelLeaf[panelId][leaf.id] ?? [];
          const items = renderableTabs.map(makeItem);
          const presentations = panelTabPresentationRegistry.reconcile(
            makeWorkbenchSessionPanelSlotKey(session.id, panelId, leaf.id),
            items.map((item) => ({
              id: item.id,
              preview: item.preview === true,
            })),
          );
          const presentationIdByTabId = new Map(
            presentations.map((presentation) => [presentation.id, presentation.presentationId]),
          );
          itemsByLeafId[leaf.id] = items.map((item) => ({
            ...item,
            presentationId: presentationIdByTabId.get(item.id),
          }));
          activeTabIdsByLeafId[leaf.id] = model.activeTabIdsByPanelLeaf[panelId][leaf.id] ?? null;
        }

        return { itemsByLeafId, activeTabIdsByLeafId };
      };

      return {
        right: buildPanelTabs("right"),
        bottom: buildPanelTabs("bottom"),
      };
    },
    [
      activateReviewTab,
      browserTabSnapshotByKey,
      presentedPageIds,
      browserBoundsSyncTriggerByPanel,
      closeEphemeralPanelTab,
      closeTab,
      composerEnterBehavior,
      createBrowserTabToRight,
      createManualTab,
      ensureDefaultDraftSessionForProject,
      onOpenAutomations,
      onOpenHooksSettings,
      onOpenLocalEnvironmentsSettings,
      onQueueingEnabledChange,
      onRefreshSessions,
      onTogglePageStageHistoryModal,
      onUpdateSessionViewTab,
      openAttachedThreadSession,
      openAttachedThreadSessionById,
      openCanvasStage,
      openMcpAppSidePanel,
      openPageTab,
      openPageInNewChat,
      openProjectSessionById,
      linkPageToChat,
      resolveChatSessionForThread,
      sendPageToChat,
      openSubagentsPanelTab,
      openTurnDiffFileInSidePanel,
      openWorkspaceFileTab,
      pageStageRelatedChatCandidates,
      pageTitleStore,
      panelTabPresentationRegistry,
      projects,
      recreateSideChatPanelTab,
      reloadBrowserTab,
      surface,
      terminalSessionVersion,
      threadQueueFollowUpsEnabled,
      updateActivePanel,
    ],
  );

  const panelGroupTabs = useMemo<PanelGroupTabsByPanel>(() => {
    if (!activeRenderSession || !activeSessionPanelModel) {
      return {
        right: { itemsByLeafId: {}, activeTabIdsByLeafId: {} },
        bottom: { itemsByLeafId: {}, activeTabIdsByLeafId: {} },
      };
    }
    return buildPanelGroupTabsForSession(activeRenderSession, activeSessionPanelModel);
  }, [activeRenderSession, activeSessionPanelModel, buildPanelGroupTabsForSession]);

  panelGroupTabsRef.current = panelGroupTabs;

  useEffect(() => {
    const nextControllerKeys = new Set<string>();
    if (activeRenderSession) {
      for (const panelId of ["right", "bottom"] as const) {
        for (const leafId of Object.keys(panelGroupTabs[panelId].itemsByLeafId)) {
          nextControllerKeys.add(
            makeWorkbenchSessionPanelSlotKey(activeRenderSession.id, panelId, leafId),
          );
        }
      }
    }
    for (const controllerKey of panelTabPresentationControllerKeysRef.current) {
      if (nextControllerKeys.has(controllerKey)) continue;
      panelTabPresentationRegistry.releaseController(controllerKey);
    }
    panelTabPresentationControllerKeysRef.current = nextControllerKeys;
  }, [
    activeRenderSession,
    panelGroupTabs,
    panelTabPresentationControllerKeysRef,
    panelTabPresentationRegistry,
  ]);

  return {
    panelGroupTabs,
    browserRetentionTabs: activeSessionPanelModel?.browserRetentionTabs ?? [],
    visibleBrowserTabIds: activeSessionPanelModel?.visibleBrowserTabIds ?? new Set<string>(),
  };
}

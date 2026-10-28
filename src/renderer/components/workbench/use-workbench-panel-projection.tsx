import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  lazy,
  type ComponentProps,
  type ComponentType,
  type MutableRefObject,
} from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";
import { type MotionValue } from "motion/react";
import {
  AutomationsIcon,
  SidePanelSideChatIcon,
  SidePanelTerminalIcon,
  ComposerPlanModeIcon,
  PluginsIcon,
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
  updateSideChatPanelTabTitle,
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
import { buildAutomationsPath } from "@/lib/workbench-automations-routes";
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
import { SideChatTabActions } from "./side-chat-tab-actions";
import type { SideChatPanelTab } from "@/lib/workbench-panel-tab-model";

const ScheduledTaskSidePanel = lazy(async () => ({
  default: (await import("@/features/scheduled/scheduled-task-side-panel")).ScheduledTaskSidePanel,
}));

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
  | "startNewChatWithPrompt"
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
  readonly saveSideChat: (tab: SideChatPanelTab) => Promise<void>;
  readonly activeRenderSession: ProjectSession | null;
  readonly activeSessionPanelModel: SessionPanelRenderModel | null;
  readonly projects: Project[];
  readonly pageStageRelatedChatCandidates: SurfaceProps["relatedChatCandidates"];
  readonly pageTitleStore: PageTitleProjectionStore;
  /** The Space Library, whose Pages a Session can also present. */
  readonly currentLibraryId: string | null;
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
    | "onSearchInFiles"
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
    readonly chats: ComponentProps<typeof ScheduledTaskSidePanel>["chats"];
    readonly onOpenAutomations: (path: string) => void;
    readonly onOpenLocalEnvironmentsSettings: ComponentProps<
      typeof ScheduledTaskSidePanel
    >["onOpenLocalEnvironmentsSettings"];
  };
  readonly onTogglePageStageHistoryModal: SurfaceProps["onTogglePageStageHistoryModal"];
  readonly onUpdateSessionViewTab: SurfaceProps["onUpdateTab"];
}

function getTabIcon(kind: WorkbenchTabProjection["kind"]): ComponentType<{ className?: string }> {
  if (kind === "image_editor") return ImageEditorTabIcon;
  return getPanelNewTabAction(kind).Icon;
}

/**
 * Content tabs show only their title. When the content lives outside the Session's Project, its
 * Library or Project location moves to the tooltip and accessible name instead.
 */
function resolveContentLocationTabChrome(
  tab: ProjectSessionRenderableTab,
  activeSession: ProjectSession,
  projects: readonly Project[],
): Pick<AppShellTabItem, "titleLabel" | "renderTooltip"> {
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
  const { routingContext } = tab.config;
  if (routingContext.kind === "project" && routingContext.projectId === activeSession.projectId)
    return {};

  const projectLabel =
    routingContext.kind === "project"
      ? projects.find((project) => project.id === routingContext.projectId)?.name.trim() ||
        routingContext.projectId
      : null;
  const accessibleLocation = projectLabel === null ? "Library" : `${projectLabel} project`;
  const tooltipLocation = projectLabel === null ? "Library" : `Project: ${projectLabel}`;

  return {
    titleLabel: (title) => `${accessibleLocation}, ${title}`,
    renderTooltip: (title) => (
      <div className="flex max-w-80 flex-col gap-0.5">
        <div className="truncate font-medium">{title}</div>
        <div className="truncate text-xs text-token-description-foreground">{tooltipLocation}</div>
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
  saveSideChat,
  activeRenderSession,
  activeSessionPanelModel,
  projects,
  pageStageRelatedChatCandidates,
  pageTitleStore,
  currentLibraryId,
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
    startNewChatWithPrompt,
  } = sessionCommands;
  const { createBrowserTabToRight, reloadBrowserTab } = panelCommands;
  const {
    composerEnterBehavior,
    threadQueueFollowUpsEnabled,
    onOpenHooksSettings,
    onQueueingEnabledChange,
    onRefreshSessions,
  } = conversation;
  const { chats: scheduledChats, onOpenAutomations, onOpenLocalEnvironmentsSettings } = automation;

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
        const pageStageLibraryId =
          !transientPanelTab && tab.kind === "page_stage"
            ? tab.config.routingContext.kind === "library"
              ? currentLibraryId
              : projects.find(
                  (project) =>
                    tab.config.routingContext.kind === "project" &&
                    project.id === tab.config.routingContext.projectId,
                )?.libraryId
            : undefined;
        const pageStageTitleSource =
          !transientPanelTab && tab.kind === "page_stage" && pageStageLibraryId
            ? pageTitleStore.createSource(
                makePageTitleResourceKey(pageStageLibraryId, tab.config.pageId),
                title,
              )
            : undefined;
        const locationChrome = resolveContentLocationTabChrome(tab, session, projects);
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
              : locationChrome),
          icon: isSideChatPanelTab(tab)
            ? SidePanelSideChatIcon
            : isMcpAppPanelTab(tab)
              ? PluginsIcon
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
          actions:
            isSideChatPanelTab(tab) && tab.runtimeSession ? (
              <SideChatTabActions tab={tab} onSave={saveSideChat} />
            ) : undefined,
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
                    iconKey: "newTab",
                    onSelect: () => void createBrowserTabToRight(tab, false),
                  },
                  {
                    id: "browser-reload",
                    label: "Reload",
                    iconKey: "reload",
                    onSelect: () => reloadBrowserTab(tab),
                  },
                  {
                    id: "browser-duplicate",
                    label: "Duplicate",
                    iconKey: "duplicate",
                    onSelect: () => void createBrowserTabToRight(tab, true),
                  },
                ]
              : !transientPanelTab && tab.kind === "terminal" && "terminalSessionId" in tab.config
                ? [
                    {
                      id: "terminal-kill",
                      label: "Kill terminal",
                      iconKey: "trash",
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
                      key={`${session.id}:${tab.id}`}
                      tab={tab}
                      onTitleChange={(title) =>
                        panelControllerRef.current.updateSideChatTabsBySession((current) => {
                          const tabs = current[tab.sessionId];
                          if (!tabs) return current;
                          const updated = updateSideChatPanelTabTitle(tabs, tab.id, title);
                          if (updated === tabs) return current;
                          return { ...current, [tab.sessionId]: updated };
                        })
                      }
                      activeSession={session}
                      projects={projects}
                      onRefreshSessions={onRefreshSessions}
                      onRecreateSideChat={() => void recreateSideChatPanelTab(tab.id)}
                      onOpenMcpAppSidePanel={openMcpAppSidePanel}
                      onOpenHooksSettings={onOpenHooksSettings}
                      onStartNewChatWithPrompt={startNewChatWithPrompt}
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
                <ApplicationSurface key={`${session.id}:${tab.id}:${tab.stateKey}`}>
                  <ScheduledTaskSidePanel
                    automationId={tab.automationId}
                    createInput={tab.createInput}
                    mode={tab.mode}
                    projects={projects}
                    chats={scheduledChats}
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
                            candidate.id === tab.id
                              ? { ...candidate, title: titleValue }
                              : candidate,
                          ),
                        };
                      });
                    }}
                  />
                </ApplicationSurface>
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
                      onStartNewChatWithPrompt={startNewChatWithPrompt}
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
                      onStartNewChatWithPrompt={startNewChatWithPrompt}
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
                onActivateReviewTab={activateReviewTab}
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
      scheduledChats,
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
      startNewChatWithPrompt,
      openWorkspaceFileTab,
      currentLibraryId,
      pageStageRelatedChatCandidates,
      pageTitleStore,
      panelTabPresentationRegistry,
      projects,
      recreateSideChatPanelTab,
      saveSideChat,
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

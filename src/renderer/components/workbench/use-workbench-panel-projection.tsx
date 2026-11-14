import { PluginAppLogo } from "@/features/plugins/view/plugin-logo";
import { SkillCubeIcon } from "@/components/shared/icons/customize-action-icons";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
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
import { restoreNormalizedImageEditorOptions } from "@/lib/content-image";
import { UserAttachmentImageEditorSurface } from "@/features/user-attachment-image-editor";
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
import { omitRecordKey } from "@/lib/utils";
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
  getPanelTabPlacement,
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
import type { Automation, PanelId, Project, WorkbenchTabProjection } from "@/lib/types";
import {
  makeBrowserSidebarTabKey,
  type BrowserSidebarTabSnapshot,
} from "../../../shared/browser-sidebar";
import { listWorkbenchPanelLeaves } from "../../../shared/workbench-panel-layout";
import type { AppShellTabItem } from "./app-shell-tabs";
import { resolveContentTabLocation } from "./content-tab-location";
import { projectContentRoute } from "../../../shared/content-routing-context";
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
import { SideChatSurfacePanel } from "./workbench-side-chat-surface";
import { toast } from "@/components/ui/toast";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { SideChatTabIcon } from "./side-chat-tab-icon";
import type { SideChatPanelTab } from "@/lib/workbench-panel-tab-model";

const AutomationSidePanel = lazy(async () => ({
  default: (await import("@/features/automations/automation-side-panel")).AutomationSidePanel,
}));

type ProjectSession = WorkbenchSessionRenderProjection;
type SurfaceProps = ComponentProps<typeof WorkbenchTabProjectionPanel>;
type PanelLifecycle = Pick<
  ReturnType<typeof useWorkbenchPanelLifecycle>,
  "closeEphemeralPanelTab" | "closeTab" | "updateActivePanel" | "pinPreviewTab"
>;
type PanelOpeners = Pick<
  ReturnType<typeof useWorkbenchPanelOpeners>,
  | "openCanvasStage"
  | "openMcpAppSidePanel"
  | "openPageTab"
  | "openPageFileTab"
  | "openWorkspaceFileTab"
  | "recreateSideChatPanelTab"
  | "retrySideChatCreation"
>;
type SessionCommands = Pick<
  ReturnType<typeof useWorkbenchSessionCommands>,
  | "activateReviewTab"
  | "createManualTab"
  | "ensureDefaultDraftSessionForProject"
  | "openPageInNewChat"
  | "openProjectSessionById"
  | "linkPageToChat"
  | "handOffPageToChat"
  | "resolveChatSessionForThread"
  | "openAttachedThreadSession"
  | "openAttachedThreadSessionById"
  | "sendPageToChat"
  | "openSubagentsPanelTab"
  | "openTurnDiffFileInSidePanel"
  | "startNewChatWithPrompt"
  | "addToChatComposer"
>;
type PanelCommands = Pick<
  ReturnType<typeof useWorkbenchPanelCommandRouter>,
  "createBrowserTabToRight" | "openBrowserTab" | "reloadBrowserTab"
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
    | "onOpenPluginFile"
    | "onOpenPlugins"
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
    readonly chats: ComponentProps<typeof AutomationSidePanel>["chats"];
    readonly onOpenAutomations: (path: string) => void;
    readonly onOpenLocalEnvironmentsSettings: ComponentProps<
      typeof AutomationSidePanel
    >["onOpenLocalEnvironmentsSettings"];
  };
  readonly onTogglePageStageHistoryModal: SurfaceProps["onTogglePageStageHistoryModal"];
  readonly onUpdateSessionViewTab: SurfaceProps["onUpdateTab"];
}

const SIDE_CHAT_DELETE_CONFIRMATION = {
  title: "Delete side chat?",
  description: "Its messages are deleted permanently.",
  confirmLabel: "Delete",
};

function getTabIcon(kind: WorkbenchTabProjection["kind"]): ComponentType<{ className?: string }> {
  if (kind === "plugin_app") return PluginsIcon;
  if (kind === "image_editor") return ImageEditorTabIcon;
  if (kind === "skill") return SkillCubeIcon;
  if (kind === "page_file") return resolveFileResourceIcon();
  return getPanelNewTabAction(kind).Icon;
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

/** A terminal title is addressed by the external-store revision observed by React. */
function readTerminalTabTitle(
  revision: number,
  terminalSessionId: string,
  fallbackTitle: string,
  terminalIndex: number,
): string {
  // React retries a torn observation before commit; retain the durable title meanwhile.
  if (terminalSessionStore.getVersion() !== revision) return fallbackTitle;
  return terminalSessionStore.resolveTitle(terminalSessionId, fallbackTitle, terminalIndex);
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
  const { closeEphemeralPanelTab, closeTab, updateActivePanel, pinPreviewTab } = lifecycle;
  const {
    openCanvasStage,
    openMcpAppSidePanel,
    openPageTab,
    openPageFileTab,
    openWorkspaceFileTab,
    recreateSideChatPanelTab,
    retrySideChatCreation,
  } = openers;
  const {
    activateReviewTab,
    createManualTab,
    ensureDefaultDraftSessionForProject,
    openPageInNewChat,
    openProjectSessionById,
    linkPageToChat,
    handOffPageToChat,
    resolveChatSessionForThread,
    openAttachedThreadSession,
    openAttachedThreadSessionById,
    sendPageToChat,
    openSubagentsPanelTab,
    openTurnDiffFileInSidePanel,
    startNewChatWithPrompt,
    addToChatComposer,
  } = sessionCommands;
  const { createBrowserTabToRight, openBrowserTab, reloadBrowserTab } = panelCommands;
  const {
    composerEnterBehavior,
    threadQueueFollowUpsEnabled,
    onOpenHooksSettings,
    onQueueingEnabledChange,
    onRefreshSessions,
  } = conversation;
  const { chats: automationChats, onOpenAutomations, onOpenLocalEnvironmentsSettings } = automation;

  const deleteSideChat = async (tabId: string, sideChatSessionId: string) => {
    try {
      await agentRuntimeRuntime.deleteSideChat({
        sessionId: sideChatSessionId,
        requestId: createUuidV7(),
      });
    } catch {
      toast.danger("Failed to delete side chat", { id: `side-chat-delete:${sideChatSessionId}` });
      return;
    }
    await closeTab(tabId);
  };

  const presentedPageIds = useMemo<ReadonlySet<string>>(() => {
    if (!activeRenderSession || !activeSessionPanelModel) return new Set();
    return collectPanelPresentedPageIds(activeRenderSession, activeSessionPanelModel);
  }, [activeRenderSession, activeSessionPanelModel]);

  const buildPanelGroupTabsForSession = (
    session: ProjectSession,
    model: SessionPanelRenderModel,
  ): PanelGroupTabsByPanel => {
    const makeItem = (tab: ProjectSessionRenderableTab): AppShellTabItem => {
      const transientPanelTab = isTransientPanelTab(tab);
      const durableImageEditorTab = !transientPanelTab && tab.kind === "image_editor";
      const title =
        !transientPanelTab && tab.kind === "terminal" && "terminalSessionId" in tab.config
          ? readTerminalTabTitle(
              terminalSessionVersion,
              tab.config.terminalSessionId,
              tab.title,
              resolveTerminalTabIndex(session, tab),
            )
          : !transientPanelTab && tab.kind === "page_file"
            ? (tab.config.titleSnapshot ?? tab.config.logicalPath?.split("/").at(-1) ?? "File")
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
      const locationChrome = transientPanelTab
        ? {}
        : resolveContentTabLocation(tab, {
            projects,
            home: session.projectId ? projectContentRoute(session.projectId) : null,
          });
      const filesIcon =
        !transientPanelTab && tab.kind === "files"
          ? resolveFileResourceIcon("path" in tab.config ? tab.config.path : undefined)
          : !transientPanelTab && tab.kind === "page_file"
            ? resolveFileResourceIcon(tab.config.logicalPath ?? tab.config.titleSnapshot)
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
        iconElement: isSideChatPanelTab(tab) ? (
          <SideChatTabIcon sessionId={null} />
        ) : !transientPanelTab && tab.kind === "side_chat" ? (
          <SideChatTabIcon sessionId={tab.config.sessionId} />
        ) : !transientPanelTab && tab.kind === "plugin_app" ? (
          <PluginAppLogo presentation={tab.config.presentation} className="icon-xs" />
        ) : !transientPanelTab && tab.kind === "browser" ? (
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
        placement: getPanelTabPlacement(tab),
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
              : !transientPanelTab && tab.kind === "side_chat"
                ? [
                    {
                      id: "side-chat-delete",
                      label: "Delete side chat",
                      iconKey: "trash",
                      tone: "destructive",
                      confirmation: SIDE_CHAT_DELETE_CONFIRMATION,
                      onSelect: () => void deleteSideChat(tab.id, tab.config.sessionId),
                    },
                  ]
                : undefined,
        renderPanel: (_closeTab, panelContext) => {
          if (isSideChatPanelTab(tab)) {
            const updateSideChatTabs = (update: (tabs: SideChatPanelTab[]) => SideChatPanelTab[]) =>
              controller.updateSideChatTabsBySession((current) => {
                const tabs = current[tab.sessionId];
                if (!tabs) return current;
                const updated = update(tabs);
                return updated === tabs ? current : { ...current, [tab.sessionId]: updated };
              });
            return (
              <ReviewRouteOpenAdapter activateReviewTab={activateReviewTab}>
                {({ onOpenTurnDiffReview }) => (
                  <SideChatSessionTab
                    key={`${session.id}:${tab.id}`}
                    tab={tab}
                    onTitleChange={(title) =>
                      updateSideChatTabs((tabs) => updateSideChatPanelTabTitle(tabs, tab.id, title))
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
                <AutomationSidePanel
                  automationId={tab.automationId}
                  createInput={tab.createInput}
                  mode={tab.mode}
                  projects={projects}
                  chats={automationChats}
                  title={tab.title}
                  updateInput={tab.updateInput}
                  onClose={() => {
                    void closeEphemeralPanelTab(tab.panelId, tab.id);
                  }}
                  onOpenInAutomations={(automationId) => {
                    onOpenAutomations(buildAutomationsPath({ automationId }));
                  }}
                  onOpenLocalEnvironmentsSettings={onOpenLocalEnvironmentsSettings}
                  onSaved={(automationValue: Automation) => {
                    controller.updateAutomationTabsBySession((current) => {
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
                    controller.updateAutomationTabsBySession((current) => {
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
                  controller.updateImageEditorTabsBySession((current) => {
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
                  controller.updateImageEditorTabsBySession((current) => {
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
          if (tab.kind === "side_chat") {
            const sideChatSessionId = tab.config.sessionId;
            return (
              <ReviewRouteOpenAdapter activateReviewTab={activateReviewTab}>
                {({ onOpenTurnDiffReview }) => (
                  <SideChatSurfacePanel
                    key={`${session.id}:${tab.id}`}
                    sideChatSessionId={sideChatSessionId}
                    sourceSession={session}
                    title={tab.title}
                    creation={controller.sideChatCreations[sideChatSessionId] ?? null}
                    projects={projects}
                    composerEnterBehavior={composerEnterBehavior}
                    turnDiffHoverPreviewDisabled={model.sidePanelOpen}
                    onTitleChange={(title) => {
                      if (title.trim() && title !== tab.title)
                        onUpdateSessionViewTab(tab.id, { title });
                    }}
                    onInitialSubmissionSettled={() =>
                      controller.updateSideChatCreations((current) =>
                        omitRecordKey(current, sideChatSessionId),
                      )
                    }
                    onRetry={() => void retrySideChatCreation(sideChatSessionId)}
                    onClose={() => void closeTab(tab.id)}
                    onRefreshSessions={onRefreshSessions}
                    onOpenThread={openAttachedThreadSession}
                    onOpenTurnDiffReview={onOpenTurnDiffReview}
                    onOpenTurnDiffFileInSidePanel={openTurnDiffFileInSidePanel}
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
              onOpenPageFile={openPageFileTab}
              onPinPreviewTab={(panelId, tabId) => void pinPreviewTab(panelId, tabId)}
              onOpenPageTab={openPageTab}
              onOpenPageInNewChat={openPageInNewChat}
              onOpenRelatedChat={openProjectSessionById}
              onLinkPageToChat={linkPageToChat}
              onHandOffPageToChat={handOffPageToChat}
              onResolveChatSessionForThread={resolveChatSessionForThread}
              onSendPageToChat={sendPageToChat}
              onAddToChatComposer={addToChatComposer}
              onOpenFileTab={openWorkspaceFileTab}
              onEnsureDefaultDraftSessionForProject={ensureDefaultDraftSessionForProject}
              onRefreshSessions={onRefreshSessions}
              onCloseTab={closeTab}
              onUpdateTab={onUpdateSessionViewTab}
              {...(tab.kind === "browser"
                ? {
                    onOpenBrowserTab: openBrowserTab,
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
  };

  const panelGroupTabs: PanelGroupTabsByPanel = (() => {
    if (!activeRenderSession || !activeSessionPanelModel) {
      return {
        right: { itemsByLeafId: {}, activeTabIdsByLeafId: {} },
        bottom: { itemsByLeafId: {}, activeTabIdsByLeafId: {} },
      };
    }
    return buildPanelGroupTabsForSession(activeRenderSession, activeSessionPanelModel);
  })();

  useLayoutEffect(() => {
    panelGroupTabsRef.current = panelGroupTabs;
  }, [panelGroupTabs, panelGroupTabsRef]);

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

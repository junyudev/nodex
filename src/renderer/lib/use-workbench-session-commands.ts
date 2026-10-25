import { collectCodexSubagentThreadIds } from "../../shared/codex-subagent-metadata";
import { conversationTurnsWithOverlay } from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  readLocalConversation,
  setLocalConversationComposerIntent,
} from "@/features/local-conversation/local-conversation-store";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import type {
  ThreadStageActions,
  useCodexAppServerControl,
  useConversationSubset,
} from "@/features/local-conversation";
import type { ThreadOpenSubagentPayload } from "@/features/local-conversation/thread-stage-types";
import { CODEX_CLIENT_THREAD_ID_PREFIX } from "../../shared/codex-client-thread";
import { useAgentRuntimeSessionLaunch } from "./use-agent-runtime-session-launch";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { createUuidV7 } from "../../shared/uuid-v7";
import { prepareAgentMessage } from "../../shared/agent-prompt";
import { readPastedTextAttachment } from "./api";
import { agentRuntimePromptImages } from "./agent-runtime-prompt";
import {
  createCommandKeymapState,
  matchesKeyboardEventToCommand,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import { isWorkbenchNewChatShortcutTargetEditable } from "./workbench-panel-shortcut-scope";
import { getDefaultPanelIdForTabKind } from "./workbench-panel-actions";
import {
  resolveLeafIdForPanelTab,
  resolveSessionPanelActiveLeafId,
} from "./workbench-panel-placement";
import {
  makeBackgroundAgentPanelTabId,
  makeProcessOutputPanelTabId,
  makeSubagentsPanelTabId,
  routeDeletedSelectedSubagentsToOverview,
  resolveProcessOutputPanelTitle,
  settlePendingSubagentsPanelTab,
  type BackgroundAgentPanelTab,
  type ProcessOutputPanelTab,
  type ProcessOutputPanelTarget,
  type SubagentsPanelTab,
} from "./workbench-panel-tab-model";
import {
  makeClientTerminalTabId,
  makeWorkbenchTabProjectionDraft,
} from "./workbench-panel-preview";
import { makeWorkbenchSessionPanelSlotKey } from "./workbench-panel-slot-key";
import { buildProcessOutputTargetFromManagerRow } from "./workbench-process-output-target";
import {
  presentWorkbenchSession,
  type WorkbenchSessionRenderProjection,
} from "./workbench-session-presentation";
import type { WorkbenchPanelController } from "./use-workbench-panel-controller";
import type { useWorkbenchPanelLifecycle } from "./use-workbench-panel-lifecycle";
import type { useWorkbenchPanelOpeners } from "./use-workbench-panel-openers";
import type {
  useWorkbenchSessionCatalog,
  WorkbenchSessionPlacement,
} from "./use-workbench-session-catalog";
import type { createThreadScopeIdentityRegistry } from "./workbench-ui-scopes";
import type { CommandMenuMode, CommandMenuOpenRequest } from "./command-palette";
import type {
  ContentSearchDomain,
  ContentSearchOpenRequest,
  ContentSearchOpenSource,
} from "@/features/content-search/content-search-context";
import type { CodexBackgroundTerminalProcessRow } from "./codex-background-terminal-processes";
import { loadPagePromptContext } from "./page-prompt-context";
import {
  sendPageToChatWithRelation,
  type OpenPageInNewChatInput,
  type SendPageToChatInput,
} from "./page-chat-actions";
import { linkPageChat } from "./page-chat-runtime";
import { subscribeCodexEvents } from "./api";
import { queryKeys } from "./query-keys";
import { seedProjectSessionDetail } from "./project-session-query-cache";
import {
  createdThreadResolveInput,
  ensureCreatedThreadSession,
  resolveCreatedThreadTarget,
} from "./codex-created-thread-runtime";
import { prepareCreatedThreadNavigation } from "./created-thread-navigation";
import type { WorkbenchSceneNavigator } from "./workbench-scene-navigator";
import type {
  CodexCollaborationModeKind,
  CodexComposerIntent,
  CodexEvent,
  PanelId,
  Project,
  ProjectSession as ProjectSessionDomain,
  WorkbenchTabCreateInput,
  WorkbenchTabProjection,
} from "./types";
import { isAgentExecutionThreadId } from "../../shared/agent-runtime-api";
import { readCodexThreadSummary } from "./codex-thread-summary";

function isResidentSubagentDescendant(
  rootThreadId: string,
  threadId: string,
  hostId: string | null,
): boolean {
  const seen = new Set<string>();
  let current: string | null = threadId;
  while (current && !seen.has(current)) {
    if (current === rootThreadId) return true;
    seen.add(current);
    current = readLocalConversation(current, hostId)?.source?.parentThreadId ?? null;
  }
  const parent = readLocalConversation(rootThreadId, hostId);
  return collectCodexSubagentThreadIds(conversationTurnsWithOverlay(parent?.canonicalState)).has(
    threadId,
  );
}

type ProjectSession = WorkbenchSessionRenderProjection;
type PanelLifecycle = Pick<
  ReturnType<typeof useWorkbenchPanelLifecycle>,
  "ensureActivePanelOpenWithoutRefresh" | "setActivePanelTab"
>;
type PanelOpeners = Pick<ReturnType<typeof useWorkbenchPanelOpeners>, "openWorkspaceFileTab">;

interface WorkbenchSessionCommandsInput {
  readonly activeProject: Project | null;
  readonly activeProjectId: string | null;
  readonly activeSession: ProjectSession | null;
  readonly projects: readonly Project[];
  readonly sessionsByProject: Record<string, ProjectSession[]>;
  readonly projectlessSessions: readonly ProjectSession[];
  readonly knownSessions: readonly ProjectSession[];
  readonly catalog: ReturnType<typeof useWorkbenchSessionCatalog>;
  readonly controller: WorkbenchPanelController;
  readonly lifecycle: PanelLifecycle;
  readonly panelOpeners: PanelOpeners;
  readonly createSessionViewTab: (
    input: WorkbenchTabCreateInput,
  ) => Promise<WorkbenchTabProjection | null>;
  readonly sceneNavigator: WorkbenchSceneNavigator;
  readonly codexControl: ReturnType<typeof useCodexAppServerControl>;
  readonly processManagerConversationsById: ReturnType<typeof useConversationSubset>;
  readonly threadScopeIdentityRegistry: ReturnType<typeof createThreadScopeIdentityRegistry>;
  readonly selectSession: (
    session: ProjectSessionDomain | ProjectSession,
    placement?: WorkbenchSessionPlacement,
  ) => void;
  readonly archiveSession: (
    session: ProjectSession,
    options?: { readonly showToast?: boolean },
  ) => Promise<boolean>;
  readonly toggleSessionPin: (session: ProjectSession) => Promise<void>;
  readonly refreshProjectSessions: (projectId: string | null) => Promise<unknown>;
  readonly resolveForkLocalEnvironmentConfigPath: (
    workspaceRoot: string | null | undefined,
  ) => Promise<string | null>;
  readonly closePendingWorktreeRoute: () => void;
  readonly setPendingWorktreeClientThreadId: (
    clientThreadId: string | null,
    expectedHostId?: string,
  ) => void;
  readonly setSettingsPath: (path: string | null) => void;
  readonly setAutomationsPath: (path: string | null) => void;
  readonly onOpenProjectSessionInNewWindow?: (session: ProjectSession) => Promise<void>;
  readonly windowSessionId: string;
  readonly commandKeymapState?: CommandKeymapState | null;
  readonly setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>;
  readonly setCommandPaletteOpenRequest: Dispatch<
    SetStateAction<{
      tick: number;
      mode: CommandMenuMode;
      initialQuery: string | undefined;
    }>
  >;
  readonly setCommandContentSearchOpenRequest: Dispatch<
    SetStateAction<ContentSearchOpenRequest | null>
  >;
  readonly setLocalEnvironmentSettingsInitial: Dispatch<
    SetStateAction<{
      projectId: string | null;
      configPath: string | null;
    } | null>
  >;
  readonly setNewThreadComposerIntentsBySessionId: Dispatch<
    SetStateAction<Record<string, CodexComposerIntent>>
  >;
  readonly setProcessManagerOpen: Dispatch<SetStateAction<boolean>>;
}

/**
 * Routes Session-scoped user intents across Catalog, Codex, panel, process,
 * route, and command-menu owner ports without copying their state.
 */
export function useWorkbenchSessionCommands({
  activeProject,
  activeProjectId,
  activeSession,
  projects,
  sessionsByProject,
  projectlessSessions,
  knownSessions,
  catalog: sessionCatalog,
  controller,
  lifecycle,
  panelOpeners,
  createSessionViewTab,
  sceneNavigator,
  codexControl: workbenchCodexControl,
  processManagerConversationsById,
  threadScopeIdentityRegistry,
  selectSession,
  archiveSession,
  toggleSessionPin,
  refreshProjectSessions,
  resolveForkLocalEnvironmentConfigPath,
  closePendingWorktreeRoute,
  setPendingWorktreeClientThreadId,
  setSettingsPath,
  setAutomationsPath,
  onOpenProjectSessionInNewWindow,
  windowSessionId,
  commandKeymapState,
  setCommandPaletteOpen,
  setCommandPaletteOpenRequest,
  setCommandContentSearchOpenRequest,
  setLocalEnvironmentSettingsInitial,
  setNewThreadComposerIntentsBySessionId,
  setProcessManagerOpen,
}: WorkbenchSessionCommandsInput) {
  const queryClient = useQueryClient();
  const launchAgentRuntimeSession = useAgentRuntimeSessionLaunch();
  const panelControllerRef = useRef(controller);
  panelControllerRef.current = controller;
  const subagentSelectionRequestRef = useRef(0);
  const runtimeNavigationRequestRef = useRef(0);
  const { pendingProcessOutputOpen } = controller;
  const { ensureActivePanelOpenWithoutRefresh, setActivePanelTab } = lifecycle;
  const { openWorkspaceFileTab } = panelOpeners;
  const pageOpenInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const pageSendInFlightRef = useRef<Map<string, Promise<void>>>(new Map());

  const onThreadDeleted = useEffectEvent(
    (event: Extract<CodexEvent, { type: "threadDeleted" }>) => {
      const sessionHostIds = new Map(
        knownSessions.map((session) => [session.id, session.thread?.executionHostId]),
      );
      panelControllerRef.current.updateBackgroundAgentTabsBySession((current) =>
        routeDeletedSelectedSubagentsToOverview(current, event, sessionHostIds),
      );
    },
  );

  useEffect(
    () =>
      subscribeCodexEvents((event) => {
        if (event.type !== "threadDeleted") return;
        onThreadDeleted(event);
      }),
    [],
  );

  const ensureDefaultDraftSessionForProject = useCallback(
    async (projectId: string | null, options?: { select?: boolean }) => {
      const shouldSelect = options?.select !== false;
      const presentation = await sessionCatalog.ensureDefaultDraft(projectId);
      const projected = presentWorkbenchSession(presentation);
      if (shouldSelect) selectSession(projected);
      return projected;
    },
    [selectSession, sessionCatalog],
  );

  const openProjectSessionById = useCallback(
    async (sessionId: string): Promise<void> => {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) throw new Error("Chat ID is required");
      const known = knownSessions.find((session) => session.id === normalizedSessionId);
      if (known) {
        selectSession(known);
        return;
      }
      const session = await sessionCatalog.prefetch(normalizedSessionId);
      if (!session || session.archived) throw new Error("This linked chat is no longer available");
      selectSession(session);
    },
    [knownSessions, selectSession, sessionCatalog],
  );

  const resolveChatSessionById = useCallback(
    async (sessionId: string): Promise<ProjectSessionDomain | ProjectSession> => {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) throw new Error("Chat ID is required");
      const known = knownSessions.find((session) => session.id === normalizedSessionId);
      if (known && !known.archived) return known;
      const loaded = await sessionCatalog.prefetch(normalizedSessionId);
      if (!loaded || loaded.archived) throw new Error("This chat is no longer available");
      return loaded;
    },
    [knownSessions, sessionCatalog],
  );

  const resolveChatSessionForThread = useCallback(
    async (threadId: string): Promise<ProjectSessionDomain | ProjectSession> => {
      const normalizedThreadId = threadId.trim();
      if (!normalizedThreadId) throw new Error("Chat thread ID is required");
      const known = knownSessions.find(
        (session) =>
          (session.executionRef?.threadId ?? session.thread?.threadId) === normalizedThreadId &&
          !session.archived,
      );
      if (known) return known;
      const materialized = await sessionCatalog.ensureThreadSession(normalizedThreadId);
      if (!materialized || materialized.archived) {
        throw new Error("This chat is no longer available");
      }
      return materialized;
    },
    [knownSessions, sessionCatalog],
  );

  const linkPageToChat = useCallback(
    async (input: {
      readonly pageAccessProjectId: string;
      readonly pageId: string;
      readonly sessionId: string;
    }): Promise<void> => {
      await linkPageChat(input.sessionId, {
        pageAccessProjectId: input.pageAccessProjectId,
        pageId: input.pageId,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pageChats.all() });
    },
    [queryClient],
  );

  const openPageInNewChat = useCallback(
    async (input: OpenPageInNewChatInput): Promise<void> => {
      const operationKey = `${input.projectId}:${input.pageId}`;
      const existing = pageOpenInFlightRef.current.get(operationKey);
      if (existing) {
        await existing;
        return;
      }

      const operation = (async () => {
        const fallbackTitle = input.titleSnapshot?.trim() || "New chat";
        let presentation: Awaited<ReturnType<typeof sessionCatalog.createOrdinarySession>>;
        try {
          presentation = await sessionCatalog.createOrdinarySession(
            input.projectId,
            fallbackTitle,
            [input.pageId],
          );
        } catch (error) {
          toast.danger(
            error instanceof Error ? error.message : "Page could not be opened in a new chat",
            { id: `open-page-in-new-chat:${operationKey}` },
          );
          return;
        }

        try {
          const result = await sceneNavigator.presentPanelSurface({
            owner: { kind: "session", sessionId: presentation.domain.id },
            request: {
              kind: "page_stage",
              config: {
                routingContext: { kind: "project", projectId: input.projectId },
                pageId: input.pageId,
                ...(input.titleSnapshot ? { titleSnapshot: input.titleSnapshot } : {}),
              },
              titleSnapshot: input.titleSnapshot,
            },
            target: { panelId: "right" },
            mode: "durable",
            navigation: "select-owner",
          });
          if (result.status !== "presented") {
            throw new Error(result.reason || "Page could not be opened in a new chat");
          }

          const projected = presentWorkbenchSession(presentation);
          panelControllerRef.current.durable.patchPanel(projected, "right", {
            collapsed: false,
            size: {
              ...projected.panels.right.size,
              fullWidth: false,
            },
          });
          toast.success("Opened Page in new chat", {
            id: `open-page-in-new-chat:${operationKey}`,
          });
        } catch (error) {
          toast.danger(
            error instanceof Error
              ? `Chat was created, but the Page could not be presented: ${error.message}`
              : "Chat was created, but the Page could not be presented",
            { id: `open-page-in-new-chat:${operationKey}` },
          );
        }
      })().finally(() => {
        if (pageOpenInFlightRef.current.get(operationKey) === operation) {
          pageOpenInFlightRef.current.delete(operationKey);
        }
      });
      pageOpenInFlightRef.current.set(operationKey, operation);
      await operation;
    },
    [sceneNavigator, sessionCatalog],
  );

  const sendPageToChat = useCallback(
    async (input: SendPageToChatInput): Promise<void> => {
      const targetKey =
        input.target.kind === "thread"
          ? `thread:${input.target.threadId}`
          : `new-thread:${input.target.sessionId ?? "project"}`;
      const operationKey = `${input.projectId}:${input.pageId}:${targetKey}`;
      const existing = pageSendInFlightRef.current.get(operationKey);
      if (existing) {
        await existing;
        return;
      }

      const operation = (async () => {
        await sendPageToChatWithRelation(input, {
          loadPageContext: loadPagePromptContext,
          resolveSessionById: resolveChatSessionById,
          resolveSessionForThread: resolveChatSessionForThread,
          ensureDefaultSession: async (projectId) =>
            (await sessionCatalog.ensureDefaultDraft(projectId)).domain,
          linkPage: linkPageToChat,
          startTurn: async ({ threadId, context }) => {
            const session = await resolveChatSessionForThread(threadId);
            if (!session.executionRef) throw new Error("This chat has no Agent Runtime execution");
            const prepared = await prepareAgentMessage(
              context.promptInput.text,
              context.promptInput,
              (file) => readPastedTextAttachment({ file }),
              { images: true, agentConfigs: true },
            );
            await agentRuntimeRuntime.message({
              sessionId: session.id,
              threadId,
              message: {
                messageId: createUuidV7(),
                ...prepared,
                images: agentRuntimePromptImages(context.promptInput),
                ...(context.promptInput.agentConfigs !== undefined
                  ? { agentConfigs: context.promptInput.agentConfigs }
                  : {}),
              },
            });
          },
          startThread: async ({ projectId, sessionId, context }) => {
            const session = await resolveChatSessionById(sessionId);
            if (session.executionRef) {
              const prepared = await prepareAgentMessage(
                context.promptInput.text,
                context.promptInput,
                (file) => readPastedTextAttachment({ file }),
                { images: true, agentConfigs: true },
              );
              await agentRuntimeRuntime.message({
                sessionId,
                message: {
                  messageId: createUuidV7(),
                  ...prepared,
                  images: agentRuntimePromptImages(context.promptInput),
                  ...(context.promptInput.agentConfigs !== undefined
                    ? { agentConfigs: context.promptInput.agentConfigs }
                    : {}),
                },
              });
            } else
              await launchAgentRuntimeSession({
                projectId,
                sessionId,
                prompt: context.promptInput.text,
                promptInput: context.promptInput,
              });
            return { kind: "started" };
          },
          refreshSessions: async (projectId) => {
            await refreshProjectSessions(projectId);
          },
        });

        toast.success(
          input.target.kind === "thread" ? "Sent Page to chat" : "Sent Page to new chat",
          { id: `send-page-to-chat:${operationKey}` },
        );
      })().finally(() => {
        if (pageSendInFlightRef.current.get(operationKey) === operation) {
          pageSendInFlightRef.current.delete(operationKey);
        }
      });
      pageSendInFlightRef.current.set(operationKey, operation);
      await operation;
    },
    [
      linkPageToChat,
      refreshProjectSessions,
      resolveChatSessionById,
      resolveChatSessionForThread,
      sessionCatalog,
      launchAgentRuntimeSession,
    ],
  );

  const startNewChatInProject = useCallback(
    async (projectId: string | null, options?: { focusComposer?: boolean }) => {
      const session = await ensureDefaultDraftSessionForProject(projectId);
      panelControllerRef.current.durable.patchPanel(session, "right", {
        size: {
          ...session.panels.right.size,
          fullWidth: false,
        },
      });
      if (!options?.focusComposer) return;
      setNewThreadComposerIntentsBySessionId((current) => ({
        ...current,
        [session.id]: {
          prompt: "",
          attachmentMode: "append",
          focusNonce: Date.now(),
        },
      }));
    },
    [ensureDefaultDraftSessionForProject, setNewThreadComposerIntentsBySessionId],
  );

  const prefillNewChat = useCallback(
    async (
      input: Parameters<NonNullable<ThreadStageActions["onStartNewChatWithPrompt"]>>[0],
      options?: { revealComposer?: boolean },
    ) => {
      if (input.isSourceCurrent?.() === false) return null;
      const session = await ensureDefaultDraftSessionForProject(input.projectId, { select: false });
      if (input.isSourceCurrent?.() === false) return null;
      selectSession(session);
      setSettingsPath(null);
      setAutomationsPath(null);
      setNewThreadComposerIntentsBySessionId((current) => ({
        ...current,
        [session.id]: {
          prompt: input.prompt,
          ...(input.prompt.length === 0 ? { clearText: true } : {}),
          focusNonce: Date.now(),
        },
      }));
      if (options?.revealComposer)
        panelControllerRef.current.durable.patchPanel(session, "right", {
          size: { ...session.panels.right.size, fullWidth: false },
        });
      return session;
    },
    [
      ensureDefaultDraftSessionForProject,
      selectSession,
      setAutomationsPath,
      setNewThreadComposerIntentsBySessionId,
      setSettingsPath,
    ],
  );

  const startNewChatWithPrompt = useCallback(
    async (input: Parameters<NonNullable<ThreadStageActions["onStartNewChatWithPrompt"]>>[0]) => {
      await prefillNewChat(input, { revealComposer: true });
    },
    [prefillNewChat],
  );

  const openSidebarCommandPalette = useCallback(() => {
    setCommandPaletteOpenRequest((current) => ({
      tick: current.tick + 1,
      mode: "pages",
      initialQuery: undefined,
    }));
    setCommandPaletteOpen(true);
  }, [setCommandPaletteOpen, setCommandPaletteOpenRequest]);

  const openCommandPalette = useCallback(
    (request?: CommandMenuOpenRequest) => {
      setCommandPaletteOpenRequest((current) => ({
        tick: current.tick + 1,
        mode: request?.mode ?? "root",
        initialQuery: request?.query,
      }));
      setCommandPaletteOpen(true);
    },
    [setCommandPaletteOpen, setCommandPaletteOpenRequest],
  );

  const requestContentSearchOpen = useCallback(
    (source: ContentSearchOpenSource, preferredDomain?: ContentSearchDomain) => {
      setCommandContentSearchOpenRequest((current) => ({
        tick: (current?.tick ?? 0) + 1,
        source,
        preferredDomain,
      }));
    },
    [setCommandContentSearchOpenRequest],
  );

  const showUnavailableProduct = useCallback((label: string) => {
    toast.info(`${label} is not available in Nodex yet.`, {
      id: `${label.toLowerCase()}-unavailable`,
    });
  }, []);

  useEffect(() => {
    const isMacPlatformForShortcut =
      typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
    const shortcutState =
      commandKeymapState ??
      createCommandKeymapState({}, isMacPlatformForShortcut ? "macOS" : "windows");

    const onKeyDown = (event: KeyboardEvent) => {
      if (isWorkbenchNewChatShortcutTargetEditable(event.target)) return;

      if (matchesKeyboardEventToCommand(event, shortcutState, "archiveThread")) {
        if (!activeSession) return;
        event.preventDefault();
        void archiveSession(activeSession);
        return;
      }

      if (matchesKeyboardEventToCommand(event, shortcutState, "newThread")) {
        event.preventDefault();
        void startNewChatInProject(activeProjectId);
        return;
      }

      if (matchesKeyboardEventToCommand(event, shortcutState, "openProcessManager")) {
        event.preventDefault();
        setProcessManagerOpen(true);
        return;
      }

      if (matchesKeyboardEventToCommand(event, shortcutState, "openThreadInNewWindow")) {
        if (!activeSession) return;
        event.preventDefault();
        void onOpenProjectSessionInNewWindow?.(activeSession);
        return;
      }

      if (matchesKeyboardEventToCommand(event, shortcutState, "quickChat")) {
        event.preventDefault();
        void startNewChatInProject(activeProjectId);
        return;
      }

      if (matchesKeyboardEventToCommand(event, shortcutState, "toggleThreadPin")) {
        if (!activeSession) return;
        event.preventDefault();
        void toggleSessionPin(activeSession);
        return;
      }

      if (matchesKeyboardEventToCommand(event, shortcutState, "focusBrowserAddressBar")) {
        const input = document.querySelector<HTMLInputElement>(
          "[data-browser-sidebar-address-input='true']",
        );
        if (!input) return;
        event.preventDefault();
        input.focus();
        input.select();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    activeProjectId,
    activeSession,
    archiveSession,
    commandKeymapState,
    onOpenProjectSessionInNewWindow,
    startNewChatInProject,
    setProcessManagerOpen,
    toggleSessionPin,
  ]);

  const createManualTab = useCallback(
    async (
      kind: Exclude<WorkbenchTabProjection["kind"], "db_view">,
      targetPanelId?: PanelId,
      targetLeafId?: string,
    ): Promise<boolean> => {
      if (!activeSession) return false;
      if (kind === "review" && !activeSession.executionRef && !activeSession.thread) return false;
      const panelId = targetPanelId ?? getDefaultPanelIdForTabKind(kind);
      if (kind === "review") {
        const existingReviewTab = activeSession.tabs.find((tab) => tab.kind === "review");
        if (existingReviewTab) {
          await setActivePanelTab(existingReviewTab.panelId, existingReviewTab.id, {
            leafId: resolveLeafIdForPanelTab(
              activeSession,
              existingReviewTab.panelId,
              existingReviewTab.id,
            ),
            openPanel: true,
          });
          return true;
        }
      }
      const draft = makeWorkbenchTabProjectionDraft(activeSession, kind);
      if (!draft) return false;

      const createInput: WorkbenchTabCreateInput = {
        sessionId: activeSession.id,
        panelId,
        ...(targetLeafId ? { targetLeafId } : {}),
        ...(draft.kind === "terminal" && "terminalSessionId" in draft.config
          ? { clientTabId: makeClientTerminalTabId(draft.config.terminalSessionId) }
          : {}),
        ...draft,
      };

      const createdTab = await createSessionViewTab(createInput);
      if (!createdTab) return false;
      await ensureActivePanelOpenWithoutRefresh(panelId);
      return true;
    },
    [activeSession, createSessionViewTab, ensureActivePanelOpenWithoutRefresh, setActivePanelTab],
  );
  const activateReviewTab = useCallback(
    () => createManualTab("review", "right"),
    [createManualTab],
  );

  const openSubagentsPanelTab = useCallback(
    async (
      rootThreadId: string,
      subagent: ThreadOpenSubagentPayload | null = null,
      sourceSession: ProjectSession | null = activeSession,
      observed?: Awaited<ReturnType<typeof agentRuntimeRuntime.inspect>>,
    ): Promise<boolean> => {
      if (!sourceSession || (!sourceSession.executionRef && sourceSession.projectId === null))
        return false;
      const projectId = sourceSession.projectId;
      const normalizedRootThreadId = rootThreadId.trim();
      const selectedThreadId = subagent?.conversationId.trim() || null;
      if (!normalizedRootThreadId || selectedThreadId === normalizedRootThreadId) return false;
      const panelId = "right" as const;
      const leafId = resolveSessionPanelActiveLeafId(sourceSession, panelId);
      const tabId = makeSubagentsPanelTabId(normalizedRootThreadId);
      const requestSequence = ++subagentSelectionRequestRef.current;
      const routeTab = (input: {
        selectedThreadId: string | null;
        selectedDisplayName: string | null;
        selectedCanInteract: boolean;
        selectedHydration: SubagentsPanelTab["selectedHydration"];
      }): SubagentsPanelTab => ({
        subagentsPanel: true,
        id: tabId,
        sessionId: sourceSession.id,
        projectId,
        panelId,
        leafId,
        rootThreadId: normalizedRootThreadId,
        ...input,
        title: "Subagents",
        stateKey: Date.now(),
      });
      const overviewTab = () =>
        routeTab({
          selectedThreadId: null,
          selectedDisplayName: null,
          selectedCanInteract: false,
          selectedHydration: null,
        });
      const settlePendingRoute = (tab: SubagentsPanelTab): void => {
        panelControllerRef.current.updateBackgroundAgentTabsBySession((current) =>
          settlePendingSubagentsPanelTab(current, {
            sessionId: sourceSession.id,
            tabId,
            requestId: requestSequence,
            tab,
          }),
        );
      };

      panelControllerRef.current.upsertEphemeralTab(
        routeTab({
          selectedThreadId,
          selectedDisplayName: subagent?.displayName.trim() || null,
          selectedCanInteract: false,
          selectedHydration: selectedThreadId
            ? {
                status: "pending",
                requestId: requestSequence,
                showLoading: sourceSession.executionRef
                  ? true
                  : !readLocalConversation(
                      normalizedRootThreadId,
                      sourceSession.thread?.executionHostId,
                    )?.turns.length ||
                    !isResidentSubagentDescendant(
                      normalizedRootThreadId,
                      selectedThreadId,
                      sourceSession.thread?.executionHostId ?? null,
                    ),
              }
            : null,
        }),
      );
      panelControllerRef.current.updatePanelCollapsedOverrides((current) => ({
        ...current,
        [makeWorkbenchSessionPanelSlotKey(sourceSession.id, panelId)]: false,
      }));
      const panelOpen =
        sourceSession.id === activeSession?.id
          ? ensureActivePanelOpenWithoutRefresh(panelId).catch(() => undefined)
          : Promise.resolve();
      if (!selectedThreadId) {
        await panelOpen;
        return true;
      }

      try {
        if (sourceSession.executionRef) {
          const inspected =
            observed ??
            (await agentRuntimeRuntime.inspect({
              sessionId: sourceSession.id,
              threadId: selectedThreadId,
            }));
          if (requestSequence !== subagentSelectionRequestRef.current) return true;
          if (
            inspected.sessionId !== sourceSession.id ||
            inspected.threadId !== selectedThreadId ||
            inspected.rootThreadId !== normalizedRootThreadId
          )
            throw new Error("Subagent does not belong to this conversation");
          settlePendingRoute(
            routeTab({
              selectedThreadId,
              selectedDisplayName: subagent?.displayName.trim() || inspected.thread.title,
              // A child the provider spawned itself is followed, never continued from here.
              selectedCanInteract:
                inspected.thread.archivedAt === null &&
                inspected.thread.creationSource !== "provider",
              selectedHydration: {
                status: "ready",
                revision: 0,
                fidelity: "metadata",
                checkpoint: null,
              },
            }),
          );
          await panelOpen;
          return true;
        }
        const hydrated = await workbenchCodexControl.hydrateSelectedSubagent({
          rootThreadId: normalizedRootThreadId,
          threadId: selectedThreadId,
          expectedHostId: sourceSession.thread?.executionHostId,
        });
        if (requestSequence !== subagentSelectionRequestRef.current) return true;
        if (
          hydrated.outcome !== "ready" ||
          hydrated.rootThreadId !== normalizedRootThreadId ||
          hydrated.threadId !== selectedThreadId
        ) {
          settlePendingRoute(overviewTab());
          toast.info(hydrated.errorMessage ?? "That subagent is not available");
          await panelOpen;
          return false;
        }
        settlePendingRoute(
          routeTab({
            selectedThreadId,
            selectedDisplayName: subagent?.displayName.trim() || selectedThreadId,
            selectedCanInteract: hydrated.canInteract,
            selectedHydration: {
              status: "ready",
              revision: hydrated.revision,
              fidelity: hydrated.fidelity,
              checkpoint: hydrated.checkpoint,
            },
          }),
        );
        await panelOpen;
        return true;
      } catch {
        if (requestSequence !== subagentSelectionRequestRef.current) return true;
        settlePendingRoute(overviewTab());
        toast.danger("Failed to open subagents");
        await panelOpen;
        return false;
      }
    },
    [activeSession, ensureActivePanelOpenWithoutRefresh, workbenchCodexControl],
  );

  const openBackgroundAgentTab = useCallback(
    async (
      rootThreadId: string,
      subagent: ThreadOpenSubagentPayload,
      sourceSession: ProjectSession | null = activeSession,
    ): Promise<boolean> => {
      if (!sourceSession || sourceSession.projectId === null) return false;
      if (sourceSession.executionRef)
        return openSubagentsPanelTab(rootThreadId, subagent, sourceSession);
      const hydrated = await workbenchCodexControl.hydrateSelectedSubagent(
        {
          rootThreadId,
          threadId: subagent.conversationId,
          expectedHostId: sourceSession.thread?.executionHostId,
        },
        { resume: false },
      );
      if (hydrated.outcome !== "ready") {
        toast.info(hydrated.errorMessage ?? "That subagent is not available");
        return false;
      }
      if (!hydrated.canInteract)
        return openSubagentsPanelTab(
          rootThreadId,
          { ...subagent, canInteract: false },
          sourceSession,
        );
      const tab: BackgroundAgentPanelTab = {
        backgroundAgent: true,
        id: makeBackgroundAgentPanelTabId(subagent.conversationId),
        sessionId: sourceSession.id,
        projectId: sourceSession.projectId,
        panelId: "right",
        leafId: resolveSessionPanelActiveLeafId(sourceSession, "right"),
        threadId: subagent.conversationId,
        title: subagent.displayName,
        stateKey: Date.now(),
        subagent: { ...subagent, canInteract: hydrated.canInteract },
      };
      panelControllerRef.current.upsertEphemeralTab(tab);
      panelControllerRef.current.updatePanelCollapsedOverrides((current) => ({
        ...current,
        [makeWorkbenchSessionPanelSlotKey(sourceSession.id, "right")]: false,
      }));
      if (sourceSession.id === activeSession?.id)
        await ensureActivePanelOpenWithoutRefresh("right");
      return true;
    },
    [
      activeSession,
      workbenchCodexControl,
      openSubagentsPanelTab,
      ensureActivePanelOpenWithoutRefresh,
    ],
  );

  const openAttachedThreadSessionResult = useCallback(
    async (
      threadId: string,
      requested?: Parameters<NonNullable<ThreadStageActions["onOpenThread"]>>[1],
    ): Promise<boolean> => {
      if (requested?.isSourceCurrent?.() === false) return false;
      // A reference names an Agent chat by its execution root Thread; its Session opens it.
      let context = requested;
      if (!requested?.runtimeSessionId && isAgentExecutionThreadId(threadId)) {
        const runtimeSessionId =
          knownSessions.find((session) => session.executionRef?.threadId === threadId)?.id ??
          (await readCodexThreadSummary(threadId))?.sessionId;
        if (!runtimeSessionId) throw new Error("This chat is no longer available");
        context = { ...requested, runtimeSessionId };
      }
      if (context?.runtimeSessionId) {
        const navigationRequest = ++runtimeNavigationRequestRef.current;
        const session = await sessionCatalog.readCurrent(context.runtimeSessionId);
        if (
          navigationRequest !== runtimeNavigationRequestRef.current ||
          context.isSourceCurrent?.() === false
        )
          return false;
        if (!session || session.archived || !session.executionRef)
          throw new Error("Conversation identity changed");
        const inspected = await agentRuntimeRuntime.inspect({ sessionId: session.id, threadId });
        if (
          navigationRequest !== runtimeNavigationRequestRef.current ||
          context.isSourceCurrent?.() === false
        )
          return false;
        if (inspected.rootThreadId !== session.executionRef.threadId)
          throw new Error("Conversation identity changed");
        sessionCatalog.seed(session);
        closePendingWorktreeRoute();
        selectSession(session);
        const projected = presentWorkbenchSession({
          domain: session,
          scene: sessionCatalog.resolveScene(session),
        });
        if (threadId !== inspected.rootThreadId)
          return openSubagentsPanelTab(
            inspected.rootThreadId,
            context.subagent ?? {
              conversationId: threadId,
              displayName: inspected.thread.title,
              agentRole: null,
              diffStats: null,
              spawnModel: inspected.thread.modelSelection.model,
              status: "unknown",
              statusSummary: null,
            },
            projected,
            inspected,
          );
        return true;
      }
      const createdInput = context?.createdTarget
        ? createdThreadResolveInput(context.createdTarget)
        : context?.hostId
          ? { threadId, expectedHostId: context.hostId }
          : null;
      if (context?.createdTarget || context?.hostId) {
        if (!createdInput) return false;
        try {
          const navigation = await prepareCreatedThreadNavigation(createdInput, {
            resolve: resolveCreatedThreadTarget,
            ensureOpen: ensureCreatedThreadSession,
            isCurrent: context.isSourceCurrent,
          });
          if (context.isSourceCurrent?.() === false) return false;
          if (!navigation) return false;
          if (navigation.type === "pending") {
            setSettingsPath(null);
            setLocalEnvironmentSettingsInitial(null);
            setAutomationsPath(null);
            setPendingWorktreeClientThreadId(navigation.clientThreadId, navigation.hostId);
            return true;
          }
          if (navigation.type === "child") {
            const source = context.sourceRoot;
            if (!source || source.hostId !== navigation.resolution.hostId) return false;
            const root = await prepareCreatedThreadNavigation(
              { threadId: source.threadId, expectedHostId: source.hostId },
              {
                resolve: resolveCreatedThreadTarget,
                ensureOpen: ensureCreatedThreadSession,
                isCurrent: context.isSourceCurrent,
              },
            );
            if (context.isSourceCurrent?.() === false) return false;
            if (root?.type !== "session") return false;
            seedProjectSessionDetail(queryClient, root.session);
            const projected = presentWorkbenchSession({
              domain: root.session,
              scene: sessionCatalog.resolveScene(root.session),
            });
            const subagent =
              context.subagent ??
              ({
                conversationId: navigation.resolution.threadId!,
                displayName: "Subagent",
                agentRole: null,
                diffStats: null,
                spawnModel: null,
                status: "unknown",
                statusSummary: null,
              } satisfies ThreadOpenSubagentPayload);
            closePendingWorktreeRoute();
            selectSession(projected);
            return subagent.canInteract
              ? openBackgroundAgentTab(source.threadId, subagent, projected)
              : openSubagentsPanelTab(source.threadId, subagent, projected);
          }
          const { session, resolution } = navigation;
          seedProjectSessionDetail(queryClient, session);
          if (resolution?.clientThreadId) {
            const stableKey = threadScopeIdentityRegistry.resolve({
              clientThreadId: resolution.clientThreadId,
            });
            threadScopeIdentityRegistry.register(stableKey, {
              clientThreadId: resolution.clientThreadId,
              threadId: resolution.threadId,
            });
          }
          closePendingWorktreeRoute();
          selectSession(
            presentWorkbenchSession({
              domain: session,
              scene: sessionCatalog.resolveScene(session),
            }),
          );
          return true;
        } catch {
          if (context.isSourceCurrent?.() === false) return false;
          toast.danger("Failed to open chat");
          return false;
        }
      }
      if (threadId.startsWith(CODEX_CLIENT_THREAD_ID_PREFIX)) {
        setSettingsPath(null);
        setLocalEnvironmentSettingsInitial(null);
        setAutomationsPath(null);
        setPendingWorktreeClientThreadId(threadId);
        return true;
      }
      if (context?.subagent) {
        const rootThreadId = activeSession?.thread?.threadId ?? null;
        if (rootThreadId) {
          return context.subagent.canInteract
            ? openBackgroundAgentTab(rootThreadId, context.subagent)
            : openSubagentsPanelTab(rootThreadId, context.subagent);
        }
      }

      const session =
        knownSessions.find(
          (candidate) =>
            (candidate.executionRef?.threadId ?? candidate.thread?.threadId) === threadId,
        ) ?? null;
      if (session) {
        closePendingWorktreeRoute();
        selectSession(session);
        return true;
      }

      try {
        const ensured = await sessionCatalog.ensureThreadSession(threadId);
        if (!ensured) {
          toast.info("That chat is not available", {
            id: `thread-open-unattached-${threadId}`,
          });
          return false;
        }
        closePendingWorktreeRoute();
        selectSession(ensured);
        return true;
      } catch {
        toast.danger("Failed to open chat");
        return false;
      }
    },
    [
      activeSession?.thread?.threadId,
      closePendingWorktreeRoute,
      knownSessions,
      openSubagentsPanelTab,
      openBackgroundAgentTab,
      selectSession,
      sessionCatalog,
      setAutomationsPath,
      setLocalEnvironmentSettingsInitial,
      setPendingWorktreeClientThreadId,
      setSettingsPath,
      queryClient,
      threadScopeIdentityRegistry,
    ],
  );

  const openAttachedThreadSession = useCallback<ThreadStageActions["onOpenThread"]>(
    async (threadId, context) => {
      await openAttachedThreadSessionResult(threadId, context);
    },
    [openAttachedThreadSessionResult],
  );

  const openResolvedPendingThreadSession = useCallback(
    async (clientThreadId: string, threadId: string, expectedHostId?: string): Promise<boolean> => {
      const resolution = await resolveCreatedThreadTarget({ clientThreadId, expectedHostId });
      if (
        !resolution?.ready ||
        resolution.threadId !== threadId ||
        (expectedHostId !== undefined && resolution.hostId !== expectedHostId)
      )
        return false;
      return openAttachedThreadSessionResult(threadId, {
        createdTarget: { clientThreadId, hostId: resolution.hostId },
      });
    },
    [openAttachedThreadSessionResult],
  );

  const openAttachedThreadSessionById = useCallback(
    async (
      threadId: string,
      context?: Parameters<NonNullable<ThreadStageActions["onOpenThread"]>>[1],
    ) => {
      return await openAttachedThreadSessionResult(threadId, context);
    },
    [openAttachedThreadSessionResult],
  );

  /** Opens a scheduled run or Heartbeat chat without leaving Scheduled. */
  const presentScheduledChat = useCallback(
    async (sessionId: string, scheduledPath: (sessionId: string) => string): Promise<void> => {
      try {
        const session = await resolveChatSessionById(sessionId);
        selectSession(session, { scheduledPath: scheduledPath(session.id) });
      } catch (error) {
        toast.danger("Could not open chat", {
          description: error instanceof Error ? error.message : undefined,
        });
      }
    },
    [resolveChatSessionById, selectSession],
  );

  /** Starts a chat about a scheduled task in its Project and shows it within Scheduled. */
  const replyAboutScheduledTask = useCallback(
    async (input: {
      readonly projectId: string | null;
      readonly prompt: string;
      readonly scheduledPath: (sessionId: string) => string;
    }): Promise<void> => {
      try {
        const session = await ensureDefaultDraftSessionForProject(input.projectId, {
          select: false,
        });
        await launchAgentRuntimeSession({
          projectId: input.projectId,
          sessionId: session.id,
          prompt: input.prompt,
        });
        await refreshProjectSessions(input.projectId);
        selectSession(session, { scheduledPath: input.scheduledPath(session.id) });
      } catch (error) {
        toast.danger("Could not send reply", {
          description: error instanceof Error ? error.message : undefined,
        });
        throw error;
      }
    },
    [
      ensureDefaultDraftSessionForProject,
      refreshProjectSessions,
      selectSession,
      launchAgentRuntimeSession,
    ],
  );

  const openProcessOutputInCurrentSession = useCallback(
    async (target: ProcessOutputPanelTarget): Promise<boolean> => {
      if (!activeSession?.thread || activeSession.thread.threadId !== target.threadId) return false;

      const panelId = "right" as const;
      const leafId = resolveSessionPanelActiveLeafId(activeSession, panelId);
      const tabId = makeProcessOutputPanelTabId(target.threadId, target.itemId);
      const tab: ProcessOutputPanelTab = {
        processOutputPanel: true,
        id: tabId,
        sessionId: activeSession.id,
        projectId: activeSession.projectId,
        panelId,
        leafId,
        threadId: target.threadId,
        turnId: target.turnId ?? null,
        itemId: target.itemId,
        title: resolveProcessOutputPanelTitle(target.command),
        stateKey: Date.now(),
        command: target.command,
        cwd: target.cwd,
        terminalSessionId: target.terminalSessionId ?? null,
      };

      panelControllerRef.current.upsertEphemeralTab(tab);
      panelControllerRef.current.updatePanelCollapsedOverrides((current) => ({
        ...current,
        [makeWorkbenchSessionPanelSlotKey(activeSession.id, panelId)]: false,
      }));
      await ensureActivePanelOpenWithoutRefresh(panelId);
      return true;
    },
    [activeSession, ensureActivePanelOpenWithoutRefresh],
  );

  const openProcessOutputForThread = useCallback(
    async (target: ProcessOutputPanelTarget) => {
      panelControllerRef.current.updatePendingProcessOutputOpen(target);
      await openAttachedThreadSession(target.threadId);
    },
    [openAttachedThreadSession],
  );

  useEffect(() => {
    if (!pendingProcessOutputOpen) return;
    if (
      !activeSession?.thread ||
      activeSession.thread.threadId !== pendingProcessOutputOpen.threadId
    )
      return;

    let cancelled = false;
    void openProcessOutputInCurrentSession(pendingProcessOutputOpen).then((opened) => {
      if (cancelled || !opened) return;
      panelControllerRef.current.updatePendingProcessOutputOpen((current) =>
        current === pendingProcessOutputOpen ? null : current,
      );
    });

    return () => {
      cancelled = true;
    };
  }, [activeSession?.thread, openProcessOutputInCurrentSession, pendingProcessOutputOpen]);

  const openProcessManagerOutput = useCallback(
    (row: CodexBackgroundTerminalProcessRow) => {
      const conversation = processManagerConversationsById[row.threadId] ?? null;
      const target = buildProcessOutputTargetFromManagerRow(row, conversation);
      void openProcessOutputForThread(target);
    },
    [openProcessOutputForThread, processManagerConversationsById],
  );

  const openTurnDiffFileInSidePanel = useCallback<
    NonNullable<ThreadStageActions["onOpenTurnDiffFileInSidePanel"]>
  >(
    async (target) => {
      await openWorkspaceFileTab({
        cwd: target.cwd,
        path: target.path,
        title: target.title,
        panelId: "right",
        workspaceRoot: target.workspaceRoot,
        ...(target.line
          ? {
              location: {
                line: target.line,
                ...(target.column ? { column: target.column } : {}),
                ...(target.endLine ? { endLine: target.endLine } : {}),
                ...(target.endColumn ? { endColumn: target.endColumn } : {}),
              },
            }
          : {}),
      });
    },
    [openWorkspaceFileTab],
  );
  const openSummaryOutputInSidePanel = useCallback<
    NonNullable<ThreadStageActions["onOpenSummaryOutputInSidePanel"]>
  >(
    async (target) => {
      if (!activeSession) return false;
      return await openWorkspaceFileTab({
        cwd: target.cwd,
        path: target.path,
        title: target.title,
        panelId: "right",
        workspaceRoot: target.workspaceRoot,
        ...(target.line
          ? {
              location: {
                line: target.line,
                ...(target.column ? { column: target.column } : {}),
                ...(target.endLine ? { endLine: target.endLine } : {}),
                ...(target.endColumn ? { endColumn: target.endColumn } : {}),
              },
            }
          : {}),
      });
    },
    [activeSession, openWorkspaceFileTab],
  );
  const consumeNewThreadComposerIntent = useCallback(
    (sessionId: string, focusNonce: number) => {
      setNewThreadComposerIntentsBySessionId((current) => {
        const intent = current[sessionId];
        if (!intent || intent.focusNonce !== focusNonce) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    },
    [setNewThreadComposerIntentsBySessionId],
  );

  const forkSessionFromTurn = useCallback(
    async (input: {
      threadId: string;
      turnId: string;
      message: string;
      collaborationMode: CodexCollaborationModeKind;
    }) => {
      const sourceSession = [
        ...Object.values(sessionsByProject).flat(),
        ...projectlessSessions,
      ].find(
        (candidate) =>
          (candidate.executionRef?.threadId ?? candidate.thread?.threadId) === input.threadId,
      );
      if (!sourceSession) {
        throw new Error("This thread is not attached to a project session");
      }

      const result = await sessionCatalog.fork(sourceSession, {
        target: "local",
        turnId: input.turnId,
        message: input.message,
        collaborationMode: input.collaborationMode,
        browserViewScopeId: windowSessionId,
      });
      if ("pendingWorktreeId" in result) {
        setPendingWorktreeClientThreadId(result.clientThreadId);
        return;
      }
      selectSession(result.session);
      if (result.composerIntent) {
        if (result.session.executionRef)
          setLocalConversationComposerIntent(result.threadId, result.composerIntent);
        else workbenchCodexControl.setComposerIntent(result.threadId, result.composerIntent);
      }
      // The selected task owns resume/hydration; it must not extend the source task's fork action.
      if (!result.session.executionRef)
        void workbenchCodexControl
          .requestThreadStreamSnapshot(result.threadId)
          .catch(() => undefined);
    },
    [
      projectlessSessions,
      selectSession,
      sessionCatalog,
      sessionsByProject,
      setPendingWorktreeClientThreadId,
      windowSessionId,
      workbenchCodexControl,
    ],
  );

  const forkSessionFromTurnIntoWorktree = useCallback(
    async (input: { threadId: string; targetTurnId: string; runtimeSessionId?: string }) => {
      const sourceSession = [
        ...Object.values(sessionsByProject).flat(),
        ...projectlessSessions,
      ].find((candidate) =>
        input.runtimeSessionId
          ? candidate.id === input.runtimeSessionId
          : (candidate.executionRef?.threadId ?? candidate.thread?.threadId) === input.threadId,
      );
      if (!sourceSession) {
        throw new Error("This thread is not attached to a project session");
      }

      const runtimeSource = sourceSession.executionRef
        ? await agentRuntimeRuntime.inspect({
            sessionId: sourceSession.id,
            threadId: input.threadId,
          })
        : null;
      const localEnvironmentConfigPath = await resolveForkLocalEnvironmentConfigPath(
        runtimeSource?.thread.worktreePath ??
          sourceSession.thread?.cwd ??
          projects.find((project) => project.id === sourceSession.projectId)?.primaryWorkspaceRoot,
      );
      const result = await sessionCatalog.fork(sourceSession, {
        target: "newWorktree",
        sourceThreadId: input.threadId,
        turnId: input.targetTurnId,
        localEnvironmentConfigPath,
        browserViewScopeId: windowSessionId,
      });
      if ("pendingWorktreeId" in result) {
        setPendingWorktreeClientThreadId(result.clientThreadId);
        return;
      }
      selectSession(result.session);
    },
    [
      projectlessSessions,
      projects,
      resolveForkLocalEnvironmentConfigPath,
      sessionCatalog,
      sessionsByProject,
      setPendingWorktreeClientThreadId,
      selectSession,
      windowSessionId,
    ],
  );

  return {
    ensureDefaultDraftSessionForProject,
    linkPageToChat,
    resolveChatSessionForThread,
    openProjectSessionById,
    openPageInNewChat,
    sendPageToChat,
    startNewChatInProject,
    startNewChatWithPrompt,
    openSidebarCommandPalette,
    openCommandPalette,
    requestContentSearchOpen,
    showUnavailableProduct,
    createManualTab,
    activateReviewTab,
    openSubagentsPanelTab,
    openAttachedThreadSession,
    openResolvedPendingThreadSession,
    openAttachedThreadSessionById,
    presentScheduledChat,
    replyAboutScheduledTask,
    openProcessOutputInCurrentSession,
    openProcessManagerOutput,
    openTurnDiffFileInSidePanel,
    openSummaryOutputInSidePanel,
    consumeNewThreadComposerIntent,
    forkSessionFromTurn,
    forkSessionFromTurnIntoWorktree,
  };
}

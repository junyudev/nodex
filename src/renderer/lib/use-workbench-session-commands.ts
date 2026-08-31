import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import type {
  ThreadStageActions,
  useCodexAppServerControl,
  useConversationSubset,
} from "@/features/local-conversation";
import type { ThreadOpenSubagentPayload } from "@/features/local-conversation/thread-stage-types";
import { CODEX_CLIENT_THREAD_ID_PREFIX } from "../../shared/codex-client-thread";
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
  resolveProcessOutputPanelTitle,
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
import { resolveCodexSubagentDisplayName } from "../../shared/codex-subagent-display";
import {
  presentWorkbenchSession,
  type WorkbenchSessionRenderProjection,
} from "./workbench-session-presentation";
import type { WorkbenchPanelController } from "./use-workbench-panel-controller";
import type { useWorkbenchPanelLifecycle } from "./use-workbench-panel-lifecycle";
import type { useWorkbenchPanelOpeners } from "./use-workbench-panel-openers";
import type { useWorkbenchSessionCatalog } from "./use-workbench-session-catalog";
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
import { queryKeys } from "./query-keys";
import type { WorkbenchSceneNavigator } from "./workbench-scene-navigator";
import type {
  CodexCollaborationModeKind,
  CodexComposerIntent,
  CodexThreadSummary,
  PanelId,
  Project,
  ProjectSession as ProjectSessionDomain,
  WorkbenchTabCreateInput,
  WorkbenchTabProjection,
} from "./types";

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
  readonly createSessionViewTab: (input: WorkbenchTabCreateInput) => WorkbenchTabProjection | null;
  readonly sceneNavigator: WorkbenchSceneNavigator;
  readonly codexControl: ReturnType<typeof useCodexAppServerControl>;
  readonly processManagerConversationsById: ReturnType<typeof useConversationSubset>;
  readonly threadScopeIdentityRegistry: ReturnType<typeof createThreadScopeIdentityRegistry>;
  readonly selectSession: (session: ProjectSessionDomain | ProjectSession) => void;
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
  readonly setPendingWorktreeClientThreadId: (clientThreadId: string | null) => void;
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
      initialQuery: string;
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
  const panelControllerRef = useRef(controller);
  panelControllerRef.current = controller;
  const { pendingProcessOutputOpen } = controller;
  const { ensureActivePanelOpenWithoutRefresh, setActivePanelTab } = lifecycle;
  const { openWorkspaceFileTab } = panelOpeners;
  const pageOpenInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const pageSendInFlightRef = useRef<Map<string, Promise<void>>>(new Map());

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
        (session) => session.thread?.threadId === normalizedThreadId && !session.archived,
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
                accessContext: { kind: "project", projectId: input.projectId },
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
          startTurn: async ({ projectId, threadId, context }) => {
            await workbenchCodexControl.startTurn(threadId, context.promptInput.text, {
              projectId,
              promptInput: context.promptInput,
            });
          },
          startThread: async ({ projectId, sessionId, context }) =>
            await workbenchCodexControl.startThreadForSession({
              projectId,
              sessionId,
              prompt: context.promptInput.text,
              promptInput: context.promptInput,
              runInTarget: "localProject",
            }),
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
      workbenchCodexControl,
    ],
  );

  const startNewChatInProject = useCallback(
    async (projectId: string | null) => {
      const session = await ensureDefaultDraftSessionForProject(projectId);
      panelControllerRef.current.durable.patchPanel(session, "right", {
        size: {
          ...session.panels.right.size,
          fullWidth: false,
        },
      });
    },
    [ensureDefaultDraftSessionForProject],
  );

  const prefillNewChat = useCallback(
    async (input: { projectId: string | null; prompt: string }) => {
      const session = await ensureDefaultDraftSessionForProject(input.projectId);
      setSettingsPath(null);
      setAutomationsPath(null);
      setNewThreadComposerIntentsBySessionId((current) => ({
        ...current,
        [session.id]: {
          prompt: input.prompt,
          focusNonce: Date.now(),
        },
      }));
      return session;
    },
    [
      ensureDefaultDraftSessionForProject,
      setAutomationsPath,
      setNewThreadComposerIntentsBySessionId,
      setSettingsPath,
    ],
  );

  const startNewChatWithPrompt = useCallback(
    async (input: { projectId: string | null; prompt: string }) => {
      const session = await prefillNewChat(input);
      panelControllerRef.current.durable.patchPanel(session, "right", {
        size: {
          ...session.panels.right.size,
          fullWidth: false,
        },
      });
    },
    [prefillNewChat],
  );

  const openScheduledAutomationChatCreate = useCallback(
    async (prompt: string) => {
      const targetProject =
        activeProject ?? projects.find((project) => project.id === activeProjectId) ?? null;
      if (!targetProject) {
        throw new Error("No project is available for scheduled task chat.");
      }
      await prefillNewChat({
        projectId: targetProject.id,
        prompt,
      });
    },
    [activeProject, activeProjectId, prefillNewChat, projects],
  );

  const startScheduledAutomationTemplateChat = useCallback(
    async (prompt: string) => {
      const targetProject =
        activeProject ?? projects.find((project) => project.id === activeProjectId) ?? null;
      if (!targetProject) {
        throw new Error("No project is available for scheduled task personalization.");
      }

      const session = await ensureDefaultDraftSessionForProject(targetProject.id);
      setSettingsPath(null);
      setAutomationsPath(null);
      const result = await workbenchCodexControl.startThreadForSession({
        projectId: targetProject.id,
        sessionId: session.id,
        prompt,
        runInTarget: "localProject",
        collaborationMode: "default",
      });
      if (result.kind !== "started") {
        throw new Error("Scheduled task personalization unexpectedly started in a worktree");
      }
      const { detail } = result;
      await refreshProjectSessions(targetProject.id);
      selectSession(session);
      await workbenchCodexControl.requestThreadStreamSnapshot(detail.threadId).catch(() => null);
    },
    [
      activeProject,
      activeProjectId,
      ensureDefaultDraftSessionForProject,
      projects,
      refreshProjectSessions,
      selectSession,
      setAutomationsPath,
      setSettingsPath,
      workbenchCodexControl,
    ],
  );

  const openSidebarCommandPalette = useCallback(() => {
    setCommandPaletteOpenRequest((current) => ({
      tick: current.tick + 1,
      mode: "pages",
      initialQuery: "",
    }));
    setCommandPaletteOpen(true);
  }, [setCommandPaletteOpen, setCommandPaletteOpenRequest]);

  const openCommandPalette = useCallback(
    (request?: CommandMenuOpenRequest) => {
      setCommandPaletteOpenRequest((current) => ({
        tick: current.tick + 1,
        mode: request?.mode ?? "root",
        initialQuery: request?.query ?? "",
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

  const showSidebarUnavailableProduct = useCallback((label: string) => {
    toast.info(`${label} is not available in Nodex yet.`, {
      id: `sidebar-${label.toLowerCase()}-unavailable`,
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
      if (kind === "review" && !activeSession.thread) return false;
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

      const createdTab = createSessionViewTab(createInput);
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

  const openBackgroundAgentPanelTab = useCallback(
    async (subagent: ThreadOpenSubagentPayload): Promise<boolean> => {
      if (!activeSession || activeSession.projectId === null || !activeSession.thread) return false;

      const threadId = subagent.conversationId.trim();
      if (!threadId) return false;

      let hydratedSummaries: CodexThreadSummary[] = [];
      try {
        hydratedSummaries = await workbenchCodexControl.hydrateBackgroundSubagentThreads({
          rootThreadId: activeSession.thread.threadId,
          threadIds: [threadId],
        });
      } catch {
        toast.danger("Failed to open background agent");
        return false;
      }

      const panelId = "right" as const;
      const leafId = resolveSessionPanelActiveLeafId(activeSession, panelId);
      const tabId = makeBackgroundAgentPanelTabId(threadId);
      const title = resolveCodexSubagentDisplayName({
        threadId,
        childSummary: hydratedSummaries.find((summary) => summary.threadId === threadId) ?? null,
        fallbackDisplayName: subagent.displayName,
      });
      const tab: BackgroundAgentPanelTab = {
        backgroundAgent: true,
        id: tabId,
        sessionId: activeSession.id,
        projectId: activeSession.projectId,
        panelId,
        leafId,
        threadId,
        title,
        stateKey: Date.now(),
        subagent: {
          ...subagent,
          conversationId: threadId,
          displayName: title,
        },
      };

      panelControllerRef.current.upsertEphemeralTab(tab);
      await ensureActivePanelOpenWithoutRefresh(panelId);
      return true;
    },
    [activeSession, ensureActivePanelOpenWithoutRefresh, workbenchCodexControl],
  );

  const openSubagentsPanelTab = useCallback(
    async (
      rootThreadId: string,
      subagent: ThreadOpenSubagentPayload | null = null,
    ): Promise<boolean> => {
      if (!activeSession || activeSession.projectId === null) return false;
      const normalizedRootThreadId = rootThreadId.trim();
      const selectedThreadId = subagent?.conversationId.trim() || null;
      if (!normalizedRootThreadId || selectedThreadId === normalizedRootThreadId) return false;

      try {
        if (selectedThreadId) {
          const hydrated = await workbenchCodexControl.hydrateSubagentPanel({
            rootThreadId: normalizedRootThreadId,
            threadIds: [selectedThreadId],
            includeTail: true,
          });
          if (!hydrated.some((summary) => summary.threadId === selectedThreadId)) return false;
        }
      } catch {
        toast.danger("Failed to open subagents");
        return false;
      }

      const panelId = "right" as const;
      const leafId = resolveSessionPanelActiveLeafId(activeSession, panelId);
      const tabId = makeSubagentsPanelTabId(normalizedRootThreadId);
      const tab: SubagentsPanelTab = {
        subagentsPanel: true,
        id: tabId,
        sessionId: activeSession.id,
        projectId: activeSession.projectId,
        panelId,
        leafId,
        rootThreadId: normalizedRootThreadId,
        selectedThreadId,
        selectedDisplayName: subagent?.displayName.trim() || null,
        title: "Subagents",
        stateKey: Date.now(),
      };

      panelControllerRef.current.upsertEphemeralTab(tab);
      await ensureActivePanelOpenWithoutRefresh(panelId);
      return true;
    },
    [activeSession, ensureActivePanelOpenWithoutRefresh, workbenchCodexControl],
  );

  const openAttachedThreadSessionResult = useCallback(
    async (
      threadId: string,
      context?: Parameters<NonNullable<ThreadStageActions["onOpenThread"]>>[1],
    ): Promise<boolean> => {
      if (threadId.startsWith(CODEX_CLIENT_THREAD_ID_PREFIX)) {
        setSettingsPath(null);
        setLocalEnvironmentSettingsInitial(null);
        setAutomationsPath(null);
        setPendingWorktreeClientThreadId(threadId);
        return true;
      }
      if (context?.subagent) {
        const rootThreadId = activeSession?.thread?.threadId ?? null;
        if (
          context.subagent.showInlineActivity === true &&
          rootThreadId &&
          (await openSubagentsPanelTab(rootThreadId, context.subagent))
        ) {
          return true;
        }
        if (await openBackgroundAgentPanelTab(context.subagent)) return true;
      }

      const session =
        knownSessions.find((candidate) => candidate.thread?.threadId === threadId) ?? null;
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
      openBackgroundAgentPanelTab,
      openSubagentsPanelTab,
      selectSession,
      sessionCatalog,
      setAutomationsPath,
      setLocalEnvironmentSettingsInitial,
      setPendingWorktreeClientThreadId,
      setSettingsPath,
    ],
  );

  const openAttachedThreadSession = useCallback<ThreadStageActions["onOpenThread"]>(
    async (threadId, context) => {
      await openAttachedThreadSessionResult(threadId, context);
    },
    [openAttachedThreadSessionResult],
  );

  const openResolvedPendingThreadSession = useCallback(
    async (clientThreadId: string, threadId: string): Promise<boolean> => {
      const stableKey = threadScopeIdentityRegistry.resolve({ clientThreadId });
      threadScopeIdentityRegistry.register(stableKey, { clientThreadId, threadId });
      return openAttachedThreadSessionResult(threadId);
    },
    [openAttachedThreadSessionResult, threadScopeIdentityRegistry],
  );

  const openAttachedThreadSessionById = useCallback(
    async (threadId: string) => {
      return await openAttachedThreadSessionResult(threadId);
    },
    [openAttachedThreadSessionResult],
  );

  const openAutomationHistoryThreadSessionById = useCallback(
    async (threadId: string) => {
      const opened = await openAttachedThreadSessionResult(threadId);
      if (!opened) return;

      setSettingsPath(null);
      setAutomationsPath(null);
    },
    [openAttachedThreadSessionResult, setAutomationsPath, setSettingsPath],
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
      ].find((candidate) => candidate.thread?.threadId === input.threadId);
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
        workbenchCodexControl.setComposerIntent(result.threadId, result.composerIntent);
      }
      // The selected task owns resume/hydration; it must not extend the source task's fork action.
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
    async (input: { threadId: string; targetTurnId: string }) => {
      const sourceSession = [
        ...Object.values(sessionsByProject).flat(),
        ...projectlessSessions,
      ].find((candidate) => candidate.thread?.threadId === input.threadId);
      if (!sourceSession) {
        throw new Error("This thread is not attached to a project session");
      }

      const localEnvironmentConfigPath = await resolveForkLocalEnvironmentConfigPath(
        sourceSession.thread?.cwd,
      );
      const result = await sessionCatalog.fork(sourceSession, {
        target: "newWorktree",
        turnId: input.targetTurnId,
        localEnvironmentConfigPath,
        browserViewScopeId: windowSessionId,
      });
      if (!("pendingWorktreeId" in result)) {
        throw new Error("Worktree fork started without a pending worktree");
      }
      setPendingWorktreeClientThreadId(result.clientThreadId);
    },
    [
      projectlessSessions,
      resolveForkLocalEnvironmentConfigPath,
      sessionCatalog,
      sessionsByProject,
      setPendingWorktreeClientThreadId,
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
    openScheduledAutomationChatCreate,
    startScheduledAutomationTemplateChat,
    openSidebarCommandPalette,
    openCommandPalette,
    requestContentSearchOpen,
    showSidebarUnavailableProduct,
    createManualTab,
    activateReviewTab,
    openSubagentsPanelTab,
    openAttachedThreadSession,
    openResolvedPendingThreadSession,
    openAttachedThreadSessionById,
    openAutomationHistoryThreadSessionById,
    openProcessOutputInCurrentSession,
    openProcessManagerOutput,
    openTurnDiffFileInSidePanel,
    openSummaryOutputInSidePanel,
    consumeNewThreadComposerIntent,
    forkSessionFromTurn,
    forkSessionFromTurnIntoWorktree,
  };
}

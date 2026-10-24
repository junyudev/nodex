import { ConversationRuntimeContext } from "@/features/local-conversation/conversation-runtime";
import { useAgentRuntimeConversationAdapter } from "@/features/local-conversation/agent-runtime-conversation-adapter";
import { createRemoteCodexStageActions } from "@/features/local-conversation/remote-codex-stage-actions";
import { useCodexAppServerControl } from "@/features/local-conversation/local-conversation-store";
import { useNativeConversationHistoryAdapter } from "@/features/local-conversation/native-conversation-history-adapter";
import type { ConversationProviderPresentation } from "@/features/local-conversation/thread-stage-types";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ConnectedThreadComposerDock,
  ConnectedThreadStage,
  type SessionThreadCommands,
  type ThreadStageActions,
} from "@/features/local-conversation";
import type { FloatingComposerPlacement } from "@/features/floating-composer/floating-composer";
import { composeNativeThreadStageActions } from "@/features/local-conversation/native-thread-stage-actions";
import { resolveSessionExecution, resolveSessionForkAvailability } from "@/lib/session-execution";
import { useOpenNativeRuntimeDiagnostics } from "@/components/shared/agent-runtime/native-runtime-diagnostics";
import type {
  NewChatStartInSelectorModel,
  ThreadOpenSideChatInput,
  ThreadPlanSidePanelState,
  ThreadSummaryPanelAuxiliaryRow,
  ThreadSummaryPanelBrowserRow,
  ThreadSummaryPanelComputerUsePipState,
  ThreadSummaryPanelScheduledAutomationRow,
} from "@/features/local-conversation/thread-stage-types";
import { useAgentInstances } from "@/features/local-conversation/use-agent-instances";
import { useNewChatExecutionDraft } from "@/features/local-conversation/use-new-chat-execution-draft";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { buildSettingsPath } from "./workbench-settings-routes";
import { useLocalEnvironmentConfigs } from "@/lib/use-local-environment-queries";
import {
  createCommandKeymapState,
  formatCommandShortcutLabel,
  resolveCommandShortcutPresentation,
  type CommandKeymapState,
} from "../../../shared/command-keybindings";
import { buildNewChatProjectSelectorOptions } from "@/lib/new-chat-project-selector";
import type { ComposerEnterBehavior } from "@/lib/composer-enter-behavior";
import type {
  CodexComposerIntent,
  CodexCollaborationModeKind,
  Project,
  CodexThreadSummary,
} from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import {
  normalizeProjectPrimaryWorkspaceRoot,
  projectWorkspaceRootOrNull,
} from "@/lib/workbench-workspace-context";
import {
  readLocalEnvironmentSelections,
  resolveLocalEnvironmentSelection,
  writeLocalEnvironmentSelection,
} from "./local-environment-selection";

function SharedConnectedSessionThread({
  agent,
  selectedNewThreadProjectId,
  setSelectedNewThreadProjectId,
  provider,
  session,
  project,
  projects,
  routeActive,
  threadBodyVisible,
  newThreadComposerIntent,
  onConsumeNewThreadComposerIntent,
  onRequestProjectPickerOpen,
  onStartNewChatWithPrompt,
  onOpenLocalEnvironmentsSettings,
  onOpenHooksSettings,
  onOpenVoiceSettings,
  composerEnterBehavior,
  threadQueueFollowUpsEnabled,
  onQueueingEnabledChange,
  onOpenThread,
  onOpenSubagentsPanel,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenSummaryGitReview,
  turnDiffHoverPreviewDisabled,
  searchOpenTick,
  summaryPanelMounted,
  summaryPanelOpen,
  summaryPanelHideImmediately,
  summaryPanelContentShift,
  summarySideChatRows,
  summaryBrowserRows,
  summaryScheduledAutomation,
  summaryComputerUsePip,
  onOpenSummarySideChatRow,
  onOpenSummaryBrowserRow,
  onOpenSummaryScheduledAutomation,
  onOpenSummaryOutputInSidePanel,
  onOpenProcessManager,
  onOpenBackgroundTerminalOutput,
  onToggleSummaryComputerUsePip,
  rightPanelComposerOverlayEnabled,
  rightPanelComposerOverlayTarget,
  rightPanelComposerOverlayPlacement,
  onOpenMcpAppSidePanel,
  onOpenSideChat,
  onOpenPlanInSidePanel,
  onClosePlanSidePanel,
  planSidePanelState,
  onRequestRenameThread,
  onArchiveThread,
  onToggleThreadPin,
  commandKeymapState,
  isMac,
  presentation = "primary",
  composerDock,
  composerScopeIdentity,
  newThreadStartBlockedReason,
  projectDraftId,
  onForkFromTurnIntoWorktree,
  onForkSession,
}: {
  agent: Pick<
    ReturnType<typeof useAgentRuntimeConversationAdapter>,
    | "summary"
    | "actions"
    | "models"
    | "modes"
    | "selectedMode"
    | "selectedModel"
    | "selectedEffort"
    | "reasoningEffortOptions"
  >;
  selectedNewThreadProjectId: string | null;
  setSelectedNewThreadProjectId: (projectId: string | null) => void;
  provider?: ConversationProviderPresentation;
  session: WorkbenchSessionRenderProjection;
  project: Project | null;
  projects: Project[];
  routeActive: boolean;
  threadBodyVisible: boolean;
  onRefreshProjectSessions: (
    projectId: string | null,
  ) => Promise<WorkbenchSessionRenderProjection[]>;
  onEnsureDefaultDraftSessionForProject: (
    projectId: string | null,
  ) => Promise<WorkbenchSessionRenderProjection>;
  onStartNewChatWithPrompt?: NonNullable<ThreadStageActions["onStartNewChatWithPrompt"]>;
  onOpenPendingWorktree: (clientThreadId: string, projectSessionId: string) => void;
  newThreadComposerIntent?: CodexComposerIntent | null;
  onConsumeNewThreadComposerIntent?: ThreadStageActions["onConsumeNewThreadComposerIntent"];
  onRequestProjectPickerOpen: () => void;
  onOpenLocalEnvironmentsSettings: (input?: {
    projectId?: string | null;
    configPath?: string | null;
  }) => void;
  onOpenHooksSettings: NonNullable<ThreadStageActions["onOpenHooksSettings"]>;
  onOpenVoiceSettings?: ThreadStageActions["onOpenVoiceSettings"];
  threadQueueFollowUpsEnabled: boolean;
  composerEnterBehavior: ComposerEnterBehavior;
  onQueueingEnabledChange: ThreadStageActions["onQueueingEnabledChange"];
  onOpenThread: ThreadStageActions["onOpenThread"];
  onOpenSubagentsPanel: ThreadStageActions["onOpenSubagentsPanel"];
  onOpenTurnDiffReview: ThreadStageActions["onOpenTurnDiffReview"];
  onOpenTurnDiffFileInSidePanel: ThreadStageActions["onOpenTurnDiffFileInSidePanel"];
  onOpenSummaryGitReview: ThreadStageActions["onOpenSummaryGitReview"];
  turnDiffHoverPreviewDisabled: boolean;
  onForkSessionFromTurn?: SessionThreadCommands["onForkSessionFromTurn"];
  onForkSession?: SessionThreadCommands["onForkSession"];
  onForkFromTurnIntoWorktree: (input: {
    threadId: string;
    targetTurnId: string;
    runtimeSessionId?: string;
  }) => Promise<void>;
  searchOpenTick: number;
  summaryPanelMounted: boolean;
  summaryPanelOpen: boolean;
  summaryPanelHideImmediately: boolean;
  summaryPanelContentShift: number;
  summarySideChatRows: readonly ThreadSummaryPanelAuxiliaryRow[];
  summaryBrowserRows: readonly ThreadSummaryPanelBrowserRow[];
  summaryScheduledAutomation: ThreadSummaryPanelScheduledAutomationRow | null;
  summaryComputerUsePip: ThreadSummaryPanelComputerUsePipState | null;
  onOpenSummarySideChatRow: NonNullable<ThreadStageActions["onOpenSummarySideChatRow"]>;
  onOpenSummaryBrowserRow: NonNullable<ThreadStageActions["onOpenSummaryBrowserRow"]>;
  onOpenSummaryScheduledAutomation: NonNullable<
    ThreadStageActions["onOpenSummaryScheduledAutomation"]
  >;
  onOpenSummaryOutputInSidePanel: NonNullable<ThreadStageActions["onOpenSummaryOutputInSidePanel"]>;
  onOpenProcessManager?: ThreadStageActions["onOpenProcessManager"];
  onOpenBackgroundTerminalOutput?: ThreadStageActions["onOpenBackgroundTerminalOutput"];
  onToggleSummaryComputerUsePip: NonNullable<ThreadStageActions["onToggleSummaryComputerUsePip"]>;
  rightPanelComposerOverlayEnabled: boolean;
  rightPanelComposerOverlayTarget: HTMLElement | null;
  rightPanelComposerOverlayPlacement?: FloatingComposerPlacement;
  onOpenSideChat?: (
    input?: ThreadOpenSideChatInput & {
      collaborationMode?: CodexCollaborationModeKind;
    },
  ) => Promise<void>;
  onOpenMcpAppSidePanel: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenPlanInSidePanel: ThreadStageActions["onOpenPlanInSidePanel"];
  onClosePlanSidePanel: ThreadStageActions["onClosePlanSidePanel"];
  planSidePanelState: ThreadPlanSidePanelState | null;
  onRequestRenameThread: ThreadStageActions["onRequestRenameThread"];
  onArchiveThread: NonNullable<ThreadStageActions["onArchiveThread"]>;
  onToggleThreadPin: NonNullable<ThreadStageActions["onToggleThreadPin"]>;
  commandKeymapState?: CommandKeymapState | null;
  isMac: boolean;
  presentation?: "primary" | "panel";
  composerDock?: {
    readonly visible: boolean;
    readonly target: HTMLElement | null;
    readonly placement?: FloatingComposerPlacement;
    readonly leadingContent: React.ReactNode;
  };
  composerScopeIdentity?: string | null;
  browserUseViewScopeId?: string | null;
  newThreadStartBlockedReason?: string | null;
  projectDraftId?: string | null;
  onMaterializeProjectDraft?: SessionThreadCommands["onMaterializeProjectDraft"];
  onCommitMaterializedProjectDraft?: SessionThreadCommands["onCommitMaterializedProjectDraft"];
}) {
  const attachedSummary = agent.summary;
  const [environmentSelections, setEnvironmentSelections] = useState(
    readLocalEnvironmentSelections,
  );
  const selectedNewThreadProject =
    selectedNewThreadProjectId === null
      ? null
      : (projects.find((candidate) => candidate.id === selectedNewThreadProjectId) ??
        project ??
        null);
  const summary = attachedSummary;
  const threadStartProgress = null;
  const startInSelectorProject = summary ? project : selectedNewThreadProject;
  const newThreadEnvironmentWorkspaceRoot = projectWorkspaceRootOrNull(startInSelectorProject);
  const effectiveProjectId = summary ? session.projectId : (selectedNewThreadProject?.id ?? null);
  const executionDraft = useNewChatExecutionDraft({
    sessionId: session.id,
    projectId: effectiveProjectId,
    workspaceRoot: newThreadEnvironmentWorkspaceRoot,
    onProjectChange: setSelectedNewThreadProjectId,
  });
  const {
    runInTarget: selectedNewThreadRunInTarget,
    worktreeStartingState: selectedNewThreadStartingState,
  } = executionDraft.target;
  const environmentAvailable = provider?.kind !== "acp";
  const environmentConfigsQuery = useLocalEnvironmentConfigs(effectiveProjectId ?? "", {
    enabled: environmentAvailable && selectedNewThreadRunInTarget === "newWorktree",
  });
  const newThreadEnvironmentConfigs = useMemo(
    () => environmentConfigsQuery.data ?? [],
    [environmentConfigsQuery.data],
  );
  const newThreadEnvironmentsLoading = environmentConfigsQuery.isFetching;
  const newThreadEnvironmentsError = environmentConfigsQuery.isError;
  const newThreadEnvironmentResolution = resolveLocalEnvironmentSelection({
    candidateSource: environmentConfigsQuery.isError
      ? { status: "unresolved", reason: "load-error", error: environmentConfigsQuery.error }
      : environmentConfigsQuery.data
        ? {
            status: "loaded",
            candidates: environmentConfigsQuery.data.map(({ configPath, state }) => ({
              configPath,
              state,
            })),
          }
        : { status: "unresolved", reason: "loading", error: null },
    selectionsByWorkspace: environmentSelections,
    workspaceRoot: newThreadEnvironmentWorkspaceRoot,
  });
  const selectedNewThreadEnvironmentPath =
    environmentAvailable && selectedNewThreadRunInTarget === "newWorktree"
      ? newThreadEnvironmentResolution.resolvedConfigPath
      : null;
  const projectSelectorOptions = useMemo(
    () => buildNewChatProjectSelectorOptions(projects),
    [projects],
  );
  const resolvedCommandKeymapState = useMemo(
    () => commandKeymapState ?? createCommandKeymapState({}, isMac ? "macOS" : "windows"),
    [commandKeymapState, isMac],
  );
  const threadActionShortcuts = useMemo(() => {
    return {
      togglePin: formatCommandShortcutLabel(
        resolvedCommandKeymapState,
        "toggleThreadPin",
        "CmdOrCtrl+Alt+P",
      ),
      rename: formatCommandShortcutLabel(
        resolvedCommandKeymapState,
        "renameThread",
        "CmdOrCtrl+Alt+R",
      ),
      archive: formatCommandShortcutLabel(
        resolvedCommandKeymapState,
        "archiveThread",
        "CmdOrCtrl+Shift+A",
      ),
      openSideTask: formatCommandShortcutLabel(
        resolvedCommandKeymapState,
        "openSideChat",
        "CmdOrCtrl+Alt+S",
      ),
      copyConversationMarkdown: formatCommandShortcutLabel(
        resolvedCommandKeymapState,
        "copyConversationMarkdown",
      ),
    };
  }, [resolvedCommandKeymapState]);
  const modelPickerShortcut = useMemo(
    () =>
      resolveCommandShortcutPresentation(
        resolvedCommandKeymapState,
        "openModelPicker",
        "Ctrl+Shift+M",
      ),
    [resolvedCommandKeymapState],
  );

  useEffect(() => {
    if (summary) return;
    setSelectedNewThreadProjectId(session.projectId);
  }, [session.id, session.projectId, summary, setSelectedNewThreadProjectId]);

  useEffect(() => {
    if (selectedNewThreadProjectId === null) return;
    if (projects.some((candidate) => candidate.id === selectedNewThreadProjectId)) {
      return;
    }
    setSelectedNewThreadProjectId(session.projectId);
  }, [projects, selectedNewThreadProjectId, session.projectId, setSelectedNewThreadProjectId]);

  const refetchEnvironmentConfigs = environmentConfigsQuery.refetch;
  const refreshNewThreadEnvironments = useCallback(async () => {
    if (effectiveProjectId === null || !environmentAvailable) return;
    await refetchEnvironmentConfigs();
    setEnvironmentSelections(readLocalEnvironmentSelections());
  }, [effectiveProjectId, environmentAvailable, refetchEnvironmentConfigs]);

  const changeNewThreadEnvironment = useCallback(
    (configPath: string | null) => {
      if (!newThreadEnvironmentWorkspaceRoot) return;
      writeLocalEnvironmentSelection({
        workspaceRoot: newThreadEnvironmentWorkspaceRoot,
        configPath,
      });
      setEnvironmentSelections(readLocalEnvironmentSelections());
    },
    [newThreadEnvironmentWorkspaceRoot],
  );

  const startInSelectorModel = useMemo<NewChatStartInSelectorModel>(() => {
    const workspaceRoot = normalizeProjectPrimaryWorkspaceRoot(startInSelectorProject);
    const repositoryName =
      workspaceRoot?.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? null;
    return {
      target: {
        runInTarget: selectedNewThreadRunInTarget,
        runInEnvironmentPath: selectedNewThreadEnvironmentPath,
        worktreeStartingState: selectedNewThreadStartingState,
      },
      disabled: effectiveProjectId === null,
      worktreeAvailable: Boolean(workspaceRoot),
      environmentAvailable,
      environments: newThreadEnvironmentConfigs,
      environmentsLoading: newThreadEnvironmentsLoading,
      environmentsError: newThreadEnvironmentsError,
      selectedEnvironmentPath: selectedNewThreadEnvironmentPath,
      defaultEnvironmentPath: newThreadEnvironmentResolution?.defaultConfigPath ?? null,
      environmentNeedsAttention: newThreadEnvironmentResolution?.status === "needs-attention",
      environmentRepairConfigPath: newThreadEnvironmentResolution?.repairConfigPath ?? null,
      repositoryName,
      additionalSourceFolderCount: Math.max(0, (startInSelectorProject?.sources.length ?? 0) - 1),
    };
  }, [
    newThreadEnvironmentConfigs,
    newThreadEnvironmentsLoading,
    newThreadEnvironmentsError,
    newThreadEnvironmentResolution,
    effectiveProjectId,
    environmentAvailable,
    selectedNewThreadEnvironmentPath,
    selectedNewThreadRunInTarget,
    selectedNewThreadStartingState,
    startInSelectorProject,
  ]);
  const effectiveNewThreadStartBlockedReason =
    newThreadStartBlockedReason ??
    (effectiveProjectId !== null &&
    !projectWorkspaceRootOrNull(selectedNewThreadProject) &&
    !summary
      ? "Choose a local Project to start this Agent."
      : null) ??
    (!environmentAvailable || selectedNewThreadRunInTarget !== "newWorktree"
      ? null
      : newThreadEnvironmentsLoading
        ? "Wait for worktree environments to finish loading."
        : newThreadEnvironmentResolution.status === "needs-attention"
          ? "Repair the selected worktree environment before starting."
          : newThreadEnvironmentResolution.status === "unresolved"
            ? "Worktree environments could not be resolved."
            : null);

  const openNativeDiagnostics = useOpenNativeRuntimeDiagnostics(provider?.diagnostics);
  const actions = composeNativeThreadStageActions(
    {
      onQueueingEnabledChange,
      onNewThreadProjectChange: executionDraft.changeProject,
      onRequestNewChatProjectCreate: onRequestProjectPickerOpen,
      onStartNewChatWithPrompt,
      onNewThreadStartInTargetChange: executionDraft.changeTarget,
      onNewThreadStartInEnvironmentChange: changeNewThreadEnvironment,
      onRefreshNewThreadStartInEnvironments: refreshNewThreadEnvironments,
      onOpenNewThreadLocalEnvironmentsSettings: (configPath) =>
        onOpenLocalEnvironmentsSettings({
          projectId: effectiveProjectId,
          configPath: configPath ?? null,
        }),
      onOpenVoiceSettings,
      onOpenSummaryBrowserRow,
      onOpenSummaryScheduledAutomation,
      onOpenSummaryOutputInSidePanel,
      onOpenSummaryGitReview,
      onOpenProcessManager,
      onOpenBackgroundTerminalOutput,
      onRequestRenameThread,
      onArchiveThread,
      onToggleThreadPin,
      onConsumeNewThreadComposerIntent,
      onOpenThread,
      onOpenTurnDiffReview,
      onOpenTurnDiffFileInSidePanel,
    },
    {
      ...agent.actions,
      ...(summary &&
      onForkSession &&
      resolveSessionForkAvailability(resolveSessionExecution(session)).available
        ? {
            onForkThread: (target: "local" | "newWorktree") =>
              onForkSession(session, { target, sourceThreadId: summary.threadId }),
          }
        : {}),
      onOpenMcpAppSidePanel,
      onOpenSideChat,
      onOpenPlanInSidePanel,
      onClosePlanSidePanel,
      onOpenSummarySideChatRow,
      onToggleSummaryComputerUsePip,
      onOpenHooksSettings,
      onOpenSubagentsPanel,
      ...(provider?.diagnostics ? { onOpenStatusPanel: openNativeDiagnostics } : {}),
    },
  );

  const connectedStageProps = {
    provider,
    projectWorkspaceRoots:
      (summary ? project : selectedNewThreadProject)?.sources.map((source) => source.root) ?? [],
    projectId: effectiveProjectId,
    sessionId: session.id,
    threadPinned: session.pinned ?? false,
    threadActionShortcuts,
    modelPickerShortcut,
    projectWorkspacePath: summary
      ? projectWorkspaceRootOrNull(project)
      : projectWorkspaceRootOrNull(selectedNewThreadProject),
    isNewThreadTab: !summary,
    newThreadTarget: summary
      ? null
      : {
          projectId: effectiveProjectId,
          projectName: selectedNewThreadProject?.name ?? "No project",
          sessionId: session.id,
          ...(projectDraftId ? { projectDraftId } : {}),
          threadTitle: "New thread",
          runInTarget: selectedNewThreadRunInTarget,
          runInEnvironmentPath: environmentAvailable ? selectedNewThreadEnvironmentPath : null,
          worktreeStartingState: selectedNewThreadStartingState,
        },
    newThreadProjectSelector: summary
      ? null
      : {
          projects: projectSelectorOptions,
          selectedProjectId: effectiveProjectId,
          disabled: Boolean(projectDraftId),
          canAddProject: !projectDraftId,
        },
    newThreadStartInSelector: summary ? null : startInSelectorModel,
    newThreadStartBlockedReason: effectiveNewThreadStartBlockedReason,
    newThreadComposerIntent: summary ? null : (newThreadComposerIntent ?? null),
    threadStartProgress,
    activeThreadId: summary?.threadId ?? null,
    activeThreadSummary: summary,
    availableModels: agent.models,
    selectedExecutionProfile: null,
    collaborationModes: agent.modes,
    selectedCollaborationMode: agent.selectedMode,
    selectedModel: agent.selectedModel,
    selectedReasoningEffort: agent.selectedEffort,
    reasoningEffortOptions: agent.reasoningEffortOptions,

    isQueueingEnabled: threadQueueFollowUpsEnabled,
    composerEnterBehavior,
    searchOpenTick,
    summarySideChatRows,
    summaryBrowserRows,
    summaryScheduledAutomation,
    summaryComputerUsePip,
    planSidePanelState,
    actions,
    onForkFromTurnIntoWorktree: (request: { threadId: string; targetTurnId: string }) =>
      onForkFromTurnIntoWorktree({
        ...request,
        ...(session.executionRef ? { runtimeSessionId: session.id } : {}),
      }),
  } as const;

  if (composerDock) {
    return (
      <ConnectedThreadComposerDock
        {...connectedStageProps}
        routeActive={routeActive}
        visible={composerDock.visible}
        overlayTarget={composerDock.target}
        overlayPlacement={composerDock.placement}
        leadingContent={composerDock.leadingContent}
        composerScopeIdentity={composerScopeIdentity}
      />
    );
  }

  return (
    <div className="h-full min-h-0">
      <ConnectedThreadStage
        {...connectedStageProps}
        visualizationSurfaceId={JSON.stringify([
          "workbench-session",
          session.id,
          presentation,
          composerScopeIdentity ?? null,
        ])}
        summaryPanelMounted={summaryPanelMounted}
        summaryPanelOpen={summaryPanelOpen}
        summaryPanelHideImmediately={summaryPanelHideImmediately}
        summaryPanelContentShift={summaryPanelContentShift}
        rightPanelComposerOverlayEnabled={rightPanelComposerOverlayEnabled}
        rightPanelComposerOverlayTarget={rightPanelComposerOverlayTarget}
        rightPanelComposerOverlayPlacement={rightPanelComposerOverlayPlacement}
        turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
        routeActive={routeActive}
        threadBodyVisible={threadBodyVisible}
        presentation={presentation}
      />
    </div>
  );
}

type ConnectedSessionThreadProps = Omit<
  Parameters<typeof SharedConnectedSessionThread>[0],
  "agent" | "provider" | "selectedNewThreadProjectId" | "setSelectedNewThreadProjectId"
>;

/** One Session Interface owns execution for every configured Agent. */
function ConnectedRuntimeSessionThread(props: ConnectedSessionThreadProps) {
  const instanceSettings = useAgentInstances();
  const windowOwner = useWorkbenchWindowOwner();
  const [selectedNewThreadProjectId, setSelectedNewThreadProjectId] = useState<string | null>(
    props.session.projectId,
  );
  const adapter = useAgentRuntimeConversationAdapter({
    sessionId: props.session.id,
    sessionTitle: props.session.displayTitle,
    sessionUnread: props.session.unread,
    workspaceRoot: projectWorkspaceRootOrNull(props.project),
    executionRef: props.session.executionRef,
    projectId: props.session.projectId,
    modelProjectId: props.session.executionRef
      ? props.session.projectId
      : selectedNewThreadProjectId,
    instances: instanceSettings.instances,
    onRefresh: props.onRefreshProjectSessions,
    onOpenThread: props.onOpenThread,
    onLaunched: props.composerDock ? async () => {} : undefined,
    ensureDraft: props.onEnsureDefaultDraftSessionForProject,
    materializeDraft: props.onMaterializeProjectDraft,
    commitDraft: props.onCommitMaterializedProjectDraft,
  });
  const provider: ConversationProviderPresentation = {
    ...adapter.provider,
    modelCatalog: adapter.provider.modelCatalog
      ? {
          ...adapter.provider.modelCatalog,
          manage: () =>
            windowOwner.openRoute({ kind: "settings", path: buildSettingsPath("agent") }),
        }
      : undefined,
  };
  return (
    <ConversationRuntimeContext value={adapter.runtime}>
      <SharedConnectedSessionThread
        {...props}
        agent={adapter}
        selectedNewThreadProjectId={selectedNewThreadProjectId}
        setSelectedNewThreadProjectId={setSelectedNewThreadProjectId}
        provider={provider}
      />
    </ConversationRuntimeContext>
  );
}

type NativeHistorySessionThreadProps = ConnectedSessionThreadProps & {
  readonly thread: NonNullable<WorkbenchSessionRenderProjection["thread"]>;
};

/** Imported native chats stay readable history; only Runtime-bound Sessions execute. */
function NativeHistorySessionThread(props: NativeHistorySessionThreadProps) {
  const backend = props.thread.backendBinding.kind;
  return backend === "codex" ? (
    <CodexHistorySessionThread {...props} />
  ) : (
    <AgentHistorySessionThread {...props} backend={backend} />
  );
}

function useNativeHistorySummary({ session, thread }: NativeHistorySessionThreadProps) {
  return useMemo<CodexThreadSummary>(
    () => ({
      ...thread,
      source: null,
      threadName: thread.threadName ?? session.displayTitle,
      hasUnreadTurn: session.unread,
      cwd: thread.cwd ?? null,
    }),
    [thread, session.displayTitle, session.unread],
  );
}

/** Local Codex history is read through bounded Thread pages; it is never resumed for execution. */
function CodexHistorySessionThread(props: NativeHistorySessionThreadProps) {
  const summary = useNativeHistorySummary(props);
  return <NativeHistoryStage {...props} summary={summary} />;
}

function AgentHistorySessionThread(
  props: NativeHistorySessionThreadProps & {
    readonly backend: Exclude<
      NativeHistorySessionThreadProps["thread"]["backendBinding"]["kind"],
      "codex"
    >;
  },
) {
  const summary = useNativeHistorySummary(props);
  const history = useNativeConversationHistoryAdapter({
    sessionId: props.session.id,
    summary,
    backend: props.backend,
  });
  return (
    <ConversationRuntimeContext value={history.runtime}>
      <NativeHistoryStage
        {...props}
        summary={summary}
        provider={history.provider}
        onCopyConversationMarkdown={history.copyMarkdown}
      />
    </ConversationRuntimeContext>
  );
}

function NativeHistoryStage(
  props: NativeHistorySessionThreadProps & {
    readonly summary: CodexThreadSummary;
    readonly provider?: ConversationProviderPresentation;
    readonly onCopyConversationMarkdown?: ThreadStageActions["onCopyConversationMarkdown"];
  },
) {
  const { session, thread, summary } = props;
  const actions = composeNativeThreadStageActions(
    {
      onQueueingEnabledChange: props.onQueueingEnabledChange,
      onRequestRenameThread: props.onRequestRenameThread,
      onArchiveThread: props.onArchiveThread,
      onToggleThreadPin: props.onToggleThreadPin,
      onOpenThread: props.onOpenThread,
      onStartNewChatWithPrompt: props.onStartNewChatWithPrompt,
    },
    {
      ...(props.onCopyConversationMarkdown
        ? { onCopyConversationMarkdown: props.onCopyConversationMarkdown }
        : {}),
      onOpenSideChat: props.onOpenSideChat,
    },
  );
  return (
    <ConnectedThreadStage
      {...(props.provider ? { provider: props.provider } : {})}
      executionAvailable={false}
      projectId={session.projectId}
      sessionId={session.id}
      threadPinned={session.pinned}
      projectWorkspacePath={projectWorkspaceRootOrNull(props.project)}
      isNewThreadTab={false}
      newThreadTarget={null}
      threadStartProgress={null}
      activeThreadId={thread.threadId}
      activeThreadSummary={summary}
      availableModels={[]}
      collaborationModes={[]}
      selectedCollaborationMode="default"
      selectedModel=""
      selectedReasoningEffort="default"
      reasoningEffortOptions={[]}
      isQueueingEnabled={false}
      composerEnterBehavior={props.composerEnterBehavior}
      searchOpenTick={props.searchOpenTick}
      routeActive={props.routeActive}
      threadBodyVisible={props.threadBodyVisible}
      presentation={props.presentation}
      actions={actions}
    />
  );
}

/** Imported native Threads remain readable; executable Sessions use the Runtime binding. */
/** Explicit remote owners retain their native protocol; they never borrow local Runtime identity. */
function ConnectedRemoteSessionThread(
  props: ConnectedSessionThreadProps & {
    readonly thread: NonNullable<WorkbenchSessionRenderProjection["thread"]>;
  },
) {
  const { thread } = props;
  const control = useCodexAppServerControl(thread.threadId, thread.executionHostId);
  const [modes, setModes] = useState<
    import("../../../shared/types").CodexCollaborationModePreset[]
  >([]);
  const [selectedMode, setMode] = useState<CodexCollaborationModeKind>("default");
  const loadModels = control.loadModels;
  const listModes = control.listCollaborationModes;
  useEffect(() => {
    let active = true;
    void loadModels().catch(() => undefined);
    void listModes()
      .then((value) => {
        if (active) setModes(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [loadModels, listModes]);
  const summary: CodexThreadSummary = {
    ...thread,
    source: null,
    threadName: thread.threadName ?? props.session.displayTitle,
    cwd: thread.cwd ?? null,
  };
  const actions = createRemoteCodexStageActions({
    hostId: thread.executionHostId,
    threadId: thread.threadId,
    projectId: props.session.projectId,
    control,
    host: {
      onQueueingEnabledChange: props.onQueueingEnabledChange,
      onOpenThread: props.onOpenThread,
      onStartNewChatWithPrompt: props.onStartNewChatWithPrompt,
    },
    onModeChanged: setMode,
  });
  return (
    <SharedConnectedSessionThread
      {...props}
      selectedNewThreadProjectId={props.session.projectId}
      setSelectedNewThreadProjectId={() => {}}
      agent={{
        summary,
        actions,
        models: control.availableModels,
        modes,
        selectedMode,
        selectedModel: control.threadSettings.model ?? "",
        selectedEffort: control.threadSettings.reasoningEffort ?? "medium",
        reasoningEffortOptions: control.reasoningEffortOptions,
      }}
    />
  );
}

function ConnectedSessionThread(props: ConnectedSessionThreadProps) {
  const thread = props.session.thread;
  if (thread && !props.session.executionRef) {
    if (thread.backendBinding.kind === "codex" && thread.executionHostId !== "local")
      return <ConnectedRemoteSessionThread {...props} thread={thread} />;
    if (props.composerDock) return null;
    return <NativeHistorySessionThread {...props} thread={thread} />;
  }
  return <ConnectedRuntimeSessionThread {...props} />;
}

export function SessionThreadPage(
  props: Omit<
    ConnectedSessionThreadProps,
    "composerDock" | "composerScopeIdentity" | "projectDraftId" | "onMaterializeProjectDraft"
  >,
) {
  return <ConnectedSessionThread {...props} />;
}

export function SessionThreadComposerDock(
  props: ConnectedSessionThreadProps & {
    readonly composerDock: NonNullable<ConnectedSessionThreadProps["composerDock"]>;
  },
) {
  return <ConnectedSessionThread {...props} />;
}

export function ProjectSessionThreadComposerDock({
  session,
  project,
  projects,
  composerDock,
  composerScopeIdentity,
  browserUseViewScopeId,
  newThreadStartBlockedReason,
  projectDraftId = null,
  onMaterializeProjectDraft,
  onCommitMaterializedProjectDraft,
  onRefreshProjectSessions,
  onEnsureDefaultDraftSessionForProject,
  onOpenPendingWorktree,
  onRequestProjectPickerOpen,
  onOpenLocalEnvironmentsSettings,
  onOpenHooksSettings,
  onOpenVoiceSettings,
  threadQueueFollowUpsEnabled,
  composerEnterBehavior,
  onQueueingEnabledChange,
  onOpenThread,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onForkSessionFromTurn,
  onForkSession,
  commandKeymapState,
  isMac,
}: {
  readonly session: WorkbenchSessionRenderProjection;
  readonly project: Project;
  readonly projects: Project[];
  readonly composerDock: NonNullable<ConnectedSessionThreadProps["composerDock"]>;
  readonly composerScopeIdentity: string;
  readonly browserUseViewScopeId: string;
  readonly newThreadStartBlockedReason?: string | null;
  readonly projectDraftId?: string | null;
  readonly onMaterializeProjectDraft?: SessionThreadCommands["onMaterializeProjectDraft"];
  readonly onCommitMaterializedProjectDraft?: SessionThreadCommands["onCommitMaterializedProjectDraft"];
  readonly onRefreshProjectSessions: ConnectedSessionThreadProps["onRefreshProjectSessions"];
  readonly onEnsureDefaultDraftSessionForProject: ConnectedSessionThreadProps["onEnsureDefaultDraftSessionForProject"];
  readonly onOpenPendingWorktree: ConnectedSessionThreadProps["onOpenPendingWorktree"];
  readonly onRequestProjectPickerOpen: ConnectedSessionThreadProps["onRequestProjectPickerOpen"];
  readonly onOpenLocalEnvironmentsSettings: ConnectedSessionThreadProps["onOpenLocalEnvironmentsSettings"];
  readonly onOpenHooksSettings: ConnectedSessionThreadProps["onOpenHooksSettings"];
  readonly onOpenVoiceSettings?: ConnectedSessionThreadProps["onOpenVoiceSettings"];
  readonly threadQueueFollowUpsEnabled: boolean;
  readonly composerEnterBehavior: ComposerEnterBehavior;
  readonly onQueueingEnabledChange: ConnectedSessionThreadProps["onQueueingEnabledChange"];
  readonly onOpenThread: ConnectedSessionThreadProps["onOpenThread"];
  readonly onOpenTurnDiffReview?: ConnectedSessionThreadProps["onOpenTurnDiffReview"];
  readonly onOpenTurnDiffFileInSidePanel?: ConnectedSessionThreadProps["onOpenTurnDiffFileInSidePanel"];
  readonly onForkSessionFromTurn?: ConnectedSessionThreadProps["onForkSessionFromTurn"];
  readonly onForkSession?: ConnectedSessionThreadProps["onForkSession"];
  readonly commandKeymapState?: CommandKeymapState | null;
  readonly isMac: boolean;
}) {
  const noOp = () => undefined;
  const noOpAsync = async () => undefined;

  return (
    <ConnectedSessionThread
      session={session}
      project={project}
      projects={projects}
      routeActive
      threadBodyVisible={false}
      onRefreshProjectSessions={onRefreshProjectSessions}
      onEnsureDefaultDraftSessionForProject={onEnsureDefaultDraftSessionForProject}
      onOpenPendingWorktree={onOpenPendingWorktree}
      onRequestProjectPickerOpen={onRequestProjectPickerOpen}
      onOpenLocalEnvironmentsSettings={onOpenLocalEnvironmentsSettings}
      onOpenHooksSettings={onOpenHooksSettings}
      onOpenVoiceSettings={onOpenVoiceSettings}
      threadQueueFollowUpsEnabled={threadQueueFollowUpsEnabled}
      composerEnterBehavior={composerEnterBehavior}
      onQueueingEnabledChange={onQueueingEnabledChange}
      onOpenThread={onOpenThread}
      onOpenSubagentsPanel={undefined}
      onOpenTurnDiffReview={onOpenTurnDiffReview}
      onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
      onOpenSummaryGitReview={undefined}
      turnDiffHoverPreviewDisabled
      onForkSessionFromTurn={onForkSessionFromTurn}
      onForkSession={onForkSession}
      onForkFromTurnIntoWorktree={noOpAsync}
      searchOpenTick={0}
      summaryPanelMounted={false}
      summaryPanelOpen={false}
      summaryPanelHideImmediately={false}
      summaryPanelContentShift={0}
      summarySideChatRows={[]}
      summaryBrowserRows={[]}
      summaryScheduledAutomation={null}
      summaryComputerUsePip={null}
      onOpenSummarySideChatRow={noOp}
      onOpenSummaryBrowserRow={noOp}
      onOpenSummaryScheduledAutomation={noOp}
      onOpenSummaryOutputInSidePanel={() => false}
      onToggleSummaryComputerUsePip={noOp}
      rightPanelComposerOverlayEnabled={false}
      rightPanelComposerOverlayTarget={null}
      onOpenMcpAppSidePanel={undefined}
      onOpenPlanInSidePanel={undefined}
      onClosePlanSidePanel={undefined}
      planSidePanelState={null}
      onRequestRenameThread={undefined}
      onArchiveThread={noOpAsync}
      onToggleThreadPin={noOpAsync}
      commandKeymapState={commandKeymapState}
      isMac={isMac}
      presentation="panel"
      composerDock={composerDock}
      composerScopeIdentity={composerScopeIdentity}
      browserUseViewScopeId={browserUseViewScopeId}
      newThreadStartBlockedReason={newThreadStartBlockedReason}
      projectDraftId={projectDraftId}
      onMaterializeProjectDraft={onMaterializeProjectDraft}
      onCommitMaterializedProjectDraft={onCommitMaterializedProjectDraft}
    />
  );
}

import { ConversationRuntimeContext } from "@/features/local-conversation/conversation-runtime";
import { useAgentConversationAdapter } from "@/features/local-conversation/agent-conversation-adapter";
import type { ConversationProviderPresentation } from "@/features/local-conversation/thread-stage-types";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ConnectedThreadComposerDock,
  ConnectedThreadStage,
  useCodexAppServerControl,
  useCodexThreadStartProgress,
  type ThreadActionControllerInput,
  type ThreadStageActions,
} from "@/features/local-conversation";
import type { RightPanelComposerOverlayVisibility } from "@/features/local-conversation/view/right-panel-composer-overlay";
import { createThreadStageActions } from "@/features/local-conversation/thread-action-controller";
import { composeNativeThreadStageActions } from "@/features/local-conversation/native-thread-stage-actions";
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
import { getGitWorkerClient } from "@/lib/api";
import { useAgentInstances } from "@/features/local-conversation/use-agent-instances";
import { useAgentModelCatalogs } from "@/features/local-conversation/use-agent-model-catalog";
import { agentBindingKey, selectAgentCatalogModel } from "@/lib/agent-model-selection";
import { nativeAgentDraftKey, nativeAgentDraftOwner } from "@/lib/native-agent-draft-owner";
import { selectNativeModel } from "@/lib/native-intelligence-selection";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { buildSettingsPath } from "./workbench-settings-routes";
import { resolveReasoningEffortForModelChange } from "@/components/shared/agent-runtime/agent-intelligence-dropdown";
import type { AgentModelPickerEntry } from "@/components/shared/agent-runtime/agent-model-picker";
import type {
  AgentModelSelection,
  ExternalAgentBinding,
} from "../../../shared/agent-model-catalog";
import {
  newThreadBackendSelectionOwner,
  resolveNewThreadBackendUnavailableReason,
  type NewThreadBackendSelection,
} from "@/lib/new-thread-backend-selection";
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
  CodexCollaborationModeKind,
  CodexCollaborationModePreset,
  CodexComposerIntent,
  PageRunInTarget,
  Project,
} from "@/lib/types";
import type { CodexPendingWorktreeStartingState } from "../../../shared/codex-pending-worktree";
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
import { projectSessionThreadLinkToSummary } from "./thread-summary-projection";
import { useThreadExecutionHandoff } from "@/lib/thread-handoff-runtime";

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
  onRefreshProjectSessions,
  onEnsureDefaultDraftSessionForProject,
  onStartNewChatWithPrompt,
  onOpenPendingWorktree,
  newThreadComposerIntent,
  onConsumeNewThreadComposerIntent,
  onRequestProjectPickerOpen,
  onOpenLocalEnvironmentsSettings,
  onOpenHooksSettings,
  onOpenVoiceSettings,
  threadQueueFollowUpsEnabled,
  composerEnterBehavior,
  onQueueingEnabledChange,
  onOpenThread,
  onOpenSubagentsPanel,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenSummaryGitReview,
  turnDiffHoverPreviewDisabled,
  onForkSessionFromTurn,
  onForkFromTurnIntoWorktree,
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
  rightPanelComposerOverlayCompact,
  rightPanelComposerOverlayTarget,
  rightPanelComposerOverlayVisibility,
  onOpenSideChat,
  onOpenMcpAppSidePanel,
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
  browserUseViewScopeId,
  newThreadStartBlockedReason,
  projectDraftId,
  onMaterializeProjectDraft,
  onCommitMaterializedProjectDraft,
}: {
  agent?: ReturnType<typeof useAgentConversationAdapter>;
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
  onForkSessionFromTurn?: ThreadActionControllerInput["onForkSessionFromTurn"];
  onForkFromTurnIntoWorktree: (input: { threadId: string; targetTurnId: string }) => Promise<void>;
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
  rightPanelComposerOverlayCompact: boolean;
  rightPanelComposerOverlayTarget: HTMLElement | null;
  rightPanelComposerOverlayVisibility?: RightPanelComposerOverlayVisibility;
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
    readonly visibility: RightPanelComposerOverlayVisibility;
    readonly leadingContent: React.ReactNode;
  };
  composerScopeIdentity?: string | null;
  browserUseViewScopeId?: string | null;
  newThreadStartBlockedReason?: string | null;
  projectDraftId?: string | null;
  onMaterializeProjectDraft?: ThreadActionControllerInput["onMaterializeProjectDraft"];
  onCommitMaterializedProjectDraft?: ThreadActionControllerInput["onCommitMaterializedProjectDraft"];
}) {
  const attachedSummary = session.thread ? projectSessionThreadLinkToSummary(session.thread) : null;
  const [selectedNewThreadRunInTarget, setSelectedNewThreadRunInTarget] =
    useState<PageRunInTarget>("localProject");
  const [selectedNewThreadStartingState, setSelectedNewThreadStartingState] = useState<
    CodexPendingWorktreeStartingState | undefined
  >(undefined);
  const [environmentSelections, setEnvironmentSelections] = useState(
    readLocalEnvironmentSelections,
  );
  const [canForkCurrentThreadIntoWorktree, setCanForkCurrentThreadIntoWorktree] = useState(false);
  const selectedNewThreadProject =
    selectedNewThreadProjectId === null
      ? null
      : (projects.find((candidate) => candidate.id === selectedNewThreadProjectId) ??
        project ??
        null);
  const progressProjectId = attachedSummary
    ? session.projectId
    : (selectedNewThreadProject?.id ?? null);
  const threadStartProgress = useCodexThreadStartProgress(progressProjectId, session.id);
  const summary = attachedSummary;
  const hasAttachedSummary = summary !== null;
  const executionHandoff = useThreadExecutionHandoff(summary?.threadId ?? null);
  const executionHandoffCompletion =
    executionHandoff && executionHandoff.status !== "running"
      ? `${executionHandoff.operationId}:${executionHandoff.revision}`
      : null;
  const refreshExecutionSession = useEffectEvent(() => {
    void onRefreshProjectSessions(session.projectId).catch(() => undefined);
  });
  useEffect(() => {
    if (!executionHandoffCompletion) return;
    refreshExecutionSession();
  }, [executionHandoffCompletion]);
  const startInSelectorProject = summary ? project : selectedNewThreadProject;
  const newThreadEnvironmentWorkspaceRoot = projectWorkspaceRootOrNull(startInSelectorProject);
  const effectiveProjectId = summary ? session.projectId : (selectedNewThreadProject?.id ?? null);
  const codexControl = useCodexAppServerControl(
    effectiveProjectId,
    agent ? null : (summary?.threadId ?? null),
    session.thread?.executionHostId ?? null,
  );
  const usesExternalAgent = Boolean(agent);
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
  const loadModels = codexControl.loadModels;
  const listCollaborationModes = codexControl.listCollaborationModes;
  const [collaborationModes, setCollaborationModes] = useState<CodexCollaborationModePreset[]>([]);
  const [selectedCollaborationMode, setSelectedCollaborationMode] =
    useState<CodexCollaborationModeKind>("default");
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
    setSelectedNewThreadRunInTarget("localProject");
    setSelectedNewThreadStartingState(undefined);
  }, [session.id, session.projectId, summary, setSelectedNewThreadProjectId]);

  useEffect(() => {
    setSelectedNewThreadStartingState(undefined);
  }, [effectiveProjectId, newThreadEnvironmentWorkspaceRoot]);

  useEffect(() => {
    if (selectedNewThreadProjectId === null) return;
    if (projects.some((candidate) => candidate.id === selectedNewThreadProjectId)) {
      return;
    }
    setSelectedNewThreadProjectId(session.projectId);
  }, [projects, selectedNewThreadProjectId, session.projectId, setSelectedNewThreadProjectId]);

  useEffect(() => {
    if (usesExternalAgent && hasAttachedSummary) return;
    void loadModels().catch(() => undefined);
    void listCollaborationModes()
      .then(setCollaborationModes)
      .catch(() => setCollaborationModes([]));
  }, [usesExternalAgent, hasAttachedSummary, listCollaborationModes, loadModels]);

  useEffect(() => {
    const cwd = summary?.cwd?.trim();
    if (!cwd) {
      setCanForkCurrentThreadIntoWorktree(false);
      return;
    }

    let disposed = false;
    setCanForkCurrentThreadIntoWorktree(false);
    void getGitWorkerClient()
      .request({
        method: "branch-metadata",
        params: { cwd },
      })
      .then((state) => {
        if (disposed) return;
        setCanForkCurrentThreadIntoWorktree(
          Boolean(state.currentBranch || state.defaultBranch || state.branches.length > 0),
        );
      })
      .catch(() => {
        if (!disposed) setCanForkCurrentThreadIntoWorktree(false);
      });

    return () => {
      disposed = true;
    };
  }, [summary?.cwd]);

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
    (agent && !projectWorkspaceRootOrNull(selectedNewThreadProject) && !summary
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

  const codexActions = useMemo<ThreadStageActions>(
    () => ({
      ...createThreadStageActions({
        activeThreadId: summary?.threadId ?? null,
        browserUseViewScopeId,
        codexControl,
        currentSessionId: session.id,
        onEnsureDefaultDraftSessionForProject,
        onRefreshProjectSessions,
        onOpenPendingWorktree,
        newThreadStartBlockedReason: effectiveNewThreadStartBlockedReason,
        onQueueingEnabledChange,
        onOpenThread,
        onOpenSubagentsPanel,
        onOpenTurnDiffReview,
        onOpenTurnDiffFileInSidePanel,
        onForkSessionFromTurn,
        currentSessionProjectId: session.projectId,
        projectId: effectiveProjectId,
        onNewThreadProjectChange: setSelectedNewThreadProjectId,
        onRequestNewChatProjectCreate: onRequestProjectPickerOpen,
        onStartNewChatWithPrompt,
        onNewThreadStartInTargetChange: (target) => {
          setSelectedNewThreadRunInTarget(target.runInTarget);
          setSelectedNewThreadStartingState(target.worktreeStartingState);
        },
        onNewThreadStartInEnvironmentChange: changeNewThreadEnvironment,
        onRefreshNewThreadStartInEnvironments: refreshNewThreadEnvironments,
        onOpenNewThreadLocalEnvironmentsSettings: (configPath) =>
          onOpenLocalEnvironmentsSettings({
            projectId: effectiveProjectId,
            configPath: configPath ?? null,
          }),
        onOpenHooksSettings,
        onOpenVoiceSettings,
        ...(onOpenSideChat
          ? {
              onOpenSideChat: async (input: ThreadOpenSideChatInput = {}) => {
                await onOpenSideChat({
                  ...input,
                  collaborationMode: selectedCollaborationMode,
                });
              },
            }
          : {}),
        onOpenMcpAppSidePanel,
        onOpenPlanInSidePanel,
        onClosePlanSidePanel,
        onOpenSummarySideChatRow,
        onOpenSummaryBrowserRow,
        onOpenSummaryScheduledAutomation,
        onOpenSummaryOutputInSidePanel,
        onOpenSummaryGitReview,
        onOpenProcessManager,
        onOpenBackgroundTerminalOutput,
        onToggleSummaryComputerUsePip,
        onRequestRenameThread,
        onArchiveThread,
        onToggleThreadPin,
        selectedCollaborationMode,
        setSelectedCollaborationMode,
        onMaterializeProjectDraft,
        onCommitMaterializedProjectDraft,
      }),
      ...(onConsumeNewThreadComposerIntent ? { onConsumeNewThreadComposerIntent } : {}),
    }),
    [
      browserUseViewScopeId,
      codexControl,
      onEnsureDefaultDraftSessionForProject,
      onStartNewChatWithPrompt,
      onRefreshProjectSessions,
      onOpenPendingWorktree,
      effectiveNewThreadStartBlockedReason,
      onQueueingEnabledChange,
      onOpenThread,
      onOpenSubagentsPanel,
      onOpenTurnDiffReview,
      onOpenTurnDiffFileInSidePanel,
      onForkSessionFromTurn,
      onRequestProjectPickerOpen,
      onOpenLocalEnvironmentsSettings,
      onOpenHooksSettings,
      onOpenVoiceSettings,
      onOpenSideChat,
      onOpenMcpAppSidePanel,
      onOpenPlanInSidePanel,
      onClosePlanSidePanel,
      onOpenSummarySideChatRow,
      onOpenSummaryBrowserRow,
      onOpenSummaryScheduledAutomation,
      onOpenSummaryOutputInSidePanel,
      onOpenSummaryGitReview,
      onOpenProcessManager,
      onOpenBackgroundTerminalOutput,
      onToggleSummaryComputerUsePip,
      onConsumeNewThreadComposerIntent,
      onRequestRenameThread,
      onArchiveThread,
      onToggleThreadPin,
      session.id,
      session.projectId,
      changeNewThreadEnvironment,
      refreshNewThreadEnvironments,
      effectiveProjectId,
      selectedCollaborationMode,
      setSelectedNewThreadProjectId,
      onMaterializeProjectDraft,
      onCommitMaterializedProjectDraft,
      summary?.threadId,
    ],
  );

  const openNativeDiagnostics = useOpenNativeRuntimeDiagnostics(provider?.diagnostics);
  const actions = agent
    ? composeNativeThreadStageActions(codexActions, {
        ...agent.actions,
        ...(provider?.diagnostics ? { onOpenStatusPanel: openNativeDiagnostics } : {}),
      })
    : codexActions;

  const externalCatalog = provider?.modelCatalog;
  const codexEntries: readonly AgentModelPickerEntry[] =
    !agent || !summary
      ? codexControl.availableModels
          .filter((model) => !model.hidden)
          .map((model) => ({
            binding: { kind: "codex" },
            label: "Codex",
            model,
            selection: { binding: { kind: "codex" }, model: model.id },
          }))
      : [];
  const presentedProvider =
    provider && externalCatalog
      ? {
          ...provider,
          modelCatalog: {
            ...externalCatalog,
            entries: [...codexEntries, ...externalCatalog.entries],
            selected: agent
              ? externalCatalog.selected
              : {
                  binding: { kind: "codex" as const },
                  model: codexControl.threadSettings.model ?? "",
                },
            refresh: () => {
              externalCatalog.refresh();
              void loadModels().catch(() => undefined);
            },
            choose: async (selection: AgentModelSelection) => {
              if (selection.binding.kind !== "codex") return externalCatalog.choose(selection);
              const effort = resolveReasoningEffortForModelChange({
                models: codexControl.availableModels,
                nextModelId: selection.model,
                currentReasoningEffort: codexControl.threadSettings.reasoningEffort ?? "medium",
              });
              await codexActions.onModelChange(selection.model);
              if (effort) await codexActions.onReasoningEffortChange(effort);
              if (!summary) provider.select?.("codex");
            },
          },
        }
      : provider;

  const connectedStageProps = {
    provider: presentedProvider,
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
    availableModels: agent?.models ?? codexControl.availableModels,
    selectedExecutionProfile: agent ? null : codexControl.executionProfile,
    collaborationModes: agent?.modes ?? collaborationModes,
    selectedCollaborationMode: agent?.selectedMode ?? selectedCollaborationMode,
    selectedModel: agent?.selectedModel ?? codexControl.threadSettings.model ?? "",
    selectedReasoningEffort:
      agent?.selectedEffort ?? codexControl.threadSettings.reasoningEffort ?? "medium",
    selectedPersonality: codexControl.personality,
    reasoningEffortOptions: agent?.reasoningEffortOptions ?? codexControl.reasoningEffortOptions,
    permissionMode: agent?.permissionMode ?? codexControl.permissionMode,
    isQueueingEnabled: agent ? false : threadQueueFollowUpsEnabled,
    composerEnterBehavior,
    searchOpenTick,
    summarySideChatRows,
    summaryBrowserRows,
    summaryScheduledAutomation,
    summaryComputerUsePip,
    planSidePanelState,
    actions,
  } as const;

  if (composerDock) {
    return (
      <ConnectedThreadComposerDock
        {...connectedStageProps}
        routeActive={routeActive}
        visible={composerDock.visible}
        overlayTarget={composerDock.target}
        overlayVisibility={composerDock.visibility}
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
        rightPanelComposerOverlayCompact={rightPanelComposerOverlayCompact}
        rightPanelComposerOverlayTarget={rightPanelComposerOverlayTarget}
        rightPanelComposerOverlayVisibility={rightPanelComposerOverlayVisibility}
        turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
        routeActive={routeActive}
        threadBodyVisible={threadBodyVisible}
        presentation={presentation}
        onForkFromTurnIntoWorktree={
          !agent && canForkCurrentThreadIntoWorktree ? onForkFromTurnIntoWorktree : undefined
        }
      />
    </div>
  );
}

type ConnectedSessionThreadProps = Omit<
  Parameters<typeof SharedConnectedSessionThread>[0],
  "agent" | "provider" | "selectedNewThreadProjectId" | "setSelectedNewThreadProjectId"
>;

/** Runtime choices are scoped to the Project until the first submission fixes the Thread binding. */
function ConnectedSessionThread(props: ConnectedSessionThreadProps) {
  const thread = props.session.thread;
  const instanceSettings = useAgentInstances();
  const { instances } = instanceSettings;
  const windowOwner = useWorkbenchWindowOwner();
  const selection = useSyncExternalStore(
    (listener) => newThreadBackendSelectionOwner.subscribe(props.session.id, listener),
    () => newThreadBackendSelectionOwner.read(props.session.id),
    (): NewThreadBackendSelection => "codex",
  );
  const binding: ExternalAgentBinding | null = thread
    ? thread.backendBinding.kind === "codex"
      ? null
      : thread.backendBinding
    : selection === "codex"
      ? null
      : selection;
  const draftUnavailableReason = thread
    ? null
    : resolveNewThreadBackendUnavailableReason(selection, instanceSettings);
  const draftUnavailableError = instanceSettings.loading ? null : draftUnavailableReason;
  const [selectedNewThreadProjectId, setSelectedNewThreadProjectId] = useState<string | null>(
    props.session.projectId,
  );
  const modelProjectId = thread ? props.session.projectId : selectedNewThreadProjectId;
  const boundInstance = binding
    ? {
        binding,
        label:
          instances.find(
            (instance) => agentBindingKey(instance.binding) === agentBindingKey(binding),
          )?.label ??
          (binding.kind === "claude"
            ? "Claude Code"
            : binding.kind === "opencode"
              ? "OpenCode"
              : binding.agentDefinitionId),
        enabled: true,
      }
    : null;
  const catalogs = useAgentModelCatalogs({
    instances: thread ? (boundInstance ? [boundInstance] : []) : instances,
    projectId: modelProjectId,
    threadId: binding ? thread?.threadId : null,
    observedExecutionLocation: thread?.cwd,
  });
  const activeCatalog = binding
    ? (catalogs.entries.find(
        (entry) => agentBindingKey(entry.instance.binding) === agentBindingKey(binding),
      )?.catalog ?? null)
    : null;
  const adapter = useAgentConversationAdapter({
    binding,
    summary: thread ? projectSessionThreadLinkToSummary(thread) : null,
    onRefresh: props.onRefreshProjectSessions,
    onOpenThread: props.onOpenThread,
    sessionProjectId: props.session.projectId,
    modelProjectId,
    sessionId: props.session.id,
    ensureDraft: props.onEnsureDefaultDraftSessionForProject,
    materializeDraft: props.onMaterializeProjectDraft,
    commitDraft: props.onCommitMaterializedProjectDraft,
    catalog: activeCatalog,
    refreshCatalog: catalogs.refresh,
    draftUnavailableReason,
  });
  const current: AgentModelSelection = {
    binding: binding ?? { kind: "codex" },
    model: adapter.selectedModel,
    options: adapter.genericIntelligence?.configOptions
      .filter((option) => option.category !== "model")
      .map((option) => ({ id: option.id, value: option.currentValue })),
    modeId: adapter.genericIntelligence?.modes?.currentModeId,
  };
  const entries: readonly AgentModelPickerEntry[] = catalogs.entries.flatMap((entry) => {
    if (!entry.catalog || entry.catalog.health.status !== "ready") return [];
    const catalog = entry.catalog;
    const saved = nativeAgentDraftOwner.read(
      nativeAgentDraftKey(props.session.id, modelProjectId, catalog.binding),
    );
    const previous =
      agentBindingKey(current.binding) === agentBindingKey(catalog.binding)
        ? current
        : {
            binding: catalog.binding,
            model: saved.selection.model,
            options: saved.options,
            modeId: saved.modeId,
          };
    return catalog.models
      .filter((model) => !model.hidden)
      .flatMap((model) => {
        const chosen = selectAgentCatalogModel(catalog, model.id, previous);
        return chosen
          ? [
              {
                binding: catalog.binding,
                label:
                  catalog.binding.kind === "opencode"
                    ? `${entry.instance.label} · ${model.description}`
                    : entry.instance.label,
                model,
                selection: chosen,
              },
            ]
          : [];
      });
  });
  const chooseModel = async (chosen: AgentModelSelection) => {
    if (chosen.binding.kind === "codex") return;
    const unavailable = thread
      ? null
      : resolveNewThreadBackendUnavailableReason(chosen.binding, instanceSettings);
    if (unavailable) throw new Error(unavailable);
    const target = catalogs.entries.find(
      (entry) => agentBindingKey(entry.instance.binding) === agentBindingKey(chosen.binding),
    );
    if (!target?.catalog || !selectAgentCatalogModel(target.catalog, chosen.model, current))
      throw new Error("Refresh models and choose an available model");
    if (thread) {
      if (!binding || agentBindingKey(chosen.binding) !== agentBindingKey(binding))
        throw new Error("Start a new conversation to change runtime");
      await adapter.actions.onModelChange?.(chosen.model);
      return;
    }
    const draftKey = nativeAgentDraftKey(props.session.id, modelProjectId, chosen.binding);
    const draft = nativeAgentDraftOwner.read(draftKey);
    nativeAgentDraftOwner.write(draftKey, {
      selection:
        chosen.binding.kind === "claude"
          ? selectNativeModel(
              draft.selection,
              chosen.model,
              "default",
              target.catalog.claudeDiscovery?.models ?? [],
            )
          : { model: chosen.model, effort: "default" },
      options: chosen.options,
      modeId: chosen.modeId,
    });
    if (!chosen.binding.instanceConfigId) throw new Error("Choose a configured Agent instance");
    newThreadBackendSelectionOwner.write(props.session.id, chosen.binding);
  };
  const provider: ConversationProviderPresentation = {
    kind: binding?.kind ?? "codex",
    label: boundInstance?.label ?? "Codex",
    selection: binding ? agentBindingKey(binding) : "codex",
    options: [],
    select: (value) => {
      if (!thread && value === "codex")
        newThreadBackendSelectionOwner.write(props.session.id, "codex");
    },
    modelCatalog: {
      entries,
      selected: current,
      loading:
        (!thread && instanceSettings.loading) || catalogs.entries.some((entry) => entry.loading),
      error:
        (!thread ? instanceSettings.error : null) ??
        draftUnavailableError ??
        (binding
          ? catalogs.entries.find(
              (entry) => agentBindingKey(entry.instance.binding) === agentBindingKey(binding),
            )?.error
          : null),
      choose: chooseModel,
      runtimeOptions:
        thread || instanceSettings.loading || instanceSettings.error
          ? []
          : instances
              .filter((instance) => instance.enabled && instance.binding.kind === "acp")
              .map((instance) => ({ binding: instance.binding, label: instance.label })),
      chooseRuntime: (chosen) => {
        if (thread || chosen.kind !== "acp") return;
        nativeAgentDraftOwner.write(nativeAgentDraftKey(props.session.id, modelProjectId, chosen), {
          selection: { model: "", effort: "default" },
          options: undefined,
          modeId: undefined,
        });
        newThreadBackendSelectionOwner.write(props.session.id, chosen);
      },
      refresh: () => {
        instanceSettings.refresh();
        catalogs.refresh();
      },
      manage: () => windowOwner.openRoute({ kind: "settings", path: buildSettingsPath("agent") }),
      ...adapter.genericIntelligence,
    },
    commands: adapter.commands,
    controls: adapter.controls,
    skills: adapter.skills,
    refreshSkills: adapter.refreshSkills,
    stopTask: adapter.stopTask,
    nativeIntelligence: adapter.nativeIntelligence,
    history: adapter.history,
    resolveHistoryImage: adapter.resolveHistoryImage,
    readToolOutput: adapter.readToolOutput,
    diagnostics: adapter.diagnostics,
    generateTitle: adapter.generateTitle,
    authentication:
      binding && adapter.state.presentation?.snapshot.status === "authentication-required"
        ? {
            methods: adapter.state.presentation.capabilities.authMethods,
            pending: adapter.state.controlPending === "authenticate",
            signIn: adapter.authenticate,
          }
        : undefined,
    error:
      draftUnavailableError ??
      (binding
        ? (adapter.state.error ??
          adapter.state.presentation?.snapshot.error ??
          adapter.modelCatalogError)
        : null),
  };
  return (
    <ConversationRuntimeContext value={adapter.runtime}>
      <SharedConnectedSessionThread
        {...props}
        newThreadStartBlockedReason={props.newThreadStartBlockedReason ?? draftUnavailableReason}
        agent={binding ? adapter : undefined}
        selectedNewThreadProjectId={selectedNewThreadProjectId}
        setSelectedNewThreadProjectId={setSelectedNewThreadProjectId}
        provider={provider}
      />
    </ConversationRuntimeContext>
  );
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
  readonly onMaterializeProjectDraft?: ThreadActionControllerInput["onMaterializeProjectDraft"];
  readonly onCommitMaterializedProjectDraft?: ThreadActionControllerInput["onCommitMaterializedProjectDraft"];
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
      rightPanelComposerOverlayCompact={false}
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

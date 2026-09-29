import { ConversationRuntimeContext } from "@/features/local-conversation/conversation-runtime";
import { useAgentConversationAdapter } from "@/features/local-conversation/agent-conversation-adapter";
import type { ConversationProviderPresentation } from "@/features/local-conversation/thread-stage-types";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
import { readAcpAgentSettings, readClaudeAgentSettings } from "@/lib/workbench-settings-runtime";
import { resolveRendererTransport } from "@/lib/renderer-transport";
import {
  newThreadBackendSelectionOwner,
  type NewThreadBackendSelection,
} from "@/lib/new-thread-backend-selection";
import type { AcpAgentInstanceConfig } from "../../../shared/types";
import { listWorktreeEnvironmentConfigs } from "@/lib/managed-worktree-runtime";
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
  WorktreeEnvironmentConfigRecord,
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
  type LocalEnvironmentSelectionResolution,
  writeLocalEnvironmentSelection,
} from "./local-environment-selection";
import { projectSessionThreadLinkToSummary } from "./thread-summary-projection";

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
  const [selectedNewThreadEnvironmentPath, setSelectedNewThreadEnvironmentPath] = useState<
    string | null
  >(null);
  const [selectedNewThreadStartingState, setSelectedNewThreadStartingState] = useState<
    CodexPendingWorktreeStartingState | undefined
  >(undefined);
  const [newThreadEnvironmentConfigs, setNewThreadEnvironmentConfigs] = useState<
    WorktreeEnvironmentConfigRecord[]
  >([]);
  const [newThreadEnvironmentResolution, setNewThreadEnvironmentResolution] =
    useState<LocalEnvironmentSelectionResolution | null>(null);
  const [newThreadEnvironmentsLoading, setNewThreadEnvironmentsLoading] = useState(false);
  const [newThreadEnvironmentsError, setNewThreadEnvironmentsError] = useState(false);
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
  const startInSelectorProject = summary ? project : selectedNewThreadProject;
  const newThreadEnvironmentWorkspaceRoot = projectWorkspaceRootOrNull(startInSelectorProject);
  const effectiveProjectId = summary ? session.projectId : (selectedNewThreadProject?.id ?? null);
  const codexControl = useCodexAppServerControl(
    effectiveProjectId,
    agent ? null : (summary?.threadId ?? null),
    session.thread?.executionHostId ?? null,
  );
  const usesExternalAgent = Boolean(agent);
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
    setSelectedNewThreadEnvironmentPath(null);
    setSelectedNewThreadStartingState(undefined);
    setNewThreadEnvironmentResolution(null);
  }, [session.id, session.projectId, summary, setSelectedNewThreadProjectId]);

  useEffect(() => {
    if (selectedNewThreadProjectId === null) return;
    if (projects.some((candidate) => candidate.id === selectedNewThreadProjectId)) {
      return;
    }
    setSelectedNewThreadProjectId(session.projectId);
  }, [projects, selectedNewThreadProjectId, session.projectId, setSelectedNewThreadProjectId]);

  useEffect(() => {
    if (usesExternalAgent) return;
    void loadModels().catch(() => undefined);
    void listCollaborationModes()
      .then(setCollaborationModes)
      .catch(() => setCollaborationModes([]));
  }, [usesExternalAgent, listCollaborationModes, loadModels]);

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

  const refreshNewThreadEnvironments = useCallback(async () => {
    if (effectiveProjectId === null) {
      setNewThreadEnvironmentsLoading(false);
      setNewThreadEnvironmentConfigs([]);
      setSelectedNewThreadEnvironmentPath(null);
      setNewThreadEnvironmentResolution(null);
      return;
    }
    setNewThreadEnvironmentsLoading(true);
    setNewThreadEnvironmentsError(false);
    try {
      const configs = await listWorktreeEnvironmentConfigs(effectiveProjectId);
      const resolution = resolveLocalEnvironmentSelection({
        candidateSource: {
          status: "loaded",
          candidates: configs.map((config) => ({
            configPath: config.configPath,
            state: config.state,
          })),
        },
        selectionsByWorkspace: readLocalEnvironmentSelections(),
        workspaceRoot: newThreadEnvironmentWorkspaceRoot,
      });
      setNewThreadEnvironmentConfigs(configs);
      setNewThreadEnvironmentResolution(resolution);
      setSelectedNewThreadEnvironmentPath(
        resolution.status === "selected" ? resolution.resolvedConfigPath : null,
      );
    } catch (error) {
      setNewThreadEnvironmentConfigs([]);
      setNewThreadEnvironmentsError(true);
      setNewThreadEnvironmentResolution(
        resolveLocalEnvironmentSelection({
          candidateSource: { status: "unresolved", reason: "load-error", error },
          selectionsByWorkspace: readLocalEnvironmentSelections(),
          workspaceRoot: newThreadEnvironmentWorkspaceRoot,
        }),
      );
    } finally {
      setNewThreadEnvironmentsLoading(false);
    }
  }, [effectiveProjectId, newThreadEnvironmentWorkspaceRoot]);

  const changeNewThreadEnvironment = useCallback(
    (configPath: string | null) => {
      setSelectedNewThreadEnvironmentPath(configPath);
      if (!newThreadEnvironmentWorkspaceRoot) return;
      writeLocalEnvironmentSelection({
        workspaceRoot: newThreadEnvironmentWorkspaceRoot,
        configPath,
      });
      setNewThreadEnvironmentResolution(
        resolveLocalEnvironmentSelection({
          candidateSource: {
            status: "loaded",
            candidates: newThreadEnvironmentConfigs.map((config) => ({
              configPath: config.configPath,
              state: config.state,
            })),
          },
          selectionsByWorkspace: readLocalEnvironmentSelections(),
          workspaceRoot: newThreadEnvironmentWorkspaceRoot,
        }),
      );
    },
    [newThreadEnvironmentConfigs, newThreadEnvironmentWorkspaceRoot],
  );

  useEffect(() => {
    if (selectedNewThreadRunInTarget !== "newWorktree") return;
    void refreshNewThreadEnvironments();
  }, [refreshNewThreadEnvironments, selectedNewThreadRunInTarget]);

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
    (agent || selectedNewThreadRunInTarget !== "newWorktree"
      ? null
      : newThreadEnvironmentsLoading || newThreadEnvironmentResolution === null
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
          if (target.runInTarget !== "newWorktree") {
            setSelectedNewThreadEnvironmentPath(null);
          }
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
          runInTarget: agent ? "localProject" : selectedNewThreadRunInTarget,
          runInEnvironmentPath: agent ? null : selectedNewThreadEnvironmentPath,
          worktreeStartingState: agent ? undefined : selectedNewThreadStartingState,
        },
    newThreadProjectSelector: summary
      ? null
      : {
          projects: projectSelectorOptions,
          selectedProjectId: effectiveProjectId,
          disabled: Boolean(projectDraftId),
          canAddProject: !projectDraftId,
        },
    newThreadStartInSelector: agent ? null : startInSelectorModel,
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

function formatAcpAgentInstanceLabel(
  instance: AcpAgentInstanceConfig,
  instanceCount: number,
): string {
  const definitionLabel =
    instance.agentDefinitionId === "claude-agent-acp" ? "Claude Agent" : instance.agentDefinitionId;
  return instanceCount > 1 ? `${definitionLabel} · ${instance.id}` : definitionLabel;
}

/**
 * Backend selection changes the runtime Adapter, never the conversation surface or draft owner.
 */
function ConnectedSessionThread(props: ConnectedSessionThreadProps) {
  const thread = props.session.thread;
  const canChooseBackend = thread === null;
  const [instances, setInstances] = useState<
    readonly { id: string; kind: "acp" | "claude"; label: string; enabled: boolean }[]
  >([]);
  const selection = useSyncExternalStore(
    (listener) => newThreadBackendSelectionOwner.subscribe(props.session.id, listener),
    () => newThreadBackendSelectionOwner.read(props.session.id),
    (): NewThreadBackendSelection => "codex",
  );

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const reload = () => {
      const requestGeneration = ++generation;
      void Promise.all([readAcpAgentSettings(), readClaudeAgentSettings()])
        .then(([acp, claude]) => {
          if (disposed || requestGeneration !== generation) return;
          setInstances([
            ...claude.instances.map((instance) => ({
              id: instance.id,
              kind: "claude" as const,
              label: instance.displayName,
              enabled: instance.enabled,
            })),
            ...acp.instances.map((instance) => ({
              id: instance.id,
              kind: "acp" as const,
              label: formatAcpAgentInstanceLabel(instance, acp.instances.length),
              enabled: instance.enabled,
            })),
          ]);
        })
        .catch(() => {
          if (!disposed && requestGeneration === generation) setInstances([]);
        });
    };
    const release = resolveRendererTransport().subscribeClaudeAgentSettingsChanges(reload);
    reload();
    return () => {
      disposed = true;
      release();
    };
  }, [props.session.id]);

  const binding =
    thread?.backendBinding.kind === "claude" || thread?.backendBinding.kind === "acp"
      ? thread.backendBinding
      : !thread && selection !== "codex"
        ? selection
        : null;
  const [selectedNewThreadProjectId, setSelectedNewThreadProjectId] = useState<string | null>(
    props.session.projectId,
  );
  const modelProjectId =
    selectedNewThreadProjectId === null
      ? null
      : (props.projects.find(({ id }) => id === selectedNewThreadProjectId)?.id ??
        props.project?.id ??
        null);
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
  });
  const provider: ConversationProviderPresentation = {
    kind: binding?.kind ?? "codex",
    label: binding
      ? (instances.find(
          (instance) => instance.id === binding.instanceConfigId && instance.kind === binding.kind,
        )?.label ?? (binding.kind === "claude" ? "Claude Code" : "Agent"))
      : "Codex",
    selection: binding ? `${binding.kind}:${binding.instanceConfigId}` : "codex",
    options: canChooseBackend
      ? [
          { value: "codex", label: "Codex" },
          ...instances
            .filter((instance) => instance.enabled)
            .map((instance) => ({
              value: `${instance.kind}:${instance.id}`,
              label: instance.label,
            })),
        ]
      : [],
    select: (value) =>
      newThreadBackendSelectionOwner.write(
        props.session.id,
        value === "codex"
          ? "codex"
          : {
              kind: value.startsWith("claude:") ? "claude" : "acp",
              instanceConfigId: value.slice(value.indexOf(":") + 1),
            },
      ),
    commands: adapter.commands,
    controls: adapter.controls,
    skills: adapter.skills,
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
    error: binding
      ? (adapter.state.error ??
        adapter.state.presentation?.snapshot.error ??
        adapter.modelCatalogError)
      : null,
  };
  return (
    <ConversationRuntimeContext value={adapter.runtime}>
      <SharedConnectedSessionThread
        {...props}
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
      onRequestProjectPickerOpen={noOp}
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

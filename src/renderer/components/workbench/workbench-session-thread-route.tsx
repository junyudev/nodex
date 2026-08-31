import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AcpConversationStage } from "@/features/acp-conversation/acp-conversation-stage";
import { AcpNewConversationStage } from "@/features/acp-conversation/acp-new-conversation-stage";
import {
  ConnectedThreadComposerDock,
  ConnectedThreadStage,
  useCodexAppServerControl,
  useCodexConversationValue,
  useCodexThreadStartProgress,
  type ThreadActionControllerInput,
  type ThreadStageActions,
} from "@/features/local-conversation";
import type { RightPanelComposerOverlayVisibility } from "@/features/local-conversation/view/right-panel-composer-overlay";
import { createThreadStageActions } from "@/features/local-conversation/thread-action-controller";
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
import { NodexDropdownButtonTrigger, NodexOptionPicker } from "@/components/ui/dropdown";
import { readAcpAgentSettings } from "@/lib/workbench-settings-runtime";
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
import { resolvePresentedSessionThread } from "./workbench-session-thread-presentation";
import {
  readLocalEnvironmentSelections,
  resolveLocalEnvironmentSelection,
  type LocalEnvironmentSelectionResolution,
  writeLocalEnvironmentSelection,
} from "./local-environment-selection";
import { projectSessionThreadLinkToSummary } from "./thread-summary-projection";

function CodexConnectedSessionThread({
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
  const [selectedNewThreadProjectId, setSelectedNewThreadProjectId] = useState<string | null>(
    session.projectId,
  );
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
  const attachedConversationHasVisibleTurn = useCodexConversationValue(
    attachedSummary?.threadId ?? null,
    (conversation) => (conversation?.turns.length ?? 0) > 0,
  );
  const summary = resolvePresentedSessionThread(attachedSummary, {
    rendererLaunchPending: threadStartProgress?.rendererLaunchPending ?? false,
    waitForFirstVisibleTurn: threadStartProgress !== null,
    hasVisibleFirstTurn: attachedConversationHasVisibleTurn,
  });
  const startInSelectorProject = summary ? project : selectedNewThreadProject;
  const newThreadEnvironmentWorkspaceRoot = projectWorkspaceRootOrNull(startInSelectorProject);
  const effectiveProjectId = summary ? session.projectId : (selectedNewThreadProject?.id ?? null);
  const codexControl = useCodexAppServerControl(effectiveProjectId);
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
  }, [session.id, session.projectId, summary]);

  useEffect(() => {
    if (selectedNewThreadProjectId === null) return;
    if (projects.some((candidate) => candidate.id === selectedNewThreadProjectId)) {
      return;
    }
    setSelectedNewThreadProjectId(session.projectId);
  }, [projects, selectedNewThreadProjectId, session.projectId]);

  useEffect(() => {
    void loadModels().catch(() => undefined);
    void listCollaborationModes()
      .then(setCollaborationModes)
      .catch(() => setCollaborationModes([]));
  }, [listCollaborationModes, loadModels]);

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
    (selectedNewThreadRunInTarget !== "newWorktree"
      ? null
      : newThreadEnvironmentsLoading || newThreadEnvironmentResolution === null
        ? "Wait for worktree environments to finish loading."
        : newThreadEnvironmentResolution.status === "needs-attention"
          ? "Repair the selected worktree environment before starting."
          : newThreadEnvironmentResolution.status === "unresolved"
            ? "Worktree environments could not be resolved."
            : null);

  const actions = useMemo<ThreadStageActions>(
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
      onMaterializeProjectDraft,
      onCommitMaterializedProjectDraft,
      summary?.threadId,
    ],
  );

  const connectedStageProps = {
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
          runInEnvironmentPath: selectedNewThreadEnvironmentPath,
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
    newThreadStartInSelector: startInSelectorModel,
    newThreadStartBlockedReason: effectiveNewThreadStartBlockedReason,
    newThreadComposerIntent: summary ? null : (newThreadComposerIntent ?? null),
    threadStartProgress,
    activeThreadId: summary?.threadId ?? null,
    activeThreadSummary: summary,
    availableModels: codexControl.availableModels,
    selectedExecutionProfile: codexControl.executionProfile,
    collaborationModes,
    selectedCollaborationMode,
    selectedModel: codexControl.threadSettings.model ?? "",
    selectedReasoningEffort: codexControl.threadSettings.reasoningEffort ?? "medium",
    selectedPersonality: codexControl.personality,
    reasoningEffortOptions: codexControl.reasoningEffortOptions,
    permissionMode: codexControl.permissionMode,
    isQueueingEnabled: threadQueueFollowUpsEnabled,
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
          canForkCurrentThreadIntoWorktree ? onForkFromTurnIntoWorktree : undefined
        }
      />
    </div>
  );
}

type ConnectedSessionThreadProps = Parameters<typeof CodexConnectedSessionThread>[0];

function formatAcpAgentInstanceLabel(
  instance: AcpAgentInstanceConfig,
  instanceCount: number,
): string {
  const definitionLabel =
    instance.agentDefinitionId === "claude-agent-acp" ? "Claude Agent" : instance.agentDefinitionId;
  return instanceCount > 1 ? `${definitionLabel} · ${instance.id}` : definitionLabel;
}

/**
 * Owns the backend choice without changing the Codex subtree's React position
 * while a fresh Session acquires its durable Thread binding.
 */
function ConnectedSessionThread(props: ConnectedSessionThreadProps) {
  const thread = props.session.thread;
  const canChooseBackend = thread === null;
  const [instances, setInstances] = useState<readonly AcpAgentInstanceConfig[]>([]);
  const selection = useSyncExternalStore(
    (listener) => newThreadBackendSelectionOwner.subscribe(props.session.id, listener),
    () => newThreadBackendSelectionOwner.read(props.session.id),
    (): NewThreadBackendSelection => "codex",
  );

  useEffect(() => {
    if (!canChooseBackend) {
      setInstances([]);
      return;
    }

    let disposed = false;
    void readAcpAgentSettings()
      .then((settings) => {
        if (disposed) return;
        setInstances(settings.instances.filter(({ enabled }) => enabled));
      })
      .catch(() => {
        if (!disposed) setInstances([]);
      });
    return () => {
      disposed = true;
    };
  }, [canChooseBackend, props.session.id]);

  const selectedInstance =
    !canChooseBackend || selection === "codex"
      ? null
      : (instances.find(({ id }) => id === selection.acpInstanceId) ?? null);
  const attachedAcpThread =
    thread?.backendBinding.kind === "acp"
      ? { thread, backendBinding: thread.backendBinding }
      : null;

  if (props.composerDock) {
    if (attachedAcpThread || selectedInstance) return null;
    return <CodexConnectedSessionThread {...props} />;
  }

  const instanceLabel = (instance: AcpAgentInstanceConfig) =>
    formatAcpAgentInstanceLabel(instance, instances.length);
  const content = attachedAcpThread ? (
    <AcpConversationStage
      threadId={attachedAcpThread.thread.threadId}
      agentLabel={
        attachedAcpThread.backendBinding.agentDefinitionId === "claude-agent-acp"
          ? "Claude Agent"
          : attachedAcpThread.backendBinding.agentDefinitionId
      }
      cwd={attachedAcpThread.thread.cwd}
      projectWorkspacePath={projectWorkspaceRootOrNull(props.project)}
    />
  ) : selectedInstance ? (
    <AcpNewConversationStage
      sessionId={props.session.id}
      instanceConfigId={selectedInstance.id}
      agentLabel={instanceLabel(selectedInstance)}
      projectName={props.project?.name ?? null}
      onStarted={async (threadId) => {
        await props.onRefreshProjectSessions(props.session.projectId);
        await props.onOpenThread(threadId);
      }}
    />
  ) : (
    <CodexConnectedSessionThread {...props} />
  );

  return (
    <div className="relative h-full min-h-0">
      {canChooseBackend && instances.length > 0 ? (
        <div className="absolute top-3 right-4 z-30" data-new-thread-backend-selector="true">
          <NodexOptionPicker
            value={selection === "codex" ? "codex" : selection.acpInstanceId}
            options={[
              { value: "codex", label: "Codex" },
              ...instances.map((instance) => ({
                value: instance.id,
                label: instanceLabel(instance),
              })),
            ]}
            onValueChange={(value) =>
              newThreadBackendSelectionOwner.write(
                props.session.id,
                value === "codex" ? "codex" : { acpInstanceId: value },
              )
            }
            triggerButton={
              <NodexDropdownButtonTrigger chrome="transparent" muted size="sm">
                {selectedInstance ? instanceLabel(selectedInstance) : "Codex"}
              </NodexDropdownButtonTrigger>
            }
          />
        </div>
      ) : null}
      {content}
    </div>
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

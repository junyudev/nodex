import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivitySpinnerIcon, NodexLogoMarkIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import {
  ConnectedThreadStage,
  useCodexAppServerControl,
  useConversation,
  type ThreadStageActions,
} from "@/features/local-conversation";
import { createThreadStageActions } from "@/features/local-conversation/thread-action-controller";
import type { ThreadOpenSubagentPayload } from "@/features/local-conversation/thread-stage-types";
import {
  SubagentsPanelDetailHeader,
  SubagentsPanelOverview,
} from "@/features/local-conversation/view/subagents-panel/subagents-panel";
import type { ComposerEnterBehavior } from "@/lib/composer-enter-behavior";
import { subscribeCodexEvents } from "@/lib/api";
import { resolveSideChatProjectId } from "@/lib/side-chat-conversation-context";
import type {
  CodexCollaborationModeKind,
  CodexCollaborationModePreset,
  Project,
} from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import type {
  BackgroundAgentPanelTab,
  SideChatPanelTab,
  SubagentsPanelTab,
} from "@/lib/workbench-panel-tab-model";
import { projectWorkspaceRootOrNull } from "@/lib/workbench-workspace-context";
import {
  SideChatExpiredPanel,
  SideChatFailedPanel,
  SideChatLoadingPanel,
} from "./workbench-side-chat-panels";
import {
  projectSubagentOverviewRowToOpenPayload,
  projectThreadStatusToSubagentOpenStatus,
} from "./workbench-subagent-status";

export function BackgroundAgentSessionTab({
  tab,
  activeSession,
  projects,
  onRefreshSessions,
  onOpenMcpAppSidePanel,
  onOpenHooksSettings,
  threadQueueFollowUpsEnabled,
  composerEnterBehavior,
  onQueueingEnabledChange,
  onOpenThread,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  turnDiffHoverPreviewDisabled,
}: {
  tab: BackgroundAgentPanelTab;
  activeSession: WorkbenchSessionRenderProjection;
  projects: Project[];
  onRefreshSessions: (projectId: string) => Promise<WorkbenchSessionRenderProjection[]>;
  onOpenMcpAppSidePanel: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenHooksSettings: NonNullable<ThreadStageActions["onOpenHooksSettings"]>;
  threadQueueFollowUpsEnabled: boolean;
  composerEnterBehavior: ComposerEnterBehavior;
  onQueueingEnabledChange: ThreadStageActions["onQueueingEnabledChange"];
  onOpenThread: ThreadStageActions["onOpenThread"];
  onOpenTurnDiffReview: ThreadStageActions["onOpenTurnDiffReview"];
  onOpenTurnDiffFileInSidePanel: NonNullable<ThreadStageActions["onOpenTurnDiffFileInSidePanel"]>;
  turnDiffHoverPreviewDisabled: boolean;
}) {
  const project = projects.find((candidate) => candidate.id === tab.projectId) ?? null;
  const conversation = useConversation(tab.threadId);
  const codexControl = useCodexAppServerControl(tab.projectId);
  const loadModels = codexControl.loadModels;
  const listCollaborationModes = codexControl.listCollaborationModes;
  const [collaborationModes, setCollaborationModes] = useState<CodexCollaborationModePreset[]>([]);
  const [selectedCollaborationMode, setSelectedCollaborationMode] =
    useState<CodexCollaborationModeKind>("default");

  useEffect(() => {
    void loadModels().catch(() => undefined);
    void listCollaborationModes()
      .then(setCollaborationModes)
      .catch(() => setCollaborationModes([]));
  }, [listCollaborationModes, loadModels]);

  const actions = useMemo(
    () =>
      createThreadStageActions({
        activeThreadId: tab.threadId,
        codexControl,
        onEnsureDefaultDraftSessionForProject: async () => activeSession,
        onRefreshProjectSessions: (projectId) =>
          projectId === null ? Promise.resolve([]) : onRefreshSessions(projectId),
        onQueueingEnabledChange,
        onOpenThread,
        onOpenTurnDiffReview,
        onOpenTurnDiffFileInSidePanel,
        currentSessionId: activeSession.id,
        currentSessionProjectId: activeSession.projectId ?? tab.projectId,
        projectId: tab.projectId,
        onNewThreadProjectChange: () => undefined,
        onRequestNewChatProjectCreate: () => undefined,
        onNewThreadStartInTargetChange: () => undefined,
        onNewThreadStartInEnvironmentChange: () => undefined,
        onRefreshNewThreadStartInEnvironments: async () => undefined,
        onOpenNewThreadLocalEnvironmentsSettings: () => undefined,
        onOpenMcpAppSidePanel,
        onOpenHooksSettings,
        selectedCollaborationMode,
        setSelectedCollaborationMode,
      }),
    [
      activeSession,
      codexControl,
      onOpenMcpAppSidePanel,
      onOpenHooksSettings,
      onOpenThread,
      onOpenTurnDiffReview,
      onOpenTurnDiffFileInSidePanel,
      onQueueingEnabledChange,
      onRefreshSessions,
      selectedCollaborationMode,
      tab.projectId,
      tab.threadId,
    ],
  );

  if (!conversation) {
    return <BackgroundAgentLoadingPanel title={tab.title} />;
  }

  return (
    <div
      className="h-full min-h-0 bg-token-main-surface-primary"
      data-background-agent-side-panel-tab={tab.id}
    >
      <ConnectedThreadStage
        projectId={tab.projectId}
        composerScopeIdentity={`background-agent:${tab.id}`}
        projectWorkspacePath={projectWorkspaceRootOrNull(project)}
        isNewThreadTab={false}
        newThreadTarget={null}
        newThreadProjectSelector={null}
        newThreadStartInSelector={null}
        threadStartProgress={null}
        activeThreadId={tab.threadId}
        activeThreadSummary={conversation}
        backgroundAgentDetail={true}
        backgroundAgentCanInteract={tab.subagent.canInteract === true}
        availableModels={codexControl.availableModels}
        selectedExecutionProfile={codexControl.executionProfile}
        collaborationModes={collaborationModes}
        selectedCollaborationMode={selectedCollaborationMode}
        selectedModel={codexControl.threadSettings.model ?? ""}
        selectedReasoningEffort={codexControl.threadSettings.reasoningEffort ?? "medium"}
        selectedPersonality={codexControl.personality}
        reasoningEffortOptions={codexControl.reasoningEffortOptions}
        permissionMode={codexControl.permissionMode}
        isQueueingEnabled={threadQueueFollowUpsEnabled}
        composerEnterBehavior={composerEnterBehavior}
        searchOpenTick={0}
        summaryPanelMounted={false}
        summaryPanelOpen={false}
        summaryPanelHideImmediately={false}
        summaryPanelContentShift={0}
        turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
        actions={actions}
      />
    </div>
  );
}

export function SubagentsPanelSessionTab({
  tab,
  activeSession,
  projects,
  onRefreshSessions,
  onOpenMcpAppSidePanel,
  onOpenHooksSettings,
  threadQueueFollowUpsEnabled,
  composerEnterBehavior,
  onQueueingEnabledChange,
  onOpenThread,
  onRouteSubagent,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  turnDiffHoverPreviewDisabled,
}: {
  tab: SubagentsPanelTab;
  activeSession: WorkbenchSessionRenderProjection;
  projects: Project[];
  onRefreshSessions: (projectId: string) => Promise<WorkbenchSessionRenderProjection[]>;
  onOpenMcpAppSidePanel: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenHooksSettings: NonNullable<ThreadStageActions["onOpenHooksSettings"]>;
  threadQueueFollowUpsEnabled: boolean;
  composerEnterBehavior: ComposerEnterBehavior;
  onQueueingEnabledChange: ThreadStageActions["onQueueingEnabledChange"];
  onOpenThread: ThreadStageActions["onOpenThread"];
  onRouteSubagent: (subagent: ThreadOpenSubagentPayload | null) => Promise<boolean>;
  onOpenTurnDiffReview: ThreadStageActions["onOpenTurnDiffReview"];
  onOpenTurnDiffFileInSidePanel: NonNullable<ThreadStageActions["onOpenTurnDiffFileInSidePanel"]>;
  turnDiffHoverPreviewDisabled: boolean;
}) {
  const selectedConversation = useConversation(tab.selectedThreadId);
  const codexControl = useCodexAppServerControl(tab.projectId);
  const refreshSelectedSubagentAuthority = codexControl.refreshSelectedSubagentAuthority;
  const [selectedCanInteract, setSelectedCanInteract] = useState(false);
  useEffect(() => {
    const selectedThreadId = tab.selectedThreadId;
    setSelectedCanInteract(false);
    if (!selectedThreadId || tab.selectedHydration?.status !== "ready") return;
    let disposed = false;
    let timer: number | null = null;
    let sequence = 0;
    const refreshAuthority = (): void => {
      const requestSequence = ++sequence;
      setSelectedCanInteract(false);
      void refreshSelectedSubagentAuthority({
        rootThreadId: tab.rootThreadId,
        threadId: selectedThreadId,
      })
        .then((hydrated) => {
          if (disposed || requestSequence !== sequence) return;
          const authorized =
            hydrated.outcome === "ready" &&
            hydrated.rootThreadId === tab.rootThreadId &&
            hydrated.threadId === selectedThreadId;
          setSelectedCanInteract(authorized && hydrated.canInteract);
        })
        .catch(() => {
          if (disposed || requestSequence !== sequence) return;
          setSelectedCanInteract(false);
        });
    };
    const unsubscribe = subscribeCodexEvents((event) => {
      const rootInvalidated =
        event.type === "subagentOverviewInvalidated" && event.rootThreadId === tab.rootThreadId;
      const selectedArchived =
        event.type === "threadArchivedState" && event.threadId === selectedThreadId;
      if (!rootInvalidated && !selectedArchived) return;
      sequence += 1;
      setSelectedCanInteract(false);
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        refreshAuthority();
      }, 75);
    });
    refreshAuthority();
    return () => {
      disposed = true;
      sequence += 1;
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    refreshSelectedSubagentAuthority,
    onRouteSubagent,
    tab.rootThreadId,
    tab.selectedHydration?.status,
    tab.selectedThreadId,
  ]);
  const routeSelectedSubagent = useCallback(
    (subagent: ThreadOpenSubagentPayload) => {
      void onRouteSubagent(subagent);
    },
    [onRouteSubagent],
  );
  const openFromDetail = useCallback<ThreadStageActions["onOpenThread"]>(
    async (threadId, context) => {
      if (context?.subagent?.showInlineActivity === true) {
        await onRouteSubagent(context.subagent);
        return;
      }
      await onOpenThread(threadId, context);
    },
    [onOpenThread, onRouteSubagent],
  );

  if (!tab.selectedThreadId) {
    return (
      <div
        className="h-full min-h-0 bg-token-main-surface-primary"
        data-subagents-side-panel-tab={tab.id}
      >
        <SubagentsPanelOverview
          projectId={tab.projectId}
          rootThreadId={tab.rootThreadId}
          onError={(message) => toast.danger(message)}
          onSelect={(row) => {
            routeSelectedSubagent(projectSubagentOverviewRowToOpenPayload(row));
          }}
        />
      </div>
    );
  }

  const displayName =
    tab.selectedDisplayName ||
    selectedConversation?.agentNickname?.replace(/^@/u, "") ||
    selectedConversation?.threadName ||
    tab.selectedThreadId;
  if (tab.selectedHydration?.status !== "ready") {
    return (
      <div
        className="flex h-full min-h-0 flex-col bg-token-main-surface-primary"
        data-subagents-side-panel-tab={tab.id}
        data-subagents-selected-hydration="pending"
      >
        <SubagentsPanelDetailHeader
          threadId={tab.selectedThreadId}
          displayName={displayName}
          onBack={() => void onRouteSubagent(null)}
        />
        <div className="min-h-0 flex-1">
          <BackgroundAgentLoadingPanel title={displayName} />
        </div>
      </div>
    );
  }
  const detailTab: BackgroundAgentPanelTab = {
    backgroundAgent: true,
    id: `${tab.id}:detail:${tab.selectedThreadId}`,
    sessionId: tab.sessionId,
    projectId: tab.projectId,
    panelId: tab.panelId,
    leafId: tab.leafId,
    threadId: tab.selectedThreadId,
    title: displayName,
    stateKey: tab.stateKey,
    subagent: {
      conversationId: tab.selectedThreadId,
      displayName,
      agentRole: selectedConversation?.agentRole ?? null,
      spawnModel: null,
      status: projectThreadStatusToSubagentOpenStatus(selectedConversation?.statusType),
      statusSummary: null,
      canInteract: selectedCanInteract,
      showInlineActivity: true,
      diffStats: null,
    },
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-token-main-surface-primary"
      data-subagents-side-panel-tab={tab.id}
      data-subagents-selected-hydration="ready"
    >
      <SubagentsPanelDetailHeader
        threadId={tab.selectedThreadId}
        displayName={displayName}
        onBack={() => void onRouteSubagent(null)}
      />
      <div className="min-h-0 flex-1">
        <BackgroundAgentSessionTab
          tab={detailTab}
          activeSession={activeSession}
          projects={projects}
          onRefreshSessions={onRefreshSessions}
          onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
          onOpenHooksSettings={onOpenHooksSettings}
          threadQueueFollowUpsEnabled={threadQueueFollowUpsEnabled}
          composerEnterBehavior={composerEnterBehavior}
          onQueueingEnabledChange={onQueueingEnabledChange}
          onOpenThread={openFromDetail}
          onOpenTurnDiffReview={onOpenTurnDiffReview}
          onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
          turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
        />
      </div>
    </div>
  );
}

function BackgroundAgentLoadingPanel({ title }: { title: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary p-6 select-none">
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col items-center justify-center text-center">
        <div className="relative mb-3 flex size-10 items-center justify-center rounded-xl bg-token-bg-secondary text-token-text-secondary">
          <NodexLogoMarkIcon monochrome className="icon-md shrink-0 opacity-40" />
          <ActivitySpinnerIcon
            className="icon-xs text-token-text-secondary"
            containerClassName="absolute"
          />
        </div>
        <div className="text-base font-semibold text-token-text-primary">{title}</div>
      </div>
    </div>
  );
}

export function SideChatSessionTab({
  tab,
  activeSession,
  projects,
  onRefreshSessions,
  onRecreateSideChat,
  onOpenMcpAppSidePanel,
  onOpenHooksSettings,
  threadQueueFollowUpsEnabled,
  composerEnterBehavior,
  onQueueingEnabledChange,
  onOpenThread,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  turnDiffHoverPreviewDisabled,
}: {
  tab: SideChatPanelTab;
  activeSession: WorkbenchSessionRenderProjection;
  projects: Project[];
  onRefreshSessions: (projectId: string | null) => Promise<WorkbenchSessionRenderProjection[]>;
  onRecreateSideChat: () => void;
  onOpenMcpAppSidePanel: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenHooksSettings: NonNullable<ThreadStageActions["onOpenHooksSettings"]>;
  threadQueueFollowUpsEnabled: boolean;
  composerEnterBehavior: ComposerEnterBehavior;
  onQueueingEnabledChange: ThreadStageActions["onQueueingEnabledChange"];
  onOpenThread: ThreadStageActions["onOpenThread"];
  onOpenTurnDiffReview: ThreadStageActions["onOpenTurnDiffReview"];
  onOpenTurnDiffFileInSidePanel: NonNullable<ThreadStageActions["onOpenTurnDiffFileInSidePanel"]>;
  turnDiffHoverPreviewDisabled: boolean;
}) {
  const conversation = useConversation(tab.threadId);
  const projectId = resolveSideChatProjectId({
    ready: tab.status === "ready",
    conversationProjectId: conversation?.projectId,
    parentProjectId: activeSession.projectId,
  });
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const codexControl = useCodexAppServerControl(projectId);
  const loadModels = codexControl.loadModels;
  const listCollaborationModes = codexControl.listCollaborationModes;
  const [collaborationModes, setCollaborationModes] = useState<CodexCollaborationModePreset[]>([]);
  const [selectedCollaborationMode, setSelectedCollaborationMode] =
    useState<CodexCollaborationModeKind>("default");

  useEffect(() => {
    if (tab.status !== "ready") return;
    void loadModels().catch(() => undefined);
    void listCollaborationModes()
      .then(setCollaborationModes)
      .catch(() => setCollaborationModes([]));
  }, [listCollaborationModes, loadModels, tab.status]);

  const actions = useMemo(
    () =>
      createThreadStageActions({
        activeThreadId: tab.threadId,
        codexControl,
        onEnsureDefaultDraftSessionForProject: async () => activeSession,
        onRefreshProjectSessions: onRefreshSessions,
        onQueueingEnabledChange,
        onOpenThread,
        onOpenTurnDiffReview,
        onOpenTurnDiffFileInSidePanel,
        currentSessionId: activeSession.id,
        currentSessionProjectId: activeSession.projectId,
        projectId,
        onNewThreadProjectChange: () => undefined,
        onRequestNewChatProjectCreate: () => undefined,
        onNewThreadStartInTargetChange: () => undefined,
        onNewThreadStartInEnvironmentChange: () => undefined,
        onRefreshNewThreadStartInEnvironments: async () => undefined,
        onOpenNewThreadLocalEnvironmentsSettings: () => undefined,
        onOpenMcpAppSidePanel,
        onOpenHooksSettings,
        selectedCollaborationMode,
        setSelectedCollaborationMode,
      }),
    [
      activeSession,
      codexControl,
      onOpenMcpAppSidePanel,
      onOpenHooksSettings,
      onOpenThread,
      onOpenTurnDiffReview,
      onOpenTurnDiffFileInSidePanel,
      onQueueingEnabledChange,
      onRefreshSessions,
      selectedCollaborationMode,
      projectId,
      tab.threadId,
    ],
  );

  if (tab.status === "loading") {
    return <SideChatLoadingPanel title={tab.title} />;
  }

  if (tab.status === "failed") {
    return (
      <SideChatFailedPanel
        errorMessage={tab.errorMessage ?? "The side chat could not be opened."}
        onRetry={onRecreateSideChat}
      />
    );
  }

  if (tab.status === "expired" || !tab.threadId || !conversation) {
    return <SideChatExpiredPanel onRecreateSideChat={onRecreateSideChat} />;
  }

  return (
    <div className="h-full min-h-0 bg-token-main-surface-primary">
      <ConnectedThreadStage
        projectId={projectId}
        composerScopeIdentity={`side-chat:${tab.id}`}
        projectWorkspacePath={projectWorkspaceRootOrNull(project)}
        isNewThreadTab={false}
        newThreadTarget={null}
        newThreadProjectSelector={null}
        newThreadStartInSelector={null}
        threadStartProgress={null}
        activeThreadId={tab.threadId}
        activeThreadSummary={conversation}
        availableModels={codexControl.availableModels}
        selectedExecutionProfile={codexControl.executionProfile}
        collaborationModes={collaborationModes}
        selectedCollaborationMode={selectedCollaborationMode}
        selectedModel={codexControl.threadSettings.model ?? ""}
        selectedReasoningEffort={codexControl.threadSettings.reasoningEffort ?? "medium"}
        selectedPersonality={codexControl.personality}
        reasoningEffortOptions={codexControl.reasoningEffortOptions}
        permissionMode={codexControl.permissionMode}
        isQueueingEnabled={threadQueueFollowUpsEnabled}
        composerEnterBehavior={composerEnterBehavior}
        searchOpenTick={0}
        summaryPanelMounted={false}
        summaryPanelOpen={false}
        summaryPanelHideImmediately={false}
        summaryPanelContentShift={0}
        sideChatContext={{
          parentThreadId: tab.parentThreadId,
          tabTitle: tab.title,
        }}
        turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
        actions={actions}
      />
    </div>
  );
}

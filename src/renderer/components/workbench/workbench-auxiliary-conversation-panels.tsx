import { useCallback, useEffect, useState } from "react";
import { ActivitySpinnerIcon, NodexLogoMarkIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import {
  ConnectedThreadStage,
  useCodexAppServerControl,
  useConversation,
  type ThreadStageActions,
} from "@/features/local-conversation";
import { createRemoteCodexStageActions } from "@/features/local-conversation/remote-codex-stage-actions";
import { composeNativeThreadStageActions } from "@/features/local-conversation/native-thread-stage-actions";
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
import {
  AgentRuntimeChildPanel,
  AgentRuntimeSubagentsOverviewPanel,
  AgentRuntimeSideChatPanel,
} from "./workbench-agent-runtime-panels";

export function BackgroundAgentSessionTab(
  props: Parameters<typeof NativeBackgroundAgentSessionTab>[0],
) {
  if (!props.activeSession.executionRef) return <NativeBackgroundAgentSessionTab {...props} />;
  return (
    <div
      className="h-full min-h-0 bg-token-main-surface-primary"
      data-background-agent-side-panel-tab={props.tab.id}
    >
      <AgentRuntimeChildPanel
        session={props.activeSession}
        threadId={props.tab.threadId}
        title={props.tab.title}
        project={props.projects.find((value) => value.id === props.tab.projectId) ?? null}
        canInteract={props.tab.subagent.canInteract === true}
        composerEnterBehavior={props.composerEnterBehavior}
        queueingEnabled={props.threadQueueFollowUpsEnabled}
        onRefresh={props.onRefreshSessions}
        onOpenThread={props.onOpenThread}
        hostActions={{
          onQueueingEnabledChange: props.onQueueingEnabledChange,
          onOpenMcpAppSidePanel: props.onOpenMcpAppSidePanel,
          onOpenHooksSettings: props.onOpenHooksSettings,
          onOpenTurnDiffReview: props.onOpenTurnDiffReview,
          onOpenTurnDiffFileInSidePanel: props.onOpenTurnDiffFileInSidePanel,
        }}
        turnDiffHoverPreviewDisabled={props.turnDiffHoverPreviewDisabled}
      />
    </div>
  );
}

function NativeBackgroundAgentSessionTab({
  tab,
  activeSession,
  projects,
  onOpenMcpAppSidePanel,
  onOpenHooksSettings,
  onStartNewChatWithPrompt,
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
  onStartNewChatWithPrompt?: ThreadStageActions["onStartNewChatWithPrompt"];
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
  const codexControl = useCodexAppServerControl(
    tab.threadId,
    activeSession.thread?.executionHostId ?? null,
  );
  const remoteHostId = activeSession.thread?.executionHostId;
  const isRemoteOwner = Boolean(remoteHostId && remoteHostId !== "local");
  const loadModels = codexControl.loadModels;
  const listCollaborationModes = codexControl.listCollaborationModes;
  const [collaborationModes, setCollaborationModes] = useState<CodexCollaborationModePreset[]>([]);
  const [selectedCollaborationMode, setSelectedCollaborationMode] =
    useState<CodexCollaborationModeKind>("default");

  useEffect(() => {
    if (!isRemoteOwner || tab.subagent.canInteract !== true) return;
    void loadModels().catch(() => undefined);
    void listCollaborationModes()
      .then(setCollaborationModes)
      .catch(() => setCollaborationModes([]));
  }, [isRemoteOwner, listCollaborationModes, loadModels, tab.subagent.canInteract]);

  const hostActions = {
    onStartNewChatWithPrompt,
    onQueueingEnabledChange,
    onOpenThread,
    onOpenTurnDiffReview,
    onOpenTurnDiffFileInSidePanel,
  };
  const actions =
    isRemoteOwner && remoteHostId
      ? createRemoteCodexStageActions({
          hostId: remoteHostId,
          threadId: tab.threadId ?? "",
          projectId: tab.projectId,
          control: codexControl,
          host: hostActions,
          onModeChanged: setSelectedCollaborationMode,
        })
      : composeNativeThreadStageActions(hostActions, {});
  actions.onOpenMcpAppSidePanel = onOpenMcpAppSidePanel;
  actions.onOpenHooksSettings = onOpenHooksSettings;

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
        executionAvailable={isRemoteOwner}
        backgroundAgentCanInteract={isRemoteOwner && tab.subagent.canInteract === true}
        availableModels={codexControl.availableModels}
        selectedExecutionProfile={codexControl.executionProfile}
        collaborationModes={collaborationModes}
        selectedCollaborationMode={selectedCollaborationMode}
        selectedModel={codexControl.threadSettings.model ?? ""}
        selectedReasoningEffort={codexControl.threadSettings.reasoningEffort ?? "medium"}
        selectedPersonality={codexControl.personality}
        reasoningEffortOptions={codexControl.reasoningEffortOptions}

        isQueueingEnabled={threadQueueFollowUpsEnabled}
        composerEnterBehavior={composerEnterBehavior}
        searchOpenTick={0}
        summaryPanelMounted={false}
        summaryPanelOpen={false}
        summaryPanelHideImmediately={false}
        turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
        actions={actions}
      />
    </div>
  );
}

export function SubagentsPanelSessionTab(
  props: Parameters<typeof NativeSubagentsPanelSessionTab>[0],
) {
  if (!props.activeSession.executionRef) return <NativeSubagentsPanelSessionTab {...props} />;
  if (!props.tab.selectedThreadId)
    return (
      <AgentRuntimeSubagentsOverviewPanel
        sessionId={props.activeSession.id}
        threadId={props.tab.rootThreadId}
        onSelect={(subagent) => void props.onRouteSubagent(subagent)}
      />
    );
  const displayName = props.tab.selectedDisplayName ?? "Subagent";
  const pending = props.tab.selectedHydration?.status !== "ready";
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-token-main-surface-primary"
      data-subagents-side-panel-tab={props.tab.id}
      data-subagents-selected-hydration={pending ? "pending" : "ready"}
    >
      <SubagentsPanelDetailHeader
        threadId={props.tab.selectedThreadId}
        displayName={displayName}
        onBack={() => void props.onRouteSubagent(null)}
      />
      <div className="min-h-0 flex-1">
        {pending ? (
          <BackgroundAgentLoadingPanel title={displayName} />
        ) : (
          <AgentRuntimeChildPanel
            session={props.activeSession}
            threadId={props.tab.selectedThreadId}
            title={displayName}
            project={props.projects.find((value) => value.id === props.tab.projectId) ?? null}
            canInteract={props.tab.selectedCanInteract === true}
            composerEnterBehavior={props.composerEnterBehavior}
            queueingEnabled={props.threadQueueFollowUpsEnabled}
            onRefresh={props.onRefreshSessions}
            onOpenThread={props.onOpenThread}
            hostActions={{
              onQueueingEnabledChange: props.onQueueingEnabledChange,
              onOpenMcpAppSidePanel: props.onOpenMcpAppSidePanel,
              onOpenHooksSettings: props.onOpenHooksSettings,
              onOpenTurnDiffReview: props.onOpenTurnDiffReview,
              onOpenTurnDiffFileInSidePanel: props.onOpenTurnDiffFileInSidePanel,
            }}
            turnDiffHoverPreviewDisabled={props.turnDiffHoverPreviewDisabled}
          />
        )}
      </div>
    </div>
  );
}

function NativeSubagentsPanelSessionTab({
  tab,
  activeSession: sourceSession,
  projects,
  onRefreshSessions,
  onOpenMcpAppSidePanel,
  onOpenHooksSettings,
  onStartNewChatWithPrompt,
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
  onStartNewChatWithPrompt?: ThreadStageActions["onStartNewChatWithPrompt"];
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
  const selectedThreadSettings = selectedConversation?.canonicalState
    ? {
        model: selectedConversation.canonicalState.latestModel,
        reasoningEffort: selectedConversation.canonicalState.latestReasoningEffort,
      }
    : selectedConversation?.latestThreadSettings;
  const codexControl = useCodexAppServerControl(
    tab.selectedThreadId ?? tab.rootThreadId,
    sourceSession.thread?.executionHostId ?? null,
  );
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
      if (context?.isSourceCurrent?.() === false) return;
      if (context?.subagent?.showInlineActivity === true) {
        await onRouteSubagent(context.subagent);
        return;
      }
      if (context?.createdTarget || context?.sourceRoot) {
        const root = sourceSession.thread;
        if (
          sourceSession.id !== tab.sessionId ||
          root?.backendBinding.kind !== "codex" ||
          root.threadId !== tab.rootThreadId
        )
          return;
        await onOpenThread(threadId, {
          ...context,
          sourceRoot: { hostId: root.executionHostId, threadId: tab.rootThreadId },
        });
        return;
      }
      await onOpenThread(threadId, context);
    },
    [onOpenThread, onRouteSubagent, sourceSession, tab.rootThreadId, tab.sessionId],
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
  if (
    tab.selectedHydration === null ||
    (tab.selectedHydration.status === "pending" && tab.selectedHydration.showLoading !== false)
  ) {
    return (
      <div
        className="flex h-full min-h-0 flex-col bg-token-main-surface-primary"
        data-subagents-side-panel-tab={tab.id}
        data-subagents-selected-hydration="pending"
      >
        <SubagentsPanelDetailHeader
          threadId={tab.selectedThreadId}
          threadSettings={selectedThreadSettings}
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
        threadSettings={selectedThreadSettings}
        displayName={displayName}
        onBack={() => void onRouteSubagent(null)}
      />
      <div className="min-h-0 flex-1">
        <BackgroundAgentSessionTab
          tab={detailTab}
          activeSession={sourceSession}
          projects={projects}
          onRefreshSessions={onRefreshSessions}
          onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
          onOpenHooksSettings={onOpenHooksSettings}
          onStartNewChatWithPrompt={onStartNewChatWithPrompt}
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

export function SideChatSessionTab(props: Parameters<typeof NativeSideChatSessionTab>[0]) {
  const session = props.tab.runtimeSession;
  if (!session) return <NativeSideChatSessionTab {...props} />;
  return (
    <AgentRuntimeSideChatPanel
      session={session}
      parentThreadId={props.tab.parentThreadId}
      title={props.tab.title}
      initialSubmission={props.tab.initialSubmission}
      project={props.projects.find((candidate) => candidate.id === session.projectId) ?? null}
      draft={
        props.tab.draftPrompt || props.tab.draftPromptInput
          ? {
              prompt: props.tab.draftPrompt ?? "",
              promptInput: props.tab.draftPromptInput,
              focusNonce: props.tab.stateKey,
            }
          : null
      }
      onRefresh={props.onRefreshSessions}
      onOpenThread={props.onOpenThread}
      composerEnterBehavior={props.composerEnterBehavior}
      hostActions={{
        onOpenTurnDiffReview: props.onOpenTurnDiffReview,
        onOpenTurnDiffFileInSidePanel: props.onOpenTurnDiffFileInSidePanel,
      }}
      turnDiffHoverPreviewDisabled={props.turnDiffHoverPreviewDisabled}
    />
  );
}

function NativeSideChatSessionTab({
  tab,
  activeSession,
  projects,
  onRecreateSideChat,
  onOpenMcpAppSidePanel,
  onOpenHooksSettings,
  onStartNewChatWithPrompt,
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
  onStartNewChatWithPrompt?: ThreadStageActions["onStartNewChatWithPrompt"];
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
  const codexControl = useCodexAppServerControl(
    tab.threadId,
    activeSession.thread?.executionHostId ?? null,
  );
  const remoteHostId = activeSession.thread?.executionHostId;
  const isRemoteOwner = Boolean(remoteHostId && remoteHostId !== "local");
  const loadModels = codexControl.loadModels;
  const listCollaborationModes = codexControl.listCollaborationModes;
  const [collaborationModes, setCollaborationModes] = useState<CodexCollaborationModePreset[]>([]);
  const [selectedCollaborationMode, setSelectedCollaborationMode] =
    useState<CodexCollaborationModeKind>("default");

  useEffect(() => {
    if (!isRemoteOwner || tab.status !== "ready") return;
    void loadModels().catch(() => undefined);
    void listCollaborationModes()
      .then(setCollaborationModes)
      .catch(() => setCollaborationModes([]));
  }, [isRemoteOwner, listCollaborationModes, loadModels, tab.status]);

  const hostActions = {
    onStartNewChatWithPrompt,
    onQueueingEnabledChange,
    onOpenThread,
    onOpenTurnDiffReview,
    onOpenTurnDiffFileInSidePanel,
  };
  const actions =
    isRemoteOwner && remoteHostId
      ? createRemoteCodexStageActions({
          hostId: remoteHostId,
          threadId: tab.threadId ?? "",
          projectId: projectId,
          control: codexControl,
          host: hostActions,
          onModeChanged: setSelectedCollaborationMode,
        })
      : composeNativeThreadStageActions(hostActions, {});
  actions.onOpenMcpAppSidePanel = onOpenMcpAppSidePanel;
  actions.onOpenHooksSettings = onOpenHooksSettings;

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
        executionAvailable={isRemoteOwner}
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

        isQueueingEnabled={threadQueueFollowUpsEnabled}
        composerEnterBehavior={composerEnterBehavior}
        searchOpenTick={0}
        summaryPanelMounted={false}
        summaryPanelOpen={false}
        summaryPanelHideImmediately={false}
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

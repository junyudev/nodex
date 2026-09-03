import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShellHeaderContentRegistrar } from "@/lib/workbench-ui-scopes";
import { resolveCodexElectronDisplayThreadTitle } from "../../../../shared/codex-thread-title";
import { buildCodexTurnOccurrenceKey } from "../../../../shared/codex-turn-identity";
import { buildComposerShellModel } from "../projection/build-composer-shell-model";
import { buildBackgroundSubagentRows } from "../projection/background-subagent-row-model";
import { selectPrimaryBackgroundConversationRequest } from "../conversation-request-helpers";
import { copyConversationMarkdown } from "../copy-conversation-markdown";
import {
  buildThreadBodyModel,
  resolveThreadStartProgressPresentation,
} from "../projection/build-thread-body-model";
import type {
  ThreadBodySurfaceModel,
  ThreadBodyUiStateOverrides,
  ThreadFooterModel,
  ThreadStageActions,
  ThreadStageHeaderModel,
  ThreadStageRouteInput,
} from "../thread-stage-types";
import {
  requestLocalConversationResume,
  markLocalConversationAsRead,
  setLocalConversationThreadViewActive,
  setLocalConversationThreadPresented,
  useComposerIntent,
  useConversationBackgroundTerminalRows,
  useConversationCapabilityFlags,
  useConversationChildMemberships,
  useConversation,
  useConversationAttachmentState,
  useConversationCollaborationMode,
  useConversationThreadSettings,
  useConversationCwd,
  useConversationPendingSteers,
  useConversationPrimaryRequest,
  useConversationQueuedFollowUps,
  useConversationRequests,
  useConversationResumeState,
  useConversationStreamRole,
  useConversationStatusActiveFlags,
  useConversationStatusType,
  useConversationSubset,
  useConversationSummaryFields,
  useConversationTurns,
  useCodexDictationState,
  useCodexAppServerManagerForConversationId,
  useCodexPermissionState,
  useConversationParentThreadId,
  useLocalConversationAccount,
} from "../local-conversation-store";
import { LocalConversationFooter } from "./local-conversation-footer";
import { EnsureLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";
import type { RightPanelComposerOverlayVisibility } from "./right-panel-composer-overlay";
import { LocalConversationNewThreadHomeScreen } from "./local-conversation-new-thread-home-screen";
import { LocalConversationStageScreen } from "./local-conversation-stage-screen";
import { RemoteHostedPipHostLayoutReporter } from "./remote-hosted-pip-host-layout-reporter";
import { ThreadStageHeader } from "./local-conversation-stage-header";
import { LocalConversationThreadBody } from "./local-conversation-thread-body";
import {
  ManagedWorktreeRestoreBannerContainer,
  useManagedWorktreeAvailability,
} from "./managed-worktree-restore-banner";
import { NewThreadHomeHero } from "./new-thread-home-hero";
import {
  ThreadFloatingSummaryPanel,
  ThreadSummaryPanelRenderBoundary,
  ThreadSummaryPanelRenderErrorFallback,
} from "./summary-panel";
import {
  resolveChildConversationIds,
  resolveEffectiveThreadStageSettings,
} from "./connected-thread-stage-model";
import {
  codexComposerChatGptConversationsListQueryOptions,
  codexComposerPluginsListQueryOptions,
  codexComposerSitesListQueryOptions,
  codexComposerSkillsListQueryOptions,
  mcpAppsQueryOptions,
} from "@/lib/query-options";
import {
  useAcknowledgeSessionFirstSubmission,
  useSessionFirstSubmission,
  useSessionFirstSubmissionTurns,
} from "../../conversation-launch/use-session-first-submission";
import type { CodexConversationTurn } from "../../../lib/types";

export type ConnectedThreadStageInput = Omit<
  ThreadStageRouteInput,
  | "conversation"
  | "parentTurns"
  | "knownConversationsById"
  | "connection"
  | "account"
  | "composerIntent"
  | "primaryRequest"
>;

let presentedConversationSurfaceSequence = 0;

function usePresentedConversationIds(conversationIds: readonly string[]): void {
  const [surfaceId] = useState(
    () => `connected-thread-stage:${++presentedConversationSurfaceSequence}`,
  );
  const currentIdsRef = useRef<ReadonlySet<string>>(new Set());
  const updateQueueRef = useRef<Promise<void>>(Promise.resolve());
  const updatePresentedIds = useEffectEvent((nextIds: readonly string[]) => {
    const next = new Set(nextIds.map((conversationId) => conversationId.trim()).filter(Boolean));
    const current = currentIdsRef.current;
    const removed = [...current].filter((conversationId) => !next.has(conversationId));
    const added = [...next].filter((conversationId) => !current.has(conversationId));
    currentIdsRef.current = next;
    updateQueueRef.current = updateQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        for (const conversationId of removed) {
          await setLocalConversationThreadPresented(conversationId, surfaceId, false).catch(
            () => undefined,
          );
        }
        for (const conversationId of added) {
          await setLocalConversationThreadPresented(conversationId, surfaceId, true).catch(
            () => undefined,
          );
        }
      });
  });

  useEffect(() => {
    updatePresentedIds(conversationIds);
  }, [conversationIds]);

  useEffect(
    () => () => {
      updatePresentedIds([]);
    },
    [],
  );
}

interface ConnectedThreadStageProps extends ConnectedThreadStageInput {
  actions: ThreadStageActions;
  composerScopeIdentity?: string | null;
  onForkFromTurnIntoWorktree?: (input: { threadId: string; targetTurnId: string }) => Promise<void>;
  initialUiState?: ThreadBodyUiStateOverrides;
  backgroundAgentDetail?: boolean;
  backgroundAgentCanInteract?: boolean;
  rightPanelComposerOverlayEnabled?: boolean;
  rightPanelComposerOverlayCompact?: boolean;
  rightPanelComposerOverlayTarget?: HTMLElement | null;
  rightPanelComposerOverlayVisibility?: RightPanelComposerOverlayVisibility;
  turnDiffHoverPreviewDisabled?: boolean;
  summaryPanelMounted?: boolean;
  summaryPanelOpen?: boolean;
  summaryPanelHideImmediately?: boolean;
  summaryPanelContentShift?: number;
  routeActive?: boolean;
  threadBodyVisible?: boolean;
  presentation?: "primary" | "panel";
}

function resolveThreadTitle(
  input: ConnectedThreadStageInput,
  summary: ReturnType<typeof useConversationSummaryFields>,
  activeThreadId: string | null,
): string {
  if (input.sideChatContext?.tabTitle) {
    return input.sideChatContext.tabTitle;
  }

  return resolveCodexElectronDisplayThreadTitle({
    threadName: summary.threadName || input.activeThreadSummary?.threadName,
    threadPreview:
      summary.threadPreview ||
      input.activeThreadSummary?.threadPreview ||
      input.newThreadTarget?.threadTitle,
    fallback: input.isNewThreadTab || activeThreadId ? "New thread" : "No thread",
  });
}

function resolveConnectedStageActiveThreadId(input: ConnectedThreadStageInput): string | null {
  if (input.activeThreadId && !input.isNewThreadTab) {
    return input.activeThreadId;
  }

  if (!input.isNewThreadTab || input.threadStartProgress?.phase !== "ready") {
    return null;
  }

  const readyThreadId = input.threadStartProgress.threadId?.trim();
  return readyThreadId ? readyThreadId : null;
}

function ConnectedThreadStageHeader({
  activeThreadId,
  input,
  actions,
  onErrorMessage,
}: {
  activeThreadId: string | null;
  input: ConnectedThreadStageInput;
  actions: ThreadStageActions;
  onErrorMessage: (message: string | null) => void;
}) {
  const summaryFields = useConversationSummaryFields(activeThreadId);
  const cwd = useConversationCwd(activeThreadId);
  const parentConversationId = useConversationParentThreadId(activeThreadId);
  const title = resolveThreadTitle(input, summaryFields, activeThreadId);
  const handleCopyConversationMarkdown = useCallback(async () => {
    if (!activeThreadId) return;
    await copyConversationMarkdown({
      conversationId: activeThreadId,
      parentConversationId,
      title,
    });
  }, [activeThreadId, parentConversationId, title]);

  const headerActions = useMemo<ThreadStageActions>(
    () => ({
      ...actions,
      ...(activeThreadId ? { onCopyConversationMarkdown: handleCopyConversationMarkdown } : {}),
    }),
    [actions, activeThreadId, handleCopyConversationMarkdown],
  );

  const model = useMemo<ThreadStageHeaderModel>(
    () => ({
      projectId: summaryFields.projectId ?? input.projectId,
      sessionId: input.sessionId ?? null,
      threadId: summaryFields.threadId ?? input.activeThreadSummary?.threadId ?? activeThreadId,
      title,
      cwd,
      pinned: input.threadPinned,
      shortcuts: input.threadActionShortcuts,
      showSideChatAction: Boolean(
        activeThreadId && !input.sideChatContext && actions.onOpenSideChat,
      ),
    }),
    [activeThreadId, actions.onOpenSideChat, cwd, input, summaryFields, title],
  );

  return (
    <ThreadStageHeader model={model} actions={headerActions} onErrorMessage={onErrorMessage} />
  );
}

function ConnectedThreadStageBody({
  activeThreadId,
  input,
  actions,
  composerScopeIdentity,
  onForkFromTurnIntoWorktree,
  isWorktreeThread,
  onErrorMessage,
  contentShiftX,
  footer,
  leadingContent,
  initialUiState,
  transcriptVisible = true,
  turnDiffHoverPreviewDisabled = false,
  presentedTurns,
  firstSubmissionActive = false,
}: {
  activeThreadId: string | null;
  input: ConnectedThreadStageInput;
  actions: ThreadStageActions;
  composerScopeIdentity: string | null;
  onForkFromTurnIntoWorktree?: (input: { threadId: string; targetTurnId: string }) => Promise<void>;
  isWorktreeThread: boolean;
  onErrorMessage: (message: string | null) => void;
  contentShiftX?: number;
  footer?: ReactNode;
  leadingContent?: ReactNode;
  initialUiState?: ThreadBodyUiStateOverrides;
  transcriptVisible?: boolean;
  turnDiffHoverPreviewDisabled?: boolean;
  presentedTurns?: CodexConversationTurn[];
  firstSubmissionActive?: boolean;
}) {
  const canonicalTurns = useConversationTurns(activeThreadId);
  const turns = presentedTurns ?? canonicalTurns;
  useAcknowledgeSessionFirstSubmission(
    {
      projectId: input.projectId,
      sessionId: input.sessionId ?? input.newThreadTarget?.sessionId ?? null,
      threadId: activeThreadId,
    },
    canonicalTurns,
    activeThreadId !== null && !input.isNewThreadTab,
  );
  const hostId = useCodexAppServerManagerForConversationId(activeThreadId).getHostId();
  const conversationSnapshot = useConversation(activeThreadId);
  const requests = useConversationRequests(activeThreadId);
  const cwd = useConversationCwd(activeThreadId);
  const resumeState = useConversationResumeState(activeThreadId);
  const attachmentState = useConversationAttachmentState(activeThreadId);
  const statusType = useConversationStatusType(activeThreadId);
  const summaryFields = useConversationSummaryFields(activeThreadId);
  const archived = input.activeThreadSummary?.archived === true || summaryFields.archived;
  const capabilityFlags = useConversationCapabilityFlags(activeThreadId);
  const parentThreadId = useConversationParentThreadId(activeThreadId);
  const parentTurns = useConversationTurns(parentThreadId);
  const childMemberships = useConversationChildMemberships(activeThreadId);
  const childThreadIds = useMemo(
    () => resolveChildConversationIds(activeThreadId, childMemberships),
    [activeThreadId, childMemberships],
  );
  const knownConversationsById = useConversationSubset(childThreadIds);
  const backgroundAgentRows = useMemo(
    () =>
      buildBackgroundSubagentRows({
        childMemberships,
        knownConversationsById,
        parentTurns: turns,
      }),
    [childMemberships, knownConversationsById, turns],
  );
  const actionsWithAttachmentRetry = useMemo<ThreadStageActions>(
    () => ({
      ...actions,
      onRetryThreadAttachment: async (threadId) => {
        onErrorMessage(null);
        await requestLocalConversationResume(threadId).catch(() => null);
      },
    }),
    [actions, onErrorMessage],
  );

  const body = useMemo(
    () =>
      buildThreadBodyModel({
        activeThreadId,
        conversation: conversationSnapshot,
        attachmentState,
        activeThreadArchived: archived,
        parentTurns,
        isNewThreadTab: input.isNewThreadTab,
        newThreadTarget: input.newThreadTarget,
        isCloudNewThreadTarget: Boolean(
          input.isNewThreadTab && input.newThreadTarget?.runInTarget === "cloud",
        ),
        threadStartProgress: input.threadStartProgress,
        firstSubmissionActive,
      }),
    [
      activeThreadId,
      attachmentState,
      archived,
      conversationSnapshot,
      input.isNewThreadTab,
      input.newThreadTarget,
      input.threadStartProgress,
      parentTurns,
      firstSubmissionActive,
    ],
  );

  const model = useMemo<ThreadBodySurfaceModel>(
    () => ({
      projectId: input.projectId,
      hostId,
      composerScopeIdentity,
      sessionId: input.sessionId ?? null,
      threadId: activeThreadId,
      isSideChat: Boolean(input.sideChatContext),
      cwd,
      turns,
      turnPagination: conversationSnapshot?.turnPagination ?? null,
      historyRows: conversationSnapshot?.historyRows,
      conversationEntityGeneration: conversationSnapshot?.conversationEntityGeneration,
      historyTopologyGeneration: conversationSnapshot?.historyTopologyGeneration,
      historyMutationRevision: conversationSnapshot?.historyMutationRevision,
      historyItemWindowsByTurnId: conversationSnapshot?.historyItemWindowsByTurnId,
      turnItemsPaginationById: conversationSnapshot?.turnItemsPaginationById,
      requests,
      canonicalRequests: conversationSnapshot?.canonicalRequests ?? [],
      resumeState,
      attachmentState,
      statusType,
      capabilityFlags,
      body,
      parentTurns,
      childMemberships,
      backgroundAgentRows,
      projectWorkspacePath: input.projectWorkspacePath ?? null,
      projectlessOutputDirectory: conversationSnapshot?.projectlessOutputDirectory ?? null,
      searchOpenTick: input.searchOpenTick,
      threadStartProgress: input.threadStartProgress,
    }),
    [
      activeThreadId,
      body,
      backgroundAgentRows,
      capabilityFlags,
      childMemberships,
      composerScopeIdentity,
      conversationSnapshot?.turnPagination,
      conversationSnapshot?.historyRows,
      conversationSnapshot?.conversationEntityGeneration,
      conversationSnapshot?.historyTopologyGeneration,
      conversationSnapshot?.historyMutationRevision,
      conversationSnapshot?.historyItemWindowsByTurnId,
      conversationSnapshot?.turnItemsPaginationById,
      conversationSnapshot?.canonicalRequests,
      cwd,
      input.projectId,
      input.sessionId,
      hostId,
      input.projectWorkspacePath,
      conversationSnapshot?.projectlessOutputDirectory,
      input.searchOpenTick,
      input.sideChatContext,
      input.threadStartProgress,
      parentTurns,
      requests,
      resumeState,
      attachmentState,
      statusType,
      turns,
    ],
  );

  return (
    <LocalConversationThreadBody
      model={model}
      actions={actionsWithAttachmentRetry}
      isWorktreeThread={isWorktreeThread}
      onForkFromTurnIntoWorktree={onForkFromTurnIntoWorktree}
      onErrorMessage={onErrorMessage}
      contentShiftX={contentShiftX}
      footer={footer}
      leadingContent={leadingContent}
      initialUiState={initialUiState}
      transcriptVisible={transcriptVisible}
      planSidePanelState={input.planSidePanelState ?? null}
      turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
    />
  );
}

export function ConnectedThreadStageFooter({
  activeThreadId,
  input,
  actions,
  composerScopeIdentity,
  errorMessage,
  onErrorMessage,
  variant = "thread",
  rightPanelComposerOverlayEnabled = false,
  rightPanelComposerOverlayCompact = false,
  rightPanelComposerOverlayAtDocumentBottom = false,
  rightPanelComposerOverlayDocumentBottomKey = null,
  rightPanelComposerOverlayTarget = null,
  turnDiffHoverPreviewDisabled = false,
  rightPanelComposerOverlayVisibility,
  rightPanelComposerLeadingContent,
  worktreeRuntimeAvailable = true,
}: {
  activeThreadId: string | null;
  input: ConnectedThreadStageInput;
  actions: ThreadStageActions;
  composerScopeIdentity: string | null;
  errorMessage: string | null;
  onErrorMessage: (message: string | null) => void;
  variant?: "thread" | "newThreadHome";
  rightPanelComposerOverlayEnabled?: boolean;
  rightPanelComposerOverlayCompact?: boolean;
  rightPanelComposerOverlayAtDocumentBottom?: boolean;
  rightPanelComposerOverlayDocumentBottomKey?: string | null;
  rightPanelComposerOverlayTarget?: HTMLElement | null;
  turnDiffHoverPreviewDisabled?: boolean;
  rightPanelComposerOverlayVisibility?: RightPanelComposerOverlayVisibility;
  rightPanelComposerLeadingContent?: ReactNode;
  worktreeRuntimeAvailable?: boolean;
}) {
  const hostId = useCodexAppServerManagerForConversationId(activeThreadId).getHostId();
  const turns = useConversationTurns(activeThreadId);
  const conversationSnapshot = useConversation(activeThreadId);
  const requests = useConversationRequests(activeThreadId);
  const cwd = useConversationCwd(activeThreadId);
  const resumeState = useConversationResumeState(activeThreadId);
  const attachmentState = useConversationAttachmentState(activeThreadId);
  const statusType = useConversationStatusType(activeThreadId);
  const statusActiveFlags = useConversationStatusActiveFlags(activeThreadId);
  const summaryFields = useConversationSummaryFields(activeThreadId);
  const archived = input.activeThreadSummary?.archived === true || summaryFields.archived;
  const childMemberships = useConversationChildMemberships(activeThreadId);
  const pendingSteers = useConversationPendingSteers(activeThreadId);
  const queuedFollowUps = useConversationQueuedFollowUps(activeThreadId);
  const backgroundTerminalRows = useConversationBackgroundTerminalRows(activeThreadId);
  const activeThreadComposerIntent = useComposerIntent(activeThreadId);
  const composerIntent = activeThreadId
    ? activeThreadComposerIntent
    : (input.newThreadComposerIntent ?? null);
  const primaryRequest = useConversationPrimaryRequest(activeThreadId);
  const liveCollaborationMode = useConversationCollaborationMode(activeThreadId);
  const liveThreadSettings = useConversationThreadSettings(activeThreadId);
  const account = useLocalConversationAccount();
  const dictation = useCodexDictationState();
  const permissionState = useCodexPermissionState(input.projectId);
  const composerPluginCwds = useMemo(
    () =>
      Array.from(
        new Set(
          [cwd, input.projectWorkspacePath].flatMap((candidate) =>
            candidate?.trim() ? [candidate.trim()] : [],
          ),
        ),
      ),
    [cwd, input.projectWorkspacePath],
  );
  const composerPluginsQuery = useQuery(codexComposerPluginsListQueryOptions(composerPluginCwds));
  const composerSkillsQuery = useQuery(codexComposerSkillsListQueryOptions(composerPluginCwds));
  const composerAppsQuery = useQuery(mcpAppsQueryOptions());
  const composerSitesQuery = useQuery(codexComposerSitesListQueryOptions());
  const composerChatGptConversationsQuery = useQuery(
    codexComposerChatGptConversationsListQueryOptions(""),
  );
  const { refetch: refetchComposerPlugins } = composerPluginsQuery;
  const { refetch: refetchComposerSkills } = composerSkillsQuery;
  const refreshComposerCapabilities = useCallback(async () => {
    await Promise.all([refetchComposerPlugins(), refetchComposerSkills()]);
  }, [refetchComposerPlugins, refetchComposerSkills]);
  const actionsWithComposerCapabilityRefresh = useMemo<ThreadStageActions>(
    () => ({
      ...actions,
      onComposerCapabilitiesChanged: refreshComposerCapabilities,
    }),
    [actions, refreshComposerCapabilities],
  );
  const childThreadIds = useMemo(
    () => resolveChildConversationIds(activeThreadId, childMemberships),
    [activeThreadId, childMemberships],
  );
  const knownConversationsById = useConversationSubset(childThreadIds);

  const composerShell = useMemo(
    () =>
      buildComposerShellModel({
        threadId: activeThreadId,
        turns,
        requests,
        canonicalRequests: conversationSnapshot?.canonicalRequests ?? [],
        pendingSteers,
        queuedFollowUps: [...queuedFollowUps],
        backgroundTerminalRows,
        childMemberships,
        statusType,
        statusActiveFlags,
        knownConversationsById,
        primaryRequest,
      }),
    [
      activeThreadId,
      backgroundTerminalRows,
      childMemberships,
      conversationSnapshot?.canonicalRequests,
      knownConversationsById,
      pendingSteers,
      primaryRequest,
      queuedFollowUps,
      requests,
      statusActiveFlags,
      statusType,
      turns,
    ],
  );

  const activeTurn = useMemo(
    () => [...turns].reverse().find((turn) => turn.status === "inProgress") ?? null,
    [turns],
  );
  const executionProfile = useMemo(() => {
    if (!activeThreadId) return input.selectedExecutionProfile ?? null;
    if (!liveThreadSettings?.model) return input.activeThreadSummary?.executionProfile ?? null;
    return {
      modelId: liveThreadSettings.model,
      reasoningEffort: liveThreadSettings.reasoningEffort,
      serviceTier: liveThreadSettings.serviceTier ?? null,
    };
  }, [
    activeThreadId,
    input.activeThreadSummary?.executionProfile,
    input.selectedExecutionProfile,
    liveThreadSettings?.model,
    liveThreadSettings?.reasoningEffort,
    liveThreadSettings?.serviceTier,
  ]);
  const effectiveSettings = resolveEffectiveThreadStageSettings({
    activeThreadId,
    liveThreadSettings,
    liveMode: liveCollaborationMode,
    fallbackMode: input.selectedCollaborationMode,
    fallbackModel: input.selectedModel,
    fallbackReasoningEffort: input.selectedReasoningEffort,
    threadExecutionProfile: executionProfile,
    availableModes: input.collaborationModes,
  });
  const { selectedCollaborationMode, selectedModel, selectedReasoningEffort } = effectiveSettings;
  const body = useMemo(
    () =>
      buildThreadBodyModel({
        activeThreadId,
        conversation: conversationSnapshot,
        attachmentState,
        activeThreadArchived: archived,
        parentTurns: [],
        isNewThreadTab: input.isNewThreadTab,
        newThreadTarget: input.newThreadTarget,
        isCloudNewThreadTarget: Boolean(
          input.isNewThreadTab && input.newThreadTarget?.runInTarget === "cloud",
        ),
        threadStartProgress: input.threadStartProgress,
      }),
    [
      activeThreadId,
      attachmentState,
      archived,
      conversationSnapshot,
      input.isNewThreadTab,
      input.newThreadTarget,
      input.threadStartProgress,
    ],
  );
  const model = useMemo<ThreadFooterModel>(
    () => ({
      projectId: input.projectId,
      hostId,
      projectWorkspacePath: input.projectWorkspacePath ?? null,
      threadId: activeThreadId,
      cwd,
      account,
      conversation: activeThreadId
        ? {
            ...(conversationSnapshot ?? {}),
            threadId: activeThreadId,
            projectId: input.projectId,
            source: conversationSnapshot?.source ?? null,
            threadName: input.activeThreadSummary?.threadName ?? null,
            threadPreview: input.activeThreadSummary?.threadPreview ?? "",
            cwd,
            statusType: statusType ?? "notLoaded",
            statusActiveFlags,
            archived,
            createdAt: input.activeThreadSummary?.createdAt ?? 0,
            updatedAt: input.activeThreadSummary?.updatedAt ?? 0,
            linkedAt: input.activeThreadSummary?.linkedAt ?? "",
            latestCollaborationMode: liveCollaborationMode ?? undefined,
            latestThreadSettings: liveThreadSettings,
            resumeState: resumeState ?? "needs_resume",
            turns,
            requests,
            queuedFollowUps: {
              status: "ready",
              ledgerRevision: 0,
              projectionRevision: 0,
              entries: queuedFollowUps,
              inFlightFollowUpId: null,
              editingFollowUpId: null,
              error: null,
            },
            pendingSteers,
            backgroundTerminalRows,
            childMemberships,
            capabilityFlags: {
              canEditLastUserTurn: false,
              canForkFromTurn: false,
              canSearch: true,
              canCollapseTurns: true,
            },
            ephemeral: conversationSnapshot?.ephemeral,
          }
        : null,
      resumeState,
      attachmentState,
      activeTurn,
      isThreadRunning: Boolean(activeTurn || statusType === "active"),
      isNewThreadTab: input.isNewThreadTab,
      isCloudNewThreadTarget: Boolean(
        input.isNewThreadTab && input.newThreadTarget?.runInTarget === "cloud",
      ),
      newThreadTarget: input.newThreadTarget,
      newThreadProjectSelector: input.newThreadProjectSelector ?? null,
      newThreadStartInSelector: input.newThreadStartInSelector ?? null,
      newThreadStartBlockedReason: input.newThreadStartBlockedReason ?? null,
      composerShell,
      body,
      collaborationModes: input.collaborationModes,
      selectedCollaborationMode,
      selectedModel,
      modelPickerShortcut:
        input.modelPickerShortcut === undefined
          ? {
              label: "Ctrl+Shift+M",
              ariaKeyShortcuts: "Control+Shift+M",
            }
          : input.modelPickerShortcut,
      availableModels: input.availableModels,
      executionProfile,
      executionIdentityLocked: Boolean(activeThreadId && executionProfile),
      selectedReasoningEffort,
      selectedPersonality:
        liveThreadSettings?.personality ?? input.selectedPersonality ?? "friendly",
      reasoningEffortOptions: input.reasoningEffortOptions,
      permissionMode: input.permissionMode,
      permissionState,
      isQueueingEnabled: input.isQueueingEnabled,
      composerEnterBehavior: input.composerEnterBehavior,
      composerIntent,
      newThreadComposerIntent: input.newThreadComposerIntent ?? null,
      composerScopeIdentity,
      dictation,
      composerPlugins: composerPluginsQuery.data ?? [],
      composerPluginsLoading: composerPluginsQuery.isPending,
      composerSkills: composerSkillsQuery.data ?? [],
      composerSkillsLoading: composerSkillsQuery.isPending,
      composerApps: composerAppsQuery.data ?? [],
      composerAppsLoading: composerAppsQuery.isPending,
      composerSites: composerSitesQuery.data?.sites ?? [],
      composerSitesAvailable: composerSitesQuery.data?.available === true,
      composerSitesLoading: composerSitesQuery.isPending,
      composerChatGptConversations: composerChatGptConversationsQuery.data?.conversations ?? [],
      composerChatGptConversationsAvailable:
        composerChatGptConversationsQuery.data?.available === true,
      composerChatGptConversationsLoading: composerChatGptConversationsQuery.isPending,
    }),
    [
      activeThreadId,
      activeTurn,
      archived,
      account,
      body,
      backgroundTerminalRows,
      childMemberships,
      conversationSnapshot,
      composerIntent,
      composerScopeIdentity,
      composerAppsQuery.data,
      composerAppsQuery.isPending,
      composerPluginsQuery.data,
      composerPluginsQuery.isPending,
      composerSkillsQuery.data,
      composerSkillsQuery.isPending,
      composerSitesQuery.data,
      composerSitesQuery.isPending,
      composerChatGptConversationsQuery.data,
      composerChatGptConversationsQuery.isPending,
      input.newThreadComposerIntent,
      dictation,
      composerShell,
      cwd,
      input.availableModels,
      input.collaborationModes,
      input.composerEnterBehavior,
      input.activeThreadSummary,
      executionProfile,
      input.isNewThreadTab,
      input.isQueueingEnabled,
      input.modelPickerShortcut,
      input.newThreadProjectSelector,
      input.newThreadStartBlockedReason,
      input.newThreadStartInSelector,
      input.newThreadTarget,
      input.permissionMode,
      permissionState,
      input.projectId,
      input.projectWorkspacePath,
      hostId,
      input.reasoningEffortOptions,
      input.selectedPersonality,
      liveCollaborationMode,
      liveThreadSettings,
      pendingSteers,
      queuedFollowUps,
      requests,
      selectedCollaborationMode,
      selectedModel,
      selectedReasoningEffort,
      resumeState,
      attachmentState,
      statusActiveFlags,
      statusType,
      turns,
    ],
  );

  return (
    <LocalConversationFooter
      model={model}
      actions={actionsWithComposerCapabilityRefresh}
      worktreeRuntimeAvailable={worktreeRuntimeAvailable}
      errorMessage={errorMessage}
      onErrorMessage={onErrorMessage}
      variant={variant}
      rightPanelComposerOverlay={{
        enabled: rightPanelComposerOverlayEnabled,
        compact: rightPanelComposerOverlayCompact,
        documentBottomKey: rightPanelComposerOverlayDocumentBottomKey,
        isAtDocumentBottom: rightPanelComposerOverlayAtDocumentBottom,
        target: rightPanelComposerOverlayTarget,
        visibility: rightPanelComposerOverlayVisibility,
        leadingContent: rightPanelComposerLeadingContent,
      }}
      planSidePanelState={input.planSidePanelState ?? null}
      turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
    />
  );
}

export interface ConnectedThreadComposerDockProps extends ConnectedThreadStageInput {
  readonly actions: ThreadStageActions;
  readonly composerScopeIdentity?: string | null;
  readonly routeActive: boolean;
  readonly visible: boolean;
  readonly overlayTarget: HTMLElement | null;
  readonly overlayVisibility: RightPanelComposerOverlayVisibility;
  readonly leadingContent: ReactNode;
}

/**
 * Footer-only projection of a canonical Session/Thread. It deliberately owns
 * no transcript, virtualizer, scroll position, or app-shell header.
 */
export function ConnectedThreadComposerDock({
  actions,
  composerScopeIdentity = null,
  routeActive,
  visible,
  overlayTarget,
  overlayVisibility,
  leadingContent,
  ...input
}: ConnectedThreadComposerDockProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const activeThreadId = resolveConnectedStageActiveThreadId(input);
  const firstSubmission = useSessionFirstSubmission({
    projectId: input.projectId,
    sessionId: input.sessionId ?? input.newThreadTarget?.sessionId ?? null,
    threadId: activeThreadId,
  });
  const resumeState = useConversationResumeState(activeThreadId);
  const attachmentState = useConversationAttachmentState(activeThreadId);
  const streamRole = useConversationStreamRole(activeThreadId);
  const statusType = useConversationStatusType(activeThreadId);
  const statusActiveFlags = useConversationStatusActiveFlags(activeThreadId);
  const requests = useConversationRequests(activeThreadId);
  const primaryRequest = useConversationPrimaryRequest(activeThreadId);
  const summaryFields = useConversationSummaryFields(activeThreadId);
  const archived = input.activeThreadSummary?.archived === true || summaryFields.archived;
  const childMemberships = useConversationChildMemberships(activeThreadId);
  const childThreadIds = useMemo(
    () => resolveChildConversationIds(activeThreadId, childMemberships),
    [activeThreadId, childMemberships],
  );
  const knownConversationsById = useConversationSubset(childThreadIds);
  const visibleBackgroundRequestConversationId = useMemo(() => {
    for (const membership of childMemberships) {
      const conversation = knownConversationsById[membership.threadId];
      if (selectPrimaryBackgroundConversationRequest(conversation ?? null)) {
        return membership.threadId;
      }
    }
    return null;
  }, [childMemberships, knownConversationsById]);
  const presentedConversationIds = useMemo(() => {
    if (!routeActive || !visible) return [];
    return [activeThreadId, visibleBackgroundRequestConversationId].filter(
      (conversationId): conversationId is string => Boolean(conversationId),
    );
  }, [activeThreadId, routeActive, visible, visibleBackgroundRequestConversationId]);
  usePresentedConversationIds(presentedConversationIds);

  const hasRuntimeWork = Boolean(
    (statusType ?? input.activeThreadSummary?.statusType) === "active" ||
    statusActiveFlags.length > 0 ||
    (input.activeThreadSummary?.statusActiveFlags.length ?? 0) > 0 ||
    requests.length > 0 ||
    primaryRequest,
  );
  const lifecycleActive = routeActive || hasRuntimeWork;

  useEffect(() => {
    if (!activeThreadId || !lifecycleActive) return;
    void setLocalConversationThreadViewActive(activeThreadId, true).catch(() => {});
    return () => {
      void setLocalConversationThreadViewActive(activeThreadId, false).catch(() => {});
    };
  }, [activeThreadId, lifecycleActive]);

  useEffect(() => {
    if (!input.activeThreadId || input.isNewThreadTab || archived) return;
    if (firstSubmission) return;
    if (!lifecycleActive || attachmentState.status === "attaching") return;
    if (attachmentState.status === "failed") return;
    if (resumeState === "resumed" && (streamRole === "owner" || streamRole === "follower")) {
      return;
    }
    void requestLocalConversationResume(input.activeThreadId).catch(() => {});
  }, [
    archived,
    attachmentState,
    firstSubmission,
    input.activeThreadId,
    input.isNewThreadTab,
    lifecycleActive,
    resumeState,
    streamRole,
  ]);

  return (
    <EnsureLocalConversationThreadScrollController>
      <ConnectedThreadStageFooter
        activeThreadId={activeThreadId}
        input={input}
        actions={actions}
        composerScopeIdentity={composerScopeIdentity}
        errorMessage={errorMessage}
        onErrorMessage={setErrorMessage}
        rightPanelComposerOverlayEnabled
        rightPanelComposerOverlayTarget={overlayTarget}
        rightPanelComposerOverlayVisibility={overlayVisibility}
        rightPanelComposerLeadingContent={leadingContent}
        turnDiffHoverPreviewDisabled
      />
    </EnsureLocalConversationThreadScrollController>
  );
}

export function ConnectedThreadStage({
  actions,
  composerScopeIdentity = null,
  onForkFromTurnIntoWorktree,
  initialUiState,
  backgroundAgentDetail = false,
  backgroundAgentCanInteract = false,
  rightPanelComposerOverlayEnabled = false,
  rightPanelComposerOverlayCompact = false,
  rightPanelComposerOverlayTarget = null,
  rightPanelComposerOverlayVisibility,
  turnDiffHoverPreviewDisabled = false,
  summaryPanelMounted = false,
  summaryPanelOpen = false,
  summaryPanelHideImmediately = false,
  summaryPanelContentShift = 0,
  routeActive = true,
  threadBodyVisible = routeActive,
  presentation = "primary",
  ...input
}: ConnectedThreadStageProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const activeThreadId = resolveConnectedStageActiveThreadId(input);
  const isSideChat = Boolean(input.sideChatContext);
  const isNewThreadRoute = input.isNewThreadTab && activeThreadId === null && !isSideChat;
  const resumeState = useConversationResumeState(activeThreadId);
  const attachmentState = useConversationAttachmentState(activeThreadId);
  const streamRole = useConversationStreamRole(activeThreadId);
  const summaryFields = useConversationSummaryFields(activeThreadId);
  const requests = useConversationRequests(activeThreadId);
  const statusType = useConversationStatusType(activeThreadId);
  const statusActiveFlags = useConversationStatusActiveFlags(activeThreadId);
  const primaryRequest = useConversationPrimaryRequest(activeThreadId);
  const turns = useConversationTurns(activeThreadId);
  const firstSubmissionProjection = useSessionFirstSubmissionTurns(
    {
      projectId: input.projectId,
      sessionId: input.sessionId ?? input.newThreadTarget?.sessionId ?? null,
      threadId: activeThreadId,
    },
    turns,
  );
  const presentedTurns = firstSubmissionProjection.turns;
  const hasFirstSubmission = firstSubmissionProjection.submission !== null;
  const hasThreadStartProgress = Boolean(
    input.threadStartProgress &&
    resolveThreadStartProgressPresentation(input.threadStartProgress) === "panel",
  );
  const showNewThreadHome = isNewThreadRoute && !hasFirstSubmission && !hasThreadStartProgress;
  const conversation = useConversation(activeThreadId);
  const backgroundTerminalRows = useConversationBackgroundTerminalRows(activeThreadId);
  const cwd = useConversationCwd(activeThreadId);
  const childMemberships = useConversationChildMemberships(activeThreadId);
  const childThreadIds = useMemo(
    () => resolveChildConversationIds(activeThreadId, childMemberships),
    [activeThreadId, childMemberships],
  );
  const knownConversationsById = useConversationSubset(childThreadIds);
  const visibleBackgroundRequestConversationId = useMemo(() => {
    if (backgroundAgentDetail) return null;
    for (const membership of childMemberships) {
      const conversation = knownConversationsById[membership.threadId];
      if (selectPrimaryBackgroundConversationRequest(conversation ?? null)) {
        return membership.threadId;
      }
    }
    return null;
  }, [backgroundAgentDetail, childMemberships, knownConversationsById]);
  const presentedConversationIds = useMemo(() => {
    const overlayManuallyVisible =
      rightPanelComposerOverlayVisibility?.kind !== "controlled" &&
      rightPanelComposerOverlayVisibility?.kind !== "controlled-browser-auto"
        ? true
        : rightPanelComposerOverlayVisibility.visible;
    const requestSurfaceVisible =
      threadBodyVisible || (rightPanelComposerOverlayEnabled && overlayManuallyVisible);
    if (!routeActive || !requestSurfaceVisible) return [];
    return [
      ...new Set(
        [activeThreadId, visibleBackgroundRequestConversationId].filter(
          (conversationId): conversationId is string =>
            typeof conversationId === "string" && conversationId.length > 0,
        ),
      ),
    ];
  }, [
    activeThreadId,
    rightPanelComposerOverlayEnabled,
    rightPanelComposerOverlayVisibility,
    routeActive,
    threadBodyVisible,
    visibleBackgroundRequestConversationId,
  ]);
  usePresentedConversationIds(presentedConversationIds);
  const isActiveThreadArchived =
    input.activeThreadSummary?.archived === true || summaryFields.archived;
  const activeThreadProjectless = summaryFields.threadId
    ? summaryFields.projectId === null
    : input.activeThreadSummary?.projectId === null;
  const activeThreadTitle = resolveThreadTitle(input, summaryFields, activeThreadId);
  const activeManagedWorktreePath =
    summaryFields.managedWorktreePath ?? input.activeThreadSummary?.managedWorktreePath ?? null;
  const activeThreadIsManagedWorktree = Boolean(activeManagedWorktreePath);
  const managedWorktreeAvailability = useManagedWorktreeAvailability(
    activeThreadId,
    activeThreadIsManagedWorktree && routeActive,
  );
  const worktreeRuntimeAvailable =
    !activeThreadIsManagedWorktree || managedWorktreeAvailability.data?.state === "available";
  const activeThreadHasRuntimeWork = Boolean(
    (statusType ?? input.activeThreadSummary?.statusType) === "active" ||
    statusActiveFlags.length > 0 ||
    (input.activeThreadSummary?.statusActiveFlags.length ?? 0) > 0 ||
    requests.length > 0 ||
    primaryRequest,
  );
  const threadLifecycleActive = routeActive || activeThreadHasRuntimeWork;
  const newestCanonicalRequest = conversation?.canonicalRequests?.at(-1) ?? null;
  const latestTurn = turns.at(-1) ?? null;
  const latestTurnKey = latestTurn
    ? buildCodexTurnOccurrenceKey(latestTurn.turnId, turns.length - 1)
    : null;
  const markActiveConversationAsRead = useCallback(
    (requireWindowFocus: boolean) => {
      if (!routeActive || !threadBodyVisible || !activeThreadId || !conversation?.hasUnreadTurn)
        return;
      if (requireWindowFocus && typeof document !== "undefined" && !document.hasFocus()) return;
      void markLocalConversationAsRead(activeThreadId).catch(() => {});
    },
    [activeThreadId, conversation?.hasUnreadTurn, routeActive, threadBodyVisible],
  );
  const markActiveConversationAsReadOnFocus = useEffectEvent(() => {
    markActiveConversationAsRead(true);
  });
  const summaryPanelContentProps = useMemo(
    () => ({
      activeThreadId,
      activeThreadTitle,
      activeThreadIsManagedWorktree,
      activeThreadProjectless,
      cwd,
      projectlessOutputDirectory: summaryFields.projectlessOutputDirectory,
      projectWorkspacePath: input.projectWorkspacePath ?? null,
      turns,
      backgroundTerminalRows,
      childMemberships,
      knownConversationsById,
      sideChatRows: input.summarySideChatRows ?? [],
      browserRows: input.summaryBrowserRows ?? [],
      scheduledAutomation: input.summaryScheduledAutomation ?? null,
      computerUsePip: input.summaryComputerUsePip ?? null,
      newThreadStartInSelector: input.newThreadStartInSelector,
      actions,
      onOpenThread: actions.onOpenThread,
      onErrorMessage: setErrorMessage,
    }),
    [
      activeThreadId,
      activeThreadTitle,
      activeThreadIsManagedWorktree,
      activeThreadProjectless,
      backgroundTerminalRows,
      childMemberships,
      input.summaryComputerUsePip,
      input.summaryBrowserRows,
      input.summaryScheduledAutomation,
      input.summarySideChatRows,
      knownConversationsById,
      cwd,
      summaryFields.projectlessOutputDirectory,
      input.newThreadStartInSelector,
      input.projectWorkspacePath,
      actions,
      turns,
    ],
  );
  useEffect(() => {
    if (!activeThreadId) return;
    if (!threadLifecycleActive) return;

    void setLocalConversationThreadViewActive(activeThreadId, true).catch(() => {});
    return () => {
      void setLocalConversationThreadViewActive(activeThreadId, false).catch(() => {});
    };
  }, [activeThreadId, threadLifecycleActive]);

  useEffect(() => {
    void latestTurn?.status;
    void latestTurnKey;
    void newestCanonicalRequest;
    const handleFocus = () => markActiveConversationAsReadOnFocus();
    window.addEventListener("focus", handleFocus);
    if (document.hasFocus()) handleFocus();
    return () => window.removeEventListener("focus", handleFocus);
  }, [
    activeThreadId,
    latestTurn?.status,
    latestTurnKey,
    newestCanonicalRequest,
    routeActive,
    threadBodyVisible,
  ]);

  useEffect(() => {
    if (!input.activeThreadId || input.isNewThreadTab) {
      return;
    }
    if (hasFirstSubmission) return;
    if (isActiveThreadArchived) {
      return;
    }
    if (!threadLifecycleActive) {
      return;
    }
    if (!worktreeRuntimeAvailable) return;

    const nextResumeState = resumeState ?? "needs_resume";
    if (attachmentState.status === "attaching" || attachmentState.status === "failed") {
      return;
    }
    if (nextResumeState === "resumed" && (streamRole === "owner" || streamRole === "follower")) {
      return;
    }

    void requestLocalConversationResume(input.activeThreadId).catch(() => {});
  }, [
    isActiveThreadArchived,
    attachmentState,
    hasFirstSubmission,
    resumeState,
    streamRole,
    input.activeThreadId,
    input.isNewThreadTab,
    threadLifecycleActive,
    worktreeRuntimeAvailable,
  ]);

  const ownsRemoteHostedPipHost =
    presentation === "primary" && routeActive && !isSideChat && !backgroundAgentDetail;

  if (showNewThreadHome) {
    return (
      <>
        {ownsRemoteHostedPipHost ? (
          <RemoteHostedPipHostLayoutReporter isCodexHomeAvailable={summaryPanelMounted} />
        ) : null}
        <LocalConversationNewThreadHomeScreen
          hero={
            <NewThreadHomeHero
              actions={actions}
              projectName={input.newThreadTarget?.projectName ?? "this project"}
              projectSelector={input.newThreadProjectSelector}
            />
          }
          body={null}
          footer={
            <ConnectedThreadStageFooter
              activeThreadId={activeThreadId}
              input={input}
              actions={actions}
              composerScopeIdentity={composerScopeIdentity}
              errorMessage={errorMessage}
              onErrorMessage={setErrorMessage}
              variant="newThreadHome"
              rightPanelComposerOverlayEnabled={false}
              rightPanelComposerOverlayTarget={null}
              turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
              worktreeRuntimeAvailable={worktreeRuntimeAvailable}
            />
          }
          floatingContent={
            <ThreadSummaryPanelRenderBoundary
              renderFallback={({ resetError }) => (
                <ThreadSummaryPanelRenderErrorFallback
                  hideImmediately={summaryPanelHideImmediately}
                  mounted={summaryPanelMounted}
                  onRetry={resetError}
                  open={summaryPanelOpen}
                />
              )}
              resetKey={activeThreadId}
            >
              <ThreadFloatingSummaryPanel
                hideImmediately={summaryPanelHideImmediately}
                mounted={summaryPanelMounted}
                open={summaryPanelOpen}
                {...summaryPanelContentProps}
              />
            </ThreadSummaryPanelRenderBoundary>
          }
          contentShiftX={summaryPanelContentShift}
        />
      </>
    );
  }

  const ownsAppShellHeader = presentation === "primary" && !isSideChat && !backgroundAgentDetail;
  const threadHeaderContent = ownsAppShellHeader ? (
    <ConnectedThreadStageHeader
      activeThreadId={activeThreadId}
      input={input}
      actions={actions}
      onErrorMessage={setErrorMessage}
    />
  ) : null;

  return (
    <>
      {ownsRemoteHostedPipHost ? (
        <RemoteHostedPipHostLayoutReporter isCodexHomeAvailable={summaryPanelMounted} />
      ) : null}
      {ownsAppShellHeader ? <AppShellHeaderContentRegistrar content={threadHeaderContent} /> : null}
      <LocalConversationStageScreen
        onReadInteraction={() => markActiveConversationAsRead(false)}
        header={null}
        body={
          <ConnectedThreadStageBody
            activeThreadId={activeThreadId}
            input={input}
            actions={actions}
            composerScopeIdentity={composerScopeIdentity}
            isWorktreeThread={activeThreadIsManagedWorktree}
            onForkFromTurnIntoWorktree={onForkFromTurnIntoWorktree}
            onErrorMessage={setErrorMessage}
            leadingContent={
              activeThreadId && activeThreadIsManagedWorktree ? (
                <ManagedWorktreeRestoreBannerContainer threadId={activeThreadId} />
              ) : null
            }
            contentShiftX={summaryPanelContentShift}
            footer={
              backgroundAgentDetail && !backgroundAgentCanInteract ? null : (
                <ConnectedThreadStageFooter
                  activeThreadId={activeThreadId}
                  input={input}
                  actions={actions}
                  composerScopeIdentity={composerScopeIdentity}
                  errorMessage={errorMessage}
                  onErrorMessage={setErrorMessage}
                  rightPanelComposerOverlayEnabled={rightPanelComposerOverlayEnabled && !isSideChat}
                  rightPanelComposerOverlayCompact={rightPanelComposerOverlayCompact}
                  rightPanelComposerOverlayTarget={rightPanelComposerOverlayTarget}
                  rightPanelComposerOverlayVisibility={rightPanelComposerOverlayVisibility}
                  turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
                  worktreeRuntimeAvailable={worktreeRuntimeAvailable}
                />
              )
            }
            initialUiState={initialUiState}
            transcriptVisible={threadBodyVisible}
            turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
            presentedTurns={presentedTurns}
            firstSubmissionActive={hasFirstSubmission}
          />
        }
        floatingContent={
          <ThreadSummaryPanelRenderBoundary
            renderFallback={({ resetError }) => (
              <ThreadSummaryPanelRenderErrorFallback
                hideImmediately={summaryPanelHideImmediately}
                mounted={summaryPanelMounted}
                onRetry={resetError}
                open={summaryPanelOpen}
              />
            )}
            resetKey={activeThreadId}
          >
            <ThreadFloatingSummaryPanel
              hideImmediately={summaryPanelHideImmediately}
              mounted={summaryPanelMounted}
              open={summaryPanelOpen}
              {...summaryPanelContentProps}
            />
          </ThreadSummaryPanelRenderBoundary>
        }
      />
    </>
  );
}

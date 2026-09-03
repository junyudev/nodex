import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { appScope, useScopeHandle } from "@/lib/maitai";
import {
  ActivitySpinnerIcon,
  CheckmarkIcon,
  RefreshIcon,
  RetryIcon,
} from "@/components/shared/icons";
import {
  useRegisterContentSearchSource,
  type ContentSearchLocalMatch,
  type ContentSearchLocalSource,
} from "@/features/content-search/content-search-context";
import {
  CONTENT_SEARCH_ACTIVE_MARK_CLASS,
  CONTENT_SEARCH_MARK_CLASS,
  applyContentSearchDomMarks,
  clearContentSearchMarks,
} from "@/features/content-search/content-search-dom";
import { cn } from "../../../lib/utils";
import type {
  PageRunInTarget,
  CodexConversationCapabilityFlags,
  CodexCanonicalServerRequest,
  CodexConversationChildMembership,
  CodexConversationResumeState,
  CodexConversationServerRequest,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexConversationTurnPagination,
  CodexThreadStatusType,
} from "../../../lib/types";
import { searchCodexPersistedHistory } from "../../../lib/api";
import {
  hydrateLocalPersistedHistoryOccurrence,
  publishLocalConversationHistoryMutation,
  requestLocalConversationHistoryPage,
  setLocalConversationHistoryResidencyPins,
} from "../local-conversation-store";
import { selectVisibleConversationTurnEntries } from "../selectors";
import type {
  ThreadBodyModel,
  ThreadBodyUiStateOverrides,
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadPlanSidePanelState,
  ThreadStageActions,
} from "../thread-stage-types";
import type { LocalConversationAttachmentState } from "../conversation-attachment-state";
import { buildThreadUserMessageNavigationItems } from "../projection/thread-user-message-navigation-items";
import { resolveConversationTurnTimestampSeparators } from "../projection/conversation-turn-timestamps";
import type { ProjectlessOutputScope } from "../projection/projectless-output-scope";
import {
  LocalConversationVirtualizedTurnList,
  type LocalConversationVirtualizedTurnListApi,
  type LocalConversationVirtualizedTurnListEntry,
} from "./local-conversation-virtualized-turn-list";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import { LocalConversationForkFromTurnDialog } from "./local-conversation-fork-from-turn-dialog";
import { useLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";
import {
  localConversationTurnCollapseOverrideFamily,
  normalizeThreadRestoreDistanceFromBottomPx,
  resolveLatestTurnCollapseTransition,
  setLocalConversationTurnCollapseOverride,
  type LocalConversationThreadRestoreSnapshot,
} from "./local-conversation-thread-view-state";
import type {
  VirtualizedLatestTurnRestoreState,
  VirtualizedTurnListRestoreState,
} from "./local-conversation-turn-virtualization";
import { LocalConversationResumeLoader } from "./shared/local-conversation-resume-loader";
import { LOCAL_CONVERSATION_CONTENT_CLASS_NAME } from "./shared/local-conversation-view-constants";
import { createLocalConversationSearchSource } from "./local-conversation-search-source";
import {
  isLocalConversationPersistedSearchMatchMeta,
  projectLocalConversationPersistedSearchResult,
  resolveLocalConversationPersistedSearchTarget,
  type LocalConversationSearchTarget,
} from "./local-conversation-persisted-search";
import { projectLocalConversationLegacyHistoryRows } from "./local-conversation-history-gap";
import {
  createLocalConversationHistoryResidencyPinPublisher,
  type LocalConversationHistoryResidencyPinPublisher,
} from "./local-conversation-history-residency-pins";
import { LocalConversationSelectedTextSideChatOverlay } from "./local-conversation-selected-text-side-chat-overlay";
import {
  LocalConversationPromptRail,
  waitForLocalConversationPromptRailResidentTarget,
} from "./local-conversation-prompt-rail";
import { formatBoundedWorktreeOutput } from "../../../../shared/worktree-output";
import type { CodexPromptRailReveal } from "../../../../shared/codex-prompt-rail-history";
import type {
  CodexHistoryBoundaryRef,
  CodexHistoryRow,
  CodexHistoryTurnItemsPagination,
} from "../../../../shared/codex-conversation-state/codex-history-topology";
import {
  createCodexConversationHistoryTurnItemsRef,
  type CodexConversationHistoryItemWindowSnapshot,
  type CodexConversationHistoryTurnItemsRef,
} from "../../../../shared/codex-conversation-history-page";

const PROGRESS_PHASES = [
  { key: "creatingWorktree", label: "Worktree" },
  { key: "runningSetup", label: "Setup" },
  { key: "startingThread", label: "Thread" },
] as const;

function turnHasUserMessage(turn: CodexConversationTurn): boolean {
  return turn.items.some(
    (item) => item.kind === "userMessage" || item.semanticKind === "userMessage",
  );
}

function turnEntryHasMcpApp(entry: LocalConversationVirtualizedTurnListEntry | undefined): boolean {
  return entry?.turn.items.some((item) => item.mcpToolCall?.mcpAppResourceUri != null) === true;
}

function resolveLatestEditableTurnId(turns: CodexConversationTurn[]): string | null {
  const latestTurn = turns.at(-1) ?? null;
  if (!latestTurn || latestTurn.status === "inProgress") return null;
  return turnHasUserMessage(latestTurn) ? latestTurn.turnId : null;
}

function countNeedleOccurrences(text: string, normalizedQuery: string): number {
  if (!normalizedQuery) return 0;
  const haystack = text.toLowerCase();
  let count = 0;
  let cursor = 0;
  while (cursor < haystack.length) {
    const index = haystack.indexOf(normalizedQuery, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + normalizedQuery.length;
  }
  return count;
}

function escapeAttributeSelectorValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function isConversationSearchMatchMeta(
  value: unknown,
): value is { unitKey: string; turnKey: string; occurrenceIndex: number } {
  if (!value || typeof value !== "object") return false;
  const meta = value as { unitKey?: unknown; turnKey?: unknown; occurrenceIndex?: unknown };
  return (
    typeof meta.unitKey === "string" &&
    typeof meta.turnKey === "string" &&
    typeof meta.occurrenceIndex === "number"
  );
}

function resolvePhaseIndex(
  phase: "creatingWorktree" | "runningSetup" | "startingThread" | "ready" | "failed",
): number {
  if (phase === "creatingWorktree") return 0;
  if (phase === "runningSetup") return 1;
  if (phase === "startingThread" || phase === "ready") return 2;
  return -1;
}

function ThreadAttachmentFailureNotice({
  failure,
  onRetry,
  fillParent = false,
}: {
  failure: Extract<LocalConversationAttachmentState, { status: "failed" }>;
  onRetry: () => void;
  fillParent?: boolean;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex min-w-0 items-center justify-between gap-3 bg-(--destructive)/6 px-3 py-2 text-sm",
        fillParent && "h-full flex-col justify-center bg-transparent px-4 text-center",
      )}
    >
      <div className={cn("min-w-0", fillParent && "max-w-sm")}>
        <div className="font-medium text-(--destructive)">Thread could not be restored</div>
        <div
          className={cn(
            "mt-0.5 text-xs text-token-text-secondary",
            fillParent ? "wrap-break-word" : "truncate",
          )}
        >
          {failure.message}
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-token-foreground/5 px-2.5 text-xs font-medium text-token-text-primary hover:bg-token-foreground/10"
      >
        <RetryIcon className="icon-2xs shrink-0" />
        Retry
      </button>
    </div>
  );
}

export function ThreadStartProgressPanel({
  progress,
  outputText,
  setupProgressLogRef,
}: {
  progress: NonNullable<{
    runInTarget: PageRunInTarget;
    threadId?: string | null;
    phase: "creatingWorktree" | "runningSetup" | "startingThread" | "ready" | "failed";
    message: string;
    outputText: string;
    outputTruncated: boolean;
    updatedAt: number;
  }>;
  outputText: string;
  setupProgressLogRef: React.RefObject<HTMLDivElement | null>;
}) {
  const isWorktreeProgress =
    progress.runInTarget === "newWorktree" ||
    progress.phase === "creatingWorktree" ||
    progress.phase === "runningSetup";
  const activePhaseIndex = resolvePhaseIndex(progress.phase);
  const isFailed = progress.phase === "failed";

  if (!isWorktreeProgress) {
    return (
      <div className="w-full max-w-95 px-6 text-center">
        <div
          className={cn(
            "inline-flex min-h-8 items-center gap-2 rounded-full border-[0.5px] px-3 py-1.5 text-sm font-medium",
            isFailed
              ? "border-(--destructive)/25 bg-(--destructive)/8 text-(--destructive)"
              : "border-(--border) bg-(--background-secondary) text-(--foreground-secondary)",
          )}
        >
          {isFailed ? (
            <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-(--destructive)/15 text-[11px] leading-none">
              !
            </span>
          ) : progress.phase === "ready" ? (
            <CheckmarkIcon className="size-3.5 shrink-0 text-(--accent-blue)" />
          ) : (
            <ActivitySpinnerIcon className="size-3.5 shrink-0 text-(--foreground-tertiary)" />
          )}
          <span>
            {progress.message || (isFailed ? "Message could not be sent." : "Sending message…")}
          </span>
        </div>
        {isFailed && outputText.trim().length > 0 ? (
          <pre className="scrollbar-token mt-3 max-h-32 overflow-auto rounded-lg border-[0.5px] border-(--border) bg-(--background-secondary) p-3 text-left font-mono text-xs/relaxed wrap-break-word whitespace-pre-wrap text-(--foreground-tertiary)">
            {outputText}
          </pre>
        ) : null}
      </div>
    );
  }

  return (
    <div className="w-full max-w-140 px-4">
      <div className="mb-3 flex items-center gap-2">
        {!isFailed ? (
          <ActivitySpinnerIcon className="size-3.5 shrink-0 text-(--foreground-tertiary)" />
        ) : null}
        <span className="text-sm font-medium text-(--foreground-secondary)">
          {progress.message || "Preparing worktree…"}
        </span>
      </div>

      <div className="mb-3 flex items-center gap-1">
        {PROGRESS_PHASES.map((phase, index) => {
          const isComplete = activePhaseIndex > index;
          const isActive = activePhaseIndex === index && !isFailed;
          return (
            <div key={phase.key} className="flex items-center gap-1">
              {index > 0 ? (
                <div
                  className={cn(
                    "mx-1 h-px w-4",
                    isComplete ? "bg-(--accent-blue)" : "bg-(--border)",
                  )}
                />
              ) : null}
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full text-[10px] font-medium transition-colors duration-200",
                    isComplete && "bg-(--accent-blue) text-white",
                    isActive &&
                      "bg-(--accent-blue)/20 text-(--accent-blue) ring-1 ring-(--accent-blue)/40",
                    !isComplete &&
                      !isActive &&
                      "bg-(--background-tertiary) text-(--foreground-tertiary)",
                    isFailed &&
                      index === activePhaseIndex &&
                      "bg-(--destructive)/15 text-(--destructive) ring-1 ring-(--destructive)/30",
                  )}
                >
                  {isComplete ? <CheckmarkIcon className="size-2.5" /> : index + 1}
                </div>
                <span
                  className={cn(
                    "text-xs",
                    isComplete && "text-(--foreground-secondary)",
                    isActive && "font-medium text-(--foreground-secondary)",
                    !isComplete && !isActive && "text-(--foreground-tertiary)",
                    isFailed && index === activePhaseIndex && "font-medium text-(--destructive)",
                  )}
                >
                  {phase.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border-[0.5px] border-(--border) bg-(--background-secondary)">
        <div
          ref={setupProgressLogRef}
          className="scrollbar-token max-h-80 min-h-28 overflow-auto p-3"
        >
          <pre className="font-mono text-xs/relaxed wrap-break-word whitespace-pre-wrap text-(--foreground-tertiary)">
            {outputText || "Preparing…\n"}
          </pre>
        </div>
      </div>
    </div>
  );
}

interface LocalConversationThreadBodyOwnerProps {
  body: ThreadBodyModel;
  projectId: string | null;
  threadId: string | null;
  isSideChat: boolean;
  cwd: string | null;
  turns: CodexConversationTurn[];
  turnPagination: CodexConversationTurnPagination | null;
  historyRows?: readonly CodexHistoryRow[];
  conversationEntityGeneration?: number;
  historyTopologyGeneration?: number;
  historyMutationRevision?: number;
  historyItemWindowsByTurnId?: Readonly<Record<string, CodexConversationHistoryItemWindowSnapshot>>;
  turnItemsPaginationById?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  requests: CodexConversationServerRequest[];
  canonicalRequests: CodexCanonicalServerRequest[];
  resumeState: CodexConversationResumeState | null;
  attachmentState?: LocalConversationAttachmentState;
  capabilityFlags: CodexConversationCapabilityFlags;
  statusType: CodexThreadStatusType | null;
  parentTurns: readonly CodexConversationTurn[];
  childMemberships: readonly CodexConversationChildMembership[];
  backgroundAgentRows: readonly ThreadComposerShellBackgroundAgentRowModel[];
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  searchOpenTick: number;
  threadStartProgress: {
    runInTarget: PageRunInTarget;
    threadId?: string | null;
    phase: "creatingWorktree" | "runningSetup" | "startingThread" | "ready" | "failed";
    message: string;
    outputText: string;
    outputTruncated: boolean;
    updatedAt: number;
  } | null;
  actions: ThreadStageActions;
  isWorktreeThread?: boolean;
  onForkFromTurnIntoWorktree?: LocalConversationForkIntoWorktreeHandler;
  planSidePanelState?: ThreadPlanSidePanelState | null;
  onErrorMessage: (message: string | null) => void;
  initialUiState?: ThreadBodyUiStateOverrides;
  initialRestoreSnapshot: LocalConversationThreadRestoreSnapshot;
  onRestoreSnapshotChange: (
    update: (
      current: LocalConversationThreadRestoreSnapshot,
    ) => LocalConversationThreadRestoreSnapshot,
  ) => void;
  turnDiffHoverPreviewDisabled?: boolean;
}

export interface LocalConversationForkIntoWorktreeInput {
  threadId: string;
  targetTurnId: string;
}

export type LocalConversationForkIntoWorktreeHandler = (
  input: LocalConversationForkIntoWorktreeInput,
) => Promise<void>;

export function LocalConversationThreadBodyOwner({
  body,
  projectId,
  threadId,
  isSideChat,
  cwd,
  turns,
  turnPagination,
  historyRows: canonicalHistoryRows,
  conversationEntityGeneration,
  historyTopologyGeneration,
  historyMutationRevision,
  historyItemWindowsByTurnId,
  turnItemsPaginationById,
  requests,
  canonicalRequests,
  resumeState,
  attachmentState,
  capabilityFlags,
  statusType,
  parentTurns,
  childMemberships,
  backgroundAgentRows,
  projectWorkspacePath,
  projectlessOutputDirectory,
  threadStartProgress,
  actions,
  isWorktreeThread = false,
  onForkFromTurnIntoWorktree,
  planSidePanelState,
  onErrorMessage,
  initialUiState,
  initialRestoreSnapshot,
  onRestoreSnapshotChange,
  turnDiffHoverPreviewDisabled = false,
}: LocalConversationThreadBodyOwnerProps) {
  const { scrollElement } = useLocalConversationThreadScrollController();
  const appHandle = useScopeHandle(appScope);
  const setupProgressLogRef = useRef<HTMLDivElement>(null);
  const contentRootRef = useRef<HTMLDivElement | null>(null);
  const listApiRef = useRef<LocalConversationVirtualizedTurnListApi | null>(null);
  const historyResidencyPinPublisherRef =
    useRef<LocalConversationHistoryResidencyPinPublisher | null>(null);
  historyResidencyPinPublisherRef.current ??= createLocalConversationHistoryResidencyPinPublisher({
    publish: setLocalConversationHistoryResidencyPins,
  });
  const historyResidencyPinPublisher = historyResidencyPinPublisherRef.current;
  const [forkDialogState, setForkDialogState] = useState<{
    threadId: string;
    turnId: string;
    message: string;
  } | null>(null);
  const forkSubmissionInFlightRef = useRef(false);
  const [isForkSubmitting, setIsForkSubmitting] = useState(false);
  const [isRestoringArchivedThread, setIsRestoringArchivedThread] = useState(false);
  const attachmentFailure = attachmentState?.status === "failed" ? attachmentState : null;
  const retryAttachment = useCallback(() => {
    if (!threadId || !actions.onRetryThreadAttachment) return;
    void actions.onRetryThreadAttachment(threadId);
  }, [actions, threadId]);
  const conversation = useMemo<CodexConversationSnapshot | null>(
    () =>
      threadId || turns.length > 0
        ? {
            threadId: threadId ?? turns[0]?.threadId ?? "unattached",
            projectId: null,
            source: null,
            threadName: null,
            threadPreview: "",
            cwd,
            projectlessOutputDirectory: projectlessOutputDirectory ?? null,
            statusType: statusType ?? (resumeState === "resumed" ? "idle" : "notLoaded"),
            statusActiveFlags: [],
            archived: false,
            createdAt: 0,
            updatedAt: 0,
            linkedAt: "",
            latestCollaborationMode: undefined,
            resumeState: resumeState ?? "needs_resume",
            turnPagination: turnPagination ?? undefined,
            historyRows: canonicalHistoryRows,
            conversationEntityGeneration,
            historyTopologyGeneration,
            historyMutationRevision,
            historyItemWindowsByTurnId,
            turnItemsPaginationById,
            turns,
            requests,
            canonicalRequests,
            queuedFollowUps: {
              status: "ready",
              ledgerRevision: 0,
              projectionRevision: 0,
              entries: [],
              inFlightFollowUpId: null,
              editingFollowUpId: null,
              error: null,
            },
            pendingSteers: [],
            backgroundTerminalRows: [],
            capabilityFlags,
          }
        : null,
    [
      canonicalRequests,
      canonicalHistoryRows,
      capabilityFlags,
      conversationEntityGeneration,
      cwd,
      projectlessOutputDirectory,
      requests,
      resumeState,
      statusType,
      threadId,
      historyTopologyGeneration,
      historyMutationRevision,
      historyItemWindowsByTurnId,
      turnItemsPaginationById,
      turnPagination,
      turns,
    ],
  );

  const editableTurnId = capabilityFlags.canEditLastUserTurn
    ? resolveLatestEditableTurnId(turns)
    : null;
  const canForkFromTurn = capabilityFlags.canForkFromTurn;
  const turnEntries = useMemo(
    () =>
      selectVisibleConversationTurnEntries({
        conversation,
        parentTurns,
      }),
    [conversation, parentTurns],
  );
  const virtualizedEntries = useMemo<LocalConversationVirtualizedTurnListEntry[]>(() => {
    const timestamps = resolveConversationTurnTimestampSeparators(
      turnEntries.map((entry) => entry.turn),
      {
        startsAfterHistoryBoundary:
          turnPagination?.hasLoadedOldest === false || parentTurns.length > 0,
      },
    );
    return turnEntries.map((entry, index) => ({
      ...entry,
      timestampSeparatorAtMs: timestamps[index] ?? null,
    }));
  }, [parentTurns.length, turnEntries, turnPagination?.hasLoadedOldest]);
  const historyRows = useMemo(
    () =>
      canonicalHistoryRows ??
      projectLocalConversationLegacyHistoryRows({
        conversationId: conversation?.threadId ?? body.threadId ?? "unattached",
        pagination: turnPagination,
        turnKeys: virtualizedEntries.map((entry) => entry.turnKey),
      }),
    [
      body.threadId,
      canonicalHistoryRows,
      conversation?.threadId,
      turnPagination,
      virtualizedEntries,
    ],
  );
  const hasCanonicalHistoryTopology =
    canonicalHistoryRows !== undefined &&
    conversationEntityGeneration !== undefined &&
    historyTopologyGeneration !== undefined &&
    historyMutationRevision !== undefined;
  const historyTurnItemsRefs = useMemo(() => {
    if (historyTopologyGeneration === undefined) return {};
    return Object.fromEntries(
      Object.entries(turnItemsPaginationById ?? {}).flatMap(([turnId, pagination]) => {
        const window = historyItemWindowsByTurnId?.[turnId] ?? null;
        const older = createCodexConversationHistoryTurnItemsRef({
          turnId,
          expectedTopologyGeneration: historyTopologyGeneration,
          pagination,
          edge: "older",
          window,
        });
        const newer = createCodexConversationHistoryTurnItemsRef({
          turnId,
          expectedTopologyGeneration: historyTopologyGeneration,
          pagination,
          edge: "newer",
          window,
        });
        return older || newer ? [[turnId, { older, newer }] as const] : [];
      }),
    );
  }, [historyItemWindowsByTurnId, historyTopologyGeneration, turnItemsPaginationById]);
  useEffect(() => {
    if (
      !threadId ||
      !hasCanonicalHistoryTopology ||
      conversationEntityGeneration === undefined ||
      historyTopologyGeneration === undefined ||
      historyMutationRevision === undefined
    ) {
      historyResidencyPinPublisher.clear();
      return;
    }
    historyResidencyPinPublisher.setTarget({
      threadId,
      conversationGeneration: conversationEntityGeneration,
      generation: historyTopologyGeneration,
      historyMutationRevision,
    });
  }, [
    hasCanonicalHistoryTopology,
    historyResidencyPinPublisher,
    conversationEntityGeneration,
    historyTopologyGeneration,
    historyMutationRevision,
    threadId,
  ]);
  useEffect(
    () => () => {
      // React Strict Mode replays effects without recreating the component instance. Clear the
      // active target while keeping the publisher reusable for the replayed setup.
      historyResidencyPinPublisher.clear();
    },
    [historyResidencyPinPublisher],
  );
  const handleVisibleHistoryTurnIdsChange = useCallback(
    (turnIds: readonly string[]) => {
      if (
        !threadId ||
        !hasCanonicalHistoryTopology ||
        conversationEntityGeneration === undefined ||
        historyTopologyGeneration === undefined ||
        historyMutationRevision === undefined
      ) {
        return;
      }
      historyResidencyPinPublisher.observe({
        threadId,
        conversationGeneration: conversationEntityGeneration,
        generation: historyTopologyGeneration,
        historyMutationRevision,
        turnIds,
      });
    },
    [
      hasCanonicalHistoryTopology,
      historyResidencyPinPublisher,
      conversationEntityGeneration,
      historyTopologyGeneration,
      historyMutationRevision,
      threadId,
    ],
  );
  const userMessageNavigationItems = useMemo(
    () =>
      buildThreadUserMessageNavigationItems(turnEntries, {
        cwd,
        projectlessOutputDirectory,
      } satisfies ProjectlessOutputScope),
    [cwd, projectlessOutputDirectory, turnEntries],
  );
  const userMessageNavigationItemsRef = useRef(userMessageNavigationItems);
  userMessageNavigationItemsRef.current = userMessageNavigationItems;
  const currentTurnEntriesRef = useRef(turnEntries);
  currentTurnEntriesRef.current = turnEntries;
  const persistedSearchSessionRef = useRef<{
    threadId: string;
    hostId: string;
    hostGeneration: number;
    topologyGeneration: number;
  } | null>(null);
  const persistedSearchTargetsRef = useRef(new Map<string, LocalConversationSearchTarget>());
  const latestTurnSearchKey = turnEntries.at(-1)?.turnSearchKey ?? null;
  const previousLatestTurnSearchKeyRef = useRef(latestTurnSearchKey);

  useLayoutEffect(() => {
    const previousLatestTurnSearchKey = previousLatestTurnSearchKeyRef.current;
    previousLatestTurnSearchKeyRef.current = latestTurnSearchKey;
    if (
      !threadId ||
      previousLatestTurnSearchKey === null ||
      previousLatestTurnSearchKey === latestTurnSearchKey
    ) {
      return;
    }

    const turnSearchKeysToCollapse = resolveLatestTurnCollapseTransition({
      entries: turnEntries.map((entry) => ({
        hasMcpApp: turnEntryHasMcpApp(entry),
        turnSearchKey: entry.turnSearchKey,
      })),
      latestTurnSearchKey,
      previousLatestTurnSearchKey,
    });
    for (const turnSearchKey of turnSearchKeysToCollapse) {
      setLocalConversationTurnCollapseOverride(
        appHandle,
        {
          conversationId: threadId,
          turnSearchKey,
        },
        true,
      );
    }
  }, [appHandle, latestTurnSearchKey, threadId, turnEntries]);

  const handleVirtualizedTurnRestoreStateChange = useCallback(
    (state: VirtualizedTurnListRestoreState | null) => {
      onRestoreSnapshotChange((current) => ({
        ...current,
        virtualizedTurnList: state,
      }));
    },
    [onRestoreSnapshotChange],
  );

  const handleLatestTurnRestoreStateChange = useCallback(
    (state: VirtualizedLatestTurnRestoreState | null, distanceFromBottomPx: number) => {
      onRestoreSnapshotChange((current) => ({
        ...current,
        distanceFromBottomPx: normalizeThreadRestoreDistanceFromBottomPx(distanceFromBottomPx),
        latestTurn: state,
      }));
    },
    [onRestoreSnapshotChange],
  );

  const handleLoadHistoryBoundary = useCallback(
    async (boundary: CodexHistoryBoundaryRef) => {
      const targetThreadId = threadId ?? body.threadId;
      if (
        !targetThreadId ||
        conversationEntityGeneration === undefined ||
        historyMutationRevision === undefined
      ) {
        return;
      }
      await requestLocalConversationHistoryPage({
        threadId: targetThreadId,
        expectedConversationGeneration: conversationEntityGeneration,
        expectedHistoryMutationRevision: historyMutationRevision,
        target: { kind: "turnBoundary", boundary },
      });
    },
    [body.threadId, conversationEntityGeneration, historyMutationRevision, threadId],
  );
  const handleLoadHistoryTurnItems = useCallback(
    async (items: CodexConversationHistoryTurnItemsRef) => {
      const targetThreadId = threadId ?? body.threadId;
      if (
        !targetThreadId ||
        conversationEntityGeneration === undefined ||
        historyMutationRevision === undefined
      ) {
        return;
      }
      await requestLocalConversationHistoryPage({
        threadId: targetThreadId,
        expectedConversationGeneration: conversationEntityGeneration,
        expectedHistoryMutationRevision: historyMutationRevision,
        target: { kind: "turnItems", items },
      });
    },
    [body.threadId, conversationEntityGeneration, historyMutationRevision, threadId],
  );

  const searchSource = useMemo(
    () =>
      createLocalConversationSearchSource({
        routeContextId: body.threadId ? `conversation:${body.threadId}` : "unavailable",
        cwd,
        projectlessOutputDirectory,
        getTurns: () => currentTurnEntriesRef.current,
        scrollAdapter: {
          scrollToTurn: async (turnKey, options) => {
            if (options?.signal?.aborted) return;
            const targetEntry = currentTurnEntriesRef.current.find(
              (entry) => entry.turnKey === turnKey,
            );
            if (threadId && targetEntry) {
              const collapseKey = {
                conversationId: threadId,
                turnSearchKey: targetEntry.turnSearchKey,
              };
              if (
                appHandle.get(localConversationTurnCollapseOverrideFamily(collapseKey)) !== false
              ) {
                setLocalConversationTurnCollapseOverride(appHandle, collapseKey, false);
              }
              await new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                  resolve();
                });
              });
              if (options?.signal?.aborted) return;
            }
            const api = listApiRef.current;
            if (!api) return;
            await api.scrollToKey(turnKey);
            if (options?.signal?.aborted) return;
            await nextAnimationFrame();
          },
          getTurnContainer: (turnKey) =>
            contentRootRef.current?.querySelector<HTMLElement>(
              `[data-content-search-turn-key="${turnKey}"]`,
            ) ?? null,
        },
      }),
    [appHandle, body.threadId, cwd, projectlessOutputDirectory, threadId],
  );

  useEffect(() => {
    clearContentSearchMarks(contentRootRef.current);
    persistedSearchSessionRef.current = null;
    persistedSearchTargetsRef.current.clear();
    setForkDialogState(null);
  }, [body.threadId]);

  useEffect(() => {
    if (!body.showThreadStartProgressPanel) return;
    const element = setupProgressLogRef.current;
    if (!element) return;
    requestAnimationFrame(() => {
      const current = setupProgressLogRef.current;
      if (!current) return;
      current.scrollTop = current.scrollHeight;
    });
  }, [
    body.showThreadStartProgressPanel,
    threadStartProgress?.outputText,
    threadStartProgress?.updatedAt,
  ]);

  const contentSearchSource = useMemo<ContentSearchLocalSource>(
    () => ({
      domain: "conversation",
      contextId: searchSource.routeContextId,
      async search(query, limit, options) {
        const literalQuery = query.trim();
        if (!literalQuery) {
          return { query, matches: [], totalMatches: 0, capped: false };
        }
        const persistedThreadId = threadId ?? body.threadId;
        if (persistedThreadId) {
          try {
            const result = await searchCodexPersistedHistory(persistedThreadId, literalQuery);
            if (options?.signal.aborted) {
              return { query, matches: [], totalMatches: 0, capped: false };
            }
            if (result.status === "unavailable") {
              persistedSearchSessionRef.current = null;
              persistedSearchTargetsRef.current.clear();
            } else {
              const page = result.page;
              persistedSearchSessionRef.current = {
                threadId: page.threadId,
                hostId: page.hostId,
                hostGeneration: page.hostGeneration,
                topologyGeneration: page.topologyGeneration,
              };
              persistedSearchTargetsRef.current.clear();
              return projectLocalConversationPersistedSearchResult({
                page,
                contextId: searchSource.routeContextId,
                limit,
              });
            }
          } catch {
            if (options?.signal.aborted) {
              return { query, matches: [], totalMatches: 0, capped: false };
            }
          }
        }

        persistedSearchSessionRef.current = null;
        persistedSearchTargetsRef.current.clear();
        const normalizedQuery = query.trim().toLowerCase();
        const matches: ContentSearchLocalMatch[] = [];
        let capped = false;
        for (const unit of searchSource.findMatches(normalizedQuery)) {
          const occurrenceCount = countNeedleOccurrences(unit.text, normalizedQuery);
          for (let occurrenceIndex = 0; occurrenceIndex < occurrenceCount; occurrenceIndex += 1) {
            if (matches.length >= limit) {
              capped = true;
              break;
            }
            matches.push({
              id: `conversation:${unit.key}:${occurrenceIndex}`,
              domain: "conversation",
              contextId: searchSource.routeContextId,
              ordinal: matches.length,
              label: unit.text,
              meta: {
                unitKey: unit.key,
                turnKey: unit.turnKey,
                occurrenceIndex,
              },
            });
          }
          if (capped) break;
        }

        return {
          query,
          matches,
          totalMatches: matches.length,
          capped,
        };
      },
      async ensureVisible(match, { signal }) {
        if (isConversationSearchMatchMeta(match.meta)) {
          await searchSource.scrollAdapter.scrollToTurn(match.meta.turnKey, { signal });
          return;
        }
        if (!isLocalConversationPersistedSearchMatchMeta(match.meta)) return;
        const meta = match.meta;
        const persistedThreadId = threadId ?? body.threadId;
        if (!persistedThreadId || meta.threadId !== persistedThreadId) return;

        clearContentSearchMarks(contentRootRef.current);
        persistedSearchTargetsRef.current.delete(match.id);
        const session = persistedSearchSessionRef.current;
        const topologyGeneration =
          session?.threadId === meta.threadId &&
          session.hostId === meta.hostId &&
          session.hostGeneration === meta.hostGeneration
            ? session.topologyGeneration
            : meta.topologyGeneration;
        const resolution = await hydrateLocalPersistedHistoryOccurrence({
          threadId: meta.threadId,
          hostId: meta.hostId,
          hostGeneration: meta.hostGeneration,
          topologyGeneration,
          occurrence: meta.occurrence,
        });
        if (signal.aborted) return;
        persistedSearchSessionRef.current = {
          threadId: meta.threadId,
          hostId: meta.hostId,
          hostGeneration: meta.hostGeneration,
          topologyGeneration: resolution.topologyGeneration,
        };

        let target: LocalConversationSearchTarget | null = null;
        let entry = currentTurnEntriesRef.current.find(
          (candidate) => candidate.turnId === meta.occurrence.turnId,
        );
        for (let attempt = 0; attempt < 5 && !target; attempt += 1) {
          if (entry) {
            target = resolveLocalConversationPersistedSearchTarget({
              entry,
              occurrence: meta.occurrence,
              itemOccurrenceIndex: meta.itemOccurrenceIndex,
              query: meta.query,
              units: searchSource.getUnitsForTurn(entry),
            });
          }
          if (target || signal.aborted) break;
          await nextAnimationFrame();
          entry = currentTurnEntriesRef.current.find(
            (candidate) => candidate.turnId === meta.occurrence.turnId,
          );
        }
        if (signal.aborted) return;
        if (target) {
          persistedSearchTargetsRef.current.set(match.id, target);
          await searchSource.scrollAdapter.scrollToTurn(target.turnKey, { signal });
          return;
        }
        if (resolution.status === "bounded-incomplete" && entry) {
          await searchSource.scrollAdapter.scrollToTurn(entry.turnKey, { signal });
          return;
        }
        throw new Error("Hydrated persisted-history occurrence is not renderable");
      },
      activate(match, query) {
        const target = isConversationSearchMatchMeta(match.meta)
          ? match.meta
          : isLocalConversationPersistedSearchMatchMeta(match.meta)
            ? persistedSearchTargetsRef.current.get(match.id)
            : null;
        if (!target) return;
        const root = contentRootRef.current;
        if (!root) return;
        const result = applyContentSearchDomMarks({
          root,
          query,
          idPrefix: "content-search:conversation",
        });
        const unitSelector = `[data-content-search-unit-key="${escapeAttributeSelectorValue(target.unitKey)}"]`;
        const unitElement = root.querySelector<HTMLElement>(unitSelector);
        const unitMarks = Array.from(
          unitElement?.querySelectorAll<HTMLElement>(`mark.${CONTENT_SEARCH_MARK_CLASS}`) ?? [],
        );
        const activeElement =
          unitMarks[target.occurrenceIndex] ?? unitMarks[0] ?? result.matches[0]?.element ?? null;
        if (!activeElement) return;
        activeElement.classList.add(CONTENT_SEARCH_ACTIVE_MARK_CLASS);
        activeElement.scrollIntoView({ block: "center", inline: "nearest" });
      },
      clear() {
        clearContentSearchMarks(contentRootRef.current);
      },
    }),
    [body.threadId, searchSource, threadId],
  );
  useRegisterContentSearchSource(contentSearchSource);

  const handleEditLastUserTurn = useCallback(
    async (input: { threadId: string; turnId: string; message: string }) => {
      onErrorMessage(null);
      try {
        await actions.onEditLastUserTurn(input);
      } catch (error) {
        const nextError =
          error instanceof Error ? error.message : "Could not edit the last user message";
        onErrorMessage(nextError);
        throw error;
      }
    },
    [actions, onErrorMessage],
  );

  const runForkChoice = useCallback(
    async (fork: () => Promise<void>, fallbackError: string) => {
      if (forkSubmissionInFlightRef.current) return;

      forkSubmissionInFlightRef.current = true;
      setIsForkSubmitting(true);
      onErrorMessage(null);
      try {
        await fork();
        setForkDialogState(null);
      } catch (error) {
        onErrorMessage(error instanceof Error ? error.message : fallbackError);
      } finally {
        forkSubmissionInFlightRef.current = false;
        setIsForkSubmitting(false);
      }
    },
    [onErrorMessage],
  );

  const runForkFromTurn = useCallback(
    async (input: { threadId: string; turnId: string; message: string }) => {
      await runForkChoice(() => actions.onForkFromTurn(input), "Could not fork the conversation");
    },
    [actions, runForkChoice],
  );

  const runForkFromTurnIntoWorktree = useCallback(
    async (input: { threadId: string; turnId: string; message: string }) => {
      if (!onForkFromTurnIntoWorktree) return;

      await runForkChoice(
        () =>
          onForkFromTurnIntoWorktree({
            threadId: input.threadId,
            targetTurnId: input.turnId,
          }),
        "Could not fork the conversation into a new worktree",
      );
    },
    [onForkFromTurnIntoWorktree, runForkChoice],
  );

  const handleForkFromTurn = useCallback(
    async (input: { threadId: string; turnId: string; message: string; isLatestTurn: boolean }) => {
      if (input.isLatestTurn) {
        await runForkFromTurn(input);
        return;
      }

      setForkDialogState({
        threadId: input.threadId,
        turnId: input.turnId,
        message: input.message,
      });
    },
    [runForkFromTurn],
  );

  const handleRestoreArchivedThread = useCallback(async () => {
    if (!threadId || isRestoringArchivedThread) return;

    setIsRestoringArchivedThread(true);
    onErrorMessage(null);
    try {
      await actions.onUnarchiveThread(threadId, projectId);
    } catch (error) {
      onErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRestoringArchivedThread(false);
    }
  }, [actions, isRestoringArchivedThread, onErrorMessage, projectId, threadId]);

  const handleRevealUserMessageNavigationItem = useCallback(
    async (item: ThreadUserMessageNavigationItem): Promise<HTMLElement | null> => {
      const unitSelector = `[data-content-search-unit-key="${escapeAttributeSelectorValue(item.id)}"]`;
      const api = listApiRef.current;
      if (api) {
        await api.scrollToKey(item.turnKey, (turnElement) =>
          turnElement.querySelector<HTMLElement>(unitSelector),
        );
        await nextAnimationFrame();
      }

      return contentRootRef.current?.querySelector<HTMLElement>(unitSelector) ?? null;
    },
    [],
  );
  const handlePublishPromptRailReveal = useCallback(async (reveal: CodexPromptRailReveal) => {
    await publishLocalConversationHistoryMutation(reveal.threadId, reveal.mutation);
  }, []);
  const handleRevealInstalledPromptRailTurn = useCallback(
    async (
      reveal: CodexPromptRailReveal,
      mode: "smooth" | "instant",
      signal: AbortSignal,
    ): Promise<HTMLElement | null> =>
      await waitForLocalConversationPromptRailResidentTarget({
        turnId: reveal.turnId,
        mode,
        signal,
        readResidentItems: () => userMessageNavigationItemsRef.current,
        revealResidentItem: async (item) => {
          const target = await handleRevealUserMessageNavigationItem(item);
          return signal.aborted ? null : target;
        },
      }),
    [handleRevealUserMessageNavigationItem],
  );

  const selectedTextSideChatOverlayEnabled = Boolean(
    threadId && !isSideChat && actions.onOpenSideChat && body.emptyState.type === "none",
  );

  return (
    <>
      <LocalConversationPromptRail
        enabled={Boolean((threadId ?? body.threadId) && historyTopologyGeneration !== undefined)}
        threadId={threadId ?? body.threadId}
        topologyGeneration={historyTopologyGeneration ?? null}
        residentItems={userMessageNavigationItems}
        publishReveal={handlePublishPromptRailReveal}
        revealResidentItem={handleRevealUserMessageNavigationItem}
        revealInstalledTurn={handleRevealInstalledPromptRailTurn}
      />
      <LocalConversationSelectedTextSideChatOverlay
        enabled={selectedTextSideChatOverlayEnabled}
        scrollElement={scrollElement}
        onOpenSideChat={actions.onOpenSideChat}
      />
      <div className="flex flex-col">
        {body.showThreadStartProgressPanel && threadStartProgress ? (
          <div className="flex items-center justify-center py-10">
            <ThreadStartProgressPanel
              progress={threadStartProgress}
              outputText={formatBoundedWorktreeOutput({
                text: threadStartProgress.outputText,
                didTruncate: threadStartProgress.outputTruncated,
              })}
              setupProgressLogRef={setupProgressLogRef}
            />
          </div>
        ) : body.emptyState.type === "newThread" || body.emptyState.type === "noThread" ? (
          <div className="flex items-center justify-center py-16">
            <div className="max-w-95 space-y-2 px-6 text-center">
              <div className="text-base font-medium text-(--foreground-tertiary)">
                {body.emptyState.title}
              </div>
              <div className="text-sm/normal text-(--foreground-tertiary) opacity-60">
                {body.emptyState.description}
              </div>
            </div>
          </div>
        ) : body.emptyState.type === "emptyThread" ? (
          <div className="flex items-center justify-center py-16">
            <div className="space-y-1 px-6 text-center">
              <div className="text-base font-medium text-(--foreground-tertiary)">
                {body.emptyState.title}
              </div>
              <div className="text-sm text-(--foreground-tertiary) opacity-60">
                {body.emptyState.description}
              </div>
            </div>
          </div>
        ) : body.emptyState.type === "archivedThread" ? (
          <div className="flex items-center justify-center py-16">
            <div className="space-y-3 px-6 text-center">
              <div className="space-y-1">
                <div className="text-base font-medium text-(--foreground-tertiary)">
                  {body.emptyState.title}
                </div>
                <div className="text-sm text-(--foreground-tertiary) opacity-60">
                  {body.emptyState.description}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleRestoreArchivedThread()}
                disabled={isRestoringArchivedThread || !threadId}
                className="mx-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-token-foreground px-3 text-sm font-medium text-token-background transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
              >
                {isRestoringArchivedThread ? (
                  <ActivitySpinnerIcon className="icon-xs" />
                ) : (
                  <RefreshIcon className="icon-xs" />
                )}
                Restore
              </button>
            </div>
          </div>
        ) : body.emptyState.type === "resumingThread" ? (
          <LocalConversationResumeLoader
            title={body.emptyState.title}
            description={body.emptyState.description}
            fillParent
          />
        ) : body.emptyState.type === "threadAttachmentFailed" && attachmentFailure ? (
          <ThreadAttachmentFailureNotice
            failure={attachmentFailure}
            onRetry={retryAttachment}
            fillParent
          />
        ) : (
          <div
            ref={contentRootRef}
            data-thread-find-target="conversation"
            className={LOCAL_CONVERSATION_CONTENT_CLASS_NAME}
          >
            {attachmentFailure ? (
              <ThreadAttachmentFailureNotice
                failure={attachmentFailure}
                onRetry={retryAttachment}
              />
            ) : null}
            <LocalConversationVirtualizedTurnList
              key={conversation?.threadId ?? body.threadId ?? "unattached"}
              entries={virtualizedEntries}
              historyRows={historyRows}
              conversationId={conversation?.threadId ?? body.threadId ?? ""}
              threadCwd={conversation?.cwd ?? null}
              projectWorkspacePath={projectWorkspacePath}
              projectlessOutputDirectory={projectlessOutputDirectory}
              editableTurnId={editableTurnId}
              canForkFromTurn={canForkFromTurn}
              initialCollapsedAgentBodyByTurnSearchKey={initialUiState?.collapsedAgentBodyByTurnId}
              onEditLastTurnMessage={handleEditLastUserTurn}
              onForkTurnMessage={handleForkFromTurn}
              onOpenTurnDiffReview={actions.onOpenTurnDiffReview}
              onOpenTurnDiffFileInSidePanel={actions.onOpenTurnDiffFileInSidePanel}
              onOpenSideChat={actions.onOpenSideChat}
              onOpenThread={actions.onOpenThread}
              onOpenSummaryScheduledAutomation={actions.onOpenSummaryScheduledAutomation}
              onOpenMcpAppSidePanel={actions.onOpenMcpAppSidePanel}
              onOpenPlanInSidePanel={actions.onOpenPlanInSidePanel}
              onClosePlanSidePanel={actions.onClosePlanSidePanel}
              planSidePanelState={planSidePanelState}
              childMemberships={childMemberships}
              backgroundAgentRows={backgroundAgentRows}
              turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
              initialScrollOffset={normalizeThreadRestoreDistanceFromBottomPx(
                initialRestoreSnapshot.distanceFromBottomPx,
              )}
              initialRestoreState={initialRestoreSnapshot.virtualizedTurnList}
              initialLatestTurnRestoreState={initialRestoreSnapshot.latestTurn}
              latestTurnSynchronousMeasurementKey={body.latestTurnId ?? body.turnCount}
              onLatestTurnRestoreStateChange={handleLatestTurnRestoreStateChange}
              onRestoreStateChange={handleVirtualizedTurnRestoreStateChange}
              onLoadHistoryBoundary={handleLoadHistoryBoundary}
              historyTurnItemsRefs={historyTurnItemsRefs}
              onLoadHistoryTurnItems={handleLoadHistoryTurnItems}
              onVisibleHistoryTurnIdsChange={handleVisibleHistoryTurnIdsChange}
              scrollElement={scrollElement}
              onApiChange={(api) => {
                listApiRef.current = api;
              }}
            />
          </div>
        )}
      </div>
      <LocalConversationForkFromTurnDialog
        open={forkDialogState !== null}
        isWorktreeThread={isWorktreeThread}
        canForkIntoWorktree={onForkFromTurnIntoWorktree !== undefined}
        isSubmitting={isForkSubmitting}
        showWorktreeOption={onForkFromTurnIntoWorktree !== undefined}
        onOpenChange={(open) => {
          if (open || isForkSubmitting) return;
          setForkDialogState(null);
        }}
        onForkIntoLocal={() => {
          if (!forkDialogState) return;
          void runForkFromTurn(forkDialogState);
        }}
        onForkIntoWorktree={() => {
          if (!forkDialogState) return;
          void runForkFromTurnIntoWorktree(forkDialogState);
        }}
      />
    </>
  );
}

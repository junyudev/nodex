import { ThreadForkSubmissionContext } from "./shared/thread-fork-state";
import { CodexThreadNavigationMarker } from "./codex-thread-navigation-marker";
import { isLocalConversationWriterConflict } from "../conversation-attachment-state";
import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { appScope, useScopeHandle, type ScopeHandle } from "@/lib/maitai";
import {
  ActivitySpinnerIcon,
  CheckmarkIcon,
  RefreshIcon,
  RetryIcon,
} from "@/components/shared/icons";
import {
  useRegisterContentSearchSource,
  type ContentSearchLocalSource,
} from "@/features/content-search/content-search-context";
import { clearContentSearchMarks } from "@/features/content-search/content-search-dom";
import { createLocalConversationSearchHighlightOwner } from "./local-conversation-search-highlight-owner";
import {
  scrollToLocalConversationSearchMatch,
  waitForLocalConversationSearchLayout,
} from "./local-conversation-search-scroll";
import { cn } from "../../../lib/utils";
import type {
  PageRunInTarget,
  CodexConversationCapabilityFlags,
  CodexCanonicalServerRequest,
  CodexConversationChildMembership,
  CodexConversationResumeState,
  CodexConversationServerRequest,
  CodexConversationTurn,
  CodexConversationTurnPagination,
} from "../../../lib/types";
import {
  hydrateLocalPersistedHistoryOccurrence,
  searchLocalPersistedHistory,
} from "../local-conversation-store";
import {
  selectVisibleConversationTurnEntries,
  isNormalizedConversationTurnEntry,
  materializeConversationTurnListEntry,
  type ConversationTurnListEntry,
  type VisibleConversationContext,
} from "../selectors";
import { useCodexTranscriptStructure } from "../normalized-transcript-hooks";
import type { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import { revealContentSearchUnit } from "../../content-search/content-search-reveal-owner";
import { selectNormalizedConversationEntriesWithFirstSubmission } from "../normalized-transcript-selectors";
import {
  isCodexRealtimeTimelineEntry,
  projectNormalizedTimelineEntries,
  type CodexTimelineViewEntry,
} from "../projection/normalized-timeline-entries";
import { readCanonicalClientUserMessageId } from "../../conversation-launch/session-first-submission-owner";
import type {
  ThreadBodyModel,
  ThreadBodyUiStateOverrides,
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadPlanSidePanelState,
  ThreadStageActions,
} from "../thread-stage-types";
import type { LocalConversationAttachmentState } from "../conversation-attachment-state";
import type { ConversationHistoryPort } from "../conversation-runtime";
import { buildThreadUserMessageNavigationItems } from "../projection/thread-user-message-navigation-items";
import {
  buildTurnTimestampMarkers,
  resolveConversationTimestampSeparators,
} from "../projection/conversation-turn-timestamps";
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
import {
  createLocalConversationSearchSource,
  projectLocalConversationResidentSearchResult,
} from "./local-conversation-search-source";
import {
  isLocalConversationPersistedSearchMatchMeta,
  mergeLocalConversationSearchResults,
  projectLocalConversationPersistedSearchResult,
  waitForLocalConversationPersistedSearchTarget,
  type LocalConversationSearchTarget,
} from "./local-conversation-persisted-search";
import { projectLocalConversationLegacyHistoryRows } from "./local-conversation-history-gap";
import { LocalConversationSelectedTextActions } from "./local-conversation-selected-text-actions";
import {
  LocalConversationPromptRail,
  waitForLocalConversationPromptRailResidentTarget,
} from "./local-conversation-prompt-rail";
import { formatBoundedWorktreeOutput } from "../../../../shared/worktree-output";
import type {
  CodexHistoryRow,
  CodexHistoryTurnItemsPagination,
} from "../../../../shared/codex-conversation-state/codex-history-topology";
import { createCodexConversationHistoryTurnItemsRef } from "../../../../shared/codex-conversation-history-page";
import {
  codexConversationTurnHasUserMessage,
  resolveEditableUserTurnIds,
} from "../../../../shared/codex-user-turn-edit";

const NO_EDITABLE_USER_TURNS: ReadonlySet<string> = new Set();

const PROGRESS_PHASES = [
  { key: "creatingWorktree", label: "Worktree" },
  { key: "runningSetup", label: "Setup" },
  { key: "startingThread", label: "Thread" },
] as const;

/** Holds committed search inputs and mounted DOM/API handles without subscribing to text. */
function createThreadBodySearchReadPort(
  initialEntries: readonly CodexTimelineViewEntry[],
  initialTurns: readonly ConversationTurnListEntry[],
) {
  let entries = initialEntries;
  let turns = initialTurns;
  let root: HTMLDivElement | null = null;
  let listApi: LocalConversationVirtualizedTurnListApi | null = null;
  return {
    updateCommittedEntries: (
      nextEntries: readonly CodexTimelineViewEntry[],
      nextTurns: readonly ConversationTurnListEntry[],
    ) => {
      entries = nextEntries;
      turns = nextTurns;
    },
    readProjectedEntries: () => entries,
    readTurns: () =>
      turns.flatMap((entry) => {
        const materialized = materializeConversationTurnListEntry(entry);
        return materialized ? [materialized] : [];
      }),
    readListApi: () => listApi,
    setListApi: (next: LocalConversationVirtualizedTurnListApi | null) => {
      listApi = next;
    },
    readRoot: () => root,
    setRoot: (next: HTMLDivElement | null) => {
      root = next;
    },
  };
}

/** Search callbacks read committed inputs only when a search or reveal runs. */
function createThreadBodySearchSource({
  appHandle,
  bodyThreadId,
  cwd,
  projectlessOutputDirectory,
  threadId,
  transcriptOwner,
  reads,
}: {
  readonly appHandle: ScopeHandle;
  readonly bodyThreadId: string | null;
  readonly cwd: string | null | undefined;
  readonly projectlessOutputDirectory: string | null | undefined;
  readonly threadId: string | null;
  readonly transcriptOwner: CodexTranscriptReadOwner | null;
  readonly reads: ReturnType<typeof createThreadBodySearchReadPort>;
}) {
  return createLocalConversationSearchSource({
    routeContextId: bodyThreadId ? `conversation:${bodyThreadId}` : "unavailable",
    cwd,
    projectlessOutputDirectory,
    getProjectedEntries: reads.readProjectedEntries,
    readOwner: () => transcriptOwner,
    getTurns: reads.readTurns,
    scrollAdapter: {
      scrollToTurn: async (turnKey, options) => {
        if (options?.signal?.aborted) return;
        const targetEntry = reads.readProjectedEntries().find((entry) => entry.turnKey === turnKey);
        if (threadId && targetEntry && !isCodexRealtimeTimelineEntry(targetEntry)) {
          const collapseKey = {
            conversationId: threadId,
            turnSearchKey: targetEntry.turnSearchKey,
          };
          if (appHandle.get(localConversationTurnCollapseOverrideFamily(collapseKey)) !== false) {
            setLocalConversationTurnCollapseOverride(appHandle, collapseKey, false);
          }
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              resolve();
            });
          });
          if (options?.signal?.aborted) return;
        }
        const api = reads.readListApi();
        if (!api) return;
        await api.scrollToKey(turnKey, undefined, { signal: options?.signal });
        if (options?.signal?.aborted) return;
        await waitForLocalConversationSearchLayout(options?.signal);
      },
      getTurnContainer: (turnKey) =>
        reads
          .readRoot()
          ?.querySelector<HTMLElement>(`[data-content-search-turn-key="${turnKey}"]`) ?? null,
    },
  });
}

function createThreadBodySearchHighlights(
  reads: ReturnType<typeof createThreadBodySearchReadPort>,
  persistedSearchTargets: Map<string, LocalConversationSearchTarget>,
  searchSource: ReturnType<typeof createLocalConversationSearchSource>,
) {
  return createLocalConversationSearchHighlightOwner({
    readRoot: reads.readRoot,
    resolveTarget: (match) => {
      if (isConversationSearchMatchMeta(match.meta)) return match.meta;
      if (!isLocalConversationPersistedSearchMatchMeta(match.meta)) return null;
      return persistedSearchTargets.get(match.id) ?? searchSource.findPersistedTarget(match.meta);
    },
  });
}

async function readThreadBodyPersistedSearch({
  threadId,
  query,
  resident,
  searchSource,
  limit,
  signal,
}: {
  readonly threadId: string;
  readonly query: string;
  readonly resident: ReturnType<typeof projectLocalConversationResidentSearchResult>;
  readonly searchSource: ReturnType<typeof createLocalConversationSearchSource>;
  readonly limit: number;
  readonly signal?: AbortSignal;
}) {
  try {
    const result = await searchLocalPersistedHistory(threadId, query);
    if (signal?.aborted || result.status !== "completed") return null;
    return {
      page: result.page,
      merged: mergeLocalConversationSearchResults({
        resident,
        persisted: projectLocalConversationPersistedSearchResult({
          page: result.page,
          contextId: searchSource.routeContextId,
          limit,
        }),
        resolveResidentTarget: searchSource.findPersistedTarget,
      }),
    };
  } catch {
    return null;
  }
}

async function withThreadBodyCleanup(operation: () => Promise<void>, cleanup: () => void) {
  try {
    await operation();
  } finally {
    cleanup();
  }
}

function turnEntryHasMcpApp(entry: LocalConversationVirtualizedTurnListEntry | undefined): boolean {
  if (entry && isCodexRealtimeTimelineEntry(entry)) return false;
  if (entry && isNormalizedConversationTurnEntry(entry)) return entry.hasMcpApp;
  return entry?.turn.items.some((item) => item.mcpToolCall?.mcpAppResourceUri != null) === true;
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
            <CheckmarkIcon className="size-3.5 shrink-0 text-info" />
          ) : (
            <ActivitySpinnerIcon className="size-3.5 shrink-0 text-(--foreground-tertiary)" />
          )}
          <span>
            {progress.message || (isFailed ? "Message could not be sent." : "Sending message…")}
          </span>
        </div>
        {isFailed && outputText.trim().length > 0 ? (
          <pre className="codex-tool-code scrollbar-token mt-3 max-h-32 overflow-auto rounded-lg border-[0.5px] border-(--border) bg-(--background-secondary) p-3 text-left font-mono text-size-code wrap-break-word whitespace-pre-wrap text-(--foreground-tertiary)">
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
                  className={cn("mx-1 h-px w-4", isComplete ? "bg-chart-blue" : "bg-(--border)")}
                />
              ) : null}
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full font-sans text-xs leading-none font-medium transition-colors duration-200",
                    isComplete && "bg-chart-blue text-(--app-color-text-on-accent)",
                    isActive &&
                      "bg-(--color-background-info-soft) text-info ring-1 ring-token-focus-border/40",
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
          <pre className="codex-tool-code font-mono text-size-code wrap-break-word whitespace-pre-wrap text-(--foreground-tertiary)">
            {outputText || "Preparing…\n"}
          </pre>
        </div>
      </div>
    </div>
  );
}

type LocalConversationRestoredTurnListProps = Omit<
  ComponentProps<typeof LocalConversationVirtualizedTurnList>,
  "initialScrollOffset" | "initialRestoreState" | "initialLatestTurnRestoreState"
> & {
  readonly readRestoreSnapshot: () => LocalConversationThreadRestoreSnapshot;
  readonly onRestoreSnapshotChange: LocalConversationThreadBodyOwnerProps["onRestoreSnapshotChange"];
};

/** A mounted transcript restores once; removing its rows cannot overwrite the saved position. */
function LocalConversationRestoredTurnList({
  readRestoreSnapshot,
  onRestoreSnapshotChange,
  ...props
}: LocalConversationRestoredTurnListProps) {
  const [initialRestoreSnapshot] = useState(readRestoreSnapshot);
  const { addScrollListener } = useLocalConversationThreadScrollController();
  useLayoutEffect(
    () =>
      addScrollListener((distanceFromBottomPx) => {
        onRestoreSnapshotChange((current) => ({
          ...current,
          distanceFromBottomPx: Number.isFinite(distanceFromBottomPx)
            ? Math.max(0, distanceFromBottomPx)
            : 0,
        }));
      }),
    [addScrollListener, onRestoreSnapshotChange],
  );

  return (
    <LocalConversationVirtualizedTurnList
      {...props}
      initialScrollOffset={normalizeThreadRestoreDistanceFromBottomPx(
        initialRestoreSnapshot.distanceFromBottomPx,
      )}
      initialRestoreState={initialRestoreSnapshot.virtualizedTurnList}
      initialLatestTurnRestoreState={initialRestoreSnapshot.latestTurn}
    />
  );
}

interface LocalConversationThreadBodyOwnerProps {
  body: ThreadBodyModel;
  projectId: string | null;
  hostId: string;
  threadId: string | null;
  isSideChat: boolean;
  cwd: string | null;
  turns: CodexConversationTurn[];
  firstSubmissionTurn?: CodexConversationTurn | null;
  turnPagination: CodexConversationTurnPagination | null;
  historyRows?: readonly CodexHistoryRow[];
  history?: ConversationHistoryPort;
  historyTopologyGeneration?: number;
  turnItemsPaginationById?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  requests: CodexConversationServerRequest[];
  canonicalRequests: CodexCanonicalServerRequest[];
  resumeState: CodexConversationResumeState | null;
  attachmentState?: LocalConversationAttachmentState;
  capabilityFlags: CodexConversationCapabilityFlags;
  parentTurns: readonly CodexConversationTurn[];
  childMemberships: readonly CodexConversationChildMembership[];
  parentModel?: string | null;
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
  readRestoreSnapshot: () => LocalConversationThreadRestoreSnapshot;
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
  hostId,
  threadId,
  isSideChat,
  cwd,
  turns,
  firstSubmissionTurn,
  turnPagination,
  historyRows: canonicalHistoryRows,
  history,
  historyTopologyGeneration,
  turnItemsPaginationById,
  requests,
  canonicalRequests,
  resumeState,
  attachmentState,
  capabilityFlags,
  parentTurns,
  childMemberships,
  parentModel,
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
  readRestoreSnapshot,
  onRestoreSnapshotChange,
  turnDiffHoverPreviewDisabled = false,
}: LocalConversationThreadBodyOwnerProps) {
  const { owner: transcriptOwner, structure: transcriptStructure } = useCodexTranscriptStructure();
  const transcriptViewer = useRef(Symbol("transcript-view"));
  const reportHistoryViewport = useCallback(
    (
      boundary:
        | import("../../../../shared/codex-history-policy").CodexHistoryViewportBoundary
        | null
        | undefined,
    ) => {
      transcriptOwner?.setHistoryViewport(transcriptViewer.current, boundary);
    },
    [transcriptOwner],
  );
  useEffect(() => {
    const viewer = transcriptViewer.current;
    return () => transcriptOwner?.setHistoryViewport(viewer, undefined);
  }, [transcriptOwner]);
  const threadScrollController = useLocalConversationThreadScrollController();
  const { scrollElement } = threadScrollController;
  const searchScrollControllerRef = useRef(threadScrollController);
  useInsertionEffect(() => {
    searchScrollControllerRef.current = threadScrollController;
  }, [threadScrollController]);
  const appHandle = useScopeHandle(appScope);
  const setupProgressLogRef = useRef<HTMLDivElement>(null);
  const [forkDialogState, setForkDialogState] = useState<{
    threadId: string;
    turnId: string;
    message: string;
  } | null>(null);
  const forkSubmissionInFlightRef = useRef(false);
  const [forkingTurnId, setForkingTurnId] = useState<string | null>(null);
  const isForkSubmitting = forkingTurnId !== null;
  const [isRestoringArchivedThread, setIsRestoringArchivedThread] = useState(false);
  const attachmentFailure =
    attachmentState?.status === "failed" && !isLocalConversationWriterConflict(attachmentState)
      ? attachmentState
      : null;
  const retryAttachment = useCallback(() => {
    if (!threadId || !actions.onRetryThreadAttachment) return;
    void actions.onRetryThreadAttachment(threadId);
  }, [actions, threadId]);
  const conversation = useMemo<VisibleConversationContext | null>(
    () =>
      threadId || turns.length > 0
        ? {
            threadId: threadId ?? turns[0]?.threadId ?? "unattached",
            projectId: null,
            resumeState: resumeState ?? "needs_resume",
            turns,
            requests,
            canonicalRequests,
          }
        : null,
    [canonicalRequests, requests, resumeState, threadId, turns],
  );

  const editableTurnIds = useMemo(
    () =>
      capabilityFlags.canEditUserTurns
        ? resolveEditableUserTurnIds(
            transcriptOwner && parentTurns.length === 0
              ? (transcriptStructure?.turns ?? []).map((row) => ({
                  turnId: row.value.details.turnId,
                  status: row.value.details.status,
                  hasUserMessage: row.hasUserMessage && !row.isStartupPrewarm,
                }))
              : turns.map((turn) => ({
                  turnId: turn.turnId,
                  status: turn.status,
                  hasUserMessage: codexConversationTurnHasUserMessage(turn),
                })),
          )
        : NO_EDITABLE_USER_TURNS,
    [
      capabilityFlags.canEditUserTurns,
      parentTurns.length,
      transcriptOwner,
      transcriptStructure,
      turns,
    ],
  );
  const canForkFromTurn = capabilityFlags.canForkFromTurn;
  const [firstSubmissionPresentation, setFirstSubmissionPresentation] =
    useState<CodexConversationTurn | null>(firstSubmissionTurn ?? null);
  const presentation = firstSubmissionTurn ?? firstSubmissionPresentation;
  const presentationClientId = presentation ? readCanonicalClientUserMessageId(presentation) : null;
  const shouldRetireFirstSubmission = Boolean(
    presentation &&
    ((presentation.threadId !== threadId && !firstSubmissionTurn) ||
      transcriptStructure?.turns.some(
        (row) => row.value.details.params.clientUserMessageId === presentationClientId,
      )),
  );
  // The launch owner may acknowledge its legacy canonical projection before this
  // subscription has committed a multipart reset. Only the read owner retires this row.
  const retainedFirstSubmission = shouldRetireFirstSubmission ? null : presentation;
  if (retainedFirstSubmission !== firstSubmissionPresentation)
    setFirstSubmissionPresentation(retainedFirstSubmission);
  const turnEntries = useMemo(
    () =>
      transcriptOwner && parentTurns.length === 0
        ? selectNormalizedConversationEntriesWithFirstSubmission({
            owner: transcriptOwner,
            structure: transcriptStructure,
            conversation,
            firstSubmissionTurn: retainedFirstSubmission,
          })
        : selectVisibleConversationTurnEntries({
            conversation,
            parentTurns,
          }),
    [conversation, parentTurns, transcriptOwner, transcriptStructure, retainedFirstSubmission],
  );
  const timelineProjection = useMemo(
    () =>
      transcriptOwner && parentTurns.length === 0
        ? projectNormalizedTimelineEntries({
            owner: transcriptOwner,
            structure: transcriptStructure,
            entries: turnEntries,
          })
        : { entries: turnEntries, historyRows: null },
    [parentTurns.length, transcriptOwner, transcriptStructure, turnEntries],
  );
  const displayedTurnEntries = useMemo(
    () =>
      timelineProjection.entries.filter(
        (entry): entry is ConversationTurnListEntry => !isCodexRealtimeTimelineEntry(entry),
      ),
    [timelineProjection.entries],
  );
  const virtualizedEntries = useMemo<LocalConversationVirtualizedTurnListEntry[]>(() => {
    const groups = timelineProjection.entries.map((entry) =>
      isCodexRealtimeTimelineEntry(entry)
        ? []
        : isNormalizedConversationTurnEntry(entry)
          ? [
              ...(entry.hasUserMessage
                ? [{ role: "user" as const, sentAtMs: entry.turnStartedAtMs }]
                : []),
              ...(entry.hasAssistantMessage
                ? [{ role: "assistant" as const, sentAtMs: entry.finalAssistantStartedAtMs }]
                : []),
            ]
          : buildTurnTimestampMarkers(entry.turn),
    );
    const timestamps = resolveConversationTimestampSeparators(
      turnPagination?.hasLoadedOldest === false || parentTurns.length > 0
        ? [null, ...groups]
        : groups,
    );
    if (turnPagination?.hasLoadedOldest === false || parentTurns.length > 0) timestamps.shift();
    return timelineProjection.entries.map((entry, index) => ({
      ...entry,
      timestampSeparatorAtMs: timestamps[index] ?? null,
    }));
  }, [parentTurns.length, timelineProjection.entries, turnPagination?.hasLoadedOldest]);
  const historyRows = useMemo(
    () =>
      timelineProjection.historyRows ??
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
      timelineProjection.historyRows,
    ],
  );

  const historyTurnItemsRefs = useMemo(() => {
    if (historyTopologyGeneration === undefined) return {};
    return Object.fromEntries(
      Object.entries(turnItemsPaginationById ?? {}).flatMap(([turnId, pagination]) => {
        const older = createCodexConversationHistoryTurnItemsRef({
          turnId,
          expectedTopologyGeneration: historyTopologyGeneration,
          pagination,
          edge: "older",
        });
        const newer = createCodexConversationHistoryTurnItemsRef({
          turnId,
          expectedTopologyGeneration: historyTopologyGeneration,
          pagination,
          edge: "newer",
        });
        return older || newer ? [[turnId, { older, newer }] as const] : [];
      }),
    );
  }, [historyTopologyGeneration, turnItemsPaginationById]);
  const userMessageNavigationItems = useMemo(
    () =>
      buildThreadUserMessageNavigationItems(
        turnEntries.flatMap((entry) => {
          const materialized = materializeConversationTurnListEntry(entry);
          return materialized ? [materialized] : [];
        }),
        {
          cwd,
          projectlessOutputDirectory,
        } satisfies ProjectlessOutputScope,
      ),
    [cwd, projectlessOutputDirectory, turnEntries],
  );
  const userMessageNavigationItemsRef = useRef(userMessageNavigationItems);
  const [searchReads] = useState(() =>
    createThreadBodySearchReadPort(timelineProjection.entries, displayedTurnEntries),
  );
  useInsertionEffect(() => {
    userMessageNavigationItemsRef.current = userMessageNavigationItems;
    searchReads.updateCommittedEntries(timelineProjection.entries, displayedTurnEntries);
  }, [displayedTurnEntries, timelineProjection.entries, userMessageNavigationItems, searchReads]);
  const persistedSearchSessionRef = useRef<{
    threadId: string;
    hostId: string;
    hostGeneration: number;
    topologyGeneration: number;
  } | null>(null);
  const [persistedSearchTargets] = useState(() => new Map<string, LocalConversationSearchTarget>());
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

  const searchSource = useMemo(
    () =>
      createThreadBodySearchSource({
        appHandle,
        bodyThreadId: body.threadId,
        cwd,
        projectlessOutputDirectory,
        threadId,
        transcriptOwner,
        reads: searchReads,
      }),
    [
      appHandle,
      body.threadId,
      cwd,
      projectlessOutputDirectory,
      threadId,
      transcriptOwner,
      searchReads,
    ],
  );

  useEffect(() => {
    searchSource.pruneCachedData();
  }, [searchSource, timelineProjection.entries]);

  useEffect(() => () => searchSource.clearCachedData(), [searchSource]);

  useEffect(() => {
    clearContentSearchMarks(searchReads.readRoot());
    persistedSearchSessionRef.current = null;
    persistedSearchTargets.clear();
    setForkDialogState(null);
  }, [body.threadId, persistedSearchTargets, searchReads]);

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

  const searchHighlights = useMemo(
    () => createThreadBodySearchHighlights(searchReads, persistedSearchTargets, searchSource),
    [persistedSearchTargets, searchReads, searchSource],
  );
  const setContentRoot = useCallback(
    (element: HTMLDivElement | null) => {
      searchReads.setRoot(element);
      searchHighlights.refresh();
    },
    [searchHighlights, searchReads],
  );
  const contentSearchSource = useMemo<ContentSearchLocalSource>(() => {
    return {
      domain: "conversation",
      contextId: searchSource.routeContextId,
      publishResult: searchHighlights.publishResult,
      async search(query, limit, options) {
        const literalQuery = query.trim();
        if (!literalQuery) {
          return { query, matches: [], totalMatches: 0, capped: false };
        }
        const resident = projectLocalConversationResidentSearchResult({
          units: searchSource.findMatches(literalQuery),
          query: literalQuery,
          contextId: searchSource.routeContextId,
          limit,
        });
        const persistedThreadId = threadId ?? body.threadId;
        if (persistedThreadId) {
          const result = await readThreadBodyPersistedSearch({
            threadId: persistedThreadId,
            query: literalQuery,
            resident,
            searchSource,
            limit,
            signal: options?.signal,
          });
          if (options?.signal.aborted)
            return { query, matches: [], totalMatches: 0, capped: false };
          if (result) {
            const page = result.page;
            persistedSearchSessionRef.current = {
              threadId: page.threadId,
              hostId: page.hostId,
              hostGeneration: page.hostGeneration,
              topologyGeneration: page.topologyGeneration,
            };
            persistedSearchTargets.clear();
            return result.merged;
          }
        }

        persistedSearchSessionRef.current = null;
        persistedSearchTargets.clear();
        return resident;
      },
      async ensureVisible(match, { signal }) {
        if (isConversationSearchMatchMeta(match.meta)) {
          const target = match.meta;
          const unit = Array.from(
            searchReads
              .readRoot()
              ?.querySelectorAll<HTMLElement>("[data-content-search-unit-key]") ?? [],
          ).find((unit) => unit.dataset.contentSearchUnitKey === target.unitKey);
          if (unit && revealContentSearchUnit(unit)) {
            await waitForLocalConversationSearchLayout(signal);
            if (signal.aborted) return;
            searchHighlights.refresh();
          }
          if (searchHighlights.readActiveMatch(match.id)) return;
          await searchSource.scrollAdapter.scrollToTurn(target.turnKey, { signal });
          if (!signal.aborted) searchHighlights.refresh();
          return;
        }
        if (!isLocalConversationPersistedSearchMatchMeta(match.meta)) return;
        const meta = match.meta;
        const persistedThreadId = threadId ?? body.threadId;
        if (!persistedThreadId || meta.threadId !== persistedThreadId) return;

        persistedSearchTargets.delete(match.id);
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

        const target = await waitForLocalConversationPersistedSearchTarget({
          signal,
          waitForRender: nextAnimationFrame,
          readTarget: () => searchSource.findPersistedTarget(meta),
        });
        if (signal.aborted) return;
        if (target) {
          persistedSearchTargets.set(match.id, target);
          await searchSource.scrollAdapter.scrollToTurn(target.turnKey, { signal });
          if (!signal.aborted) searchHighlights.refresh();
          return;
        }
        throw new Error("Hydrated persisted-history occurrence is not renderable");
      },
      async activate(match, _query, options) {
        const target = isConversationSearchMatchMeta(match.meta)
          ? match.meta
          : isLocalConversationPersistedSearchMatchMeta(match.meta)
            ? persistedSearchTargets.get(match.id)
            : null;
        if (!target) return;
        const root = searchReads.readRoot();
        if (!root) return;
        if (options?.signal?.aborted) return;
        const unit = Array.from(
          root.querySelectorAll<HTMLElement>("[data-content-search-unit-key]"),
        ).find((unit) => unit.dataset.contentSearchUnitKey === target.unitKey);
        if (unit && revealContentSearchUnit(unit))
          await waitForLocalConversationSearchLayout(options?.signal);
        if (options?.signal?.aborted) return;
        if (!searchHighlights.readActiveMatch(match.id)) searchHighlights.refresh();
        return scrollToLocalConversationSearchMatch({
          signal: options?.signal,
          readMatch: () => searchHighlights.readActiveMatch(match.id),
          scroll: (activeElement) => {
            const scroll = searchScrollControllerRef.current;
            // A resident mark skips row placement, but still retires latest-turn following.
            scroll.holdViewport();
            scroll.setScrollMode("programmaticFind");
            scroll.scrollElementIntoView(activeElement, "smooth", "center", {
              turnKey: target.turnKey,
              signal: options?.signal,
              readTarget: () => searchHighlights.readActiveMatch(match.id),
            });
          },
        });
      },
      clear() {
        searchHighlights.clear();
      },
    };
  }, [
    body.threadId,
    persistedSearchTargets,
    searchSource,
    threadId,
    searchHighlights,
    searchReads,
  ]);
  useRegisterContentSearchSource(contentSearchSource);

  const handleEditUserTurn = useCallback(
    async (input: { threadId: string; turnId: string; message: string }) => {
      onErrorMessage(null);
      threadScrollController.prepareLatestTurnSubmitPlacement({ placeLatestTurn: true });
      try {
        await actions.onEditUserTurn(input);
      } catch (error) {
        threadScrollController.clearPendingLatestTurnSubmitPlacement();
        const nextError = error instanceof Error ? error.message : "Could not edit the message";
        onErrorMessage(nextError);
        throw error;
      }
    },
    [actions, onErrorMessage, threadScrollController],
  );

  const runForkChoice = useCallback(
    async (turnId: string, fork: () => Promise<void>, fallbackError: string) => {
      if (forkSubmissionInFlightRef.current) return;

      forkSubmissionInFlightRef.current = true;
      setForkingTurnId(turnId);
      onErrorMessage(null);
      await withThreadBodyCleanup(
        async () => {
          try {
            await fork();
            setForkDialogState(null);
          } catch (error) {
            onErrorMessage(error instanceof Error ? error.message : fallbackError);
          }
        },
        () => {
          forkSubmissionInFlightRef.current = false;
          setForkingTurnId(null);
        },
      );
    },
    [onErrorMessage],
  );

  const runForkFromTurn = useCallback(
    async (input: { threadId: string; turnId: string; message: string }) => {
      await runForkChoice(
        input.turnId,
        () => actions.onForkFromTurn(input),
        "Could not fork the conversation",
      );
    },
    [actions, runForkChoice],
  );

  const runForkFromTurnIntoWorktree = useCallback(
    async (input: { threadId: string; turnId: string; message: string }) => {
      if (!onForkFromTurnIntoWorktree) return;

      await runForkChoice(
        input.turnId,
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
    await withThreadBodyCleanup(
      async () => {
        try {
          await actions.onUnarchiveThread(threadId, projectId);
        } catch (error) {
          onErrorMessage(error instanceof Error ? error.message : String(error));
        }
      },
      () => setIsRestoringArchivedThread(false),
    );
  }, [actions, isRestoringArchivedThread, onErrorMessage, projectId, threadId]);

  const handleRevealUserMessageNavigationItem = useCallback(
    async (item: ThreadUserMessageNavigationItem): Promise<HTMLElement | null> => {
      const unitSelector = `[data-content-search-unit-key="${escapeAttributeSelectorValue(item.id)}"]`;
      const api = searchReads.readListApi();
      if (api) {
        await api.scrollToKey(item.turnKey, (turnElement) =>
          turnElement.querySelector<HTMLElement>(unitSelector),
        );
        await nextAnimationFrame();
      }

      return searchReads.readRoot()?.querySelector<HTMLElement>(unitSelector) ?? null;
    },
    [searchReads],
  );
  const handleRevealInstalledPromptRailTurn = useCallback(
    async (
      turnId: string,
      mode: "smooth" | "instant",
      signal: AbortSignal,
    ): Promise<HTMLElement | null> =>
      await waitForLocalConversationPromptRailResidentTarget({
        turnId,
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

  const selectedTextActionsEnabled = Boolean(threadId && body.emptyState.type === "none");

  return (
    <>
      <CodexThreadNavigationMarker
        threadId={threadId}
        isSideChat={isSideChat}
        contentReady={
          !body.showThreadStartProgressPanel &&
          (body.emptyState.type === "none" ||
            body.emptyState.type === "emptyThread" ||
            body.emptyState.type === "archivedThread")
        }
      />
      <LocalConversationPromptRail
        port={history?.promptRail ?? null}
        threadId={threadId ?? body.threadId}
        residentItems={userMessageNavigationItems}
        revealResidentItem={handleRevealUserMessageNavigationItem}
        revealInstalledTurn={handleRevealInstalledPromptRailTurn}
      />
      <LocalConversationSelectedTextActions
        key={threadId}
        enabled={selectedTextActionsEnabled}
        hostId={hostId}
        threadId={threadId}
        scrollElement={scrollElement}
        onOpenSideChat={isSideChat ? undefined : actions.onOpenSideChat}
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
            ref={setContentRoot}
            data-thread-find-target="conversation"
            className={LOCAL_CONVERSATION_CONTENT_CLASS_NAME}
          >
            {attachmentFailure ? (
              <ThreadAttachmentFailureNotice
                failure={attachmentFailure}
                onRetry={retryAttachment}
              />
            ) : null}
            <ThreadForkSubmissionContext value={forkingTurnId}>
              <LocalConversationRestoredTurnList
                key={conversation?.threadId ?? body.threadId ?? "unattached"}
                entries={virtualizedEntries}
                historyRows={historyRows}
                onHistoryRetentionBoundaryChange={reportHistoryViewport}
                conversationId={conversation?.threadId ?? body.threadId ?? ""}
                threadCwd={cwd}
                parentModel={parentModel}
                projectWorkspacePath={projectWorkspacePath}
                projectlessOutputDirectory={projectlessOutputDirectory}
                editableTurnIds={editableTurnIds}
                canForkFromTurn={canForkFromTurn}
                initialCollapsedAgentBodyByTurnSearchKey={
                  initialUiState?.collapsedAgentBodyByTurnId
                }
                onEditUserTurn={handleEditUserTurn}
                onForkTurnMessage={handleForkFromTurn}
                onOpenTurnDiffReview={actions.onOpenTurnDiffReview}
                onOpenTurnDiffFileInSidePanel={actions.onOpenTurnDiffFileInSidePanel}
                onOpenSideChat={actions.onOpenSideChat}
                onOpenThread={actions.onOpenThread}
                onOpenSubagentsPanel={actions.onOpenSubagentsPanel}
                onOpenSummaryScheduledAutomation={actions.onOpenSummaryScheduledAutomation}
                onOpenMcpAppSidePanel={actions.onOpenMcpAppSidePanel}
                onOpenPlanInSidePanel={actions.onOpenPlanInSidePanel}
                onClosePlanSidePanel={actions.onClosePlanSidePanel}
                planSidePanelState={planSidePanelState}
                childMemberships={childMemberships}
                backgroundAgentRows={backgroundAgentRows}
                turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
                readRestoreSnapshot={readRestoreSnapshot}
                onRestoreSnapshotChange={onRestoreSnapshotChange}
                latestTurnSynchronousMeasurementKey={body.latestTurnId ?? body.turnCount}
                onLatestTurnRestoreStateChange={handleLatestTurnRestoreStateChange}
                onRestoreStateChange={handleVirtualizedTurnRestoreStateChange}
                onLoadHistoryBoundary={history?.loadBoundary}
                historyRequestSource={history}
                historyTurnItemsRefs={historyTurnItemsRefs}
                onLoadHistoryTurnItems={history?.loadTurnItems}
                scrollElement={scrollElement}
                onApiChange={(api) => {
                  searchReads.setListApi(api);
                }}
              />
            </ThreadForkSubmissionContext>
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

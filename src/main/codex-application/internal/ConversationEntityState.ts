import type {
  CodexCanonicalWorktreeInitItem,
  CodexCanonicalLiveTurnParams,
  CodexCanonicalHydratedPermissionContext,
  CodexCanonicalConversationState,
  CodexConversationThreadSettings,
  CodexThreadStatusType,
  CodexCanonicalServerRequest,
  CodexConversationTurnPagination,
  CodexConversationResumeState,
  CodexConversationSnapshot,
  CodexConversationItem,
  CodexQueuedFollowUpProjection,
  CodexThreadStreamCheckpoint,
} from "../../../shared/types";
import { EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION } from "../../../shared/codex-queued-follow-up-state";
import * as Data from "effect/Data";
import {
  appendCodexCanonicalWorktreeInitItem,
  appendCodexCanonicalInProgressSyntheticItem,
  removeCodexCanonicalLocalSyntheticItem,
  type CodexCanonicalContextCompactionItem,
  type CodexCanonicalSteeringUserMessageItem,
  type CodexCanonicalItem,
  type CodexCanonicalTurnState,
} from "../../../shared/codex-conversation-state/codex-conversation-state";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryIslandTopology,
  createEmptyCodexHistoryTopology,
  exhaustedCodexHistoryBoundary,
  flattenCodexHistoryTopology,
  insertCodexHistoryIsland,
  mergeCodexHistoryBoundaryPage,
  replaceCodexHistoryEntity,
  type CodexCanonicalHistoryTopology,
  type CodexHistoryBoundary,
  type CodexHistoryEntity,
} from "../../../shared/codex-conversation-state/codex-history-topology";
import {
  buildCodexConversationHistoryMutation,
  advanceCodexConversationHistoryItemWindowSnapshot,
  codexConversationHistoryPageRequestKey,
  codexConversationHistoryTurnItemsProgressKey,
  restoreCodexConversationHistoryItemWindow,
  seedCodexConversationHistoryItemWindow,
  snapshotCodexConversationHistoryItemWindow,
  type CodexConversationHistoryMutation,
  type CodexConversationHistoryItemWindowSnapshot,
  type CodexConversationHistoryPageRequest,
  type CodexConversationHistoryTurnItemsMutation,
} from "../../../shared/codex-conversation-history-page";
import {
  appendCodexHistoryItemPage,
  prependCodexHistoryItemPage,
  type CodexHistoryItemWindow,
} from "../../../shared/codex-conversation-state/codex-history-item-window";
import {
  DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES,
  DEFAULT_CODEX_ACTIVE_HISTORY_MAX_TURNS,
  retainCodexHistoryResidency,
  type CodexHistoryResidencyLimits,
} from "../../../shared/codex-conversation-state/codex-history-residency";
import type { ThreadGoal, Turn } from "@nodex/codex-app-server-protocol/v2";
import {
  CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID,
  reduceCodexConversationEventWithEffects,
  type CodexConversationReducerContext,
  type CodexConversationReducerEffect,
} from "../../../shared/codex-conversation-state/codex-conversation-reducer";
import {
  appendCodexCanonicalOptimisticTurn,
  bindCodexCanonicalOptimisticTurn,
  failCodexCanonicalOptimisticTurn,
} from "../../../shared/codex-conversation-state/codex-optimistic-turn";
import {
  retargetCodexCanonicalSteeringItem,
  removeCodexCanonicalSteeringItem,
  upsertCodexCanonicalSteeringItem,
} from "../../../shared/codex-conversation-state/codex-steering-state";
import {
  listCodexBackgroundTerminalTurnIds,
  reduceCodexBackgroundTerminalCleanup,
} from "../../../shared/codex-conversation-state/codex-background-terminal-cleanup";
import type {
  CodexServerRequestLifecycleResult,
  CodexServerRequestRawLifecycleResult,
  CodexServerRequestRawState,
} from "../../../shared/codex-conversation-state/codex-server-request-lifecycle";
import { completeCodexCanonicalPlanImplementationState } from "../../../shared/codex-conversation-state/codex-server-request-lifecycle";
import {
  reduceCodexConversationFrameTextDeltas,
  type CodexFrameTextDeltaOutcome,
} from "../../../shared/codex-conversation-state/codex-frame-text-delta";
import type { CodexFrameTextDeltaUpdate } from "../../../shared/codex-conversation-state/codex-frame-text-delta-queue";
import {
  reduceCodexConversationCommandOutput,
  reduceCodexConversationTerminalCommands,
  type CodexCommandExecutionMutationDisposition,
  type CodexTerminalCommandUpdate,
} from "../../../shared/codex-conversation-state/codex-command-execution-stream";
import type { CodexCommandOutputUpdate } from "../../../shared/codex-conversation-state/codex-command-output-queue";
import {
  buildCodexThreadStreamCheckpoint,
  type CodexThreadStreamReplica,
} from "../../../shared/codex-owner-follower-replication";
import {
  reduceCodexConversationThreadGoalResumeConfirmationDismissed,
  reduceCodexConversationThreadGoalUpdated,
  reduceCodexConversationThreadName,
} from "../../../shared/codex-conversation-state/codex-thread-metadata";
import { appendCodexCanonicalThreadGoalTranscriptTurn } from "../../../shared/codex-conversation-state/codex-thread-goal-transcript";
import {
  projectCodexConversationRawServerRequestLifecycle,
  projectCodexConversationPlanImplementationCompleted,
  projectCodexConversationServerRequestLifecycle,
} from "../CodexConversationServerRequestProjection";
import { projectCodexConversationSnapshot } from "../CodexConversationSnapshotProjection";
import { projectCodexConversationHistoryResidency } from "../CodexConversationHistoryResidencyProjection";
import { projectCodexConversationHistoryItemWindows } from "../CodexConversationHistoryProjection";
import type { CodexHydratedHistoryItemSegment } from "../CodexHistoryPageAdapter";
import { boundChangedCodexLiveTurns } from "../../../shared/codex-conversation-state/codex-live-turn-residency";
import { cappedApproximateValueBytes } from "../../../shared/codex-bounded-value-size";
import type { CodexServerNotification } from "../../codex-runtime/CodexApplicationProtocol";
import type { CodexApplicationProtocolOccurrence } from "../../codex-runtime/CodexApplicationRequestInbox";
import type { CodexHistoryTurnItemsPagination } from "../../../shared/codex-conversation-state/codex-history-topology";

export type CodexConversationStreamRole = "follower" | "owner" | null;

export type CodexConversationServerRequestLifecycleCommit =
  | {
      readonly kind: "canonical";
      readonly before: CodexCanonicalConversationState;
      readonly lifecycle: CodexServerRequestLifecycleResult;
    }
  | {
      readonly kind: "raw";
      readonly lifecycle: CodexServerRequestRawLifecycleResult;
    };

export interface CodexConversationServerRequestState {
  readonly canonicalState: CodexCanonicalConversationState | null;
  readonly rawState: CodexServerRequestRawState;
  readonly streamRole: CodexConversationStreamRole;
}

export interface CodexConversationServerRequestCommitResult {
  readonly hasUnreadTurn: boolean;
  readonly stateChanged: boolean;
  readonly unreadChanged: boolean;
}

export interface CodexConversationProtocolEventCommitResult {
  readonly effects: readonly CodexConversationReducerEffect[];
  readonly stateChanged: boolean;
}

export interface ConversationEntitySnapshot {
  readonly generation: number;
  readonly canonicalState: CodexCanonicalConversationState | null;
  readonly preHydrationServerRequests: readonly CodexCanonicalServerRequest[];
  readonly preHydrationHasUnreadTurn: boolean;
  readonly streamRole: CodexConversationStreamRole;
  readonly acceptedReplica: CodexThreadStreamReplica | null;
  readonly version: number;
  readonly revision: number;
  readonly checkpoint: CodexThreadStreamCheckpoint | null;
  readonly snapshot: CodexConversationSnapshot | null;
  readonly resumeState: CodexConversationResumeState;
  readonly turnPagination: CodexConversationTurnPagination;
  readonly turnItemsPaginationById: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly historyTopology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
  readonly historyMutationRevision: number;
  readonly isStreaming: boolean;
}

export interface CodexConversationHistoryFence {
  readonly generation: number;
  readonly olderCursor: string;
  readonly oldestLoadedTurnId: string | null;
}

export interface CodexConversationTurnItemsHistoryFence {
  readonly generation: number;
  readonly turnId: string;
  readonly olderCursor: string;
}

export type CodexConversationHistoryIslandCommitResult =
  | {
      readonly status: "committed";
      readonly topologyGeneration: number;
      readonly mutation: CodexConversationHistoryMutation;
    }
  | { readonly status: "staleGeneration" }
  | { readonly status: "rejected"; readonly reason: string };

export type CodexConversationHistoryPageCommitResult =
  | { readonly status: "committed"; readonly mutation: CodexConversationHistoryMutation }
  | { readonly status: "staleGeneration" | "staleTarget" }
  | { readonly status: "rejected"; readonly reason: string };

export type CodexConversationHistoryResidencyPinResult =
  | { readonly status: "staleGeneration" }
  | {
      readonly status: "applied";
      readonly evictedTurnIds: readonly string[];
      readonly limitsSatisfied: boolean;
      readonly mutation?: CodexConversationHistoryMutation;
    };

interface MutableConversationEntityState {
  readonly generation: number;
  canonicalState: CodexCanonicalConversationState | null;
  preHydrationServerRequests: readonly CodexCanonicalServerRequest[];
  preHydrationHasUnreadTurn: boolean;
  streamRole: CodexConversationStreamRole;
  acceptedReplica: CodexThreadStreamReplica | null;
  version: number;
  revision: number;
  checkpoint: CodexThreadStreamCheckpoint | null;
  snapshot: CodexConversationSnapshot | null;
  resumeState: CodexConversationResumeState;
  turnPagination: CodexConversationTurnPagination;
  turnItemsPaginationById: Record<string, CodexHistoryTurnItemsPagination>;
  historyItemWindowsByTurnId: Map<
    string,
    CodexHistoryItemWindow<CodexCanonicalItem, CodexConversationItem>
  >;
  historyTopology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
  isStreaming: boolean;
  historyGeneration: number;
  historyEntityRevision: number;
  historyMutationRevision: number;
  historyVisibleIslandIdsByClient: Map<string, Set<string>>;
  historyVisibleTurnIdsByClient: Map<string, Set<string>>;
  historyRevealedTurnIds: Map<string, number>;
  activeSearchHistoryIslandId: string | null;
  historyPageLoadLeases: Map<
    string,
    { readonly islandIds: readonly string[]; readonly turnIds: readonly string[] }
  >;
  resumeEventBuffer: CodexApplicationProtocolOccurrence[] | null;
  resumeEventBufferBytes: number;
  threadStartEventBuffer: CodexApplicationProtocolOccurrence[] | null;
  threadStartEventBufferBytes: number;
  threadStartEventBufferFence: CodexThreadStartEventBufferFence | null;
  threadStartDeferred: boolean;
  queuedFollowUps: CodexQueuedFollowUpProjection;
}

export interface CodexThreadStartEventBufferFence {
  readonly hostId: string;
  readonly generation: number;
}

export type CodexThreadStartEventBufferTake =
  | {
      readonly kind: "matched";
      readonly events: readonly CodexApplicationProtocolOccurrence[];
    }
  | {
      readonly kind: "generation-mismatch";
      readonly events: readonly CodexApplicationProtocolOccurrence[];
    };

export type CodexProtocolOccurrenceAdmission =
  | "buffered"
  | "unbuffered"
  | "overflow"
  | "generation-mismatch";

export class CodexConversationIngressOverflow extends Data.TaggedError(
  "CodexConversationIngressOverflow",
)<{
  readonly threadId: string;
  readonly maximumBytes: number;
  readonly maximumOccurrences: number;
}> {}

export const conversationIngressOverflow = (threadId: string) =>
  new CodexConversationIngressOverflow({
    threadId,
    maximumBytes: MAX_BUFFERED_PROTOCOL_BYTES,
    maximumOccurrences: MAX_BUFFERED_PROTOCOL_OCCURRENCES,
  });

export interface ConversationEntityState {
  readonly threadId: string;
  readonly generation: number;
  readonly read: () => ConversationEntitySnapshot;
  readonly readCanonicalState: () => CodexCanonicalConversationState | null;
  readonly readServerRequests: () => readonly CodexCanonicalServerRequest[];
  readonly readServerRequestState: () => CodexConversationServerRequestState;
  readonly readHasUnreadTurn: () => boolean;
  readonly readSnapshot: () => CodexConversationSnapshot | null;
  /** Installs the canonical application snapshot without implying renderer ownership. */
  readonly installSnapshot: (snapshot: CodexConversationSnapshot) => void;
  /** Seeds durable Workspace state before canonical app-server hydration. */
  readonly seedHasUnreadTurn: (hasUnreadTurn: boolean) => void;
  /** Applies the canonical read-state transition to every loaded conversation projection. */
  readonly setHasUnreadTurn: (hasUnreadTurn: boolean, projectReplica: boolean) => boolean;
  readonly readResumeState: () => CodexConversationResumeState;
  readonly setResumeState: (state: CodexConversationResumeState) => void;
  readonly isStreaming: () => boolean;
  readonly setStreaming: (isStreaming: boolean) => void;
  readonly readTurnPagination: () => CodexConversationTurnPagination;
  readonly readTurnItemsPagination: (turnId: string) => CodexHistoryTurnItemsPagination | null;
  readonly readAllTurnItemsPagination: () => Readonly<
    Record<string, CodexHistoryTurnItemsPagination>
  >;
  readonly readHistoryItemPageCursor: (
    turnId: string,
    edge: "older" | "newer",
  ) => string | null | undefined;
  readonly readHistoryTopology: () => CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
  /** Atomically installs one bounded, cursor-independent search window into canonical history. */
  readonly insertHistoryIsland: (input: {
    readonly mutationId: string;
    readonly expectedTopologyGeneration: number;
    readonly index: number;
    readonly islandId: string;
    readonly state: CodexCanonicalConversationState;
    readonly turnIds: readonly string[];
    readonly positionsByEntityKey?: Readonly<Record<string, number>>;
    readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
    readonly olderBoundary: CodexHistoryBoundary;
    readonly newerBoundary: CodexHistoryBoundary;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => CodexConversationHistoryIslandCommitResult;
  /** Atomically commits one exact boundary or Turn-item page and returns its bounded mutation. */
  readonly commitHistoryPage: (input: {
    readonly request: CodexConversationHistoryPageRequest;
    readonly state: CodexCanonicalConversationState;
    readonly turnIds: readonly string[];
    readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
    readonly itemSegmentsByTurnId?: Readonly<
      Record<string, readonly CodexHydratedHistoryItemSegment[]>
    >;
    readonly continuation?: CodexHistoryBoundary;
    readonly itemPage?: {
      readonly direction: "older" | "newer";
      readonly segmentId: string;
      readonly canonicalItems: readonly CodexCanonicalItem[];
      readonly rendererItems: readonly CodexConversationItem[];
      readonly itemIds: readonly string[];
      readonly approximateBytes: number;
      readonly nextCursor: string | null;
      readonly backwardsCursor: string | null;
    };
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => CodexConversationHistoryPageCommitResult;
  /** Pins the exact target while its one physical page is outside the causal lane. */
  readonly beginHistoryPageLoad: (request: CodexConversationHistoryPageRequest) => boolean;
  readonly endHistoryPageLoad: (request: CodexConversationHistoryPageRequest) => void;
  /**
   * Replaces renderer-visible residency pins for one exact topology generation. Search navigation
   * owns a default pin until this explicit viewport seam supersedes it.
   */
  readonly setHistoryResidencyPins: (input: {
    readonly clientId: string;
    readonly expectedTopologyGeneration: number;
    readonly expectedHistoryMutationRevision: number;
    readonly islandIds: readonly string[];
    readonly turnIds: readonly string[];
  }) => CodexConversationHistoryResidencyPinResult;
  readonly clearHistoryResidencyPins: (clientId: string) => void;
  /** Replaces pagination when a canonical hydration installs a new history window. */
  readonly initializeHistory: (
    pagination: CodexConversationTurnPagination,
    loadedTurnCount: number,
    itemsPaginationByTurnId?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>,
  ) => void;
  /** Opens one cursor-fenced physical history load. */
  readonly beginHistoryLoad: (loadedTurnCount: number) => CodexConversationHistoryFence | null;
  readonly isHistoryLoadCurrent: (fence: CodexConversationHistoryFence) => boolean;
  readonly commitHistoryLoad: (
    fence: CodexConversationHistoryFence,
    pagination: CodexConversationTurnPagination,
    loadedTurnCount: number,
  ) => boolean;
  readonly commitHistoryProjection: (input: {
    readonly fence: CodexConversationHistoryFence;
    readonly state: CodexCanonicalConversationState;
    readonly pagination: CodexConversationTurnPagination;
    readonly loadedTurnCount: number;
    readonly itemsPaginationByTurnId?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  readonly failHistoryLoad: (fence: CodexConversationHistoryFence) => boolean;
  readonly beginTurnItemsHistoryLoad: (
    turnId: string,
  ) => CodexConversationTurnItemsHistoryFence | null;
  readonly isTurnItemsHistoryLoadCurrent: (
    fence: CodexConversationTurnItemsHistoryFence,
  ) => boolean;
  readonly commitTurnItemsHistoryProjection: (input: {
    readonly fence: CodexConversationTurnItemsHistoryFence;
    readonly state: CodexCanonicalConversationState;
    readonly pagination: CodexHistoryTurnItemsPagination;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  readonly failTurnItemsHistoryLoad: (fence: CodexConversationTurnItemsHistoryFence) => boolean;
  readonly beginResumeEventBuffer: () => boolean;
  readonly hasResumeEventBuffer: () => boolean;
  readonly offerProtocolOccurrence: (input: {
    readonly occurrence: CodexApplicationProtocolOccurrence;
    readonly bypassResume: boolean;
    readonly startsThread: boolean;
    readonly deferThreadStart: CodexThreadStartEventBufferFence | null;
  }) => CodexProtocolOccurrenceAdmission;
  readonly takeResumeEventBuffer: () => readonly CodexApplicationProtocolOccurrence[] | null;
  readonly takeThreadStartEventBuffer: (
    fence: CodexThreadStartEventBufferFence,
  ) => CodexThreadStartEventBufferTake | null;
  readonly discardResumeEventBuffer: () => readonly CodexApplicationProtocolOccurrence[];
  readonly clearBufferedEvents: () => readonly CodexApplicationProtocolOccurrence[];
  readonly commitFrameTextDeltas: (input: {
    readonly updates: readonly CodexFrameTextDeltaUpdate[];
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => readonly CodexFrameTextDeltaOutcome[];
  readonly commitCommandOutputDeltas: (input: {
    readonly updates: readonly CodexCommandOutputUpdate[];
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => readonly CodexCommandExecutionMutationDisposition[];
  readonly commitTerminalCommands: (input: {
    readonly update: CodexTerminalCommandUpdate;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => CodexCommandExecutionMutationDisposition;
  readonly commitServerRequestLifecycle: (
    input: CodexConversationServerRequestLifecycleCommit & {
      readonly observedAtMs: number;
      readonly projectReplica: boolean;
    },
  ) => CodexConversationServerRequestCommitResult;
  /** Applies one transport-ordered notification to canonical state and accepted projections. */
  readonly commitProtocolNotification: (input: {
    readonly notification: CodexServerNotification;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
    readonly createId: () => `${string}-${string}-${string}-${string}-${string}`;
    readonly reducerContext?: Pick<
      CodexConversationReducerContext,
      "consumeContextCompactionSource" | "resolveCollabReceiverThread"
    >;
  }) => CodexConversationProtocolEventCommitResult;
  readonly completePlanImplementation: (turnId: string, projectReplica: boolean) => boolean;
  /** Revision-fences and projects the goal observed after one completed Thread resume. */
  readonly commitPostResumeGoalHydration: (input: {
    readonly expectedRevision: number;
    readonly goal: ThreadGoal | null;
  }) => boolean;
  /** Admits one optimistic Main-owned turn into canonical state and every accepted projection. */
  readonly admitOptimisticTurn: (input: {
    readonly params: CodexCanonicalLiveTurnParams;
    readonly worktreeInit?: CodexCanonicalWorktreeInitItem;
    readonly currentCollaborationModel?: string;
    readonly startedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  /** Binds an accepted app-server Turn to its exact optimistic client message. */
  readonly acceptOptimisticTurn: (input: {
    readonly clientUserMessageId: string;
    readonly turn: Turn;
    readonly recovery?: {
      readonly params: CodexCanonicalLiveTurnParams;
      readonly currentCollaborationModel?: string;
      readonly startedAtMs: number;
    };
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  /** Converts an unaccepted optimistic Turn into its canonical failed outcome. */
  readonly rejectOptimisticTurn: (input: {
    readonly clientUserMessageId: string;
    readonly failureItemId: `${string}-${string}-${string}-${string}-${string}`;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  /** Admits a steering user message only when its exact target Turn exists. */
  readonly admitSteeringItem: (input: {
    readonly turnId: string;
    readonly item: CodexCanonicalSteeringUserMessageItem;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  /** Corrects the active Turn identity while preserving its pending message. */
  readonly retargetSteeringItem: (input: {
    readonly fromTurnId: string;
    readonly toTurnId: string;
    readonly itemId: string;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  /** Removes one unaccepted steering message by its exact target and correlation id. */
  readonly rejectSteeringItem: (input: {
    readonly turnId: string;
    readonly itemId: string;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  /** Returns the requested Turn when known, otherwise the latest in-progress Turn. */
  readonly resolveInterruptTurnId: (requestedTurnId?: string) => string | null;
  /** Commits the accepted local interrupt outcome for one exact in-progress Turn. */
  readonly interruptTurn: (input: {
    readonly turnId: string;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  /** Derives the Turns which still own running background terminal rows. */
  readonly backgroundTerminalTurnIds: () => readonly string[] | null;
  /** Marks every running background terminal row interrupted across canonical projections. */
  readonly cleanBackgroundTerminals: (input: {
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  readonly applyTurnConfiguration: (input: {
    readonly settings: CodexConversationThreadSettings;
    readonly permissions: CodexCanonicalHydratedPermissionContext;
    readonly projectReplica: boolean;
  }) => boolean;
  readonly renameThread: (input: {
    readonly name: string;
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  readonly acceptThreadGoal: (input: {
    readonly goal: ThreadGoal;
    readonly appendTranscriptItem: boolean;
    readonly dismissResumeConfirmation: boolean;
    readonly projectReplica: boolean;
  }) => boolean;
  readonly admitManualCompaction: (input: {
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => string | null;
  readonly rollbackManualCompaction: (input: {
    readonly observedAtMs: number;
    readonly projectReplica: boolean;
  }) => boolean;
  readonly relocateExecution: (input: {
    readonly cwd: string;
    readonly managedWorktreePath: string | null;
    readonly projectId: string | null;
    readonly projectlessOutputDirectory: string | null;
    readonly projectlessWorkspaceBrowserRoot: string | null;
    readonly permissions: CodexCanonicalHydratedPermissionContext;
    readonly projectReplica: boolean;
  }) => boolean;
  readonly setThreadStatus: (statusType: CodexThreadStatusType, projectReplica: boolean) => boolean;
  readonly readQueuedFollowUpProjection: () => CodexQueuedFollowUpProjection;
  /** Installs an exact Main/Core-authored projection without synthesizing revisions. */
  readonly installQueuedFollowUpProjection: (
    projection: CodexQueuedFollowUpProjection,
    projectReplica: boolean,
  ) => boolean;
  readonly readStreamRole: () => CodexConversationStreamRole;
  readonly setStreamRole: (role: CodexConversationStreamRole) => void;
  readonly acceptCanonicalState: (
    state: CodexCanonicalConversationState,
  ) => CodexCanonicalConversationState;
  readonly replaceServerRequests: (requests: readonly CodexCanonicalServerRequest[]) => void;
  readonly incrementVersion: () => number;
  readonly acceptReplica: (input: {
    readonly conversation: CodexConversationSnapshot;
    readonly revision: number;
    readonly ownerEpoch: number;
  }) => CodexThreadStreamReplica;
  readonly advanceReplica: (input: {
    readonly conversation: CodexConversationSnapshot;
    readonly ownerEpoch: number;
  }) => {
    readonly baseRevision: number;
    readonly replica: CodexThreadStreamReplica;
  };
  readonly clearReplica: () => void;
  /** Clears semantic state while retaining the current live runtime generation. */
  readonly reset: () => void;
}

export interface ConversationEntityStateRegistry {
  /** Pure query: an unknown or released Thread never creates a new generation. */
  readonly current: (threadId: string) => ConversationEntityState | null;
  /** Binds a semantic aggregate generation to a caller or keyed runtime Scope. */
  readonly acquire: (threadId: string) => ConversationEntityState;
  /** Releases only the generation owned by the closing keyed runtime. */
  readonly releaseGeneration: (threadId: string, generation: number) => void;
  /** Releases every generation at the process Scope boundary. */
  readonly releaseAll: () => void;
  /** Marks every loaded generation non-live after the app-server connection is lost. */
  readonly markAllNeedsResume: () => readonly string[];
}

export interface ConversationEntityStateRegistryOptions {
  readonly historyResidencyLimits?: Partial<CodexHistoryResidencyLimits>;
  readonly historyTailTurnCount?: number;
  readonly historyRevealLeaseLimits?: Partial<CodexHistoryResidencyLimits>;
}

const pendingManualCompaction: CodexCanonicalContextCompactionItem = {
  type: "contextCompaction",
  id: CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID,
  completed: false,
  source: "manual",
};

const MAX_BUFFERED_PROTOCOL_OCCURRENCES = 1_024;
const MAX_BUFFERED_PROTOCOL_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_REVEAL_LEASE_TURNS = 32;
const MAX_HISTORY_REVEAL_LEASE_APPROXIMATE_BYTES = 16 * 1024 * 1024;

/** Avoid a payload-sized JSON string while deciding whether a deferred occurrence fits. */
const protocolOccurrenceBytes = (occurrence: CodexApplicationProtocolOccurrence): number =>
  cappedApproximateValueBytes(occurrence, MAX_BUFFERED_PROTOCOL_BYTES);

const canonicalTurnBytes = (turn: CodexCanonicalTurnState): number =>
  cappedApproximateValueBytes(turn, DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES);

const canonicalTurnMetadataBytes = (turn: CodexCanonicalTurnState): number =>
  cappedApproximateValueBytes(
    { ...turn, items: [] },
    DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES,
  );

type PersistedCanonicalTurn = CodexCanonicalTurnState & {
  readonly protocol: CodexCanonicalTurnState["protocol"] & { readonly id: string };
};

const persistedCanonicalTurns = (
  canonical: CodexCanonicalConversationState | null,
): readonly PersistedCanonicalTurn[] =>
  (canonical?.turns ?? []).filter(
    (turn): turn is PersistedCanonicalTurn => turn.protocol.id !== null,
  );

/** Owner publications can trail the transport-ordered Main reducer by one or more notifications. */
const hasTerminalTurnRegression = (
  authoritative: CodexCanonicalConversationState | null,
  candidate: CodexCanonicalConversationState | null | undefined,
): boolean => {
  if (!authoritative || !candidate) return false;
  const candidateStatusByTurnId = new Map(
    candidate.turns.flatMap((turn) =>
      turn.protocol.id === null ? [] : [[turn.protocol.id, turn.protocol.status] as const],
    ),
  );
  return authoritative.turns.some(
    (turn) =>
      turn.protocol.id !== null &&
      turn.protocol.status !== "inProgress" &&
      candidateStatusByTurnId.get(turn.protocol.id) === "inProgress",
  );
};

const defaultTurnItemsPagination = (
  turn: CodexCanonicalTurnState,
): CodexHistoryTurnItemsPagination => ({
  olderCursor: null,
  isLoadingOlder: false,
  hasLoadedOldest: turn.protocol.itemsView === "full",
  oldestUserInput: null,
  openingUserMessageId: null,
  itemsView: turn.protocol.itemsView ?? "full",
});

const historyEntity = (input: {
  readonly turn: PersistedCanonicalTurn;
  readonly current: CodexHistoryEntity<CodexCanonicalTurnState> | undefined;
  readonly itemsPagination: CodexHistoryTurnItemsPagination | undefined;
  readonly authority: CodexHistoryEntity<CodexCanonicalTurnState>["authority"];
  readonly revision: number;
  readonly approximateBytes?: number;
}): CodexHistoryEntity<CodexCanonicalTurnState> => {
  const preserveLive = input.current?.authority === "live" && input.authority === "history";
  const turn = preserveLive ? input.current.turn : input.turn;
  return {
    key: input.turn.protocol.id,
    turn,
    itemCount: turn.items.length,
    approximateBytes: input.approximateBytes ?? canonicalTurnBytes(turn),
    itemsPagination:
      input.itemsPagination ?? input.current?.itemsPagination ?? defaultTurnItemsPagination(turn),
    authority: preserveLive ? "live" : input.authority,
    revision: preserveLive ? input.current.revision : input.revision,
  };
};

const paginationBoundary = (input: {
  readonly current: CodexHistoryBoundary;
  readonly pagination: CodexConversationTurnPagination;
}): CodexHistoryBoundary => {
  if (input.current.status === "opaque") return input.current;
  if (input.pagination.olderCursor === null) {
    return exhaustedCodexHistoryBoundary(input.current.boundaryId);
  }
  return availableCodexHistoryBoundary(input.current.boundaryId, {
    cursor: input.pagination.olderCursor,
    oldestLoadedTurnId: input.pagination.oldestLoadedTurnId,
  });
};

const assembleHistoryTopology = (input: {
  readonly generation: number;
  readonly islands: readonly {
    readonly id: string;
    readonly turns: readonly PersistedCanonicalTurn[];
    readonly olderBoundary: CodexHistoryBoundary;
    readonly newerBoundary: CodexHistoryBoundary;
  }[];
  readonly current: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
  readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly authority: CodexHistoryEntity<CodexCanonicalTurnState>["authority"];
  readonly liveTurnIds?: ReadonlySet<string>;
  readonly revision: number;
}): CodexCanonicalHistoryTopology<CodexCanonicalTurnState> => {
  let topology = createEmptyCodexHistoryTopology<CodexCanonicalTurnState>(input.generation);
  for (const island of input.islands) {
    if (island.turns.length === 0) continue;
    const entities = island.turns.map((turn) => {
      const current = input.current.entitiesByKey[turn.protocol.id];
      const authority =
        input.authority === "live" && input.liveTurnIds && !input.liveTurnIds.has(turn.protocol.id)
          ? (current?.authority ?? "history")
          : input.authority;
      return historyEntity({
        turn,
        current,
        itemsPagination: input.itemsPaginationByTurnId[turn.protocol.id],
        authority,
        revision: input.revision,
      });
    });
    const inserted = insertCodexHistoryIsland(topology, {
      index: topology.islands.length,
      islandId: island.id,
      entries: entities.map((entity) => ({ key: entity.key, entityKey: entity.key })),
      entities,
      olderBoundary: island.olderBoundary,
      newerBoundary: island.newerBoundary,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    topology = inserted.topology;
  }
  return topology;
};

const rebuildHistoryTopology = (input: {
  readonly generation: number;
  readonly canonical: CodexCanonicalConversationState | null;
  readonly pagination: CodexConversationTurnPagination;
  readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly authority: CodexHistoryEntity<CodexCanonicalTurnState>["authority"];
  readonly revision?: number;
}): CodexCanonicalHistoryTopology<CodexCanonicalTurnState> => {
  const turns = persistedCanonicalTurns(input.canonical);
  if (turns.length === 0) return createEmptyCodexHistoryTopology(input.generation);
  const entities = turns.map((turn): CodexHistoryEntity<CodexCanonicalTurnState> => {
    const turnId = turn.protocol.id;
    return historyEntity({
      turn,
      current: undefined,
      itemsPagination: input.itemsPaginationByTurnId[turnId],
      authority: input.authority,
      revision: input.revision ?? input.generation,
    });
  });
  const topology = createCodexHistoryIslandTopology({
    generation: input.generation,
    islandId: `tail:${input.generation}`,
    entries: entities.map((entity) => ({ key: entity.key, entityKey: entity.key })),
    entities,
    olderBoundary:
      input.pagination.olderCursor === null
        ? exhaustedCodexHistoryBoundary(`older:${input.generation}`)
        : availableCodexHistoryBoundary(`older:${input.generation}`, {
            cursor: input.pagination.olderCursor,
            oldestLoadedTurnId: input.pagination.oldestLoadedTurnId,
          }),
    newerBoundary: exhaustedCodexHistoryBoundary(`newer:${input.generation}`),
  });
  if (!topology.ok) throw new Error(topology.error.message);
  return topology.topology;
};

const reconcileHistoryTopology = (input: {
  readonly topology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
  readonly canonical: CodexCanonicalConversationState;
  readonly pagination: CodexConversationTurnPagination;
  readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly authority: CodexHistoryEntity<CodexCanonicalTurnState>["authority"];
  readonly liveTurnIds?: ReadonlySet<string>;
  readonly revision: number;
}): CodexCanonicalHistoryTopology<CodexCanonicalTurnState> => {
  const turns = persistedCanonicalTurns(input.canonical);
  if (input.topology.islands.length === 0) {
    return rebuildHistoryTopology({
      generation: input.topology.generation,
      canonical: input.canonical,
      pagination: input.pagination,
      itemsPaginationByTurnId: input.itemsPaginationByTurnId,
      authority: input.authority,
      revision: input.revision,
    });
  }

  const turnsById = new Map(turns.map((turn) => [turn.protocol.id, turn] as const));
  const tailIndex = input.topology.islands.findLastIndex(
    (island) => island.newerBoundary.status === "exhausted",
  );
  const nonTailEntityKeys = new Set(
    input.topology.islands.flatMap((island, index) =>
      index === tailIndex ? [] : island.entries.map((entry) => entry.entityKey),
    ),
  );
  const islands = input.topology.islands.flatMap((island, index) => {
    const islandTurns =
      index === tailIndex
        ? turns.filter((turn) => !nonTailEntityKeys.has(turn.protocol.id))
        : island.entries.flatMap((entry) => {
            const turn =
              turnsById.get(entry.entityKey) ?? input.topology.entitiesByKey[entry.entityKey]?.turn;
            return turn?.protocol.id === null ? [] : [turn as PersistedCanonicalTurn];
          });
    if (islandTurns.length === 0) return [];
    return [
      {
        id: island.id,
        turns: islandTurns,
        olderBoundary:
          index === tailIndex
            ? paginationBoundary({
                current: island.olderBoundary,
                pagination: input.pagination,
              })
            : island.olderBoundary,
        newerBoundary: island.newerBoundary,
      },
    ];
  });
  if (tailIndex < 0) {
    const unreferencedTurns = turns.filter((turn) => !nonTailEntityKeys.has(turn.protocol.id));
    if (unreferencedTurns.length > 0) {
      islands.push({
        id: `tail:${input.topology.generation}`,
        turns: unreferencedTurns,
        olderBoundary:
          input.pagination.olderCursor === null
            ? exhaustedCodexHistoryBoundary(`older:${input.topology.generation}`)
            : availableCodexHistoryBoundary(`older:${input.topology.generation}`, {
                cursor: input.pagination.olderCursor,
                oldestLoadedTurnId: input.pagination.oldestLoadedTurnId,
              }),
        newerBoundary: exhaustedCodexHistoryBoundary(`newer:${input.topology.generation}`),
      });
    }
  }
  return assembleHistoryTopology({
    generation: input.topology.generation,
    islands,
    current: input.topology,
    itemsPaginationByTurnId: input.itemsPaginationByTurnId,
    authority: input.authority,
    liveTurnIds: input.liveTurnIds,
    revision: input.revision,
  });
};

const paginationForHistoryTopology = (input: {
  readonly current: CodexConversationTurnPagination;
  readonly topology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
}): CodexConversationTurnPagination => {
  const tailIsland =
    input.topology.islands.find((island) => island.id.startsWith("tail:")) ??
    input.topology.islands.findLast((island) => island.newerBoundary.status === "exhausted");
  const olderBoundary = tailIsland?.olderBoundary ?? null;
  const newerBoundary = tailIsland?.newerBoundary ?? null;
  const entities = Object.values(input.topology.entitiesByKey);
  return {
    olderCursor: olderBoundary?.status === "available" ? olderBoundary.handle.cursor : null,
    backwardsCursor:
      newerBoundary?.status === "available"
        ? newerBoundary.handle.cursor
        : input.current.backwardsCursor,
    oldestLoadedTurnId: tailIsland?.entries[0]?.entityKey ?? null,
    isLoadingOlder: false,
    hasLoadedOldest: olderBoundary?.status === "exhausted",
    loadedTurnCount: input.topology.residency.turnCount,
    itemsView: entities.every(
      (entity) =>
        entity.itemsPagination.itemsView === "full" && entity.itemsPagination.hasLoadedOldest,
    )
      ? "full"
      : "summary",
  };
};

const preserveResidentHistoryTurns = (
  state: CodexCanonicalConversationState,
  topology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>,
): CodexCanonicalConversationState => {
  const incomingById = new Map(
    persistedCanonicalTurns(state).map((turn) => [turn.protocol.id, turn] as const),
  );
  const topologyTurns = topology.islands.flatMap((island) =>
    island.entries.flatMap((entry) => {
      const incoming = incomingById.get(entry.entityKey);
      if (incoming) return [incoming];
      const resident = topology.entitiesByKey[entry.entityKey]?.turn;
      return resident?.protocol.id === null ? [] : [resident as PersistedCanonicalTurn];
    }),
  );
  const represented = new Set(topologyTurns.map((turn) => turn.protocol.id));
  const unrepresentedIncoming = persistedCanonicalTurns(state).filter(
    (turn) => !represented.has(turn.protocol.id),
  );
  const syntheticTurns = state.turns.filter((turn) => turn.protocol.id === null);
  const turns = [...topologyTurns, ...unrepresentedIncoming, ...syntheticTurns];
  if (
    turns.length === state.turns.length &&
    turns.every((turn, index) => turn === state.turns[index])
  ) {
    return state;
  }
  return { ...state, turns };
};

const initialAggregate = (generation: number): MutableConversationEntityState => ({
  generation,
  canonicalState: null,
  preHydrationServerRequests: [],
  preHydrationHasUnreadTurn: false,
  streamRole: null,
  acceptedReplica: null,
  version: 0,
  revision: 0,
  checkpoint: null,
  snapshot: null,
  resumeState: "resumed",
  turnPagination: {
    olderCursor: null,
    backwardsCursor: null,
    oldestLoadedTurnId: null,
    isLoadingOlder: false,
    hasLoadedOldest: true,
    loadedTurnCount: 0,
    itemsView: "full",
  },
  turnItemsPaginationById: {},
  historyItemWindowsByTurnId: new Map(),
  historyTopology: createEmptyCodexHistoryTopology(0),
  isStreaming: false,
  historyGeneration: 0,
  historyEntityRevision: 0,
  historyMutationRevision: 0,
  historyVisibleIslandIdsByClient: new Map(),
  historyVisibleTurnIdsByClient: new Map(),
  historyRevealedTurnIds: new Map(),
  activeSearchHistoryIslandId: null,
  historyPageLoadLeases: new Map(),
  resumeEventBuffer: null,
  resumeEventBufferBytes: 0,
  threadStartEventBuffer: null,
  threadStartEventBufferBytes: 0,
  threadStartEventBufferFence: null,
  threadStartDeferred: false,
  queuedFollowUps: EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION,
});

const snapshot = (aggregate: MutableConversationEntityState): ConversationEntitySnapshot => ({
  generation: aggregate.generation,
  canonicalState: aggregate.canonicalState,
  preHydrationServerRequests: [...aggregate.preHydrationServerRequests],
  preHydrationHasUnreadTurn: aggregate.preHydrationHasUnreadTurn,
  streamRole: aggregate.streamRole,
  acceptedReplica:
    aggregate.acceptedReplica === null
      ? null
      : {
          checkpoint: aggregate.acceptedReplica.checkpoint,
          conversation: aggregate.acceptedReplica.conversation,
        },
  version: aggregate.version,
  revision: aggregate.revision,
  checkpoint: aggregate.checkpoint,
  snapshot: aggregate.snapshot,
  resumeState: aggregate.resumeState,
  turnPagination: { ...aggregate.turnPagination },
  turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
  historyTopology: aggregate.historyTopology,
  historyMutationRevision: aggregate.historyMutationRevision,
  isStreaming: aggregate.isStreaming,
});

/**
 * Creates the private per-Thread canonical state owned by ConversationEntityMap.
 * Its interface exposes semantic state transitions rather than mutable records or generic reducers.
 */
export function makeConversationEntityStateRegistry(
  options: ConversationEntityStateRegistryOptions = {},
): ConversationEntityStateRegistry {
  const aggregates = new Map<string, MutableConversationEntityState>();
  const capabilities = new Map<string, ConversationEntityState>();
  let nextGeneration = 1;

  const ensureState = (threadId: string): MutableConversationEntityState => {
    const existing = aggregates.get(threadId);
    if (existing) return existing;
    const created = initialAggregate(nextGeneration++);
    aggregates.set(threadId, created);
    return created;
  };

  const resetAggregate = (aggregate: MutableConversationEntityState): void => {
    aggregate.canonicalState = null;
    aggregate.preHydrationServerRequests = [];
    aggregate.preHydrationHasUnreadTurn = false;
    aggregate.streamRole = null;
    aggregate.acceptedReplica = null;
    aggregate.version = 0;
    aggregate.revision = 0;
    aggregate.checkpoint = null;
    aggregate.snapshot = null;
    aggregate.resumeState = "resumed";
    aggregate.turnPagination = initialAggregate(aggregate.generation).turnPagination;
    aggregate.turnItemsPaginationById = {};
    aggregate.historyItemWindowsByTurnId.clear();
    aggregate.historyTopology = createEmptyCodexHistoryTopology(0);
    aggregate.isStreaming = false;
    aggregate.historyGeneration = 0;
    aggregate.historyEntityRevision = 0;
    aggregate.historyMutationRevision = 0;
    aggregate.historyVisibleIslandIdsByClient.clear();
    aggregate.historyVisibleTurnIdsByClient.clear();
    aggregate.historyRevealedTurnIds.clear();
    aggregate.activeSearchHistoryIslandId = null;
    aggregate.historyPageLoadLeases.clear();
    aggregate.resumeEventBuffer = null;
    aggregate.resumeEventBufferBytes = 0;
    aggregate.threadStartEventBuffer = null;
    aggregate.threadStartEventBufferBytes = 0;
    aggregate.threadStartEventBufferFence = null;
    aggregate.threadStartDeferred = false;
    aggregate.queuedFollowUps = EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION;
  };

  const makeCapability = (
    threadId: string,
    aggregate: MutableConversationEntityState,
  ): ConversationEntityState => {
    const acceptReplica = (input: {
      readonly conversation: CodexConversationSnapshot;
      readonly revision: number;
      readonly ownerEpoch: number;
    }): CodexThreadStreamReplica => {
      const mustReconcileTerminalAuthority = hasTerminalTurnRegression(
        aggregate.canonicalState,
        input.conversation.canonicalState,
      );
      let conversation: CodexConversationSnapshot = {
        ...input.conversation,
        conversationEntityGeneration: aggregate.generation,
        historyMutationRevision: aggregate.historyMutationRevision,
        queuedFollowUps: {
          ...aggregate.queuedFollowUps,
          entries: [...aggregate.queuedFollowUps.entries],
        },
      };
      if (mustReconcileTerminalAuthority && aggregate.canonicalState) {
        // Main observes protocol notifications before the renderer can publish their reduced
        // document. Rebase a lagging owner publication onto Main's terminal lifecycle authority.
        // Its checkpoint then intentionally differs from the submitted one, causing the
        // coordinator to return this reconciled replica as recovery instead of acknowledging a
        // document that would put the renderer back into a permanently running state.
        conversation = projectCodexConversationSnapshot({
          conversation,
          before: conversation.canonicalState ?? null,
          after: aggregate.canonicalState,
          observedAtMs: Date.now(),
        });
      }
      const checkpoint = buildCodexThreadStreamCheckpoint({
        ownerEpoch: input.ownerEpoch,
        revision: input.revision,
        conversation,
      });
      const replica = { checkpoint, conversation };
      aggregate.acceptedReplica = replica;
      aggregate.snapshot = conversation;
      aggregate.revision = input.revision;
      aggregate.checkpoint = checkpoint;
      return replica;
    };

    const leaseHistoryRevealedTurns = (turnIds: readonly string[], revision: number): void => {
      for (const turnId of turnIds) {
        aggregate.historyRevealedTurnIds.delete(turnId);
        aggregate.historyRevealedTurnIds.set(turnId, revision);
      }
      const leasedBytes = (): number =>
        [...aggregate.historyRevealedTurnIds.keys()].reduce(
          (bytes, turnId) =>
            bytes + (aggregate.historyTopology.entitiesByKey[turnId]?.approximateBytes ?? 0),
          0,
        );
      const maxTurns = Math.max(
        1,
        options.historyRevealLeaseLimits?.maxTurns ?? MAX_HISTORY_REVEAL_LEASE_TURNS,
      );
      const maxApproximateBytes = Math.max(
        1,
        options.historyRevealLeaseLimits?.maxApproximateBytes ??
          MAX_HISTORY_REVEAL_LEASE_APPROXIMATE_BYTES,
      );
      while (
        aggregate.historyRevealedTurnIds.size > 1 &&
        (aggregate.historyRevealedTurnIds.size > maxTurns || leasedBytes() > maxApproximateBytes)
      ) {
        const oldestTurnId = aggregate.historyRevealedTurnIds.keys().next().value;
        if (typeof oldestTurnId !== "string") break;
        aggregate.historyRevealedTurnIds.delete(oldestTurnId);
      }
    };

    const readOrSeedHistoryItemWindow = (
      turnId: string,
    ): CodexHistoryItemWindow<CodexCanonicalItem, CodexConversationItem> | null => {
      const existing = aggregate.historyItemWindowsByTurnId.get(turnId);
      if (existing) return existing;
      const snapshotWindow = aggregate.snapshot?.historyItemWindowsByTurnId?.[turnId];
      if (snapshotWindow) {
        const restored = restoreCodexConversationHistoryItemWindow(snapshotWindow);
        if (restored) {
          aggregate.historyItemWindowsByTurnId.set(turnId, restored);
          return restored;
        }
      }
      const canonicalTurn = persistedCanonicalTurns(aggregate.canonicalState).find(
        (turn) => turn.protocol.id === turnId,
      );
      const rendererTurn = aggregate.snapshot?.turns.find((turn) => turn.turnId === turnId);
      const pagination = aggregate.turnItemsPaginationById[turnId];
      if (!canonicalTurn || !rendererTurn || !pagination) return null;
      const seeded = seedCodexConversationHistoryItemWindow({
        turnId,
        canonicalItems: canonicalTurn.items,
        rendererItems: rendererTurn.items,
        pagination,
      });
      if (!seeded) return null;
      aggregate.historyItemWindowsByTurnId.set(turnId, seeded);
      return seeded;
    };

    const historyItemProgressKey = (turnId: string, edge: "older" | "newer"): string | null => {
      const pagination = aggregate.turnItemsPaginationById[turnId];
      if (!pagination) return null;
      const snapshotWindow = aggregate.snapshot?.historyItemWindowsByTurnId?.[turnId] ?? null;
      if (edge === "newer" && snapshotWindow?.newerBoundary.status !== "available") return null;
      return codexConversationHistoryTurnItemsProgressKey(pagination, edge, snapshotWindow);
    };

    const projectCanonicalState = (
      state: CodexCanonicalConversationState,
      observedAtMs: number,
      projectReplica: boolean,
    ): boolean => {
      const before = aggregate.canonicalState;
      if (!before || state === before) return false;
      state = boundChangedCodexLiveTurns(before, state);
      const beforeTurnsById = new Map(
        persistedCanonicalTurns(before).map((turn) => [turn.protocol.id, turn] as const),
      );
      const liveTurnIds = new Set(
        persistedCanonicalTurns(state)
          .filter((turn) => beforeTurnsById.get(turn.protocol.id) !== turn)
          .map((turn) => turn.protocol.id),
      );
      for (const turnId of liveTurnIds) aggregate.historyItemWindowsByTurnId.delete(turnId);
      const withoutChangedItemWindows = (
        conversation: CodexConversationSnapshot,
      ): CodexConversationSnapshot => ({
        ...conversation,
        historyItemWindowsByTurnId: Object.fromEntries(
          Object.entries(conversation.historyItemWindowsByTurnId ?? {}).filter(
            ([turnId]) => !liveTurnIds.has(turnId),
          ),
        ),
      });
      aggregate.canonicalState = state;
      if (aggregate.snapshot) {
        aggregate.snapshot = projectCodexConversationSnapshot({
          conversation: withoutChangedItemWindows(aggregate.snapshot),
          before,
          after: state,
          observedAtMs,
        });
      }
      if (projectReplica && aggregate.acceptedReplica) {
        acceptReplica({
          conversation: projectCodexConversationSnapshot({
            conversation: withoutChangedItemWindows(aggregate.acceptedReplica.conversation),
            before,
            after: state,
            observedAtMs,
          }),
          ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
          revision: aggregate.revision + 1,
        });
      }
      reconcileCanonicalHistory("live", liveTurnIds);
      enforceHistoryResidency(projectReplica);
      return true;
    };

    const reconcileCanonicalHistory = (
      authority: CodexHistoryEntity<CodexCanonicalTurnState>["authority"],
      liveTurnIds?: ReadonlySet<string>,
    ): void => {
      const canonical = aggregate.canonicalState;
      if (!canonical) return;
      aggregate.historyEntityRevision += 1;
      aggregate.historyTopology = reconcileHistoryTopology({
        topology: aggregate.historyTopology,
        canonical,
        pagination: aggregate.turnPagination,
        itemsPaginationByTurnId: aggregate.turnItemsPaginationById,
        authority,
        liveTurnIds,
        revision: aggregate.historyEntityRevision,
      });
    };

    const operationHistoryProtection = (): {
      readonly islandIds: Set<string>;
      readonly turnIds: Set<string>;
    } => {
      const islandIds = new Set<string>();
      const turnIds = new Set(aggregate.historyRevealedTurnIds.keys());
      if (aggregate.activeSearchHistoryIslandId) {
        islandIds.add(aggregate.activeSearchHistoryIslandId);
      }
      for (const lease of aggregate.historyPageLoadLeases.values()) {
        for (const islandId of lease.islandIds) islandIds.add(islandId);
        for (const turnId of lease.turnIds) turnIds.add(turnId);
      }
      return { islandIds, turnIds };
    };

    const admitHistoryViewportPins = (input: {
      readonly islandIds: readonly string[];
      readonly turnIds: readonly string[];
    }): { readonly islandIds: Set<string>; readonly turnIds: Set<string> } => {
      const operationPins = operationHistoryProtection();
      const admittedIslandIds = new Set<string>();
      const admittedTurnIds = new Set<string>();
      const fits = (): boolean =>
        !retainCodexHistoryResidency(aggregate.historyTopology, {
          limits: {
            maxTurns:
              options.historyResidencyLimits?.maxTurns ?? DEFAULT_CODEX_ACTIVE_HISTORY_MAX_TURNS,
            maxApproximateBytes:
              options.historyResidencyLimits?.maxApproximateBytes ??
              DEFAULT_CODEX_ACTIVE_HISTORY_MAX_APPROXIMATE_BYTES,
          },
          ...(options.historyTailTurnCount === undefined
            ? {}
            : { tailTurnCount: options.historyTailTurnCount }),
          protectedIslandIds: new Set([...operationPins.islandIds, ...admittedIslandIds]),
          protectedEntityKeys: new Set([...operationPins.turnIds, ...admittedTurnIds]),
        }).protectedResidencyExceedsLimits;

      if (!fits()) return { islandIds: admittedIslandIds, turnIds: admittedTurnIds };
      for (const turnId of input.turnIds) {
        admittedTurnIds.add(turnId);
        if (fits()) continue;
        admittedTurnIds.delete(turnId);
      }
      for (const islandId of input.islandIds) {
        admittedIslandIds.add(islandId);
        if (fits()) continue;
        admittedIslandIds.delete(islandId);
      }
      return { islandIds: admittedIslandIds, turnIds: admittedTurnIds };
    };

    const enforceHistoryResidency = (projectReplica: boolean) => {
      const canonicalState = aggregate.canonicalState;
      if (!canonicalState) return null;
      const protectedIslandIds = new Set(
        [...aggregate.historyVisibleIslandIdsByClient.values()].flatMap((values) => [...values]),
      );
      if (aggregate.activeSearchHistoryIslandId) {
        protectedIslandIds.add(aggregate.activeSearchHistoryIslandId);
      }
      const protectedTurnIds = new Set([
        ...[...aggregate.historyVisibleTurnIdsByClient.values()].flatMap((values) => [...values]),
        ...aggregate.historyRevealedTurnIds.keys(),
      ]);
      for (const lease of aggregate.historyPageLoadLeases.values()) {
        for (const islandId of lease.islandIds) protectedIslandIds.add(islandId);
        for (const turnId of lease.turnIds) protectedTurnIds.add(turnId);
      }
      const retention = retainCodexHistoryResidency(aggregate.historyTopology, {
        ...(options.historyResidencyLimits ? { limits: options.historyResidencyLimits } : {}),
        ...(options.historyTailTurnCount === undefined
          ? {}
          : { tailTurnCount: options.historyTailTurnCount }),
        protectedIslandIds,
        protectedEntityKeys: protectedTurnIds,
      });
      const residentTurnIds = new Set(Object.keys(retention.topology.entitiesByKey));
      const hasNonResidentCanonicalTurn = (
        state: CodexCanonicalConversationState | null | undefined,
      ) =>
        state?.turns.some(
          (turn) => turn.protocol.id !== null && !residentTurnIds.has(turn.protocol.id),
        ) ?? false;
      const hasNonResidentConversation = (conversation: CodexConversationSnapshot | null) =>
        conversation !== null &&
        (conversation.turns.some(
          (turn) => turn.turnId !== null && !residentTurnIds.has(turn.turnId),
        ) ||
          hasNonResidentCanonicalTurn(conversation.canonicalState) ||
          Object.keys(conversation.turnItemsPaginationById ?? {}).some(
            (turnId) => !residentTurnIds.has(turnId),
          ) ||
          Object.keys(conversation.historyItemWindowsByTurnId ?? {}).some(
            (turnId) => !residentTurnIds.has(turnId),
          ));
      const requiresProjection =
        retention.evictedEntityKeys.length > 0 ||
        hasNonResidentCanonicalTurn(canonicalState) ||
        Object.keys(aggregate.turnItemsPaginationById).some(
          (turnId) => !residentTurnIds.has(turnId),
        ) ||
        hasNonResidentConversation(aggregate.snapshot) ||
        hasNonResidentConversation(aggregate.acceptedReplica?.conversation ?? null);
      aggregate.historyTopology = retention.topology;
      if (!requiresProjection) return retention;

      const projection = projectCodexConversationHistoryResidency({
        canonicalState,
        conversationPagination: aggregate.turnPagination,
        turnItemsPaginationById: aggregate.turnItemsPaginationById,
        topology: retention.topology,
      });
      const snapshotBefore = aggregate.snapshot;
      const replicaBefore = aggregate.acceptedReplica;
      aggregate.canonicalState = projection.canonicalState;
      aggregate.turnPagination = projection.turnPagination;
      aggregate.turnItemsPaginationById = { ...projection.turnItemsPaginationById };
      for (const turnId of aggregate.historyItemWindowsByTurnId.keys()) {
        if (!residentTurnIds.has(turnId)) aggregate.historyItemWindowsByTurnId.delete(turnId);
      }
      const projectResidentConversation = (
        conversation: CodexConversationSnapshot,
      ): CodexConversationSnapshot => ({
        ...projection.projectConversation(conversation),
        historyItemWindowsByTurnId: Object.fromEntries(
          Object.entries(conversation.historyItemWindowsByTurnId ?? {}).filter(([turnId]) =>
            residentTurnIds.has(turnId),
          ),
        ),
      });
      if (snapshotBefore) {
        aggregate.snapshot = projectResidentConversation(snapshotBefore);
      }
      if (replicaBefore && projectReplica) {
        acceptReplica({
          conversation: projectResidentConversation(replicaBefore.conversation),
          ownerEpoch: replicaBefore.checkpoint.ownerEpoch,
          // Residency is part of the semantic mutation already being accepted. Advancing a
          // private extra revision would strand the owner on an unknowable checkpoint.
          revision: aggregate.revision,
        });
      }
      if (
        aggregate.activeSearchHistoryIslandId &&
        !aggregate.historyTopology.islands.some(
          (island) => island.id === aggregate.activeSearchHistoryIslandId,
        )
      ) {
        aggregate.activeSearchHistoryIslandId = null;
      }
      return retention;
    };

    const installQueuedFollowUpProjection = (
      projection: CodexQueuedFollowUpProjection,
      projectReplica: boolean,
    ): boolean => {
      const previous = aggregate.queuedFollowUps;
      if (
        previous.status === projection.status &&
        previous.ledgerRevision === projection.ledgerRevision &&
        previous.projectionRevision === projection.projectionRevision &&
        previous.inFlightFollowUpId === projection.inFlightFollowUpId &&
        previous.editingFollowUpId === projection.editingFollowUpId &&
        previous.error === projection.error &&
        previous.entries.length === projection.entries.length &&
        previous.entries.every((entry, index) => entry === projection.entries[index])
      ) {
        return false;
      }
      aggregate.queuedFollowUps = {
        ...projection,
        entries: [...projection.entries],
      };
      if (aggregate.snapshot) {
        aggregate.snapshot = { ...aggregate.snapshot, queuedFollowUps: aggregate.queuedFollowUps };
      }
      if (projectReplica && aggregate.acceptedReplica) {
        acceptReplica({
          conversation: {
            ...aggregate.acceptedReplica.conversation,
            queuedFollowUps: aggregate.queuedFollowUps,
          },
          ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
          revision: aggregate.revision + 1,
        });
      }
      return true;
    };

    return {
      threadId,
      generation: aggregate.generation,
      read: () => snapshot(aggregate),
      readCanonicalState: () => aggregate.canonicalState,
      readServerRequests: () =>
        aggregate.canonicalState?.requests ?? aggregate.preHydrationServerRequests,
      readHasUnreadTurn: () =>
        aggregate.canonicalState?.sidecar.hasUnreadTurn ?? aggregate.preHydrationHasUnreadTurn,
      readSnapshot: () => aggregate.snapshot,
      installSnapshot: (conversation) => {
        aggregate.snapshot = {
          ...conversation,
          conversationEntityGeneration: aggregate.generation,
          historyMutationRevision: aggregate.historyMutationRevision,
          queuedFollowUps: aggregate.queuedFollowUps,
        };
        enforceHistoryResidency(false);
      },
      seedHasUnreadTurn: (hasUnreadTurn) => {
        if (aggregate.canonicalState) return;
        aggregate.preHydrationHasUnreadTurn = hasUnreadTurn;
        if (aggregate.snapshot) {
          aggregate.snapshot = { ...aggregate.snapshot, hasUnreadTurn };
        }
      },
      setHasUnreadTurn: (hasUnreadTurn, projectReplica) => {
        const previous =
          aggregate.canonicalState?.sidecar.hasUnreadTurn ?? aggregate.preHydrationHasUnreadTurn;
        const replicaChanged =
          aggregate.acceptedReplica !== null &&
          aggregate.acceptedReplica.conversation.hasUnreadTurn !== hasUnreadTurn;
        if (previous !== hasUnreadTurn) {
          if (aggregate.canonicalState) {
            aggregate.canonicalState = {
              ...aggregate.canonicalState,
              sidecar: {
                ...aggregate.canonicalState.sidecar,
                hasUnreadTurn,
              },
            };
          } else {
            aggregate.preHydrationHasUnreadTurn = hasUnreadTurn;
          }
          if (aggregate.snapshot) {
            aggregate.snapshot = {
              ...aggregate.snapshot,
              hasUnreadTurn,
              ...(hasUnreadTurn ? {} : { unreadMessageCount: 0 }),
            };
          }
        }
        if (projectReplica && replicaChanged && aggregate.acceptedReplica) {
          const conversation = {
            ...aggregate.acceptedReplica.conversation,
            hasUnreadTurn,
            ...(hasUnreadTurn ? {} : { unreadMessageCount: 0 }),
          };
          acceptReplica({
            conversation,
            ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
            revision: aggregate.revision + 1,
          });
        }
        return previous !== hasUnreadTurn || (projectReplica && replicaChanged);
      },
      readResumeState: () => aggregate.resumeState,
      setResumeState: (state) => {
        const replicaChanged =
          aggregate.acceptedReplica !== null &&
          aggregate.acceptedReplica.conversation.resumeState !== state;
        if (aggregate.resumeState === state && !replicaChanged) return;
        aggregate.resumeState = state;
        if (aggregate.snapshot) {
          aggregate.snapshot = { ...aggregate.snapshot, resumeState: state };
        }
        if (!replicaChanged || !aggregate.acceptedReplica) return;
        acceptReplica({
          conversation: { ...aggregate.acceptedReplica.conversation, resumeState: state },
          ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
          revision: aggregate.revision + 1,
        });
      },
      isStreaming: () => aggregate.isStreaming,
      setStreaming: (isStreaming) => {
        aggregate.isStreaming = isStreaming;
      },
      readTurnPagination: () => ({ ...aggregate.turnPagination }),
      readTurnItemsPagination: (turnId) => {
        const pagination = aggregate.turnItemsPaginationById[turnId];
        return pagination ? { ...pagination } : null;
      },
      readAllTurnItemsPagination: () => ({ ...aggregate.turnItemsPaginationById }),
      readHistoryItemPageCursor: (turnId, edge) => {
        const window = readOrSeedHistoryItemWindow(turnId);
        if (!window) return undefined;
        const boundary = edge === "older" ? window.olderBoundary : window.newerBoundary;
        return boundary.status === "available" ? boundary.cursor : undefined;
      },
      readHistoryTopology: () => aggregate.historyTopology,
      insertHistoryIsland: (input) => {
        if (aggregate.historyTopology.generation !== input.expectedTopologyGeneration) {
          return { status: "staleGeneration" };
        }
        const before = aggregate.canonicalState;
        const beforeSnapshot = aggregate.snapshot;
        if (!before || !beforeSnapshot) {
          return { status: "rejected", reason: "Canonical history is not installed" };
        }
        if (input.turnIds.length === 0 || new Set(input.turnIds).size !== input.turnIds.length) {
          return { status: "rejected", reason: "History island turn identities are invalid" };
        }

        const state = preserveResidentHistoryTurns(input.state, aggregate.historyTopology);
        const turnsById = new Map(
          persistedCanonicalTurns(state).map((turn) => [turn.protocol.id, turn] as const),
        );
        const revision = aggregate.historyEntityRevision + 1;
        const entities: CodexHistoryEntity<CodexCanonicalTurnState>[] = [];
        for (const turnId of input.turnIds) {
          const turn = turnsById.get(turnId);
          if (!turn) {
            return { status: "rejected", reason: `History island is missing Turn ${turnId}` };
          }
          entities.push(
            historyEntity({
              turn,
              current: aggregate.historyTopology.entitiesByKey[turnId],
              itemsPagination: input.itemsPaginationByTurnId[turnId],
              authority: "history",
              revision,
            }),
          );
        }
        const inserted = insertCodexHistoryIsland(aggregate.historyTopology, {
          index: input.index,
          islandId: input.islandId,
          entries: entities.map((entity) => ({ key: entity.key, entityKey: entity.key })),
          entities,
          olderBoundary: input.olderBoundary,
          newerBoundary: input.newerBoundary,
          ...(input.positionsByEntityKey
            ? { positionsByEntityKey: input.positionsByEntityKey }
            : {}),
        });
        if (!inserted.ok) {
          return { status: "rejected", reason: inserted.error.message };
        }
        const canonicalTurns = inserted.topology.islands.flatMap((island) =>
          island.entries.map((entry) => inserted.topology.entitiesByKey[entry.entityKey]!.turn),
        );
        const committedState: CodexCanonicalConversationState = {
          ...state,
          turns: [...canonicalTurns, ...state.turns.filter((turn) => turn.protocol.id === null)],
        };
        aggregate.historyEntityRevision = revision;
        aggregate.canonicalState = committedState;
        aggregate.turnItemsPaginationById = {
          ...aggregate.turnItemsPaginationById,
          ...input.itemsPaginationByTurnId,
        };
        aggregate.historyTopology = inserted.topology;
        if (input.islandId.startsWith("prompt-rail:")) {
          for (const island of aggregate.historyTopology.islands) {
            if (!island.id.startsWith("prompt-rail:") || island.id === input.islandId) continue;
            for (const entry of island.entries) {
              aggregate.historyRevealedTurnIds.delete(entry.entityKey);
            }
          }
        }
        if (input.islandId.startsWith("search:")) {
          aggregate.activeSearchHistoryIslandId = input.islandId;
        }
        const historyRows = flattenCodexHistoryTopology(aggregate.historyTopology);
        aggregate.historyMutationRevision += 1;
        leaseHistoryRevealedTurns(input.turnIds, aggregate.historyMutationRevision);
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...projectCodexConversationSnapshot({
              conversation: aggregate.snapshot,
              before,
              after: committedState,
              observedAtMs: input.observedAtMs,
            }),
            turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
            historyRows,
            historyTopologyGeneration: aggregate.historyTopology.generation,
            historyMutationRevision: aggregate.historyMutationRevision,
          };
        }
        if (input.projectReplica && aggregate.acceptedReplica) {
          acceptReplica({
            conversation: {
              ...projectCodexConversationSnapshot({
                conversation: aggregate.acceptedReplica.conversation,
                before,
                after: committedState,
                observedAtMs: input.observedAtMs,
              }),
              turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
              historyRows,
              historyTopologyGeneration: aggregate.historyTopology.generation,
              historyMutationRevision: aggregate.historyMutationRevision,
            },
            ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
            revision: aggregate.revision + 1,
          });
        }
        enforceHistoryResidency(input.projectReplica);
        const afterSnapshot = aggregate.snapshot;
        if (!afterSnapshot) {
          return { status: "rejected", reason: "History snapshot disappeared during commit" };
        }
        return {
          status: "committed",
          topologyGeneration: aggregate.historyTopology.generation,
          mutation: buildCodexConversationHistoryMutation({
            before: beforeSnapshot,
            after: afterSnapshot,
            origin: {
              kind: "island",
              threadId,
              mutationId: input.mutationId,
              expectedConversationGeneration: aggregate.generation,
              expectedTopologyGeneration: input.expectedTopologyGeneration,
            },
          }),
        };
      },
      beginHistoryPageLoad: (request) => {
        if (
          request.threadId !== threadId ||
          request.expectedConversationGeneration !== aggregate.generation
        ) {
          return false;
        }
        const target = request.target;
        const expectedTopologyGeneration =
          target.kind === "turnBoundary"
            ? target.boundary.generation
            : target.items.expectedTopologyGeneration;
        if (expectedTopologyGeneration !== aggregate.historyTopology.generation) return false;
        const key = codexConversationHistoryPageRequestKey(request);
        if (aggregate.historyPageLoadLeases.has(key)) return true;
        if (target.kind === "turnItems") {
          const pagination = aggregate.turnItemsPaginationById[target.items.turnId];
          if (
            !aggregate.historyTopology.entitiesByKey[target.items.turnId] ||
            !pagination ||
            historyItemProgressKey(target.items.turnId, target.items.edge) !==
              target.items.progressKey
          ) {
            return false;
          }
          aggregate.historyPageLoadLeases.set(key, {
            islandIds: [],
            turnIds: [target.items.turnId],
          });
          return true;
        }
        const island = aggregate.historyTopology.islands.find(
          (candidate) => candidate.id === target.boundary.islandId,
        );
        const boundary =
          target.boundary.edge === "older" ? island?.olderBoundary : island?.newerBoundary;
        if (
          boundary?.status !== "available" ||
          boundary.boundaryId !== target.boundary.boundaryId ||
          boundary.progressKey !== target.boundary.progressKey
        ) {
          return false;
        }
        aggregate.historyPageLoadLeases.set(key, {
          islandIds: [target.boundary.islandId],
          turnIds: island?.entries.map((entry) => entry.entityKey) ?? [],
        });
        return true;
      },
      endHistoryPageLoad: (request) => {
        aggregate.historyPageLoadLeases.delete(codexConversationHistoryPageRequestKey(request));
      },
      commitHistoryPage: (input) => {
        if (
          input.request.threadId !== threadId ||
          input.request.expectedConversationGeneration !== aggregate.generation
        ) {
          return { status: "staleGeneration" };
        }
        const before = aggregate.canonicalState;
        const beforeSnapshot = aggregate.snapshot;
        if (!before || !beforeSnapshot) {
          return { status: "rejected", reason: "Canonical history is not installed" };
        }
        const target = input.request.target;
        const expectedTopologyGeneration =
          target.kind === "turnBoundary"
            ? target.boundary.generation
            : target.items.expectedTopologyGeneration;
        if (aggregate.historyTopology.generation !== expectedTopologyGeneration) {
          return { status: "staleGeneration" };
        }

        const staged = preserveResidentHistoryTurns(input.state, aggregate.historyTopology);
        const stagedById = new Map(
          persistedCanonicalTurns(staged).map((turn) => [turn.protocol.id, turn] as const),
        );
        const revision = aggregate.historyEntityRevision + 1;
        let nextTopology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
        let turnItemsMutation: readonly CodexConversationHistoryTurnItemsMutation[] = [];
        let itemRendererProjection: {
          readonly turnId: string;
          readonly itemIds: readonly string[];
          readonly items: readonly CodexConversationItem[];
        } | null = null;
        let itemWindowSnapshotBefore:
          | import("../../../shared/codex-conversation-history-page").CodexConversationHistoryItemWindowSnapshot
          | null = null;
        if (target.kind === "turnBoundary") {
          if (
            !input.continuation ||
            (input.turnIds.length === 0 && input.continuation.status !== "exhausted")
          ) {
            return { status: "rejected", reason: "Boundary page is empty without exhaustion" };
          }
          const entities: CodexHistoryEntity<CodexCanonicalTurnState>[] = [];
          for (const turnId of input.turnIds) {
            const turn = stagedById.get(turnId);
            const pagination = input.itemsPaginationByTurnId[turnId];
            if (!turn || !pagination) {
              return { status: "rejected", reason: `Boundary page is missing Turn ${turnId}` };
            }
            entities.push(
              historyEntity({
                turn,
                current: aggregate.historyTopology.entitiesByKey[turnId],
                itemsPagination: pagination,
                authority: "history",
                revision,
              }),
            );
          }
          const merged = mergeCodexHistoryBoundaryPage(aggregate.historyTopology, {
            boundary: target.boundary,
            entries: entities.map((entity) => ({ key: entity.key, entityKey: entity.key })),
            entities,
            continuation: input.continuation,
          });
          if (!merged.ok) {
            return merged.error.code === "staleGeneration"
              ? { status: "staleGeneration" }
              : merged.error.code === "boundaryMissing" ||
                  merged.error.code === "staleBoundary" ||
                  merged.error.code === "cursorStalled"
                ? { status: "staleTarget" }
                : { status: "rejected", reason: merged.error.message };
          }
          nextTopology = merged.topology;
        } else {
          const currentPagination = aggregate.turnItemsPaginationById[target.items.turnId];
          const itemPage = input.itemPage;
          if (
            !currentPagination ||
            historyItemProgressKey(target.items.turnId, target.items.edge) !==
              target.items.progressKey ||
            !itemPage ||
            itemPage.direction !== target.items.edge
          ) {
            return { status: "staleTarget" };
          }
          const turn = stagedById.get(target.items.turnId);
          const currentEntity = aggregate.historyTopology.entitiesByKey[target.items.turnId];
          const currentRendererTurn = beforeSnapshot.turns.find(
            (candidate) => candidate.turnId === target.items.turnId,
          );
          const window = readOrSeedHistoryItemWindow(target.items.turnId);
          if (!turn || !currentEntity || !currentRendererTurn || !window) {
            return { status: "staleTarget" };
          }
          itemWindowSnapshotBefore =
            beforeSnapshot.historyItemWindowsByTurnId?.[target.items.turnId] ??
            snapshotCodexConversationHistoryItemWindow(window);
          if (
            itemPage.itemIds.length !== itemPage.canonicalItems.length ||
            itemPage.itemIds.some((itemId, index) => itemPage.canonicalItems[index]?.id !== itemId)
          ) {
            return { status: "rejected", reason: "Item page projection identities diverged" };
          }
          const transitioned =
            target.items.edge === "older"
              ? prependCodexHistoryItemPage(window, {
                  turnId: target.items.turnId,
                  segmentId: itemPage.segmentId,
                  items: {
                    itemIds: itemPage.itemIds,
                    canonicalItems: itemPage.canonicalItems,
                    rendererItems: itemPage.rendererItems,
                  },
                  approximateBytes: itemPage.approximateBytes,
                  olderCursorAfter: itemPage.nextCursor,
                  newerCursor: itemPage.backwardsCursor,
                })
              : appendCodexHistoryItemPage(window, {
                  turnId: target.items.turnId,
                  segmentId: itemPage.segmentId,
                  items: {
                    itemIds: itemPage.itemIds,
                    canonicalItems: itemPage.canonicalItems,
                    rendererItems: itemPage.rendererItems,
                  },
                  approximateBytes: itemPage.approximateBytes,
                  newerCursorAfter: itemPage.nextCursor,
                  olderCursor: itemPage.backwardsCursor,
                });
          if (!transitioned.ok) {
            return transitioned.error.code === "staleBoundary" ||
              transitioned.error.code === "cursorStalled" ||
              transitioned.error.code === "duplicateItem"
              ? { status: "staleTarget" }
              : { status: "rejected", reason: transitioned.error.message };
          }
          const releasedCanonicalCount = transitioned.releasedSegments.reduce(
            (count, segment) => count + segment.items.canonicalItems.length,
            0,
          );
          const releasedRendererCount = transitioned.releasedSegments.reduce(
            (count, segment) => count + segment.items.rendererItems.length,
            0,
          );
          const retainedCanonical =
            target.items.edge === "older"
              ? turn.items.slice(0, turn.items.length - releasedCanonicalCount)
              : turn.items.slice(releasedCanonicalCount);
          const retainedRenderer =
            target.items.edge === "older"
              ? currentRendererTurn.items.slice(
                  0,
                  currentRendererTurn.items.length - releasedRendererCount,
                )
              : currentRendererTurn.items.slice(releasedRendererCount);
          const canonicalItems =
            target.items.edge === "older"
              ? [...itemPage.canonicalItems, ...retainedCanonical]
              : [...retainedCanonical, ...itemPage.canonicalItems];
          const rendererItems =
            target.items.edge === "older"
              ? [...itemPage.rendererItems, ...retainedRenderer]
              : [...retainedRenderer, ...itemPage.rendererItems];
          const hasLoadedOldest = transitioned.window.olderBoundary.status === "exhausted";
          const hasLoadedNewest = transitioned.window.newerBoundary.status === "exhausted";
          const pagination: CodexHistoryTurnItemsPagination = {
            ...currentPagination,
            olderCursor:
              transitioned.window.olderBoundary.status === "available"
                ? transitioned.window.olderBoundary.cursor
                : null,
            isLoadingOlder: false,
            hasLoadedOldest,
            itemsView: hasLoadedOldest && hasLoadedNewest ? "full" : "summary",
          };
          const nextTurn: PersistedCanonicalTurn = {
            ...turn,
            protocol: { ...turn.protocol, itemsView: pagination.itemsView },
            items: canonicalItems,
          };
          aggregate.historyItemWindowsByTurnId.set(target.items.turnId, transitioned.window);
          turnItemsMutation = [
            {
              turnId: target.items.turnId,
              itemsView: pagination.itemsView,
              windowMutation: {
                wireSegment: transitioned.wireSegment,
                releasedSegmentIds: transitioned.releasedSegmentIds,
              },
            },
          ];
          itemRendererProjection = {
            turnId: target.items.turnId,
            itemIds: canonicalItems.map((item) => item.id),
            items: rendererItems,
          };
          const replaced = replaceCodexHistoryEntity(aggregate.historyTopology, {
            expectedGeneration: target.items.expectedTopologyGeneration,
            entity: historyEntity({
              turn: nextTurn,
              current: currentEntity,
              itemsPagination: pagination,
              authority: currentEntity.authority,
              revision,
              approximateBytes:
                canonicalTurnMetadataBytes(nextTurn) +
                transitioned.window.residency.approximateBytes,
            }),
          });
          if (!replaced.ok) {
            return replaced.error.code === "staleGeneration"
              ? { status: "staleGeneration" }
              : { status: "staleTarget" };
          }
          nextTopology = replaced.topology;
        }

        const canonicalTurns = nextTopology.islands.flatMap((island) =>
          island.entries.map((entry) => nextTopology.entitiesByKey[entry.entityKey]!.turn),
        );
        const committedState: CodexCanonicalConversationState = {
          ...staged,
          turns: [...canonicalTurns, ...staged.turns.filter((turn) => turn.protocol.id === null)],
        };
        aggregate.historyEntityRevision = revision;
        aggregate.historyTopology = nextTopology;
        aggregate.canonicalState = committedState;
        aggregate.turnItemsPaginationById = Object.fromEntries(
          Object.entries(nextTopology.entitiesByKey).map(([turnId, entity]) => [
            turnId,
            entity.itemsPagination,
          ]),
        );
        aggregate.turnPagination = paginationForHistoryTopology({
          current: aggregate.turnPagination,
          topology: nextTopology,
        });
        const previousTurnIds = new Set(
          persistedCanonicalTurns(before).map((turn) => turn.protocol.id),
        );
        const revealedTurnIds =
          target.kind === "turnItems"
            ? [target.items.turnId]
            : input.turnIds.filter((turnId) => !previousTurnIds.has(turnId));
        const historyRows = flattenCodexHistoryTopology(nextTopology);
        aggregate.historyMutationRevision += 1;
        leaseHistoryRevealedTurns(revealedTurnIds, aggregate.historyMutationRevision);
        let boundaryItemWindowSnapshots: Readonly<
          Record<string, CodexConversationHistoryItemWindowSnapshot>
        > | null = null;
        const projectCommittedSnapshot = (
          conversation: CodexConversationSnapshot,
        ): CodexConversationSnapshot => {
          if (
            target.kind === "turnItems" &&
            itemRendererProjection &&
            itemWindowSnapshotBefore &&
            turnItemsMutation.length === 1
          ) {
            const window = aggregate.historyItemWindowsByTurnId.get(target.items.turnId);
            const windowMutation = turnItemsMutation[0]?.windowMutation;
            const currentTurn = conversation.turns.find(
              (turn) => turn.turnId === itemRendererProjection.turnId,
            );
            if (!window || !windowMutation || !currentTurn) {
              throw new TypeError("Turn-item page projection lost its resident window");
            }
            const itemWindowSnapshot = advanceCodexConversationHistoryItemWindowSnapshot({
              before:
                conversation.historyItemWindowsByTurnId?.[target.items.turnId] ??
                itemWindowSnapshotBefore,
              mutation: windowMutation,
              after: window,
            });
            return {
              ...conversation,
              canonicalState: committedState,
              historyItemWindowsByTurnId: {
                ...(conversation.historyItemWindowsByTurnId ?? {}),
                [target.items.turnId]: itemWindowSnapshot,
              },
              turns: conversation.turns.map((turn) =>
                turn === currentTurn
                  ? {
                      ...turn,
                      itemIds: [...itemRendererProjection.itemIds],
                      items: [...itemRendererProjection.items],
                    }
                  : turn,
              ),
            };
          }
          const projected = projectCodexConversationSnapshot({
            conversation,
            before,
            after: committedState,
            observedAtMs: input.observedAtMs,
          });
          if (target.kind === "turnBoundary" && input.itemSegmentsByTurnId) {
            if (boundaryItemWindowSnapshots === null) {
              const newlyResidentSegments = Object.fromEntries(
                Object.entries(input.itemSegmentsByTurnId).filter(
                  ([turnId]) => !previousTurnIds.has(turnId),
                ),
              );
              boundaryItemWindowSnapshots = projectCodexConversationHistoryItemWindows({
                canonical: committedState,
                snapshot: projected,
                itemsPaginationByTurnId: aggregate.turnItemsPaginationById,
                itemSegmentsByTurnId: newlyResidentSegments,
              });
            }
            return {
              ...projected,
              historyItemWindowsByTurnId: {
                ...(conversation.historyItemWindowsByTurnId ?? {}),
                ...boundaryItemWindowSnapshots,
              },
            };
          }
          return projected;
        };
        aggregate.snapshot = {
          ...projectCommittedSnapshot(beforeSnapshot),
          turnPagination: { ...aggregate.turnPagination },
          turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
          historyRows,
          historyTopologyGeneration: nextTopology.generation,
          historyMutationRevision: aggregate.historyMutationRevision,
        };
        for (const [
          turnId,
          itemWindowSnapshot,
        ] of Object.entries<CodexConversationHistoryItemWindowSnapshot>(
          boundaryItemWindowSnapshots ?? {},
        )) {
          const restored = restoreCodexConversationHistoryItemWindow(itemWindowSnapshot);
          if (restored) aggregate.historyItemWindowsByTurnId.set(turnId, restored);
        }
        if (input.projectReplica && aggregate.acceptedReplica) {
          acceptReplica({
            conversation: {
              ...projectCommittedSnapshot(aggregate.acceptedReplica.conversation),
              turnPagination: { ...aggregate.turnPagination },
              turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
              historyRows,
              historyTopologyGeneration: nextTopology.generation,
              historyMutationRevision: aggregate.historyMutationRevision,
            },
            ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
            revision: aggregate.revision + 1,
          });
        }
        enforceHistoryResidency(input.projectReplica);
        const afterSnapshot = aggregate.snapshot;
        if (!afterSnapshot) {
          return { status: "rejected", reason: "History snapshot disappeared during commit" };
        }
        return {
          status: "committed",
          mutation: buildCodexConversationHistoryMutation({
            before: beforeSnapshot,
            after: afterSnapshot,
            origin: { kind: "page", request: input.request },
            turnItems: turnItemsMutation,
          }),
        };
      },
      setHistoryResidencyPins: (input) => {
        if (aggregate.historyTopology.generation !== input.expectedTopologyGeneration) {
          return { status: "staleGeneration" };
        }
        const beforeSnapshot = aggregate.snapshot;
        const requestedVisibleIslandIds = new Set(input.islandIds);
        const requestedVisibleTurnIds = new Set(input.turnIds);
        // A revision-matched viewport observation acknowledges the page reveal lease. Search
        // islands use the stronger overlap handoff below so tail observations cannot release them.
        for (const [turnId, revision] of aggregate.historyRevealedTurnIds) {
          const visibleThroughIsland = aggregate.historyTopology.islands.some(
            (island) =>
              requestedVisibleIslandIds.has(island.id) &&
              island.entries.some((entry) => entry.entityKey === turnId),
          );
          if (
            revision <= input.expectedHistoryMutationRevision &&
            (requestedVisibleTurnIds.has(turnId) || visibleThroughIsland)
          ) {
            aggregate.historyRevealedTurnIds.delete(turnId);
          }
        }
        const activeSearchIslandId = aggregate.activeSearchHistoryIslandId;
        const activeSearchIsland = activeSearchIslandId
          ? aggregate.historyTopology.islands.find((island) => island.id === activeSearchIslandId)
          : null;
        if (
          activeSearchIslandId &&
          (requestedVisibleIslandIds.has(activeSearchIslandId) ||
            activeSearchIsland?.entries.some((entry) =>
              requestedVisibleTurnIds.has(entry.entityKey),
            ))
        ) {
          aggregate.activeSearchHistoryIslandId = null;
        }
        if (input.islandIds.length === 0 && input.turnIds.length === 0) {
          aggregate.historyVisibleIslandIdsByClient.delete(input.clientId);
          aggregate.historyVisibleTurnIdsByClient.delete(input.clientId);
        } else {
          // The renderer registry has one owner. Replacing stale client state here is a second
          // boundary against owner handoff races and prevents client-count-multiplied pin unions.
          aggregate.historyVisibleIslandIdsByClient.clear();
          aggregate.historyVisibleTurnIdsByClient.clear();
          const admitted = admitHistoryViewportPins(input);
          if (admitted.islandIds.size > 0) {
            aggregate.historyVisibleIslandIdsByClient.set(input.clientId, admitted.islandIds);
          }
          if (admitted.turnIds.size > 0) {
            aggregate.historyVisibleTurnIdsByClient.set(input.clientId, admitted.turnIds);
          }
        }
        const retained = enforceHistoryResidency(false);
        const projectedSnapshot = aggregate.snapshot;
        let mutation: CodexConversationHistoryMutation | null = null;
        if (beforeSnapshot && projectedSnapshot && projectedSnapshot !== beforeSnapshot) {
          aggregate.historyMutationRevision += 1;
          aggregate.snapshot = {
            ...projectedSnapshot,
            historyMutationRevision: aggregate.historyMutationRevision,
          };
          mutation = buildCodexConversationHistoryMutation({
            before: beforeSnapshot,
            after: aggregate.snapshot,
            origin: {
              kind: "residency",
              threadId,
              expectedConversationGeneration: aggregate.generation,
              expectedTopologyGeneration: input.expectedTopologyGeneration,
              expectedHistoryMutationRevision: input.expectedHistoryMutationRevision,
            },
          });
        }
        return {
          status: "applied",
          evictedTurnIds: retained?.evictedEntityKeys ?? [],
          limitsSatisfied: retained?.limitsSatisfied ?? true,
          ...(mutation ? { mutation } : {}),
        };
      },
      clearHistoryResidencyPins: (clientId) => {
        aggregate.historyVisibleIslandIdsByClient.delete(clientId);
        aggregate.historyVisibleTurnIdsByClient.delete(clientId);
      },
      initializeHistory: (pagination, loadedTurnCount, itemsPaginationByTurnId = {}) => {
        aggregate.historyGeneration += 1;
        aggregate.historyEntityRevision += 1;
        aggregate.historyMutationRevision += 1;
        aggregate.historyVisibleIslandIdsByClient.clear();
        aggregate.historyVisibleTurnIdsByClient.clear();
        aggregate.historyRevealedTurnIds.clear();
        aggregate.activeSearchHistoryIslandId = null;
        aggregate.historyPageLoadLeases.clear();
        aggregate.historyItemWindowsByTurnId.clear();
        aggregate.turnPagination = { ...pagination, loadedTurnCount };
        aggregate.turnItemsPaginationById = { ...itemsPaginationByTurnId };
        aggregate.historyTopology = rebuildHistoryTopology({
          generation: aggregate.historyGeneration,
          canonical: aggregate.canonicalState,
          pagination: aggregate.turnPagination,
          itemsPaginationByTurnId: aggregate.turnItemsPaginationById,
          authority: "history",
          revision: aggregate.historyEntityRevision,
        });
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...aggregate.snapshot,
            turnPagination: { ...aggregate.turnPagination },
            turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
            historyRows: flattenCodexHistoryTopology(aggregate.historyTopology),
            historyTopologyGeneration: aggregate.historyTopology.generation,
            historyMutationRevision: aggregate.historyMutationRevision,
          };
        }
        enforceHistoryResidency(false);
      },
      beginHistoryLoad: (loadedTurnCount) => {
        const pagination = aggregate.turnPagination;
        if (
          pagination.isLoadingOlder ||
          pagination.hasLoadedOldest ||
          pagination.olderCursor === null
        ) {
          return null;
        }
        aggregate.historyGeneration += 1;
        const fence = {
          generation: aggregate.historyGeneration,
          olderCursor: pagination.olderCursor,
          oldestLoadedTurnId: pagination.oldestLoadedTurnId,
        };
        aggregate.turnPagination = {
          ...pagination,
          isLoadingOlder: true,
          hasLoadedOldest: false,
          loadedTurnCount,
        };
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...aggregate.snapshot,
            turnPagination: { ...aggregate.turnPagination },
            turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
          };
        }
        return fence;
      },
      isHistoryLoadCurrent: (fence) =>
        aggregate.historyGeneration === fence.generation &&
        aggregate.turnPagination.isLoadingOlder &&
        aggregate.turnPagination.olderCursor === fence.olderCursor,
      commitHistoryLoad: (fence, pagination, loadedTurnCount) => {
        if (
          !aggregate.turnPagination.isLoadingOlder ||
          aggregate.historyGeneration !== fence.generation ||
          aggregate.turnPagination.olderCursor !== fence.olderCursor
        ) {
          return false;
        }
        aggregate.turnPagination = { ...pagination, loadedTurnCount, isLoadingOlder: false };
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...aggregate.snapshot,
            turnPagination: { ...aggregate.turnPagination },
            turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
          };
        }
        return true;
      },
      commitHistoryProjection: ({
        fence,
        state,
        pagination,
        loadedTurnCount,
        itemsPaginationByTurnId,
        observedAtMs,
        projectReplica,
      }) => {
        if (
          !aggregate.turnPagination.isLoadingOlder ||
          aggregate.historyGeneration !== fence.generation ||
          aggregate.turnPagination.olderCursor !== fence.olderCursor
        ) {
          return false;
        }
        const before = aggregate.canonicalState;
        if (!before) return false;
        const beforeTurnIds = new Set(
          persistedCanonicalTurns(before).map((turn) => turn.protocol.id),
        );
        aggregate.canonicalState = state;
        if (aggregate.snapshot) {
          aggregate.snapshot = projectCodexConversationSnapshot({
            conversation: aggregate.snapshot,
            before,
            after: state,
            observedAtMs,
          });
        }
        aggregate.turnPagination = { ...pagination, loadedTurnCount, isLoadingOlder: false };
        if (itemsPaginationByTurnId) {
          aggregate.turnItemsPaginationById = {
            ...aggregate.turnItemsPaginationById,
            ...itemsPaginationByTurnId,
          };
        }
        const revealedTurnIds = persistedCanonicalTurns(state).flatMap((turn) =>
          beforeTurnIds.has(turn.protocol.id) ? [] : [turn.protocol.id],
        );
        if (revealedTurnIds.length > 0) {
          leaseHistoryRevealedTurns(revealedTurnIds, aggregate.historyMutationRevision);
        }
        reconcileCanonicalHistory("history");
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...aggregate.snapshot,
            turnPagination: { ...aggregate.turnPagination },
            turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
            historyRows: flattenCodexHistoryTopology(aggregate.historyTopology),
            historyTopologyGeneration: aggregate.historyTopology.generation,
          };
        }
        if (projectReplica && aggregate.acceptedReplica) {
          acceptReplica({
            conversation: {
              ...projectCodexConversationSnapshot({
                conversation: aggregate.acceptedReplica.conversation,
                before,
                after: state,
                observedAtMs,
              }),
              turnPagination: { ...aggregate.turnPagination },
              turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
            },
            ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
            revision: aggregate.revision + 1,
          });
        }
        enforceHistoryResidency(projectReplica);
        return true;
      },
      failHistoryLoad: (fence) => {
        if (
          !aggregate.turnPagination.isLoadingOlder ||
          aggregate.historyGeneration !== fence.generation ||
          aggregate.turnPagination.olderCursor !== fence.olderCursor
        ) {
          return false;
        }
        aggregate.turnPagination = {
          ...aggregate.turnPagination,
          olderCursor: fence.olderCursor,
          oldestLoadedTurnId: fence.oldestLoadedTurnId,
          isLoadingOlder: false,
          hasLoadedOldest: false,
        };
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...aggregate.snapshot,
            turnPagination: { ...aggregate.turnPagination },
          };
        }
        return true;
      },
      beginTurnItemsHistoryLoad: (turnId) => {
        const pagination = aggregate.turnItemsPaginationById[turnId];
        if (
          !pagination ||
          pagination.isLoadingOlder ||
          pagination.hasLoadedOldest ||
          pagination.olderCursor === null
        ) {
          return null;
        }
        aggregate.historyGeneration += 1;
        const fence = {
          generation: aggregate.historyGeneration,
          turnId,
          olderCursor: pagination.olderCursor,
        };
        aggregate.turnItemsPaginationById = {
          ...aggregate.turnItemsPaginationById,
          [turnId]: { ...pagination, isLoadingOlder: true },
        };
        reconcileCanonicalHistory("history");
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...aggregate.snapshot,
            turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
            historyRows: flattenCodexHistoryTopology(aggregate.historyTopology),
            historyTopologyGeneration: aggregate.historyTopology.generation,
          };
        }
        return fence;
      },
      isTurnItemsHistoryLoadCurrent: (fence) => {
        const pagination = aggregate.turnItemsPaginationById[fence.turnId];
        return (
          aggregate.historyGeneration === fence.generation &&
          pagination?.isLoadingOlder === true &&
          pagination.olderCursor === fence.olderCursor
        );
      },
      commitTurnItemsHistoryProjection: ({
        fence,
        state,
        pagination,
        observedAtMs,
        projectReplica,
      }) => {
        const currentPagination = aggregate.turnItemsPaginationById[fence.turnId];
        if (
          aggregate.historyGeneration !== fence.generation ||
          currentPagination?.isLoadingOlder !== true ||
          currentPagination.olderCursor !== fence.olderCursor
        ) {
          return false;
        }
        const before = aggregate.canonicalState;
        if (!before) return false;
        aggregate.canonicalState = state;
        if (aggregate.snapshot) {
          aggregate.snapshot = projectCodexConversationSnapshot({
            conversation: aggregate.snapshot,
            before,
            after: state,
            observedAtMs,
          });
        }
        aggregate.turnItemsPaginationById = {
          ...aggregate.turnItemsPaginationById,
          [fence.turnId]: { ...pagination, isLoadingOlder: false },
        };
        leaseHistoryRevealedTurns([fence.turnId], aggregate.historyMutationRevision);
        reconcileCanonicalHistory("history");
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...aggregate.snapshot,
            turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
            historyRows: flattenCodexHistoryTopology(aggregate.historyTopology),
            historyTopologyGeneration: aggregate.historyTopology.generation,
          };
        }
        if (projectReplica && aggregate.acceptedReplica) {
          acceptReplica({
            conversation: {
              ...projectCodexConversationSnapshot({
                conversation: aggregate.acceptedReplica.conversation,
                before,
                after: state,
                observedAtMs,
              }),
              turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
            },
            ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
            revision: aggregate.revision + 1,
          });
        }
        enforceHistoryResidency(projectReplica);
        return true;
      },
      failTurnItemsHistoryLoad: (fence) => {
        const pagination = aggregate.turnItemsPaginationById[fence.turnId];
        if (
          aggregate.historyGeneration !== fence.generation ||
          pagination?.isLoadingOlder !== true ||
          pagination.olderCursor !== fence.olderCursor
        ) {
          return false;
        }
        aggregate.turnItemsPaginationById = {
          ...aggregate.turnItemsPaginationById,
          [fence.turnId]: { ...pagination, isLoadingOlder: false },
        };
        reconcileCanonicalHistory("history");
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...aggregate.snapshot,
            turnItemsPaginationById: { ...aggregate.turnItemsPaginationById },
            historyRows: flattenCodexHistoryTopology(aggregate.historyTopology),
            historyTopologyGeneration: aggregate.historyTopology.generation,
          };
        }
        return true;
      },
      beginResumeEventBuffer: () => {
        if (aggregate.resumeEventBuffer !== null) return false;
        aggregate.resumeEventBuffer = [];
        aggregate.resumeEventBufferBytes = 0;
        return true;
      },
      hasResumeEventBuffer: () => aggregate.resumeEventBuffer !== null,
      offerProtocolOccurrence: ({ occurrence, bypassResume, startsThread, deferThreadStart }) => {
        const bytes = protocolOccurrenceBytes(occurrence);
        if (!bypassResume && aggregate.resumeEventBuffer !== null) {
          if (
            aggregate.resumeEventBuffer.length >= MAX_BUFFERED_PROTOCOL_OCCURRENCES ||
            aggregate.resumeEventBufferBytes + bytes > MAX_BUFFERED_PROTOCOL_BYTES
          ) {
            return "overflow";
          }
          aggregate.resumeEventBuffer.push(occurrence);
          aggregate.resumeEventBufferBytes += bytes;
          return "buffered";
        }
        if (aggregate.threadStartEventBuffer !== null) {
          const fence = aggregate.threadStartEventBufferFence;
          if (
            fence === null ||
            fence.hostId !== occurrence.hostId ||
            fence.generation !== occurrence.generation
          ) {
            return "generation-mismatch";
          }
          if (
            aggregate.threadStartEventBuffer.length >= MAX_BUFFERED_PROTOCOL_OCCURRENCES ||
            aggregate.threadStartEventBufferBytes + bytes > MAX_BUFFERED_PROTOCOL_BYTES
          ) {
            return "overflow";
          }
          aggregate.threadStartEventBuffer.push(occurrence);
          aggregate.threadStartEventBufferBytes += bytes;
          return "buffered";
        }
        if (!startsThread || !deferThreadStart) return "unbuffered";
        if (
          deferThreadStart.hostId !== occurrence.hostId ||
          deferThreadStart.generation !== occurrence.generation
        ) {
          return "generation-mismatch";
        }
        if (bytes > MAX_BUFFERED_PROTOCOL_BYTES) return "overflow";
        aggregate.threadStartDeferred = true;
        aggregate.threadStartEventBuffer = [occurrence];
        aggregate.threadStartEventBufferBytes = bytes;
        aggregate.threadStartEventBufferFence = deferThreadStart;
        return "buffered";
      },
      takeResumeEventBuffer: () => {
        const buffered = aggregate.resumeEventBuffer;
        aggregate.resumeEventBuffer = null;
        aggregate.resumeEventBufferBytes = 0;
        return buffered;
      },
      takeThreadStartEventBuffer: (fence) => {
        if (!aggregate.threadStartDeferred) return null;
        const activeFence = aggregate.threadStartEventBufferFence;
        const matched =
          activeFence !== null &&
          activeFence.hostId === fence.hostId &&
          activeFence.generation === fence.generation;
        const events = aggregate.threadStartEventBuffer ?? [];
        aggregate.threadStartEventBuffer = null;
        aggregate.threadStartEventBufferBytes = 0;
        aggregate.threadStartEventBufferFence = null;
        aggregate.threadStartDeferred = false;
        return { kind: matched ? "matched" : "generation-mismatch", events };
      },
      discardResumeEventBuffer: () => {
        const buffered = aggregate.resumeEventBuffer ?? [];
        aggregate.resumeEventBuffer = null;
        aggregate.resumeEventBufferBytes = 0;
        return buffered;
      },
      clearBufferedEvents: () => {
        const buffered = [
          ...(aggregate.resumeEventBuffer ?? []),
          ...(aggregate.threadStartEventBuffer ?? []),
        ];
        aggregate.resumeEventBuffer = null;
        aggregate.resumeEventBufferBytes = 0;
        aggregate.threadStartEventBuffer = null;
        aggregate.threadStartEventBufferBytes = 0;
        aggregate.threadStartEventBufferFence = null;
        aggregate.threadStartDeferred = false;
        return buffered;
      },
      commitFrameTextDeltas: ({ updates, observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before || updates.length === 0) return [];
        const result = reduceCodexConversationFrameTextDeltas(before, updates, {
          now: () => observedAtMs,
        });
        projectCanonicalState(result.state, observedAtMs, projectReplica);
        return result.outcomes;
      },
      commitCommandOutputDeltas: ({ updates, observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before || updates.length === 0) return [];
        let state = before;
        const dispositions: CodexCommandExecutionMutationDisposition[] = [];
        for (const update of updates) {
          const result = reduceCodexConversationCommandOutput(state, update);
          state = result.state;
          dispositions.push(result.disposition);
        }
        projectCanonicalState(state, observedAtMs, projectReplica);
        return dispositions;
      },
      commitTerminalCommands: ({ update, observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before) return "noTurns";
        const result = reduceCodexConversationTerminalCommands(before, update);
        if (!result.stateChanged) return result.disposition;
        projectCanonicalState(result.state, observedAtMs, projectReplica);
        return result.disposition;
      },
      readServerRequestState: () => {
        const canonicalState = aggregate.canonicalState;
        return {
          canonicalState,
          rawState: canonicalState
            ? {
                threadId,
                turns: canonicalState.turns.map((turn) => ({
                  turnId: turn.protocol.id,
                  status: turn.protocol.status,
                  hasError: turn.protocol.error !== null,
                  items: turn.items,
                  hookRuns: turn.sidecar.hookRuns,
                  turnStartedAtMs: turn.sidecar.turnStartedAtMs,
                })),
                requests: canonicalState.requests,
                hasUnreadTurn: canonicalState.sidecar.hasUnreadTurn,
              }
            : {
                threadId,
                turns: [],
                requests: aggregate.preHydrationServerRequests,
                hasUnreadTurn: aggregate.preHydrationHasUnreadTurn,
              },
          streamRole: aggregate.streamRole,
        };
      },
      commitServerRequestLifecycle: (input) => {
        const previousHasUnreadTurn =
          aggregate.canonicalState?.sidecar.hasUnreadTurn ?? aggregate.preHydrationHasUnreadTurn;
        if (!input.lifecycle.stateChanged) {
          return {
            stateChanged: false,
            unreadChanged: false,
            hasUnreadTurn: previousHasUnreadTurn,
          };
        }
        if (input.kind === "canonical") {
          aggregate.canonicalState = input.lifecycle.state;
          aggregate.preHydrationServerRequests = [];
          aggregate.preHydrationHasUnreadTurn = false;
          if (input.projectReplica && aggregate.acceptedReplica) {
            const conversation = projectCodexConversationServerRequestLifecycle({
              before: input.before,
              conversation: aggregate.acceptedReplica.conversation,
              lifecycle: input.lifecycle,
              observedAtMs: input.observedAtMs,
            });
            acceptReplica({
              conversation,
              ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
              revision: aggregate.revision + 1,
            });
          }
        } else {
          aggregate.preHydrationServerRequests = [...input.lifecycle.state.requests];
          aggregate.preHydrationHasUnreadTurn = input.lifecycle.state.hasUnreadTurn;
          if (input.projectReplica && aggregate.acceptedReplica) {
            const conversation = projectCodexConversationRawServerRequestLifecycle({
              conversation: aggregate.acceptedReplica.conversation,
              lifecycle: input.lifecycle,
            });
            acceptReplica({
              conversation,
              ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
              revision: aggregate.revision + 1,
            });
          }
        }
        const hasUnreadTurn =
          aggregate.canonicalState?.sidecar.hasUnreadTurn ?? aggregate.preHydrationHasUnreadTurn;
        return {
          stateChanged: true,
          unreadChanged: hasUnreadTurn !== previousHasUnreadTurn,
          hasUnreadTurn,
        };
      },
      commitProtocolNotification: ({
        notification,
        observedAtMs,
        projectReplica,
        createId,
        reducerContext,
      }) => {
        const before = aggregate.canonicalState;
        if (!before) return { effects: [], stateChanged: false };
        const reduced = reduceCodexConversationEventWithEffects(
          before,
          { type: "notification", notification },
          { now: () => observedAtMs, createId, ...reducerContext },
        );
        return {
          effects: reduced.effects,
          stateChanged: projectCanonicalState(reduced.state, observedAtMs, projectReplica),
        };
      },
      completePlanImplementation: (turnId, projectReplica) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        const state = completeCodexCanonicalPlanImplementationState(before, turnId);
        if (state === before) return false;
        aggregate.canonicalState = state;
        if (projectReplica && aggregate.acceptedReplica) {
          const conversation = projectCodexConversationPlanImplementationCompleted({
            conversation: aggregate.acceptedReplica.conversation,
            state,
            turnId,
          });
          acceptReplica({
            conversation,
            ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
            revision: aggregate.revision + 1,
          });
        }
        return true;
      },
      commitPostResumeGoalHydration: ({ expectedRevision, goal }) => {
        if (aggregate.revision !== expectedRevision) return false;

        const project = (conversation: CodexConversationSnapshot): CodexConversationSnapshot => ({
          ...conversation,
          threadGoal: goal,
          completedThreadGoal: goal?.status === "complete" ? goal : null,
          threadGoalResumeConfirmation: null,
        });
        if (aggregate.canonicalState) {
          aggregate.canonicalState = {
            ...aggregate.canonicalState,
            sidecar: {
              ...aggregate.canonicalState.sidecar,
              threadGoal: goal,
              completedThreadGoal: goal?.status === "complete" ? goal : null,
              threadGoalResumeConfirmation: null,
            },
          };
        }
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...project(aggregate.snapshot),
            canonicalState: aggregate.canonicalState,
          };
        }
        if (aggregate.acceptedReplica) {
          acceptReplica({
            conversation: {
              ...project(aggregate.acceptedReplica.conversation),
              canonicalState: aggregate.canonicalState,
            },
            ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
            revision: aggregate.revision,
          });
        }
        return true;
      },
      admitOptimisticTurn: ({
        params,
        worktreeInit,
        currentCollaborationModel,
        startedAtMs,
        projectReplica,
      }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        const optimistic = appendCodexCanonicalOptimisticTurn(before, {
          params,
          ...(currentCollaborationModel ? { currentCollaborationModel } : {}),
          startedAtMs,
        });
        const after = worktreeInit
          ? appendCodexCanonicalWorktreeInitItem(optimistic, worktreeInit)
          : optimistic;
        const changed = projectCanonicalState(after, startedAtMs, projectReplica);
        if (changed) aggregate.isStreaming = true;
        return changed;
      },
      acceptOptimisticTurn: ({
        clientUserMessageId,
        turn,
        recovery,
        observedAtMs,
        projectReplica,
      }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        if (before.turns.some((candidate) => candidate.protocol.id === turn.id)) return true;
        const hasOptimisticTurn = before.turns.some(
          (candidate) => candidate.sidecar.params.clientUserMessageId === clientUserMessageId,
        );
        const admitted =
          !hasOptimisticTurn && recovery
            ? appendCodexCanonicalOptimisticTurn(before, {
                params: recovery.params,
                ...(recovery.currentCollaborationModel
                  ? { currentCollaborationModel: recovery.currentCollaborationModel }
                  : {}),
                startedAtMs: recovery.startedAtMs,
              })
            : before;
        const accepted = bindCodexCanonicalOptimisticTurn(admitted, clientUserMessageId, turn);
        if (!accepted.turns.some((candidate) => candidate.protocol.id === turn.id)) return false;
        projectCanonicalState(accepted, observedAtMs, projectReplica);
        return true;
      },
      rejectOptimisticTurn: ({
        clientUserMessageId,
        failureItemId,
        observedAtMs,
        projectReplica,
      }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        return projectCanonicalState(
          failCodexCanonicalOptimisticTurn(before, clientUserMessageId, failureItemId),
          observedAtMs,
          projectReplica,
        );
      },
      admitSteeringItem: ({ turnId, item, observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        return projectCanonicalState(
          upsertCodexCanonicalSteeringItem(before, turnId, item),
          observedAtMs,
          projectReplica,
        );
      },
      retargetSteeringItem: ({ fromTurnId, toTurnId, itemId, observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        return projectCanonicalState(
          retargetCodexCanonicalSteeringItem(before, fromTurnId, toTurnId, itemId),
          observedAtMs,
          projectReplica,
        );
      },
      rejectSteeringItem: ({ turnId, itemId, observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        return projectCanonicalState(
          removeCodexCanonicalSteeringItem(before, turnId, itemId),
          observedAtMs,
          projectReplica,
        );
      },
      resolveInterruptTurnId: (requestedTurnId) => {
        const turns = aggregate.canonicalState?.turns ?? [];
        if (requestedTurnId && turns.some((turn) => turn.protocol.id === requestedTurnId)) {
          return requestedTurnId;
        }
        return (
          turns.findLast(
            (turn) => turn.protocol.status === "inProgress" && turn.protocol.id !== null,
          )?.protocol.id ?? null
        );
      },
      interruptTurn: ({ turnId, observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        const turnIndex = before.turns.findIndex((turn) => turn.protocol.id === turnId);
        const turn = before.turns[turnIndex];
        if (!turn || turn.protocol.status !== "inProgress") return false;
        const interruptedCommandExecutionItemIds = [
          ...new Set([
            ...(turn.sidecar.interruptedCommandExecutionItemIds ?? []),
            ...turn.items.flatMap((item) =>
              item.type === "commandExecution" && item.status === "inProgress" ? [item.id] : [],
            ),
          ]),
        ];
        const turns = [...before.turns];
        turns[turnIndex] = {
          ...turn,
          protocol: { ...turn.protocol, status: "interrupted" },
          sidecar: { ...turn.sidecar, interruptedCommandExecutionItemIds },
        };
        return projectCanonicalState({ ...before, turns }, observedAtMs, projectReplica);
      },
      backgroundTerminalTurnIds: () => {
        const conversation = aggregate.canonicalState;
        if (!conversation) return null;
        return listCodexBackgroundTerminalTurnIds(conversation);
      },
      cleanBackgroundTerminals: ({ observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        return projectCanonicalState(
          reduceCodexBackgroundTerminalCleanup(before),
          observedAtMs,
          projectReplica,
        );
      },
      applyTurnConfiguration: ({ settings, permissions, projectReplica }) => {
        const before = aggregate.canonicalState;
        const hydration = before?.sidecar.hydrationContext;
        if (!before || !hydration) return false;
        const canonical = {
          ...before,
          sidecar: {
            ...before.sidecar,
            hydrationContext: {
              ...hydration,
              latestModel: settings.model ?? hydration.latestModel,
              latestReasoningEffort: settings.reasoningEffort,
              latestThreadSettings: {
                ...(hydration.latestThreadSettings ?? {}),
                model: settings.model ?? hydration.latestModel,
                serviceTier: settings.serviceTier ?? null,
                effort: settings.reasoningEffort,
                summary: settings.summary ?? null,
                personality: settings.personality,
                collaborationMode: settings.collaborationMode,
              },
              currentPermissions: permissions,
            },
          },
        };
        aggregate.canonicalState = canonical;
        const project = (conversation: CodexConversationSnapshot): CodexConversationSnapshot => ({
          ...conversation,
          latestCollaborationMode: settings.collaborationMode ?? undefined,
          latestThreadSettings: settings,
          approvalPolicy: permissions.approvalPolicy,
          approvalsReviewer: permissions.approvalsReviewer,
          sandbox: permissions.sandboxPolicy,
          canonicalState: canonical,
        });
        if (aggregate.snapshot) aggregate.snapshot = project(aggregate.snapshot);
        if (projectReplica && aggregate.acceptedReplica) {
          acceptReplica({
            conversation: project(aggregate.acceptedReplica.conversation),
            ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
            revision: aggregate.revision + 1,
          });
        }
        return true;
      },
      renameThread: ({ name, observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        return projectCanonicalState(
          reduceCodexConversationThreadName(before, threadId, name),
          observedAtMs,
          projectReplica,
        );
      },
      acceptThreadGoal: ({
        goal,
        appendTranscriptItem,
        dismissResumeConfirmation,
        projectReplica,
      }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        const updated = reduceCodexConversationThreadGoalUpdated(before, threadId, goal).state;
        const dismissed = dismissResumeConfirmation
          ? reduceCodexConversationThreadGoalResumeConfirmationDismissed(updated, threadId)
          : updated;
        const after = appendTranscriptItem
          ? appendCodexCanonicalThreadGoalTranscriptTurn(dismissed, goal)
          : dismissed;
        return projectCanonicalState(after, goal.updatedAt * 1_000, projectReplica);
      },
      admitManualCompaction: ({ observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before) return null;
        const after = appendCodexCanonicalInProgressSyntheticItem(
          before,
          pendingManualCompaction,
          observedAtMs,
        );
        projectCanonicalState(after, observedAtMs, projectReplica);
        const turnIndex = after.turns.findLastIndex((turn) =>
          turn.items.some((item) => item.id === pendingManualCompaction.id),
        );
        return after.turns[turnIndex]?.protocol.id ?? null;
      },
      rollbackManualCompaction: ({ observedAtMs, projectReplica }) => {
        const before = aggregate.canonicalState;
        if (!before) return false;
        return projectCanonicalState(
          removeCodexCanonicalLocalSyntheticItem(before, pendingManualCompaction.id),
          observedAtMs,
          projectReplica,
        );
      },
      relocateExecution: ({
        cwd,
        managedWorktreePath,
        projectId,
        projectlessOutputDirectory,
        projectlessWorkspaceBrowserRoot,
        permissions,
        projectReplica,
      }) => {
        const before = aggregate.canonicalState;
        const hydration = before?.sidecar.hydrationContext;
        if (!before || !hydration) return false;
        const canonical = {
          ...before,
          sidecar: {
            ...before.sidecar,
            hydrationContext: {
              ...hydration,
              cwd,
              latestThreadSettings: {
                ...(hydration.latestThreadSettings ?? {}),
                cwd,
              },
              currentPermissions: permissions,
            },
          },
        };
        aggregate.canonicalState = canonical;
        const project = (conversation: CodexConversationSnapshot): CodexConversationSnapshot => ({
          ...conversation,
          projectId,
          cwd,
          managedWorktreePath,
          projectlessOutputDirectory,
          projectlessWorkspaceBrowserRoot,
          approvalPolicy: permissions.approvalPolicy,
          approvalsReviewer: permissions.approvalsReviewer,
          sandbox: permissions.sandboxPolicy,
          canonicalState: canonical,
        });
        if (aggregate.snapshot) aggregate.snapshot = project(aggregate.snapshot);
        if (projectReplica && aggregate.acceptedReplica) {
          acceptReplica({
            conversation: project(aggregate.acceptedReplica.conversation),
            ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
            revision: aggregate.revision + 1,
          });
        }
        return true;
      },
      setThreadStatus: (statusType, projectReplica) => {
        const beforeStatus = aggregate.canonicalState?.protocol.status.type ?? null;
        if (aggregate.canonicalState && beforeStatus !== statusType) {
          aggregate.canonicalState = {
            ...aggregate.canonicalState,
            protocol: {
              ...aggregate.canonicalState.protocol,
              status: { type: statusType, activeFlags: [] },
            },
          };
        }
        const snapshotChanged = aggregate.snapshot?.statusType !== statusType;
        if (aggregate.snapshot && snapshotChanged) {
          aggregate.snapshot = {
            ...aggregate.snapshot,
            statusType,
            statusActiveFlags: [],
            canonicalState: aggregate.canonicalState,
          };
        }
        const replicaChanged = aggregate.acceptedReplica?.conversation.statusType !== statusType;
        if (projectReplica && aggregate.acceptedReplica && replicaChanged) {
          acceptReplica({
            conversation: {
              ...aggregate.acceptedReplica.conversation,
              statusType,
              statusActiveFlags: [],
              canonicalState: aggregate.canonicalState,
            },
            ownerEpoch: aggregate.acceptedReplica.checkpoint.ownerEpoch,
            revision: aggregate.revision + 1,
          });
        }
        return beforeStatus !== statusType || snapshotChanged || (projectReplica && replicaChanged);
      },
      readQueuedFollowUpProjection: () => ({
        ...aggregate.queuedFollowUps,
        entries: [...aggregate.queuedFollowUps.entries],
      }),
      installQueuedFollowUpProjection,
      readStreamRole: () => aggregate.streamRole,
      setStreamRole: (role) => {
        aggregate.streamRole = role;
      },
      acceptCanonicalState: (state) => {
        const before = aggregate.canonicalState;
        const incomingTurns = persistedCanonicalTurns(state);
        const beforeTurnsById = new Map(
          persistedCanonicalTurns(before).map((turn) => [turn.protocol.id, turn] as const),
        );
        const liveTurnIds = new Set(
          incomingTurns
            .filter((turn) => beforeTurnsById.get(turn.protocol.id) !== turn)
            .map((turn) => turn.protocol.id),
        );
        const acceptedState = preserveResidentHistoryTurns(state, aggregate.historyTopology);
        aggregate.canonicalState = acceptedState;
        reconcileCanonicalHistory("live", liveTurnIds);
        aggregate.preHydrationServerRequests = [];
        aggregate.preHydrationHasUnreadTurn = false;
        if (aggregate.snapshot && before !== acceptedState) {
          aggregate.snapshot = projectCodexConversationSnapshot({
            conversation: aggregate.snapshot,
            before,
            after: acceptedState,
            observedAtMs: Date.now(),
          });
          aggregate.snapshot = {
            ...aggregate.snapshot,
            historyRows: flattenCodexHistoryTopology(aggregate.historyTopology),
            historyTopologyGeneration: aggregate.historyTopology.generation,
          };
        }
        enforceHistoryResidency(false);
        return aggregate.canonicalState ?? acceptedState;
      },
      replaceServerRequests: (requests) => {
        if (!aggregate.canonicalState) {
          aggregate.preHydrationServerRequests = [...requests];
          return;
        }
        aggregate.canonicalState = {
          ...aggregate.canonicalState,
          requests: [...requests],
        };
        aggregate.preHydrationServerRequests = [];
      },
      incrementVersion: () => {
        aggregate.version += 1;
        return aggregate.version;
      },
      acceptReplica: (input) => {
        const accepted = acceptReplica(input);
        enforceHistoryResidency(true);
        return aggregate.acceptedReplica ?? accepted;
      },
      advanceReplica: (input) => {
        const baseRevision = aggregate.revision;
        const accepted = acceptReplica({ ...input, revision: baseRevision + 1 });
        enforceHistoryResidency(true);
        return { baseRevision, replica: aggregate.acceptedReplica ?? accepted };
      },
      clearReplica: () => {
        aggregate.acceptedReplica = null;
        aggregate.revision = 0;
        aggregate.checkpoint = null;
      },
      reset: () => resetAggregate(aggregate),
    };
  };

  const acquire = (threadId: string): ConversationEntityState => {
    const existing = capabilities.get(threadId);
    if (existing) return existing;
    const capability = makeCapability(threadId, ensureState(threadId));
    capabilities.set(threadId, capability);
    return capability;
  };

  return {
    current: (threadId) => capabilities.get(threadId) ?? null,
    acquire,
    releaseGeneration: (threadId, generation) => {
      const aggregate = aggregates.get(threadId);
      if (aggregate?.generation !== generation) return;
      aggregates.delete(threadId);
      capabilities.delete(threadId);
    },
    releaseAll: () => {
      aggregates.clear();
      capabilities.clear();
    },
    markAllNeedsResume: () => {
      const affectedThreadIds = [...capabilities.keys()];
      for (const conversation of capabilities.values()) {
        // Renderer replicas are generation-bound recovery checkpoints. Renderers retain their
        // visible document, but Main must seed the next accepted checkpoint from fresh canonical
        // hydration instead of pairing a stale checkpoint with replacement-generation history.
        conversation.clearReplica();
        conversation.setResumeState("needs_resume");
        conversation.setStreamRole(null);
        conversation.setStreaming(false);
      }
      return affectedThreadIds;
    },
  };
}

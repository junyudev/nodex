import {
  mutateCodexTurnStartRejection,
  type CodexPreparedTurnExecution,
  type CodexTurnStartRejection,
} from "../../../shared/codex-conversation-state/codex-turn-execution";
import { acceptCodexPreparedEnvironmentSelection } from "../../../shared/codex-conversation-state/codex-environment-selection";
import { castDraft, type Draft, type Patch } from "immer";
import {
  residentConversationTurns,
  residentConversationTurnEntries,
  conversationTurnDraft,
} from "../../../shared/codex-conversation-state/codex-turn-mutation";

import { CodexConversationPresentation } from "../CodexConversationPresentation";

import { CodexConversationEntityDocument } from "../../../shared/codex-conversation-entity-document";
import {
  releaseCanonicalConversationHistoryDraft,
  completeCanonicalConversationUnsubscribeDraft,
  selectCanonicalRetentionRequestKind,
  type CanonicalRetentionRequestKind,
} from "../../../shared/codex-canonical-retention";
import type {
  CodexCanonicalWorktreeInitItem,
  CodexCanonicalLiveTurnParams,
  CodexCanonicalPermissionContext,
  CodexCanonicalConversationState,
  CodexConversationThreadSettings,
  CodexThreadStatusType,
  CodexCanonicalServerRequest,
  CodexConversationTurnPagination,
  CodexConversationResumeState,
  CodexConversationSnapshot,
  CodexQueuedFollowUpProjection,
} from "../../../shared/types";
import { EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION } from "../../../shared/codex-queued-follow-up-state";
import * as Data from "effect/Data";
import {
  mergeCodexCanonicalTurnState,
  mutateCodexCanonicalWorktreeInitItem,
  mutateCodexCanonicalInProgressSyntheticItem,
  mutateCodexCanonicalLocalSyntheticItemRemoval,
  type CodexCanonicalContextCompactionItem,
  type CodexCanonicalTurnState,
} from "../../../shared/codex-conversation-state/codex-conversation-state";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryIslandTopology,
  createEmptyCodexHistoryTopology,
  exhaustedCodexHistoryBoundary,
  flattenCodexHistoryTopology,
  type CodexCanonicalHistoryTopology,
  type CodexHistoryEntity,
} from "../../../shared/codex-conversation-state/codex-history-topology";
import type { Thread, ThreadGoal, Turn } from "@nodex/codex-app-server-protocol/v2";
import {
  CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID,
  mutateCodexConversationEvent,
  type CodexConversationReducerContext,
  type CodexConversationReducerEffect,
} from "../../../shared/codex-conversation-state/codex-conversation-reducer";
import {
  mutateCodexCanonicalOptimisticTurn,
  mutateCodexCanonicalOptimisticTurnBinding,
} from "../../../shared/codex-conversation-state/codex-optimistic-turn";
import {
  listCodexBackgroundTerminalTurnIds,
  mutateCodexBackgroundTerminalCleanup,
} from "../../../shared/codex-conversation-state/codex-background-terminal-cleanup";
import type {
  CodexServerRequestLifecycleResult,
  CodexServerRequestRawLifecycleResult,
  CodexServerRequestRawState,
} from "../../../shared/codex-conversation-state/codex-server-request-lifecycle";
import {
  mutateCodexConversationFrameTextDeltas,
  type CodexFrameTextDeltaOutcome,
} from "../../../shared/codex-conversation-state/codex-frame-text-delta";
import type { CodexFrameTextDeltaUpdate } from "../../../shared/codex-conversation-state/codex-frame-text-delta-queue";
import {
  mutateCodexConversationCommandOutput,
  mutateCodexConversationTerminalCommands,
  type CodexCommandExecutionMutationDisposition,
  type CodexTerminalCommandUpdate,
} from "../../../shared/codex-conversation-state/codex-command-execution-stream";
import type { CodexCommandOutputUpdate } from "../../../shared/codex-conversation-state/codex-command-output-queue";
import {
  mutateCodexConversationThreadGoalResumeConfirmationDismissed,
  mutateCodexConversationThreadName,
  mutateCodexConversationThreadMetadata,
} from "../../../shared/codex-conversation-state/codex-thread-metadata";
import { mutateCodexCanonicalThreadGoalTranscriptTurn } from "../../../shared/codex-conversation-state/codex-thread-goal-transcript";
import {
  projectCodexConversationRawServerRequestLifecycle,
  projectCodexConversationServerRequestLifecycle,
} from "../CodexConversationServerRequestProjection";
import { projectCodexConversationSnapshot } from "../CodexConversationSnapshotProjection";

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
  readonly serverRequests: readonly CodexCanonicalServerRequest[];
  readonly hasUnreadTurn: boolean;
  readonly streamRole: CodexConversationStreamRole;
  readonly version: number;
  readonly snapshot: CodexConversationSnapshot | null;
  readonly resumeState: CodexConversationResumeState;
  readonly turnPagination: CodexConversationTurnPagination;
  readonly turnItemsPaginationById: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly historyTopology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
  readonly historyMutationRevision: number;
  readonly isStreaming: boolean;
}

export interface ConversationCanonicalMutation {
  readonly threadId: string;
  readonly before: CodexCanonicalConversationState | null;
  readonly after: CodexCanonicalConversationState | null;
  readonly patches?: readonly Patch[];
  readonly origin: "local" | "follower";
  readonly broadcast: boolean;
}

class MutableConversationEntityState {
  readonly generation!: number;
  private currentDocument!: CodexConversationEntityDocument;
  onCanonicalChange?: (change: Omit<ConversationCanonicalMutation, "threadId">) => void;
  mutationOrigin: "local" | "follower" = "local";
  mutationBroadcast = true;
  get document(): CodexConversationEntityDocument {
    return this.currentDocument;
  }
  set document(document: CodexConversationEntityDocument) {
    const before = this.currentDocument?.canonicalState ?? null;
    this.currentDocument = document;
    const after = document.canonicalState;
    if (before === after) return;
    this.onCanonicalChange?.({
      before,
      after,
      patches: document.patchesFrom(before),
      origin: this.mutationOrigin,
      broadcast: this.mutationBroadcast,
    });
  }
  streamRole!: CodexConversationStreamRole;
  version!: number;
  private presentation = new CodexConversationPresentation();
  get snapshot(): CodexConversationSnapshot | null {
    return this.presentation.read(this.document);
  }
  set snapshot(value: CodexConversationSnapshot | null) {
    this.presentation = this.presentation.withSnapshot(value, this.document);
  }
  forkPresentation(): void {
    this.presentation = this.presentation.fork();
  }
  constructor(generation: number) {
    Object.assign(this, initialAggregateFields(generation));
  }
  resumeStateBeforeHydration!: CodexConversationResumeState;
  get resumeState(): CodexConversationResumeState {
    return this.document.canonicalState?.resumeState ?? this.resumeStateBeforeHydration;
  }
  turnPagination!: CodexConversationTurnPagination;
  get turnItemsPaginationById(): Record<string, CodexHistoryTurnItemsPagination> {
    return Object.fromEntries(
      residentConversationTurns(this.document.canonicalState).flatMap((turn) =>
        turn.turnId !== null && turn.itemsPagination ? [[turn.turnId, turn.itemsPagination]] : [],
      ),
    );
  }
  private unmaterializedHistory = createEmptyCodexHistoryTopology<CodexCanonicalTurnState>(0);
  get historyTopology(): CodexCanonicalHistoryTopology<CodexCanonicalTurnState> {
    return this.document.canonicalState?.turnHistory?.history ?? this.unmaterializedHistory;
  }
  set historyTopology(history: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>) {
    const canonical = this.document.canonicalState;
    if (!canonical) {
      this.unmaterializedHistory = history;
      return;
    }
    this.document = this.document.withCanonicalState(installCanonicalHistory(canonical, history));
  }
  isStreaming!: boolean;
  historyGeneration!: number;
  historyMutationRevision!: number;
  historyPageLoadLeases!: Set<string>;
  threadStartEventBuffer!: CodexApplicationProtocolOccurrence[] | null;
  threadStartEventBufferBytes!: number;
  threadStartEventBufferFence!: CodexThreadStartEventBufferFence | null;
  threadStartDeferred!: boolean;
  queuedFollowUps!: CodexQueuedFollowUpProjection;
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
  readonly mutateCanonicalState: (
    recipe: (draft: Draft<CodexCanonicalConversationState>) => void,
    observedAtMs: number,
    broadcast?: boolean,
  ) => boolean;
  readonly installFollowerCanonicalState: (state: CodexCanonicalConversationState) => void;
  readonly threadId: string;
  readonly generation: number;
  readonly read: () => ConversationEntitySnapshot;
  readonly readCanonicalState: () => CodexCanonicalConversationState | null;
  readonly readServerRequests: () => readonly CodexCanonicalServerRequest[];
  readonly readServerRequestState: () => CodexConversationServerRequestState;
  readonly readHasUnreadTurn: () => boolean;
  readonly readSnapshot: () => CodexConversationSnapshot | null;
  readonly readRetentionState: () => {
    primaryRequest: CanonicalRetentionRequestKind;
    ephemeralSide: boolean;
  };
  readonly releasePassiveHistory: () => void;

  readonly completeHistoryUnsubscribe: (retainHistory: boolean) => void;
  /** Installs the canonical application snapshot without implying renderer ownership. */
  readonly installSnapshot: (snapshot: CodexConversationSnapshot) => void;
  /** Seeds durable Workspace state before canonical app-server hydration. */
  readonly seedHasUnreadTurn: (hasUnreadTurn: boolean) => void;
  /** Applies the canonical read-state transition to every loaded conversation projection. */
  readonly setHasUnreadTurn: (hasUnreadTurn: boolean) => boolean;
  readonly readResumeState: () => CodexConversationResumeState;
  readonly setResumeState: (state: CodexConversationResumeState) => void;
  readonly isStreaming: () => boolean;
  readonly setStreaming: (isStreaming: boolean) => void;
  readonly readTurnPagination: () => CodexConversationTurnPagination;
  readonly readTurnItemsPagination: (turnId: string) => CodexHistoryTurnItemsPagination | null;
  readonly readAllTurnItemsPagination: () => Readonly<
    Record<string, CodexHistoryTurnItemsPagination>
  >;
  readonly readHistoryTopology: () => CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
  /** Atomically installs one bounded, cursor-independent search window into canonical history. */

  /** Atomically commits one exact boundary or Turn-item page and returns its bounded mutation. */

  /** Admits one exact target while its physical page is outside the causal lane. */

  /** Replaces pagination when a canonical hydration installs a new history window. */
  readonly initializeHistory: (
    pagination: CodexConversationTurnPagination,
    loadedTurnCount: number,
    itemsPaginationByTurnId?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>,
  ) => void;
  /** Opens one cursor-fenced physical history load. */

  readonly offerProtocolOccurrence: (input: {
    readonly occurrence: CodexApplicationProtocolOccurrence;
    readonly startsThread: boolean;
    readonly deferThreadStart: CodexThreadStartEventBufferFence | null;
  }) => CodexProtocolOccurrenceAdmission;
  readonly takeThreadStartEventBuffer: (
    fence: CodexThreadStartEventBufferFence,
  ) => CodexThreadStartEventBufferTake | null;
  readonly clearBufferedEvents: () => readonly CodexApplicationProtocolOccurrence[];
  readonly commitFrameTextDeltas: (input: {
    readonly updates: readonly CodexFrameTextDeltaUpdate[];
    readonly observedAtMs: number;
  }) => readonly CodexFrameTextDeltaOutcome[];
  readonly commitCommandOutputDeltas: (input: {
    readonly updates: readonly CodexCommandOutputUpdate[];
    readonly observedAtMs: number;
  }) => readonly CodexCommandExecutionMutationDisposition[];
  readonly commitTerminalCommands: (input: {
    readonly update: CodexTerminalCommandUpdate;
    readonly observedAtMs: number;
  }) => CodexCommandExecutionMutationDisposition;
  readonly commitServerRequestLifecycle: (
    input: CodexConversationServerRequestLifecycleCommit & {
      readonly observedAtMs: number;
    },
  ) => CodexConversationServerRequestCommitResult;
  /** Applies one transport-ordered notification to canonical state and accepted projections. */
  readonly commitProtocolNotification: (input: {
    readonly notification: CodexServerNotification;
    readonly observedAtMs: number;
    readonly createId: () => `${string}-${string}-${string}-${string}-${string}`;
    readonly reducerContext?: Pick<
      CodexConversationReducerContext,
      "consumeContextCompactionSource" | "resolveCollabReceiverThread"
    >;
  }) => CodexConversationProtocolEventCommitResult;
  /** Admits one optimistic Main-owned turn into canonical state and every accepted projection. */
  readonly admitOptimisticTurn: (input: {
    readonly execution?: CodexPreparedTurnExecution;
    readonly params: CodexCanonicalLiveTurnParams;
    readonly localMetadata?: unknown;
    readonly mcpAppModelContextAttachments?: unknown;
    readonly worktreeInit?: CodexCanonicalWorktreeInitItem;
    readonly startedAtMs: number;
  }) => boolean;
  /** Binds an accepted app-server Turn to its exact optimistic client message. */
  readonly acceptOptimisticTurn: (input: {
    readonly permissions?: CodexCanonicalPermissionContext;
    readonly execution?: CodexPreparedTurnExecution;
    readonly environmentSelectionEvidence?: CodexPreparedTurnExecution["environmentSelectionEvidence"];
    readonly clientUserMessageId: string;
    readonly turn: Turn;
    readonly recovery?: {
      readonly params: CodexCanonicalLiveTurnParams;
      readonly localMetadata?: unknown;
      readonly mcpAppModelContextAttachments?: unknown;
      readonly startedAtMs: number;
    };
    readonly observedAtMs: number;
  }) => boolean;
  /** Converts an unaccepted optimistic Turn into its canonical failed outcome. */
  readonly rejectOptimisticTurn: (
    input: CodexTurnStartRejection & {
      readonly observedAtMs: number;
    },
  ) => boolean;
  /** Returns the requested Turn when known, otherwise the latest in-progress Turn. */
  readonly resolveInterruptTurnId: (requestedTurnId?: string) => string | null;
  /** Commits the accepted local interrupt outcome for one exact in-progress Turn. */
  readonly interruptTurn: (input: {
    readonly turnId: string;
    readonly observedAtMs: number;
  }) => boolean;
  /** Derives the Turns which still own running background terminal rows. */
  readonly backgroundTerminalTurnIds: () => readonly string[] | null;
  /** Marks every running background terminal row interrupted across canonical projections. */
  readonly cleanBackgroundTerminals: (input: { readonly observedAtMs: number }) => boolean;
  readonly applyTurnConfiguration: (input: {
    readonly settings: CodexConversationThreadSettings;
    readonly permissions: CodexCanonicalPermissionContext;
  }) => boolean;
  readonly refreshThreadMetadata: (threadId: string) => boolean;
  readonly renameThread: (input: {
    readonly name: string;
    readonly observedAtMs: number;
    readonly generated?: boolean;
  }) => boolean;
  readonly acceptThreadGoal: (input: {
    readonly goal: ThreadGoal | null;
    readonly appendTranscriptItem: boolean;
    readonly dismissResumeConfirmation: boolean;
  }) => boolean;
  readonly admitManualCompaction: (input: { readonly observedAtMs: number }) => string | null;
  readonly rollbackManualCompaction: (input: { readonly observedAtMs: number }) => boolean;
  readonly relocateExecution: (input: {
    readonly cwd: string;
    readonly managedWorktreePath: string | null;
    readonly projectId: string | null;
    readonly projectlessOutputDirectory: string | null;
    readonly projectlessWorkspaceBrowserRoot: string | null;
    readonly permissions: CodexCanonicalPermissionContext;
  }) => boolean;
  readonly setThreadStatus: (statusType: CodexThreadStatusType) => boolean;
  readonly readQueuedFollowUpProjection: () => CodexQueuedFollowUpProjection;
  /** Installs an exact Main/Core-authored projection without synthesizing revisions. */
  readonly installQueuedFollowUpProjection: (projection: CodexQueuedFollowUpProjection) => boolean;
  readonly readStreamRole: () => CodexConversationStreamRole;
  readonly setStreamRole: (role: CodexConversationStreamRole) => void;
  readonly acceptCanonicalState: (
    state: CodexCanonicalConversationState,
  ) => CodexCanonicalConversationState;
  readonly replaceServerRequests: (requests: readonly CodexCanonicalServerRequest[]) => void;
  readonly incrementVersion: () => number;
  /** Clears semantic state while retaining the current live runtime generation. */
  readonly reset: () => void;
}

export interface ConversationEntityStateRegistry {
  readonly subscribeRetired: (
    listener: (threadId: string, generation: number) => void,
  ) => Disposable;
  readonly subscribeCanonicalMutations: (
    listener: (mutation: ConversationCanonicalMutation) => void,
  ) => Disposable;
  readonly forHost: (hostId: string) => readonly ConversationEntityState[];
  readonly registerThreadMetadata: (thread: Thread) => void;
  readonly readThreadMetadata: (threadId: string) => Thread | null;
  readonly removeThreadMetadata: (threadId: string) => void;
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

const pendingManualCompaction: CodexCanonicalContextCompactionItem = {
  type: "contextCompaction",
  id: CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID,
  completed: false,
  source: "manual",
};
const MAX_BUFFERED_PROTOCOL_OCCURRENCES = 1024;
const MAX_BUFFERED_PROTOCOL_BYTES = 16 * 1024 * 1024;

/** Avoid a payload-sized JSON string while deciding whether a deferred occurrence fits. */
const protocolOccurrenceBytes = (occurrence: CodexApplicationProtocolOccurrence): number =>
  cappedApproximateValueBytes(occurrence, MAX_BUFFERED_PROTOCOL_BYTES);

type PersistedCanonicalTurn = CodexCanonicalTurnState & {
  readonly turnId: string;
};

const persistedCanonicalTurns = (
  canonical: CodexCanonicalConversationState | null,
): readonly PersistedCanonicalTurn[] =>
  residentConversationTurns(canonical).filter(
    (turn): turn is PersistedCanonicalTurn => turn.turnId !== null,
  );

const defaultTurnItemsPagination = (
  turn: CodexCanonicalTurnState,
): CodexHistoryTurnItemsPagination => ({
  olderCursor: null,
  isLoadingOlder: false,
  hasLoadedOldest: turn.itemsView === "full",
  oldestUserInput: null,
  openingUserMessageId: null,
  itemsView: turn.itemsView ?? "full",
});

const historyEntity = (input: {
  readonly turn: PersistedCanonicalTurn;
  readonly current: CodexCanonicalTurnState | undefined;
  readonly itemsPagination: CodexHistoryTurnItemsPagination | undefined;
  readonly authority: "history" | "live";
}): CodexHistoryEntity<CodexCanonicalTurnState> => {
  const turn =
    input.current && input.authority === "history"
      ? mergeCodexCanonicalTurnState(input.current, input.turn)
      : input.turn;
  return {
    key: input.turn.turnId,
    turn: {
      ...turn,
      itemsPagination:
        input.itemsPagination ?? turn.itemsPagination ?? defaultTurnItemsPagination(turn),
    },
  };
};

const rebuildHistoryTopology = (input: {
  readonly generation: number;
  readonly canonical: CodexCanonicalConversationState | null;
  readonly pagination: CodexConversationTurnPagination;
  readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly authority: "history" | "live";
}): CodexCanonicalHistoryTopology<CodexCanonicalTurnState> => {
  const turns = residentConversationTurns(input.canonical);
  const entities = turns.map((turn, index): CodexHistoryEntity<CodexCanonicalTurnState> => {
    if (turn.turnId === null)
      return { key: turn.entityKey ?? `tail:${input.generation}:local:${index}`, turn };
    const turnId = turn.turnId;
    return historyEntity({
      turn: { ...turn, turnId },
      current: undefined,
      itemsPagination: input.itemsPaginationByTurnId[turnId],
      authority: input.authority,
    });
  });
  const topology = createCodexHistoryIslandTopology({
    generation: input.generation,
    isComplete: input.pagination.hasLoadedOldest,
    islandId: `tail:${input.generation}`,
    entries: entities.map((entity) => ({ key: entity.key, value: entity.key })),
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

const preserveResidentHistoryTurns = (
  state: CodexCanonicalConversationState,
  topology: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>,
): CodexCanonicalConversationState => {
  if (state.turnHistory || topology.islands.length === 0) return state;
  const incoming = new Map(persistedCanonicalTurns(state).map((turn) => [turn.turnId, turn]));
  const entitiesByKey = { ...topology.entitiesByKey };
  const represented = new Set<string>();
  for (const [key, resident] of Object.entries(entitiesByKey)) {
    if (resident.turnId === null) continue;
    represented.add(resident.turnId);
    const next = incoming.get(resident.turnId);
    entitiesByKey[key] = next ? mergeCodexCanonicalTurnState(resident, next) : resident;
  }
  const additional = persistedCanonicalTurns(state).filter((turn) => !represented.has(turn.turnId));
  let history = { ...topology, entitiesByKey };
  if (additional.length > 0) {
    const tail = history.islands.findLast((island) => island.newerBoundary.status === "exhausted");
    const id = tail?.id ?? `tail:${history.generation}`;
    const nextTail = {
      id,
      entries: [
        ...(tail?.entries ?? []),
        ...additional.map((turn) => ({ key: turn.turnId, value: turn.turnId })),
      ],
      olderBoundary: tail?.olderBoundary ?? exhaustedCodexHistoryBoundary(`${id}:older`),
      newerBoundary: tail?.newerBoundary ?? exhaustedCodexHistoryBoundary(`${id}:newer`),
    };
    for (const turn of additional)
      entitiesByKey[turn.turnId] = {
        ...turn,
        itemsPagination: turn.itemsPagination ?? defaultTurnItemsPagination(turn),
      };
    history = {
      ...history,
      islands: tail
        ? history.islands.map((island) => (island === tail ? nextTail : island))
        : [...history.islands, nextTail],
    };
  }
  return installCanonicalHistory(state, history);
};

const installCanonicalHistory = (
  state: CodexCanonicalConversationState,
  history: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>,
): CodexCanonicalConversationState => {
  if (state.turnHistory?.history === history && state.turns.length === 0) return state;
  const localTurns = state.turnHistory ? [] : state.turns.filter((turn) => turn.turnId === null);
  if (localTurns.length === 0)
    return { ...state, turnHistory: { kind: "canonical", history }, turns: [] };
  const tail = history.islands.findLast((island) => island.newerBoundary.status === "exhausted");
  const tailId = tail?.id ?? `local-live-tail:${history.generation}`;
  const entities = localTurns.map((turn, index) => ({
    key: turn.entityKey ?? `${tailId}:local:${index}`,
    turn,
  }));
  const nextTail = {
    id: tailId,
    entries: [...(tail?.entries ?? []), ...entities.map(({ key }) => ({ key, value: key }))],
    olderBoundary: tail?.olderBoundary ?? exhaustedCodexHistoryBoundary(`${tailId}:older`),
    newerBoundary: tail?.newerBoundary ?? exhaustedCodexHistoryBoundary(`${tailId}:newer`),
  };
  return {
    ...state,
    turns: [],
    turnHistory: {
      kind: "canonical",
      history: {
        ...history,
        isComplete: tail ? history.isComplete : false,
        islands: tail
          ? history.islands.map((island) => (island === tail ? nextTail : island))
          : [...history.islands, nextTail],
        entitiesByKey: {
          ...history.entitiesByKey,
          ...Object.fromEntries(entities.map(({ key, turn }) => [key, turn])),
        },
      },
    },
  };
};

const initialAggregateFields = (generation: number) => ({
  generation,
  document: new CodexConversationEntityDocument(),
  streamRole: null,
  version: 0,
  resumeStateBeforeHydration: "needs_resume",
  turnPagination: {
    olderCursor: null,
    backwardsCursor: null,
    oldestLoadedTurnId: null,
    isLoadingOlder: false,
    hasLoadedOldest: true,
    loadedTurnCount: 0,
    itemsView: "full",
  },
  historyTopology: createEmptyCodexHistoryTopology(0),
  isStreaming: false,
  historyGeneration: 0,
  historyMutationRevision: 0,
  historyPageLoadLeases: new Set(),
  threadStartEventBuffer: null,
  threadStartEventBufferBytes: 0,
  threadStartEventBufferFence: null,
  threadStartDeferred: false,
  queuedFollowUps: EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION,
});

const initialAggregate = (generation: number): MutableConversationEntityState =>
  new MutableConversationEntityState(generation);

/** Mutable transaction containers are isolated; immutable transcript graphs remain shared. */

const snapshot = (aggregate: MutableConversationEntityState): ConversationEntitySnapshot => ({
  generation: aggregate.generation,
  canonicalState: aggregate.document.canonicalState,
  serverRequests: aggregate.document.requests,
  hasUnreadTurn: aggregate.document.hasUnreadTurn,
  streamRole: aggregate.streamRole,
  version: aggregate.version,
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
export function makeConversationEntityStateRegistry(): ConversationEntityStateRegistry {
  const threadsById = new Map<string, Thread>();
  const aggregates = new Map<string, MutableConversationEntityState>();
  const capabilities = new Map<string, ConversationEntityState>();
  const mutationListeners = new Set<(mutation: ConversationCanonicalMutation) => void>();
  let nextGeneration = 1;

  const ensureState = (threadId: string): MutableConversationEntityState => {
    const existing = aggregates.get(threadId);
    if (existing) return existing;
    const created = initialAggregate(nextGeneration++);
    created.onCanonicalChange = (change) => {
      for (const listener of mutationListeners) listener({ threadId, ...change });
    };
    aggregates.set(threadId, created);
    return created;
  };

  const resetAggregate = (aggregate: MutableConversationEntityState): void => {
    aggregate.document = aggregate.document.withCanonicalState(null);

    aggregate.streamRole = null;
    aggregate.version = 0;
    aggregate.snapshot = null;
    aggregate.resumeStateBeforeHydration = "needs_resume";
    aggregate.turnPagination = initialAggregate(aggregate.generation).turnPagination;
    aggregate.historyTopology = createEmptyCodexHistoryTopology(0);
    aggregate.isStreaming = false;
    aggregate.historyGeneration = 0;
    aggregate.historyMutationRevision = 0;
    aggregate.historyPageLoadLeases.clear();
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
    const mutateCanonicalState = (
      recipe: (draft: Draft<CodexCanonicalConversationState>) => void,
      observedAtMs: number,
    ): boolean => {
      const mutation = aggregate.document.mutate(recipe);
      return (
        mutation !== null && projectCanonicalState(mutation.after, observedAtMs, mutation.document)
      );
    };

    const projectCanonicalState = (
      state: CodexCanonicalConversationState,
      observedAtMs: number,
      document?: CodexConversationEntityDocument,
    ): boolean => {
      const before = aggregate.document.canonicalState;
      if (!before || state === before) return false;
      aggregate.document = document ?? aggregate.document.withCanonicalState(state);
      if (aggregate.snapshot) {
        aggregate.snapshot = projectCodexConversationSnapshot({
          conversation: aggregate.snapshot,
          before,
          after: state,
          observedAtMs,
        });
      }

      return true;
    };

    const installQueuedFollowUpProjection = (
      projection: CodexQueuedFollowUpProjection,
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
      return true;
    };

    const clearUnsubscribedBookkeeping = (): void => {
      aggregate.streamRole = null;
      aggregate.isStreaming = false;
      aggregate.historyGeneration += 1;
      aggregate.historyPageLoadLeases.clear();
    };
    const readRetentionState = () => {
      const state = aggregate.document.canonicalState;
      return {
        primaryRequest: selectCanonicalRetentionRequestKind(state),
        ephemeralSide: state?.ephemeral === true && state.sideConversation === true,
      };
    };

    return {
      mutateCanonicalState: (recipe, observedAtMs, broadcast = true) => {
        const previous = aggregate.mutationBroadcast;
        aggregate.mutationBroadcast = broadcast;
        try {
          return mutateCanonicalState(recipe, observedAtMs);
        } finally {
          aggregate.mutationBroadcast = previous;
        }
      },
      installFollowerCanonicalState: (state) => {
        if (state.id !== threadId)
          throw new TypeError("Follower document belongs to another conversation");
        const before = aggregate.document.canonicalState;
        aggregate.mutationOrigin = "follower";
        try {
          aggregate.document = aggregate.document.withCanonicalState(state);
          if (aggregate.snapshot)
            aggregate.snapshot = projectCodexConversationSnapshot({
              conversation: aggregate.snapshot,
              before,
              after: state,
              observedAtMs: state.updatedAt,
            });
        } finally {
          aggregate.mutationOrigin = "local";
        }
      },
      threadId,
      generation: aggregate.generation,
      read: () => snapshot(aggregate),
      readCanonicalState: () => aggregate.document.canonicalState,
      readServerRequests: () => aggregate.document.requests,
      readHasUnreadTurn: () => aggregate.document.hasUnreadTurn,
      readSnapshot: () => aggregate.snapshot,

      readRetentionState,
      releasePassiveHistory: () => {
        const state = aggregate.document.canonicalState;
        if (!state || aggregate.streamRole !== null) return;
        mutateCanonicalState(releaseCanonicalConversationHistoryDraft, state.updatedAt);
        clearUnsubscribedBookkeeping();
      },
      completeHistoryUnsubscribe: (retainHistory) => {
        const state = aggregate.document.canonicalState;
        if (!state) return;
        const { primaryRequest, ephemeralSide } = readRetentionState();
        mutateCanonicalState(
          (draft) =>
            completeCanonicalConversationUnsubscribeDraft(draft, {
              retainHistory,
              ephemeral: ephemeralSide,
              primaryRequest,
            }),
          state.updatedAt,
        );
        clearUnsubscribedBookkeeping();
      },
      installSnapshot: (conversation) => {
        aggregate.snapshot = {
          ...conversation,
          conversationEntityGeneration: aggregate.generation,
          historyMutationRevision: aggregate.historyMutationRevision,
          queuedFollowUps: aggregate.queuedFollowUps,
        };
        if (conversation.source?.sideConversation !== undefined) {
          mutateCanonicalState((draft) => {
            draft.sideConversation = conversation.source!.sideConversation;
          }, conversation.updatedAt);
        }
      },
      seedHasUnreadTurn: (hasUnreadTurn) => {
        if (aggregate.document.canonicalState) return;
        aggregate.document = aggregate.document.withUnreadState(hasUnreadTurn);
        if (aggregate.snapshot) {
          aggregate.snapshot = { ...aggregate.snapshot, hasUnreadTurn };
        }
      },
      setHasUnreadTurn: (hasUnreadTurn) => {
        const previous = aggregate.document.hasUnreadTurn;
        if (previous === hasUnreadTurn) return false;
        aggregate.document = aggregate.document.withUnreadState(hasUnreadTurn);
        if (aggregate.snapshot) {
          aggregate.snapshot = {
            ...aggregate.snapshot,
            hasUnreadTurn,
            ...(hasUnreadTurn ? {} : { unreadMessageCount: 0 }),
          };
        }
        return true;
      },
      readResumeState: () => aggregate.resumeState,
      setResumeState: (state) => {
        const canonical = aggregate.document.canonicalState;
        if (
          aggregate.resumeState === state &&
          (!aggregate.snapshot || aggregate.snapshot.resumeState === state)
        )
          return;
        if (!canonical) aggregate.resumeStateBeforeHydration = state;
        if (canonical)
          aggregate.document = aggregate.document.withCanonicalState({
            ...canonical,
            resumeState: state,
          });
        if (aggregate.snapshot) aggregate.snapshot = { ...aggregate.snapshot, resumeState: state };
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
      readHistoryTopology: () => aggregate.historyTopology,

      initializeHistory: (pagination, loadedTurnCount, itemsPaginationByTurnId = {}) => {
        aggregate.historyGeneration += 1;
        aggregate.historyMutationRevision += 1;
        aggregate.historyPageLoadLeases.clear();
        aggregate.turnPagination = { ...pagination, loadedTurnCount };
        aggregate.historyTopology = rebuildHistoryTopology({
          generation: aggregate.historyGeneration,
          canonical: aggregate.document.canonicalState,
          pagination: aggregate.turnPagination,
          itemsPaginationByTurnId,
          authority: "history",
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
      },

      offerProtocolOccurrence: ({ occurrence, startsThread, deferThreadStart }) => {
        const bytes = protocolOccurrenceBytes(occurrence);
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
      clearBufferedEvents: () => {
        const buffered = [...(aggregate.threadStartEventBuffer ?? [])];
        aggregate.threadStartEventBuffer = null;
        aggregate.threadStartEventBufferBytes = 0;
        aggregate.threadStartEventBufferFence = null;
        aggregate.threadStartDeferred = false;
        return buffered;
      },
      commitFrameTextDeltas: ({ updates, observedAtMs }) => {
        if (updates.length === 0) return [];
        const mutation = aggregate.document.mutate((draft) =>
          mutateCodexConversationFrameTextDeltas(draft, updates, { now: () => observedAtMs }),
        );
        if (!mutation) return [];
        projectCanonicalState(mutation.after, observedAtMs, mutation.document);
        return mutation.result;
      },
      commitCommandOutputDeltas: ({ updates, observedAtMs }) => {
        if (updates.length === 0) return [];
        const mutation = aggregate.document.mutate((draft) =>
          updates.map((update) => mutateCodexConversationCommandOutput(draft, update).disposition),
        );
        if (!mutation) return [];
        projectCanonicalState(mutation.after, observedAtMs, mutation.document);
        return mutation.result;
      },
      commitTerminalCommands: ({ update, observedAtMs }) => {
        const mutation = aggregate.document.mutate((draft) =>
          mutateCodexConversationTerminalCommands(draft, update),
        );
        if (!mutation) return "noTurns";
        projectCanonicalState(mutation.after, observedAtMs, mutation.document);
        return mutation.result.disposition;
      },
      readServerRequestState: () => {
        const canonicalState = aggregate.document.canonicalState;
        return {
          canonicalState,
          rawState: canonicalState
            ? {
                threadId,
                turns: residentConversationTurns(canonicalState).map((turn) => ({
                  turnId: turn.turnId,
                  status: turn.status,
                  hasError: turn.error !== null,
                  items: turn.items,
                  hookRuns: turn.hookRuns,
                  turnStartedAtMs: turn.turnStartedAtMs,
                })),
                requests: canonicalState.requests,
                hasUnreadTurn: canonicalState.hasUnreadTurn,
              }
            : {
                threadId,
                turns: [],
                requests: aggregate.document.requests,
                hasUnreadTurn: aggregate.document.hasUnreadTurn,
              },
          streamRole: aggregate.streamRole,
        };
      },
      commitServerRequestLifecycle: (input) => {
        const previousHasUnreadTurn = aggregate.document.hasUnreadTurn;
        if (!input.lifecycle.stateChanged)
          return {
            stateChanged: false,
            unreadChanged: false,
            hasUnreadTurn: previousHasUnreadTurn,
          };
        const previousSnapshot = aggregate.snapshot;
        if (input.kind === "canonical") {
          aggregate.document = aggregate.document.withCanonicalState(input.lifecycle.state);
          if (previousSnapshot)
            aggregate.snapshot = projectCodexConversationServerRequestLifecycle({
              before: input.before,
              conversation: previousSnapshot,
              lifecycle: input.lifecycle,
              observedAtMs: input.observedAtMs,
            });
        } else {
          aggregate.document = aggregate.document.withRequests(input.lifecycle.state.requests);
          aggregate.document = aggregate.document.withUnreadState(
            input.lifecycle.state.hasUnreadTurn,
          );
          if (previousSnapshot)
            aggregate.snapshot = projectCodexConversationRawServerRequestLifecycle({
              conversation: previousSnapshot,
              lifecycle: input.lifecycle,
            });
        }
        const hasUnreadTurn = aggregate.document.hasUnreadTurn;
        return {
          stateChanged: true,
          unreadChanged: hasUnreadTurn !== previousHasUnreadTurn,
          hasUnreadTurn,
        };
      },
      commitProtocolNotification: ({ notification, observedAtMs, createId, reducerContext }) => {
        const before = aggregate.document.canonicalState;
        if (!before) return { effects: [], stateChanged: false };
        const mutation = aggregate.document.mutate((draft) =>
          mutateCodexConversationEvent(
            draft,
            { type: "notification", notification },
            { now: () => observedAtMs, createId, ...reducerContext },
          ),
        )!;
        return {
          effects: mutation.result,
          stateChanged: projectCanonicalState(mutation.after, observedAtMs, mutation.document),
        };
      },
      admitOptimisticTurn: ({
        execution,
        params,
        localMetadata,
        mcpAppModelContextAttachments,
        worktreeInit,
        startedAtMs,
      }) => {
        const before = aggregate.document.canonicalState;
        if (!before) return false;
        const changed = mutateCanonicalState((draft) => {
          mutateCodexCanonicalOptimisticTurn(draft, {
            execution,
            params,
            localMetadata,
            mcpAppModelContextAttachments,
            startedAtMs,
          });
          if (worktreeInit) mutateCodexCanonicalWorktreeInitItem(draft, worktreeInit);
        }, startedAtMs);
        if (changed) aggregate.isStreaming = true;
        return changed;
      },
      acceptOptimisticTurn: ({
        clientUserMessageId,
        turn,
        recovery,
        observedAtMs,
        permissions,
        execution,
        environmentSelectionEvidence,
      }) => {
        const before = aggregate.document.canonicalState;
        if (!before) return false;
        const hasBoundTurn = residentConversationTurns(before).some(
          (candidate) => candidate.turnId === turn.id,
        );
        const hasOptimisticTurn = residentConversationTurns(before).some(
          (candidate) => candidate.params.clientUserMessageId === clientUserMessageId,
        );
        const mutation = aggregate.document.mutate((draft) => {
          if (!hasBoundTurn && !hasOptimisticTurn && recovery)
            mutateCodexCanonicalOptimisticTurn(draft, {
              params: recovery.params,
              localMetadata: recovery.localMetadata,
              mcpAppModelContextAttachments: recovery.mcpAppModelContextAttachments,
              startedAtMs: recovery.startedAtMs,
            });
          mutateCodexCanonicalOptimisticTurnBinding(draft, clientUserMessageId, turn);
          const environmentSelection = acceptCodexPreparedEnvironmentSelection(
            draft,
            execution?.environments,
            environmentSelectionEvidence,
            (recovery?.startedAtMs ?? observedAtMs) / 1_000,
          );
          draft.environments = castDraft(environmentSelection.environments);
          draft.environmentSelectionEvidence = castDraft(
            environmentSelection.environmentSelectionEvidence,
          );
          if (execution?.pendingWorkspace) {
            draft.workspaceBrowserRoot = null;
            draft.cwd = execution.pendingWorkspace.cwd;
          }
          const acceptedPermissions = execution?.permissions ?? permissions;
          if (acceptedPermissions) draft.currentPermissions = castDraft(acceptedPermissions);
        });
        if (!mutation) return hasBoundTurn;
        if (
          !mutation ||
          !residentConversationTurns(mutation.after).some(
            (candidate) => candidate.turnId === turn.id,
          )
        )
          return false;
        projectCanonicalState(mutation.after, observedAtMs, mutation.document);
        return true;
      },
      rejectOptimisticTurn: ({ observedAtMs, ...rejection }) => {
        const before = aggregate.document.canonicalState;
        if (!before) return false;
        return mutateCanonicalState(
          (draft) => mutateCodexTurnStartRejection(draft, rejection),
          observedAtMs,
        );
      },
      resolveInterruptTurnId: (requestedTurnId) => {
        const turns = residentConversationTurns(aggregate.document.canonicalState);
        if (requestedTurnId && turns.some((turn) => turn.turnId === requestedTurnId)) {
          return requestedTurnId;
        }
        return (
          turns.findLast((turn) => turn.status === "inProgress" && turn.turnId !== null)?.turnId ??
          null
        );
      },
      interruptTurn: ({ turnId, observedAtMs }) => {
        const before = aggregate.document.canonicalState;
        if (!before) return false;
        const entry = residentConversationTurnEntries(before).find(
          ({ turn }) => turn.turnId === turnId,
        );
        if (!entry || entry.turn.status !== "inProgress") return false;
        const { turn } = entry;
        const interruptedCommandExecutionItemIds = [
          ...new Set([
            ...(turn.interruptedCommandExecutionItemIds ?? []),
            ...turn.items.flatMap((item) =>
              item.type === "commandExecution" && item.status === "inProgress" ? [item.id] : [],
            ),
          ]),
        ];
        return mutateCanonicalState((draft) => {
          const target = conversationTurnDraft(draft, entry.address);
          if (!target) return;
          target.status = "interrupted";
          target.interruptedCommandExecutionItemIds = interruptedCommandExecutionItemIds;
        }, observedAtMs);
      },
      backgroundTerminalTurnIds: () => {
        const conversation = aggregate.document.canonicalState;
        if (!conversation) return null;
        return listCodexBackgroundTerminalTurnIds(conversation);
      },
      cleanBackgroundTerminals: ({ observedAtMs }) => {
        const before = aggregate.document.canonicalState;
        if (!before) return false;
        return mutateCanonicalState(
          (draft) => mutateCodexBackgroundTerminalCleanup(draft),
          observedAtMs,
        );
      },
      applyTurnConfiguration: ({ settings, permissions }) => {
        const before = aggregate.document.canonicalState;
        const hydration = before?.hydrationContext;
        if (!before || !hydration) return false;
        const canonical = {
          ...before,
          modelProvider: settings.modelProvider ?? before.modelProvider,
          currentPermissions: permissions,
          latestModel: settings.model ?? before.latestModel,
          latestReasoningEffort: settings.reasoningEffort,
          latestCollaborationMode: settings.collaborationMode ?? before.latestCollaborationMode,
          latestThreadSettings: {
            cwd: before.cwd,
            approvalPolicy: permissions.approvalPolicy,
            approvalsReviewer: permissions.approvalsReviewer,
            sandboxPolicy: permissions.sandboxPolicy,
            activePermissionProfile: permissions.activePermissionProfile,
            model: settings.model ?? before.latestModel,
            modelProvider: settings.modelProvider ?? before.modelProvider,
            serviceTier: settings.serviceTier ?? null,
            effort: settings.reasoningEffort,
            summary: settings.summary ?? null,
            personality: settings.personality ?? null,
            collaborationMode: settings.collaborationMode ?? before.latestCollaborationMode,
            multiAgentMode: "explicitRequestOnly" as const,
          },
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
          },
        };
        aggregate.document = aggregate.document.withCanonicalState(canonical);
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
        return true;
      },
      refreshThreadMetadata: (metadataThreadId) => {
        const before = aggregate.document.canonicalState;
        if (!before) return false;
        return mutateCanonicalState((draft) => {
          mutateCodexConversationThreadMetadata(
            draft,
            metadataThreadId,
            (id) => threadsById.get(id) ?? null,
          );
        }, Date.now());
      },
      renameThread: ({ name, observedAtMs, generated }) => {
        const before = aggregate.document.canonicalState;
        if (!before) return false;
        return mutateCanonicalState((draft) => {
          mutateCodexConversationThreadName(draft, threadId, name, generated);
        }, observedAtMs);
      },
      acceptThreadGoal: ({ goal, appendTranscriptItem, dismissResumeConfirmation }) => {
        const before = aggregate.document.canonicalState;
        if (!before) return false;
        return mutateCanonicalState(
          (draft) => {
            // Command acceptance leaves completion bookkeeping to native notifications.
            draft.threadGoal = goal;
            if (dismissResumeConfirmation)
              mutateCodexConversationThreadGoalResumeConfirmationDismissed(draft, threadId);
            if (goal && appendTranscriptItem)
              mutateCodexCanonicalThreadGoalTranscriptTurn(draft, goal);
          },
          goal ? goal.updatedAt * 1000 : Date.now(),
        );
      },
      admitManualCompaction: ({ observedAtMs }) => {
        const before = aggregate.document.canonicalState;
        if (!before) return null;
        const mutation = aggregate.document.mutate((draft) =>
          mutateCodexCanonicalInProgressSyntheticItem(draft, pendingManualCompaction, observedAtMs),
        );
        if (!mutation) return null;
        const after = mutation.after;
        projectCanonicalState(after, observedAtMs, mutation.document);
        const turnIndex = residentConversationTurns(after).findLastIndex((turn) =>
          turn.items.some((item) => item.id === pendingManualCompaction.id),
        );
        return residentConversationTurns(after)[turnIndex]?.turnId ?? null;
      },
      rollbackManualCompaction: ({ observedAtMs }) => {
        const before = aggregate.document.canonicalState;
        if (!before) return false;
        return mutateCanonicalState(
          (draft) =>
            mutateCodexCanonicalLocalSyntheticItemRemoval(draft, pendingManualCompaction.id),
          observedAtMs,
        );
      },
      relocateExecution: ({
        cwd,
        managedWorktreePath,
        projectId,
        projectlessOutputDirectory,
        projectlessWorkspaceBrowserRoot,
        permissions,
      }) => {
        const before = aggregate.document.canonicalState;
        const hydration = before?.hydrationContext;
        if (!before || !hydration) return false;
        const canonical = {
          ...before,
          cwd,
          currentPermissions: permissions,
          workspaceKind: projectId === null ? ("projectless" as const) : ("project" as const),
          workspaceBrowserRoot: projectlessWorkspaceBrowserRoot,
          ...(before.latestThreadSettings
            ? {
                latestThreadSettings: { ...before.latestThreadSettings, cwd },
              }
            : {}),
          hydrationContext: {
            ...hydration,
            cwd,
            latestThreadSettings: {
              ...(hydration.latestThreadSettings ?? {}),
              cwd,
            },
          },
        };
        aggregate.document = aggregate.document.withCanonicalState(canonical);
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
        return true;
      },
      setThreadStatus: (statusType) => {
        const canonical = aggregate.document.canonicalState;
        const current = aggregate.snapshot;
        const canonicalChanged =
          canonical !== null && canonical.threadRuntimeStatus.type !== statusType;
        const snapshotChanged = current !== null && current.statusType !== statusType;
        if (canonicalChanged)
          aggregate.document = aggregate.document.withCanonicalState({
            ...canonical,
            threadRuntimeStatus: { type: statusType, activeFlags: [] },
          });
        if (current && (canonicalChanged || snapshotChanged))
          aggregate.snapshot = {
            ...current,
            statusType,
            statusActiveFlags: [],
            canonicalState: aggregate.document.canonicalState,
          };
        return canonicalChanged || snapshotChanged;
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
        const before = aggregate.document.canonicalState;
        const acceptedState = preserveResidentHistoryTurns(state, aggregate.historyTopology);
        aggregate.document = aggregate.document.withCanonicalState(acceptedState);

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
        return aggregate.document.canonicalState ?? acceptedState;
      },
      replaceServerRequests: (requests) => {
        aggregate.document = aggregate.document.withRequests([...requests]);
      },
      incrementVersion: () => {
        aggregate.version += 1;
        return aggregate.version;
      },
      reset: () => {
        resetAggregate(aggregate);
      },
    };
  };

  const acquire = (threadId: string): ConversationEntityState => {
    const existing = capabilities.get(threadId);
    if (existing) return existing;
    const capability = makeCapability(threadId, ensureState(threadId));
    capabilities.set(threadId, capability);
    return capability;
  };

  const retirementListeners = new Set<(threadId: string, generation: number) => void>();
  const releaseGeneration = (threadId: string, generation: number): void => {
    const aggregate = aggregates.get(threadId);
    if (aggregate?.generation !== generation) return;
    aggregates.delete(threadId);
    capabilities.delete(threadId);
    threadsById.delete(threadId);
    for (const listener of retirementListeners) listener(threadId, generation);
  };

  return {
    subscribeRetired: (listener) => {
      retirementListeners.add(listener);
      return {
        [Symbol.dispose]: () => {
          retirementListeners.delete(listener);
        },
      };
    },
    subscribeCanonicalMutations: (listener) => {
      mutationListeners.add(listener);
      return {
        [Symbol.dispose]: () => {
          mutationListeners.delete(listener);
        },
      };
    },
    forHost: (hostId) =>
      [...capabilities.values()].filter((entity) => entity.readCanonicalState()?.hostId === hostId),
    registerThreadMetadata: (thread) => {
      threadsById.set(thread.id, { ...thread, turns: [] });
      for (const capability of capabilities.values()) capability.refreshThreadMetadata(thread.id);
    },
    readThreadMetadata: (threadId) => threadsById.get(threadId) ?? null,
    removeThreadMetadata: (threadId) => {
      threadsById.delete(threadId);
    },
    current: (threadId) => capabilities.get(threadId) ?? null,
    acquire,
    releaseGeneration,
    releaseAll: () => {
      for (const [threadId, aggregate] of [...aggregates])
        releaseGeneration(threadId, aggregate.generation);
      threadsById.clear();
      retirementListeners.clear();
    },
    markAllNeedsResume: () => {
      const affectedThreadIds = [...capabilities.keys()];
      for (const conversation of capabilities.values()) {
        conversation.setResumeState("needs_resume");
        conversation.setStreamRole(null);
        conversation.setStreaming(false);
      }
      return affectedThreadIds;
    },
  };
}

import { randomUUID } from "node:crypto";
import type { ProjectWorkspaceIntent } from "../core-client/types";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type {
  CodexCollaborationModeKind,
  CodexPromptInput,
  CodexQueuedFollowUp,
  CodexQueuedFollowUpPause,
  CodexQueuedFollowUpFreshStartResolution,
  CodexQueuedFollowUpProjection,
  CodexQueueOwnerTranscriptDirective,
  CodexQueueOwnerUpdateResult,
  CodexServiceTier,
} from "../../shared/types";
import { createUuidV7 } from "../../shared/uuid-v7";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";
import {
  CODEX_INTERRUPTED_STEER_REASON,
  CODEX_QUEUE_OWNER_UPDATE_METHOD,
  CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION,
} from "../../shared/codex-queued-follow-up-state";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import type { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { RendererClientRuntime } from "../host-runtime/RendererClientRuntime";
import { MAIN_RELIABLE_COMMAND_CAPACITY } from "../runtime-limits";
import { CodexConversationProjection } from "./CodexConversationProjection";
import {
  CodexQueuedFollowUpPayloadStore,
  type CodexQueuedFollowUpDurableEntry,
} from "./CodexQueuedFollowUpPayloadStore";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import { CodexTurnCommands } from "./CodexTurnCommands";
import {
  clearCodexQueuedFollowUps,
  completeCodexQueuedFollowUp,
  enqueueCodexQueuedFollowUp,
  failCodexQueuedFollowUp,
  recoverEndedCodexQueuedFollowUps,
  recoverInterruptedCodexQueuedFollowUps,
  reorderCodexQueuedFollowUps,
  replaceCodexQueuedFollowUp,
  resumeInterruptedCodexQueuedFollowUps,
  type CodexQueuedFollowUpLedgerState,
} from "./internal/CodexQueuedFollowUpState";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

type CoreQueuedFollowUpEntry = Extract<
  ProjectWorkspaceIntent,
  { readonly kind: "commit_queued_follow_up_ledger" }
>["entries"][number];

type QueueOperation =
  | "read"
  | "enqueue"
  | "remove"
  | "replace"
  | "reorder"
  | "resume"
  | "resolve-after-fresh-start"
  | "terminal"
  | "send"
  | "project";

export class CodexQueuedFollowUpsError extends Schema.TaggedError<CodexQueuedFollowUpsError>()(
  "CodexQueuedFollowUpsError",
  {
    operation: Schema.Literals([
      "read",
      "enqueue",
      "remove",
      "replace",
      "reorder",
      "resume",
      "resolve-after-fresh-start",
      "terminal",
      "send",
      "project",
    ]),
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface CodexQueuedFollowUpEnqueueInput {
  readonly threadId: string;
  readonly prompt: string;
  readonly collaborationMode?: CodexCollaborationModeKind | null;
  readonly serviceTier?: CodexServiceTier;
  readonly pause?: CodexQueuedFollowUpPause | null;
  readonly promptInput?: CodexPromptInput;
  readonly summary?: CodexQueuedFollowUp["summary"];
}

export interface CodexQueuedFollowUpReadOptions {
  /**
   * Resume hydration targets the recovery replica until the renderer has
   * atomically adopted ownership. Ordinary reads may project through the
   * current renderer owner.
   */
  readonly projectionTarget?: "owner" | "replica";
}

export class CodexQueuedFollowUps extends Context.Service<
  CodexQueuedFollowUps,
  {
    readonly read: (
      threadId: string,
      options?: CodexQueuedFollowUpReadOptions,
    ) => Effect.Effect<CodexQueuedFollowUpProjection, CodexQueuedFollowUpsError>;
    readonly list: (threadId: string) => readonly CodexQueuedFollowUp[];
    readonly enqueue: (
      input: CodexQueuedFollowUpEnqueueInput,
    ) => Effect.Effect<string, CodexQueuedFollowUpsError>;
    readonly remove: (
      threadId: string,
      followUpId: string,
    ) => Effect.Effect<boolean, CodexQueuedFollowUpsError>;
    readonly replace: (
      threadId: string,
      followUpId: string,
      expectedLedgerRevision: number,
      input: Omit<CodexQueuedFollowUpEnqueueInput, "threadId">,
    ) => Effect.Effect<boolean, CodexQueuedFollowUpsError>;
    readonly reorder: (
      threadId: string,
      orderedFollowUpIds: readonly string[],
    ) => Effect.Effect<void, CodexQueuedFollowUpsError>;
    readonly resumeInterrupted: (
      threadId: string,
    ) => Effect.Effect<boolean, CodexQueuedFollowUpsError>;
    readonly resolveAfterFreshStart: (
      threadId: string,
      expectedLedgerRevision: number,
      resolution: CodexQueuedFollowUpFreshStartResolution,
    ) => Effect.Effect<boolean, CodexQueuedFollowUpsError>;
    readonly requestDispatch: (threadId: string) => Effect.Effect<void>;
    readonly sendNow: (
      threadId: string,
      followUpId: string,
    ) => Effect.Effect<void, CodexQueuedFollowUpsError>;
    /** Called only while the notification consequence already owns the Thread lane. */
    readonly acceptTerminalOutcomeInCurrentLane: (input: {
      readonly threadId: string;
      readonly rows: readonly CodexQueuedFollowUp[];
      readonly interrupted: boolean;
    }) => Effect.Effect<void, CodexQueuedFollowUpsError>;
    /** Cancels process-local delivery only; durable queue rows remain in Core. */
    readonly closeThread: (threadId: string) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexQueuedFollowUps") {}

const normalizeId = (value: string): string => value.trim();

const queueError = (
  operation: QueueOperation,
  threadId: string,
  cause: unknown,
): CodexQueuedFollowUpsError =>
  cause instanceof CodexQueuedFollowUpsError
    ? cause
    : new CodexQueuedFollowUpsError({ operation, threadId, cause });

const safeErrorMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim();
  return "Queued follow-up state could not be updated";
};

const sameEntries = (
  left: readonly CodexQueuedFollowUp[],
  right: readonly CodexQueuedFollowUp[],
): boolean =>
  left.length === right.length &&
  left.every((entry, index) => JSON.stringify(entry) === JSON.stringify(right[index]));

const toCoreEntry = (entry: CodexQueuedFollowUp): CoreQueuedFollowUpEntry => {
  if (!entry.payloadRef) {
    throw new Error(`Queued follow-up '${entry.followUpId}' has no durable payload`);
  }
  return {
    follow_up_id: entry.followUpId,
    client_user_message_id: entry.clientUserMessageId,
    created_at_ms: entry.createdAtMs,
    pause: entry.pause,
    payload: {
      schema_version: entry.payloadRef.schemaVersion,
      asset_uri: entry.payloadRef.assetUri,
      sha256: entry.payloadRef.sha256,
      byte_length: entry.payloadRef.byteLength,
    },
  };
};

const toDurableEntry = (
  threadId: string,
  entry: CoreQueuedFollowUpEntry,
): CodexQueuedFollowUpDurableEntry => {
  if (entry.payload.schema_version !== CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION) {
    throw new Error("Core returned an unsupported queued follow-up payload schema");
  }
  const pause = entry.pause
    ? entry.pause.kind === "interrupted"
      ? entry.pause.reason === CODEX_INTERRUPTED_STEER_REASON
        ? ({ kind: "interrupted", reason: CODEX_INTERRUPTED_STEER_REASON } as const)
        : (() => {
            throw new Error("Core returned a non-canonical interruption pause");
          })()
      : ({ kind: "failed", reason: entry.pause.reason } as const)
    : null;
  return {
    followUpId: entry.follow_up_id,
    clientUserMessageId: entry.client_user_message_id,
    threadId,
    createdAtMs: entry.created_at_ms,
    pause,
    payloadRef: {
      schemaVersion: CODEX_QUEUED_FOLLOW_UP_PAYLOAD_SCHEMA_VERSION,
      assetUri: entry.payload.asset_uri,
      sha256: entry.payload.sha256,
      byteLength: entry.payload.byte_length,
    },
  };
};

const projectionFromLedger = (
  previous: CodexQueuedFollowUpProjection,
  ledger: CodexQueuedFollowUpLedgerState,
  patch: Partial<
    Pick<
      CodexQueuedFollowUpProjection,
      "status" | "inFlightFollowUpId" | "editingFollowUpId" | "error"
    >
  > = {},
): CodexQueuedFollowUpProjection => ({
  status: patch.status ?? "ready",
  ledgerRevision: ledger.ledgerRevision,
  projectionRevision: previous.projectionRevision + 1,
  entries: [...ledger.entries],
  inFlightFollowUpId:
    patch.inFlightFollowUpId === undefined ? previous.inFlightFollowUpId : patch.inFlightFollowUpId,
  editingFollowUpId:
    patch.editingFollowUpId === undefined ? previous.editingFollowUpId : patch.editingFollowUpId,
  error: patch.error === undefined ? null : patch.error,
});

const effectRetryable = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "retryable" in cause &&
  (cause as Pick<CoreRuntimeError, "retryable">).retryable === true;

interface QueuedDelivery {
  readonly row: CodexQueuedFollowUp;
  readonly activeTurnId: string | null;
  readonly generation: number;
  readonly ownerClientId: string | null;
}

export const make: Effect.Effect<
  CodexQueuedFollowUps["Service"],
  never,
  | CodexConversationProjection
  | CodexQueuedFollowUpPayloadStore
  | CodexRendererConversationRegistry
  | CodexTurnCommands
  | ConversationEntityMap
  | CoreModules
  | RendererClientRuntime
  | Scope.Scope
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const core = yield* CoreModules;
  const payloads = yield* CodexQueuedFollowUpPayloadStore;
  const rendererConversations = yield* CodexRendererConversationRegistry;
  const rendererClients = yield* RendererClientRuntime;
  const turns = yield* CodexTurnCommands;
  const conversationProjection = yield* CodexConversationProjection;
  const dispatchIntents = yield* Queue.bounded<string>(MAIN_RELIABLE_COMMAND_CAPACITY);
  const dispatches = yield* FiberMap.make<string, void, CodexQueuedFollowUpsError>();
  const deferredDispatchThreadIds = new Set<string>();
  const hydratedGenerationByThread = new Map<string, number>();
  let closed = false;

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      deferredDispatchThreadIds.clear();
      hydratedGenerationByThread.clear();
    }).pipe(Effect.andThen(Queue.shutdown(dispatchIntents))),
  );

  const current = (threadId: string) => conversations.current(threadId);

  const installProjection = (
    threadId: string,
    projection: CodexQueuedFollowUpProjection,
    projectReplica: boolean,
  ): void => {
    const aggregate = current(threadId);
    if (!aggregate) throw new Error(`Conversation '${threadId}' is not loaded`);
    aggregate.installQueuedFollowUpProjection(projection, projectReplica);
  };

  const publishProjection = (
    threadId: string,
    projection: CodexQueuedFollowUpProjection,
    transcript: CodexQueueOwnerTranscriptDirective = { kind: "none" },
  ): Effect.Effect<void, CodexQueuedFollowUpsError> =>
    Effect.gen(function* () {
      const aggregate = current(threadId);
      if (!aggregate) return;
      const ownerClientId = rendererConversations.getOwnerClientId(threadId);
      const ownerEpoch = rendererConversations.getOwnerEpoch(threadId);
      if (!ownerClientId || ownerEpoch === null) {
        installProjection(threadId, projection, true);
        return;
      }

      installProjection(threadId, projection, false);
      const result = yield* rendererClients
        .request<CodexQueueOwnerUpdateResult>(ownerClientId, CODEX_QUEUE_OWNER_UPDATE_METHOD, {
          threadId,
          threadGeneration: aggregate.generation,
          ownerEpoch,
          projectionRevision: projection.projectionRevision,
          projection,
          transcript,
        })
        .pipe(Effect.retry({ times: 2 }));
      if (result.kind === "rejected") {
        return yield* queueError(
          "project",
          threadId,
          new Error(`Renderer owner rejected queue projection: ${result.reason}`),
        );
      }
      if (
        rendererConversations.getOwnerClientId(threadId) !== ownerClientId ||
        rendererConversations.getOwnerEpoch(threadId) !== ownerEpoch ||
        current(threadId)?.generation !== aggregate.generation
      ) {
        return yield* queueError(
          "project",
          threadId,
          new Error("Renderer owner changed while queue projection was being applied"),
        );
      }
    }).pipe(Effect.mapError((cause) => queueError("project", threadId, cause)));

  const readCoreLedger = (
    threadId: string,
  ): Effect.Effect<CodexQueuedFollowUpLedgerState, CodexQueuedFollowUpsError> =>
    Effect.gen(function* () {
      const snapshot = yield* core.workspace.read({
        kind: "queued_follow_up_ledger",
        thread_id: threadId,
      });
      if (snapshot.value.kind !== "queued_follow_up_ledger") {
        return yield* queueError(
          "read",
          threadId,
          new Error("Core returned the wrong queued follow-up read variant"),
        );
      }
      const entries = yield* Effect.forEach(snapshot.value.ledger.entries, (entry) =>
        payloads.hydrate(toDurableEntry(threadId, entry)),
      );
      return {
        ledgerRevision: snapshot.value.ledger.revision,
        entries,
      };
    }).pipe(Effect.mapError((cause) => queueError("read", threadId, cause)));

  const loadInCurrentLane = (
    threadId: string,
    force = false,
    projectionTarget: "owner" | "replica" = "owner",
  ): Effect.Effect<CodexQueuedFollowUpProjection, CodexQueuedFollowUpsError> =>
    Effect.gen(function* () {
      const aggregate = current(threadId);
      if (!aggregate) {
        return yield* queueError("read", threadId, new Error("Conversation is not loaded"));
      }
      const previous = aggregate.readQueuedFollowUpProjection();
      if (!force && hydratedGenerationByThread.get(threadId) === aggregate.generation) {
        return previous;
      }
      const loading: CodexQueuedFollowUpProjection = {
        ...previous,
        status: "loading",
        projectionRevision: previous.projectionRevision + 1,
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      };
      const projectReplica =
        projectionTarget === "replica" || !rendererConversations.hasOwner(threadId);
      installProjection(threadId, loading, projectReplica);
      const ledger = yield* readCoreLedger(threadId).pipe(
        Effect.catch((cause) => {
          const failed: CodexQueuedFollowUpProjection = {
            ...loading,
            status: "error",
            projectionRevision: loading.projectionRevision + 1,
            error: safeErrorMessage(cause),
          };
          installProjection(threadId, failed, projectReplica);
          if (projectionTarget === "replica") return Effect.fail(cause);
          return publishProjection(threadId, failed).pipe(
            Effect.catch(() => Effect.void),
            Effect.andThen(Effect.fail(cause)),
          );
        }),
      );
      const ready = projectionFromLedger(loading, ledger, {
        status: "ready",
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      });
      hydratedGenerationByThread.set(threadId, aggregate.generation);
      if (projectionTarget === "replica") {
        installProjection(threadId, ready, true);
      } else {
        yield* publishProjection(threadId, ready);
      }
      return ready;
    });

  const applyCoreCommit = (
    threadId: string,
    operation: QueueOperation,
    expectedRevision: number,
    entries: readonly CodexQueuedFollowUp[],
    operationId: string,
    remainingAttempts = 2,
  ): Effect.Effect<number, CodexQueuedFollowUpsError> =>
    core.workspace
      .apply({
        operationId,
        intent: {
          kind: "commit_queued_follow_up_ledger",
          thread_id: threadId,
          expected_revision: expectedRevision,
          entries: entries.map(toCoreEntry),
        },
      })
      .pipe(
        Effect.flatMap((result) => {
          const commit = result.outcome.queued_follow_up_ledger;
          return commit?.thread_id === threadId
            ? Effect.succeed(commit.revision)
            : Effect.fail(
                queueError(
                  operation,
                  threadId,
                  new Error("Core omitted the queued follow-up commit outcome"),
                ),
              );
        }),
        Effect.catch((cause) =>
          remainingAttempts > 0 && effectRetryable(cause)
            ? Effect.sleep("50 millis").pipe(
                Effect.andThen(
                  applyCoreCommit(
                    threadId,
                    operation,
                    expectedRevision,
                    entries,
                    operationId,
                    remainingAttempts - 1,
                  ),
                ),
              )
            : Effect.fail(queueError(operation, threadId, cause)),
        ),
      );

  const commitTransitionInCurrentLane = (
    threadId: string,
    operation: QueueOperation,
    transition: (state: CodexQueuedFollowUpLedgerState) => CodexQueuedFollowUpLedgerState,
    options: { readonly clearInFlight?: boolean; readonly operationId?: string } = {},
  ): Effect.Effect<
    { readonly changed: boolean; readonly projection: CodexQueuedFollowUpProjection },
    CodexQueuedFollowUpsError
  > =>
    Effect.gen(function* () {
      let previous = yield* loadInCurrentLane(threadId);
      let next = transition({
        ledgerRevision: previous.ledgerRevision,
        entries: previous.entries,
      });
      if (sameEntries(previous.entries, next.entries)) {
        if (!options.clearInFlight || previous.inFlightFollowUpId === null) {
          return { changed: false, projection: previous };
        }
        const settled = {
          ...previous,
          projectionRevision: previous.projectionRevision + 1,
          inFlightFollowUpId: null,
        };
        yield* publishProjection(threadId, settled);
        return { changed: false, projection: settled };
      }
      const operationId = options.operationId ?? createOperationId(`queued-follow-up.${operation}`);
      let revision: number;
      const attempted = yield* Effect.exit(
        applyCoreCommit(threadId, operation, previous.ledgerRevision, next.entries, operationId),
      );
      if (attempted._tag === "Success") {
        revision = attempted.value;
      } else {
        const reloaded = yield* readCoreLedger(threadId);
        if (sameEntries(reloaded.entries, next.entries)) {
          revision = reloaded.ledgerRevision;
          next = reloaded;
        } else if (reloaded.ledgerRevision !== previous.ledgerRevision) {
          previous = projectionFromLedger(previous, reloaded);
          installProjection(threadId, previous, !rendererConversations.hasOwner(threadId));
          next = transition(reloaded);
          if (sameEntries(reloaded.entries, next.entries)) {
            return { changed: false, projection: previous };
          }
          revision = yield* applyCoreCommit(
            threadId,
            operation,
            reloaded.ledgerRevision,
            next.entries,
            `${operationId}:rebase`,
          );
        } else {
          return yield* Effect.failCause(attempted.cause);
        }
      }
      const accepted = projectionFromLedger(
        previous,
        { ledgerRevision: revision, entries: next.entries },
        options.clearInFlight ? { inFlightFollowUpId: null } : {},
      );
      yield* publishProjection(threadId, accepted);
      return { changed: true, projection: accepted };
    }).pipe(Effect.mapError((cause) => queueError(operation, threadId, cause)));

  const runMutation = <A>(
    threadId: string,
    operation: QueueOperation,
    effect: Effect.Effect<A, CodexQueuedFollowUpsError>,
  ): Effect.Effect<A, CodexQueuedFollowUpsError> =>
    conversations
      .runCommand(threadId, effect)
      .pipe(Effect.mapError((cause) => queueError(operation, threadId, cause)));

  const requestDispatch = (threadId: string): Effect.Effect<void> => {
    const normalized = normalizeId(threadId);
    return !closed && normalized
      ? Queue.offer(dispatchIntents, normalized).pipe(Effect.asVoid)
      : Effect.void;
  };

  const beginDelivery = (
    threadId: string,
    requestedFollowUpId: string | undefined,
    allowActiveTurn: boolean,
  ): Effect.Effect<QueuedDelivery | null, CodexQueuedFollowUpsError> =>
    runMutation(
      threadId,
      "send",
      Effect.gen(function* () {
        const projection = yield* loadInCurrentLane(threadId);
        if (projection.status !== "ready" || projection.inFlightFollowUpId) return null;
        const state = yield* conversationProjection
          .read(threadId)
          .pipe(Effect.mapError((cause) => queueError("send", threadId, cause)));
        const activeTurnId =
          state.canonical.turns.findLast((turn) => turn.protocol.status === "inProgress")?.protocol
            .id ?? null;
        if (activeTurnId && !allowActiveTurn) return null;
        const row = requestedFollowUpId
          ? projection.entries.find((entry) => entry.followUpId === requestedFollowUpId)
          : projection.entries[0];
        if (!row || (!requestedFollowUpId && row.pause)) return null;
        const inFlight: CodexQueuedFollowUpProjection = {
          ...projection,
          projectionRevision: projection.projectionRevision + 1,
          inFlightFollowUpId: row.followUpId,
          error: null,
        };
        yield* publishProjection(threadId, inFlight);
        return {
          row,
          activeTurnId,
          generation: current(threadId)?.generation ?? -1,
          ownerClientId: rendererConversations.getOwnerClientId(threadId),
        };
      }),
    );

  const markDeliveryFailure = (
    threadId: string,
    followUpId: string,
    generation: number,
    cause: unknown,
  ) =>
    runMutation(
      threadId,
      "send",
      Effect.gen(function* () {
        if (current(threadId)?.generation !== generation) return;
        yield* commitTransitionInCurrentLane(
          threadId,
          "send",
          (state) => failCodexQueuedFollowUp(state, followUpId, safeErrorMessage(cause)),
          { clearInFlight: true },
        );
      }),
    );

  const clearInterruptedInFlight = (threadId: string, followUpId: string, generation: number) =>
    conversations.runCommand(
      threadId,
      Effect.gen(function* () {
        const aggregate = current(threadId);
        const projection = aggregate?.readQueuedFollowUpProjection();
        if (
          !aggregate ||
          aggregate.generation !== generation ||
          projection?.inFlightFollowUpId !== followUpId
        ) {
          return;
        }
        yield* publishProjection(threadId, {
          ...projection,
          projectionRevision: projection.projectionRevision + 1,
          inFlightFollowUpId: null,
        }).pipe(Effect.catch(() => Effect.void));
      }),
    );

  const settleDeliverySuccess = (threadId: string, followUpId: string, generation: number) =>
    runMutation(
      threadId,
      "send",
      Effect.gen(function* () {
        if (current(threadId)?.generation !== generation) return;
        const result = yield* Effect.exit(
          commitTransitionInCurrentLane(
            threadId,
            "send",
            (state) => completeCodexQueuedFollowUp(state, followUpId),
            {
              clearInFlight: true,
              operationId: createOperationId("queued-follow-up.settle"),
            },
          ),
        );
        if (result._tag === "Success") return;
        const projection = current(threadId)?.readQueuedFollowUpProjection();
        if (projection?.inFlightFollowUpId === followUpId) {
          yield* publishProjection(threadId, {
            ...projection,
            status: "error",
            projectionRevision: projection.projectionRevision + 1,
            error: "Message was accepted, but its queue receipt could not be saved",
          }).pipe(Effect.catch(() => Effect.void));
        }
        return yield* Effect.failCause(result.cause);
      }),
    );

  const submit = (delivery: QueuedDelivery) => {
    const overrides = {
      collaborationMode: delivery.row.collaborationMode ?? undefined,
      serviceTier: delivery.row.serviceTier,
      summary: delivery.row.summary,
      promptInput: delivery.row.promptInput,
      clientUserMessageId: delivery.row.clientUserMessageId,
    };
    if (delivery.activeTurnId) {
      return turns
        .steer({
          threadId: delivery.row.threadId,
          expectedTurnId: delivery.activeTurnId,
          prompt: delivery.row.prompt,
          promptInput: delivery.row.promptInput,
          collaborationMode: delivery.row.collaborationMode,
          serviceTier: delivery.row.serviceTier,
          summary: delivery.row.summary,
          intent: {
            steerId: `steer:${delivery.row.followUpId}`,
            recoveryRow: { ...delivery.row, pause: null },
          },
        })
        .pipe(Effect.asVoid);
    }
    if (delivery.ownerClientId) {
      return turns
        .startRendererOwned(delivery.row.threadId, delivery.row.prompt, overrides)
        .pipe(Effect.asVoid);
    }
    return turns.start(delivery.row.threadId, delivery.row.prompt, overrides).pipe(Effect.asVoid);
  };

  const dispatch = (
    threadId: string,
    followUpId: string | undefined,
    allowActiveTurn: boolean,
  ): Effect.Effect<void, CodexQueuedFollowUpsError> => {
    let interruptCleanup: QueuedDelivery | null = null;
    return Effect.gen(function* () {
      const delivery = yield* beginDelivery(threadId, followUpId, allowActiveTurn);
      if (!delivery) return;
      interruptCleanup = delivery;
      const transported = yield* Effect.exit(submit(delivery));
      if (transported._tag === "Failure") {
        yield* markDeliveryFailure(
          threadId,
          delivery.row.followUpId,
          delivery.generation,
          transported.cause,
        );
        return yield* queueError("send", threadId, transported.cause);
      }
      yield* settleDeliverySuccess(threadId, delivery.row.followUpId, delivery.generation);
      interruptCleanup = null;
    }).pipe(
      Effect.onInterrupt(() => {
        return interruptCleanup
          ? clearInterruptedInFlight(
              threadId,
              interruptCleanup.row.followUpId,
              interruptCleanup.generation,
            )
          : Effect.void;
      }),
      Effect.mapError((cause) => queueError("send", threadId, cause)),
    );
  };

  const forkDispatch = (threadId: string, effect: Effect.Effect<void, CodexQueuedFollowUpsError>) =>
    Effect.gen(function* () {
      const running = Option.getOrUndefined(FiberMap.getUnsafe(dispatches, threadId));
      if (running) {
        if (!deferredDispatchThreadIds.has(threadId)) {
          deferredDispatchThreadIds.add(threadId);
          yield* Effect.forkChild(
            Fiber.await(running).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  deferredDispatchThreadIds.delete(threadId);
                }),
              ),
              Effect.andThen(requestDispatch(threadId)),
            ),
          );
        }
        return running;
      }
      const fiber = yield* Effect.forkChild(effect, { startImmediately: false });
      FiberMap.setUnsafe(dispatches, threadId, fiber, { onlyIfMissing: true });
      return Option.getOrUndefined(FiberMap.getUnsafe(dispatches, threadId)) ?? fiber;
    });

  yield* Effect.forever(
    Queue.take(dispatchIntents).pipe(
      Effect.tap((threadId) =>
        forkDispatch(threadId, dispatch(threadId, undefined, false)).pipe(Effect.asVoid),
      ),
    ),
  ).pipe(Effect.forkScoped);

  const acceptTerminalOutcomeInCurrentLane = (input: {
    readonly threadId: string;
    readonly rows: readonly CodexQueuedFollowUp[];
    readonly interrupted: boolean;
  }) =>
    Effect.gen(function* () {
      const projection = yield* loadInCurrentLane(input.threadId);
      const existingById = new Map(
        projection.entries.map((entry) => [entry.followUpId, entry] as const),
      );
      const durableRows = yield* Effect.forEach(input.rows, (row) => {
        const existing = existingById.get(row.followUpId);
        if (existing) return Effect.succeed(existing);
        return payloads
          .freeze(row)
          .pipe(Effect.mapError((cause) => queueError("terminal", input.threadId, cause)));
      });
      yield* commitTransitionInCurrentLane(input.threadId, "terminal", (state) =>
        input.interrupted
          ? recoverInterruptedCodexQueuedFollowUps(state, durableRows)
          : recoverEndedCodexQueuedFollowUps(state, durableRows),
      );
    }).pipe(Effect.mapError((cause) => queueError("terminal", input.threadId, cause)));

  return CodexQueuedFollowUps.of({
    read: (threadId, options = {}) => {
      const normalized = normalizeId(threadId);
      return runMutation(
        normalized,
        "read",
        loadInCurrentLane(normalized, false, options.projectionTarget),
      );
    },
    list: (threadId) =>
      current(normalizeId(threadId))?.readQueuedFollowUpProjection().entries ?? [],
    enqueue: (input) => {
      const threadId = normalizeId(input.threadId);
      const prompt = input.prompt.trim();
      const promptInput = input.promptInput ?? { text: input.prompt };
      const hasStructuredInput = Object.entries(promptInput).some(([key, value]) => {
        if (key === "text") return typeof value === "string" && value.trim().length > 0;
        return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
      });
      if (!threadId || closed || (!prompt && !hasStructuredInput)) {
        return Effect.fail(
          queueError(
            "enqueue",
            threadId,
            new Error(closed ? "Queued follow-up state is closed" : "Queued follow-up is empty"),
          ),
        );
      }
      return runMutation(
        threadId,
        "enqueue",
        Effect.gen(function* () {
          const createdAtMs = yield* Clock.currentTimeMillis;
          const row = yield* payloads
            .freeze({
              followUpId: `follow-up:${createUuidV7()}`,
              clientUserMessageId: randomUUID(),
              threadId,
              prompt,
              promptInput,
              createdAtMs,
              collaborationMode: input.collaborationMode ?? null,
              serviceTier: normalizeCodexServiceTier(input.serviceTier),
              summary: input.summary ?? null,
              pause: input.pause ?? null,
              payloadRef: null,
            })
            .pipe(Effect.mapError((cause) => queueError("enqueue", threadId, cause)));
          yield* commitTransitionInCurrentLane(threadId, "enqueue", (state) =>
            enqueueCodexQueuedFollowUp(state, row),
          );
          yield* requestDispatch(threadId);
          return row.followUpId;
        }),
      );
    },
    remove: (threadId, followUpId) => {
      const normalizedThreadId = normalizeId(threadId);
      const normalizedFollowUpId = normalizeId(followUpId);
      return runMutation(
        normalizedThreadId,
        "remove",
        Effect.gen(function* () {
          const projection = yield* loadInCurrentLane(normalizedThreadId);
          if (projection.inFlightFollowUpId === normalizedFollowUpId) return false;
          const result = yield* commitTransitionInCurrentLane(
            normalizedThreadId,
            "remove",
            (state) => completeCodexQueuedFollowUp(state, normalizedFollowUpId),
          );
          return result.changed;
        }),
      );
    },
    replace: (threadId, followUpId, expectedLedgerRevision, input) => {
      const normalizedThreadId = normalizeId(threadId);
      const normalizedFollowUpId = normalizeId(followUpId);
      const prompt = input.prompt.trim();
      const promptInput = input.promptInput ?? { text: input.prompt };
      const hasStructuredInput = Object.entries(promptInput).some(([key, value]) => {
        if (key === "text") return typeof value === "string" && value.trim().length > 0;
        return Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
      });
      if (!normalizedThreadId || !normalizedFollowUpId || (!prompt && !hasStructuredInput)) {
        return Effect.fail(
          queueError("replace", normalizedThreadId, new Error("Queued follow-up edit is empty")),
        );
      }
      return runMutation(
        normalizedThreadId,
        "replace",
        Effect.gen(function* () {
          const projection = yield* loadInCurrentLane(normalizedThreadId);
          if (projection.ledgerRevision !== expectedLedgerRevision) return false;
          if (projection.inFlightFollowUpId === normalizedFollowUpId) return false;
          const previous = projection.entries.find(
            (entry) => entry.followUpId === normalizedFollowUpId,
          );
          if (!previous) return false;
          const replacement = yield* payloads
            .freeze({
              ...previous,
              prompt,
              promptInput,
              collaborationMode: input.collaborationMode ?? previous.collaborationMode,
              serviceTier:
                input.serviceTier === undefined
                  ? previous.serviceTier
                  : normalizeCodexServiceTier(input.serviceTier),
              summary: input.summary === undefined ? previous.summary : input.summary,
            })
            .pipe(Effect.mapError((cause) => queueError("replace", normalizedThreadId, cause)));
          const result = yield* commitTransitionInCurrentLane(
            normalizedThreadId,
            "replace",
            (state) => replaceCodexQueuedFollowUp(state, replacement),
          );
          return result.changed;
        }),
      );
    },
    reorder: (threadId, orderedFollowUpIds) => {
      const normalizedThreadId = normalizeId(threadId);
      return runMutation(
        normalizedThreadId,
        "reorder",
        Effect.gen(function* () {
          const projection = yield* loadInCurrentLane(normalizedThreadId);
          if (projection.inFlightFollowUpId) return;
          yield* commitTransitionInCurrentLane(normalizedThreadId, "reorder", (state) =>
            reorderCodexQueuedFollowUps(state, orderedFollowUpIds.map(normalizeId)),
          );
        }),
      );
    },
    resumeInterrupted: (threadId) => {
      const normalized = normalizeId(threadId);
      return runMutation(
        normalized,
        "resume",
        commitTransitionInCurrentLane(
          normalized,
          "resume",
          resumeInterruptedCodexQueuedFollowUps,
        ).pipe(
          Effect.tap((result) => (result.changed ? requestDispatch(normalized) : Effect.void)),
          Effect.map((result) => result.changed),
        ),
      );
    },
    resolveAfterFreshStart: (threadId, expectedLedgerRevision, resolution) => {
      const normalized = normalizeId(threadId);
      return runMutation(
        normalized,
        "resolve-after-fresh-start",
        Effect.gen(function* () {
          const currentProjection = yield* loadInCurrentLane(normalized);
          if (currentProjection.ledgerRevision !== expectedLedgerRevision) return false;
          const transition =
            resolution === "clear"
              ? clearCodexQueuedFollowUps
              : resumeInterruptedCodexQueuedFollowUps;
          const result = yield* commitTransitionInCurrentLane(
            normalized,
            "resolve-after-fresh-start",
            transition,
          );
          return result.changed;
        }),
      );
    },
    requestDispatch,
    sendNow: (threadId, followUpId) => {
      const normalizedThreadId = normalizeId(threadId);
      return Effect.gen(function* () {
        const running = Option.getOrUndefined(FiberMap.getUnsafe(dispatches, normalizedThreadId));
        if (running) yield* Fiber.join(running);
        const fiber = yield* forkDispatch(
          normalizedThreadId,
          dispatch(normalizedThreadId, normalizeId(followUpId), true),
        );
        yield* Fiber.join(fiber);
      });
    },
    acceptTerminalOutcomeInCurrentLane,
    closeThread: (threadId) =>
      FiberMap.remove(dispatches, normalizeId(threadId)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            hydratedGenerationByThread.delete(normalizeId(threadId));
          }),
        ),
      ),
  });
});

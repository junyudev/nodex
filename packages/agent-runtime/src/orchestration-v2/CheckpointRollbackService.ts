import {
  CheckpointId,
  type CommandId,
  CheckpointScopeId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  ProviderThreadId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  isCheckpointRestoreIsolated,
  isEditableUserRun,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export const ROLLBACK_FAILED_MESSAGE =
  "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs.";

export class CheckpointRollbackExecutionError extends Schema.TaggedError<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "unexpected-failure",
      "shared-workspace",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${this.checkpointId} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${this.checkpointId} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${this.checkpointId} is unavailable on provider thread ${this.providerThreadId}.`;
      case "shared-workspace":
        return SHARED_WORKSPACE_RESTORE_MESSAGE;
      case "unexpected-failure":
        return ROLLBACK_FAILED_MESSAGE;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
    readonly beforeRunId?: RunId;
  }) => Effect.Effect<void, CheckpointRollbackExecutionError>;
}

export class CheckpointRollbackServiceV2 extends Context.Service<
  CheckpointRollbackServiceV2,
  CheckpointRollbackServiceV2Shape
>()("t3/orchestration-v2/CheckpointRollbackService/CheckpointRollbackServiceV2") {}

export const layer: Layer.Layer<
  CheckpointRollbackServiceV2,
  never,
  | CheckpointServiceV2
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
  | Path.Path
  | ProjectStore.ProjectStoreV2
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const path = yield* Path.Path;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
      readonly beforeRunId?: RunId;
    }) {
      const projection = yield* projections.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerSessions",
        "checkpoints",
        "checkpointScopes",
        "runs",
        "attempts",
        "nodes",
        "providerTurns",
        "contextHandoffs",
      ]);
      // Superseded effects and a committed rewind whose outbox acknowledgement was lost
      // are complete. Replaying them must never discard newly submitted work.
      if (projection.thread.rollbackRequestId !== input.requestId) return;
      if (input.beforeRunId !== undefined) {
        if (
          !isEditableUserRun(projection.runs, input.beforeRunId) ||
          projection.providerThreads.some(
            (candidate) => (candidate.pendingBackgroundTasks?.length ?? 0) > 0,
          )
        ) {
          return yield* new CheckpointRollbackExecutionError({
            reason: "rollback-target-invalid",
            threadId: input.threadId,
            providerThreadId: input.providerThreadId,
            checkpointId: input.checkpointId,
          });
        }
      }
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === input.checkpointId,
      );
      const scope = projection.checkpointScopes.find((candidate) => candidate.id === input.scopeId);
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        checkpoint.scopeId !== scope.id ||
        (checkpoint.status !== "ready" &&
          !(input.restoreFiles === false && checkpoint.status === "missing"))
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      if (
        providerThread.id !== projection.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== projection.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      if (
        input.restoreFiles !== false &&
        !(yield* isCheckpointRestoreIsolated(projection.thread, scope, {
          fileSystem,
          projections,
          projects,
          path,
        }))
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "shared-workspace",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const modelSelection = projection.thread.modelSelection;
      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection,
      });
      const existingSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerThread.providerSessionId,
      );
      const session = yield* sessions.open({
        threadId: input.threadId,
        providerSessionId: providerThread.providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
        ...(providerThread.nativeThreadRef?.nativeId == null
          ? {}
          : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      });

      const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
      // Stopped and failed runs after the target leave the provider
      // conversation too, so they must not stay visible.
      const runsToRollback = projection.runs.filter(
        (run) =>
          run.ordinal > targetOrdinal &&
          (run.status === "completed" ||
            run.status === "interrupted" ||
            run.status === "failed" ||
            run.status === "cancelled"),
      );
      // Rolled-back turns stay in the audit history, but no longer exist in
      // the provider conversation and must not be counted by a later rewind.
      const rolledBackRunIds = new Set(
        projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
      );
      const rolledBackAttemptIds = new Set(
        projection.attempts
          .filter((attempt) => rolledBackRunIds.has(attempt.runId))
          .map((attempt) => attempt.id),
      );
      const providerThreadTurns = projection.providerTurns.filter(
        (turn) =>
          turn.providerThreadId === providerThread.id &&
          (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
      );
      // The logical boundary belongs to the Thread, not necessarily the active Agent.
      // Retain the active native conversation only through its own last surviving Turn.
      const retainedRun = projection.runs
        .filter((run) => run.ordinal <= targetOrdinal && run.status !== "rolled_back")
        .toSorted((left, right) => right.ordinal - left.ordinal)
        .find((run) =>
          providerThreadTurns.some((turn) => turn.runAttemptId === run.activeAttemptId),
        );
      const retainedTurn = latestProviderTurnForAttempt(
        providerThreadTurns,
        retainedRun?.activeAttemptId,
      );
      const rollbackTarget: ProviderAdapter.ProviderAdapterV2RollbackTarget =
        retainedTurn === undefined
          ? { type: "thread_start", checkpointId: checkpoint.id, appRunOrdinal: 0 }
          : {
              type: "provider_turn",
              checkpointId: checkpoint.id,
              appRunOrdinal: retainedRun!.ordinal,
              providerTurn: retainedTurn,
            };
      if (targetOrdinal > 0 && !projection.runs.some((run) => run.ordinal === targetOrdinal)) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "provider-turn-unavailable",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const removedRunIds = new Set(runsToRollback.map((run) => run.id));
      // Native context injection precedes a Turn and may survive native Turn rollback.
      // Likewise a failed start may have accepted context without publishing a Turn.
      // Neither has a proven native boundary: abandon that incarnation instead.
      const requiresFreshNative =
        runsToRollback.some(
          (run) =>
            run.providerThreadId === providerThread.id &&
            !providerThreadTurns.some((turn) => turn.runAttemptId === run.activeAttemptId),
        ) ||
        projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.status !== "inline" &&
            (removedRunIds.has(handoff.targetRunId) ||
              handoff.coveredRunOrdinals.to > targetOrdinal),
        );
      const snapshot = requiresFreshNative
        ? {
            providerThread: {
              ...providerThread,
              id: ids.derive.providerThread({
                driver: providerThread.driver,
                nativeThreadId: `pending:rewind:${input.requestId}`,
              }),
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              firstRunOrdinal: null,
              status: "not_loaded" as const,
            },
          }
        : runsToRollback.length === 0
          ? { providerThread }
          : yield* session.rollbackThread({
              providerThread,
              target: rollbackTarget,
              providerThreadTurns,
            });
      if (input.restoreFiles !== false) yield* checkpoints.restore({ scope, checkpoint });
      const staleCheckpoints = projection.checkpoints.filter(
        (candidate) =>
          candidate.scopeId === scope.id &&
          candidate.appRunOrdinal !== null &&
          candidate.appRunOrdinal > targetOrdinal &&
          candidate.status === "ready",
      );
      if (staleCheckpoints.length > 0) {
        yield* checkpoints.deleteStaleRefs({ scope, checkpoints: staleCheckpoints });
      }

      const now = yield* DateTime.now;
      const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
        Effect.map(
          ids.allocate.event({ threadId: event.threadId }),
          (id) =>
            ({
              ...event,
              id,
            }) as Event,
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      // Other native conversations may contain discarded Runs directly or via a handoff.
      // Retire them in the same transaction as the logical rewind, rather than attempting a
      // non-atomic rewind across several external providers. A later selection reconstructs
      // only retained history through the ordinary context-handoff path.
      const retiredThreads = projection.providerThreads.filter(
        (candidate) =>
          candidate.ownerNodeId === null &&
          candidate.status !== "closed" &&
          candidate.id !== snapshot.providerThread.id &&
          (candidate.id === providerThread.id ||
            (candidate.lastRunOrdinal ?? 0) > targetOrdinal ||
            projection.contextHandoffs.some(
              (handoff) =>
                handoff.toProviderThreadId === candidate.id &&
                handoff.coveredRunOrdinals.to > targetOrdinal,
            )),
      );
      for (const retired of retiredThreads) {
        events.push(
          yield* makeEvent({
            type: "provider-thread.updated",
            threadId: input.threadId,
            driver: retired.driver,
            providerInstanceId: retired.providerInstanceId,
            occurredAt: now,
            payload: { ...retired, status: "closed", updatedAt: now },
          }),
        );
      }
      events.push(
        yield* makeEvent({
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...snapshot.providerThread,
            lastRunOrdinal: requiresFreshNative ? null : (retainedRun?.ordinal ?? null),
            // Native rollback has already retained any earlier handoff. Never replay a
            // discarded handoff when an adapter gives the rewound conversation a new ID.
            handoffIds: [],
            contextUsage: null,
            updatedAt: now,
          },
        }),
      );
      for (const staleCheckpoint of staleCheckpoints) {
        events.push(
          yield* makeEvent({
            type: "checkpoint.captured",
            threadId: input.threadId,
            ...(staleCheckpoint.runId === null ? {} : { runId: staleCheckpoint.runId }),
            nodeId: staleCheckpoint.nodeId,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: { ...staleCheckpoint, status: "stale" },
          }),
        );
      }
      for (const handoff of projection.contextHandoffs) {
        if (!removedRunIds.has(handoff.targetRunId)) continue;
        const { delivery: _delivery, ...retainedAudit } = handoff;
        events.push(
          yield* makeEvent({
            type: "context-handoff.updated",
            threadId: input.threadId,
            runId: handoff.targetRunId,
            occurredAt: now,
            payload: { ...retainedAudit, status: "superseded", updatedAt: now },
          }),
        );
      }
      const historyRevision = (projection.thread.historyRevision ?? 0) + 1;
      for (const run of runsToRollback) {
        const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
        events.push(
          yield* makeEvent({
            type: "run.updated",
            threadId: input.threadId,
            runId: run.id,
            ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              ...run,
              status: "rolled_back",
              rolledBackAtRevision: historyRevision,
              completedAt: now,
            },
          }),
        );
        if (rootNode !== undefined) {
          events.push(
            yield* makeEvent({
              type: "node.updated",
              threadId: input.threadId,
              runId: run.id,
              nodeId: rootNode.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...rootNode, status: "rolled_back", completedAt: now },
            }),
          );
        }
      }
      const { rollbackRequestId: _requestId, ...thread } = projection.thread;
      events.push(
        yield* makeEvent({
          type: "thread.metadata-updated",
          threadId: input.threadId,
          occurredAt: now,
          payload: {
            ...thread,
            activeProviderThreadId: snapshot.providerThread.id,
            historyRevision,
            rollbackFailure: null,
            updatedAt: now,
          },
        }),
      );
      yield* eventSink.write({ events });
    });

    return CheckpointRollbackServiceV2.of({
      execute: (input) =>
        threadCommands.withLock(input.threadId, execute(input)).pipe(
          Effect.mapError((cause) =>
            isCheckpointRollbackExecutionError(cause)
              ? cause
              : new CheckpointRollbackExecutionError({
                  reason: "unexpected-failure",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                  cause,
                }),
          ),
        ),
    });
  }),
);

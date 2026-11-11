import {
  CommandId,
  EventId,
  ProviderRequestKind,
  type OrchestrationV2Run,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ProviderThreadId,
  type ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  NodeId,
  type ProjectId,
  ThreadId,
} from "@nodex/runtime-contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { replayAndBufferProjectedLiveEvents } from "./LiveStreamBudget.ts";
import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";

import { boundStoredTurnItem } from "./commandOutputStorage.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as RunAdmission from "./RunAdmission.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

/**
 * ERRORS
 */
export class EventSinkWriteError extends Schema.TaggedError<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedError<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

/**
 * SERVICE DEFINITION
 */
type ProviderThreadUpdate = Extract<
  OrchestrationV2DomainEvent,
  { type: "provider-thread.updated" }
>;

export interface EventSinkV2Shape {
  readonly writeProviderBackgroundTasks: (
    event: ProviderThreadUpdate,
  ) => Effect.Effect<boolean, EventSinkV2Error>;
  readonly write: (input: {
    /** Reject orphan cleanup if a native turn has been adopted by another attempt. */
    readonly expectedProviderTurn?: {
      readonly id: ProviderTurnId;
      readonly runAttemptId: RunAttemptId | null;
    };
    readonly guardProviderRequestUpdates?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    readonly updateDelegatedCompletionOnlyRunId?: RunId;
    /** Reject orphan cleanup if a native turn has been adopted by another attempt. */
    readonly expectedProviderTurn?: {
      readonly id: ProviderTurnId;
      readonly runAttemptId: RunAttemptId | null;
    };
    readonly guardProviderRequestUpdates?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeIfRunCurrent: (input: {
    readonly guardProviderRequestUpdates?: boolean;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects?: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /**
   * Atomically commit only when the provider thread is still owned by the
   * expected run attempt and ordinal. Used for late post-terminal
   * provider_thread updates so a completed or superseded attempt cannot clobber
   * a newer attempt that already claimed the thread.
   */
  readonly writeIfProviderThreadOwner: (input: {
    readonly guardProviderRequestUpdates?: boolean;
    readonly commandId?: CommandId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedLastRunOrdinal: number;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly updateDelegatedCompletionOnlyRunId?: RunId;
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptStore.CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.CommandReceiptV2, EventSinkV2Error>;
  /**
   * Append a project event, fold it into its row and record the receipt in one
   * transaction. A reused command id commits nothing and returns its receipt.
   */
  readonly commitProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly event: UnsequencedProjectEvent;
  }) => Effect.Effect<
    { readonly receipt: CommandReceiptStore.ProjectCommandReceiptV2; readonly committed: boolean },
    EventSinkV2Error
  >;
  /** Record a rejected project command, or return the receipt its command id already has. */
  readonly commitRejectedProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.ProjectCommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    /** Filter before queuing live events so a busy worker retains only the events it handles. */
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    /** Bound RPC subscribers; internal workers must not drop their subscription under load. */
    readonly bounded?: boolean;
    /**
     * A cursor promises continuity, so a stream fails rather than skip events pruned after it, and
     * the client reloads a snapshot. Set this only for a cursor read from the store just now.
     */
    readonly capturedCursor?: boolean;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "nodex/runtime/orchestration-v2/EventSink/EventSinkV2",
) {}

/**
 * IMPLEMENTATIONS
 */
const layerBase: Layer.Layer<
  EventSinkV2,
  never,
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectOutbox.EffectOutboxV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const liveEventsByType = new Map<
      OrchestrationV2DomainEvent["type"],
      PubSub.PubSub<OrchestrationV2StoredEvent>
    >();
    const publishLiveEvents = (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      Effect.gen(function* () {
        yield* PubSub.publishAll(liveEvents, events);
        for (const [type, pubsub] of liveEventsByType) {
          yield* PubSub.publishAll(
            pubsub,
            events.filter((stored) => stored.event.type === type),
          );
        }
      });
    const publishStoredEvents = (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      eventStore
        .publishCommitted(events)
        .pipe(
          Effect.andThen(publishLiveEvents(events)),
          Effect.andThen(
            events.some(
              ({ event }) => event.type === "run.updated" || event.type === "provider-turn.updated",
            )
              ? effectOutbox.notifyAvailable(16)
              : Effect.void,
          ),
        );

    // Transactions commit one at a time, but each writer publishes after its
    // commit. If a writer is descheduled in between, a later commit reaches
    // subscribers first, and clients drop any event at or below the newest
    // sequence they have applied. So a writer takes this lane as the last step
    // of its transaction and holds it until it has published. Publishing never
    // waits, so a writer that holds the transaction while it waits for the
    // lane is not blocked for long.
    const publishLane = yield* Semaphore.make(1);
    const commitThenPublish = <A, E, R>(
      transaction: Effect.Effect<A, E, R>,
      publish: (committed: A) => Effect.Effect<void>,
    ) =>
      Effect.suspend(() => {
        let holdsLane = false;
        const takeLane = publishLane.take(1).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdsLane = true;
            }),
          ),
          Effect.uninterruptible,
        );
        return sql
          .withTransaction(Effect.tap(transaction, () => takeLane))
          .pipe(
            Effect.tap(publish),
            Effect.ensuring(
              Effect.suspend(() => (holdsLane ? publishLane.release(1) : Effect.void)),
            ),
          );
      });

    // Native cleanup and late provider events cannot erase a person's recorded decision.
    const guardProviderRequests = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        const staleRequests = new Set<RuntimeRequestId>();
        const staleNodes = new Set<NodeId>();
        for (const event of events) {
          if (event.type !== "runtime-request.updated") continue;
          const current = yield* projectionStore.getRuntimeRequest(
            event.threadId,
            event.payload.id,
          );
          const resolvedApproval =
            current?.status === "resolved" && Schema.is(ProviderRequestKind)(current.kind);
          const reopened =
            current !== undefined &&
            current.status !== "pending" &&
            event.payload.status === "pending";
          const staleCancellation =
            event.payload.status === "cancelled" &&
            (current?.status !== "pending" ||
              current.kind !== event.payload.kind ||
              current.providerTurnId !== event.payload.providerTurnId ||
              current.responseCapability.type === "message");
          if (!resolvedApproval && !reopened && !staleCancellation) continue;
          staleRequests.add(event.payload.id);
          staleNodes.add(event.payload.nodeId);
        }
        const guarded: Array<OrchestrationV2DomainEvent> = [];
        for (const event of events) {
          if (event.type === "runtime-request.updated" && staleRequests.has(event.payload.id))
            continue;
          if (event.type === "node.updated" && staleNodes.has(event.payload.id)) continue;
          const requestId =
            event.type === "node.updated" && event.payload.kind === "approval_request"
              ? event.payload.runtimeRequestId
              : event.type === "turn-item.updated" && event.payload.type === "approval_request"
                ? event.payload.requestId
                : null;
          if (requestId !== null) {
            if (staleRequests.has(requestId)) continue;
            const current = yield* projectionStore.getRuntimeRequest(event.threadId, requestId);
            if (
              current?.status === "resolved" ||
              (current !== undefined &&
                current.status !== "pending" &&
                (event.type === "node.updated" || event.type === "turn-item.updated") &&
                (event.payload.status === "waiting" || event.payload.status === "pending"))
            )
              continue;
          }
          // Question cancellation shares the same transaction fence.
          if (
            event.type === "turn-item.updated" &&
            event.payload.type === "user_input_request" &&
            event.payload.status === "cancelled" &&
            staleRequests.has(event.payload.requestId)
          )
            continue;
          guarded.push(event);
        }
        return guarded;
      });

    const decodeProviderThread = Schema.decodeUnknownEffect(
      Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
    );
    // A run can publish metadata captured before a newer session observation.
    // Resolve an omitted roster inside the same transaction as the event append.
    const preserveBackgroundTasks = (
      event: ProviderThreadUpdate,
      prior: Map<ProviderThreadId, ProviderThreadUpdate["payload"]>,
    ) =>
      Effect.gen(function* () {
        const offered = event.payload;
        let current = prior.get(offered.id);
        if (
          current === undefined &&
          offered.pendingBackgroundTasks === undefined &&
          offered.providerSessionId !== null &&
          offered.status !== "closed"
        ) {
          const rows = yield* sql<{ payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${offered.id}
              AND provider_session_id = ${offered.providerSessionId}
              AND json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
          `;
          if (rows[0] !== undefined) current = yield* decodeProviderThread(rows[0].payload_json);
        }
        const payload =
          offered.pendingBackgroundTasks === undefined &&
          offered.status !== "closed" &&
          current?.pendingBackgroundTasks !== undefined &&
          current.providerSessionId === offered.providerSessionId &&
          current.nativeThreadRef?.nativeId === offered.nativeThreadRef?.nativeId
            ? { ...offered, pendingBackgroundTasks: current.pendingBackgroundTasks }
            : offered;
        prior.set(offered.id, payload);
        return { ...event, payload };
      });

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        for (const event of events) {
          if (
            event.type === "thread.metadata-updated" &&
            event.payload.lineage.rootThreadId === event.threadId &&
            event.payload.executionHandoff == null
          ) {
            const unreleased = yield* sql<{
              held: number;
            }>`SELECT 1 AS held FROM orchestration_v2_projection_threads root
              WHERE root.thread_id = ${event.threadId}
                AND json_extract(root.payload_json,'$.executionHandoff.operationId') IS NOT NULL
                AND (EXISTS(SELECT 1 FROM orchestration_v2_execution_retirement_targets WHERE root_thread_id = root.thread_id)
                  OR EXISTS(SELECT 1 FROM orchestration_v2_projection_threads actor
                    CROSS JOIN orchestration_v2_projection_provider_session_bindings binding ON binding.thread_id = actor.thread_id
                    WHERE json_extract(actor.payload_json,'$.lineage.rootThreadId') = root.thread_id)
                  OR EXISTS(SELECT 1 FROM orchestration_v2_projection_threads actor
                    CROSS JOIN orchestration_v2_effect_outbox pending ON pending.thread_id = actor.thread_id
                    WHERE json_extract(actor.payload_json,'$.lineage.rootThreadId') = root.thread_id
                      AND pending.effect_type = 'provider-session.detach' AND pending.status IN ('pending','running','failed','cancelled'))) LIMIT 1`;
            if (unreleased.length !== 0)
              return yield* Effect.fail(
                new Error("The execution workspace still has unretired sources"),
              );
          }
          if (event.type !== "run.execution-retired") continue;
          const proof = event.payload;
          const allowed = yield* sql<{ ok: number }>`SELECT 1 AS ok
            FROM orchestration_v2_projection_threads t
            JOIN orchestration_v2_projection_threads root ON root.thread_id = json_extract(t.payload_json,'$.lineage.rootThreadId')
            JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id AND r.run_id = ${proof.runId}
            LEFT JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = r.provider_thread_id
            WHERE t.thread_id = ${event.threadId}
              AND json_extract(root.payload_json,'$.executionHandoff.operationId') = ${proof.operationId}
              AND json_extract(r.payload_json,'$.activeAttemptId') IS ${proof.attemptId}
              AND json_extract(r.payload_json,'$.rootNodeId') IS ${proof.rootNodeId}
              AND r.provider_thread_id IS ${proof.providerThreadId}
              AND EXISTS(SELECT 1 FROM orchestration_v2_execution_retirement_targets target
                WHERE target.root_thread_id = root.thread_id AND target.thread_id = t.thread_id
                  AND target.run_id = r.run_id AND target.operation_id = ${proof.operationId})
              AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id = t.thread_id)
              AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads actor
                CROSS JOIN orchestration_v2_effect_outbox pending ON pending.thread_id = actor.thread_id
                WHERE json_extract(actor.payload_json,'$.lineage.rootThreadId') = root.thread_id
                  AND pending.effect_type = 'provider-session.detach' AND pending.status IN ('pending','running','failed','cancelled'))
              AND ((${proof.retirementEffectId} IS NULL AND (p.provider_session_id IS NULL OR json_extract(p.payload_json,'$.nativeThreadRef') IS NULL)) OR EXISTS(
                SELECT 1 FROM orchestration_v2_effect_outbox receipt WHERE receipt.effect_id = ${proof.retirementEffectId}
                  AND receipt.thread_id = t.thread_id AND receipt.effect_type = 'provider-session.detach' AND receipt.status = 'succeeded'
                  AND json_extract(receipt.payload_json,'$.revokeMcpCredential') = 1
                  AND (p.provider_session_id IS NULL OR json_extract(receipt.payload_json,'$.providerSessionId') = p.provider_session_id))) LIMIT 1`;
          if (allowed.length !== 1)
            return yield* Effect.fail(
              new Error("Execution retirement proof changed before commit"),
            );
        }
        // This check shares the SQL commit with the events. A child/queue planner can have
        // started before its root's hold committed under a different Thread lock.
        const starts = new Set(
          events.flatMap((event) => {
            if (
              event.type === "run.created" ||
              (event.type === "run.updated" && event.payload.status === "starting")
            )
              return [event.threadId];
            if (event.type === "thread.created" && event.payload.forkedFrom?.type === "run")
              return [event.payload.forkedFrom.threadId];
            return [];
          }),
        );
        for (const threadId of starts) {
          const held = yield* sql<{ held: number }>`SELECT 1 AS held
          FROM orchestration_v2_projection_threads t
          JOIN orchestration_v2_projection_threads root
            ON root.thread_id = json_extract(t.payload_json,'$.lineage.rootThreadId')
          WHERE t.thread_id = ${threadId}
            AND json_extract(root.payload_json,'$.executionHandoff.operationId') IS NOT NULL LIMIT 1`;
          if (held.length > 0)
            return yield* Effect.fail(
              new Error("The conversation is moving its execution workspace"),
            );
        }
        const runOrdinals = new Map(
          events.flatMap((event) =>
            event.type === "run.created" || event.type === "run.updated"
              ? [[event.payload.id, event.payload.ordinal] as const]
              : [],
          ),
        );
        const providerThreads = new Map<ProviderThreadId, ProviderThreadUpdate["payload"]>();
        return yield* Effect.forEach(
          events,
          (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> => {
            if (event.type === "provider-thread.updated")
              return preserveBackgroundTasks(event, providerThreads);
            return event.type === "turn-item.updated"
              ? turnItemPositions
                  .normalize(
                    boundStoredTurnItem(event.payload),
                    event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
                  )
                  .pipe(Effect.map((payload) => ({ ...event, payload })))
              : Effect.succeed(event);
          },
          { concurrency: 1 },
        );
      });

    const applyStoredEvents = (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      Effect.gen(function* () {
        yield* Effect.forEach(storedEvents, (stored) => projectionStore.apply(stored.event), {
          concurrency: 1,
        });
        // Activation classifies against current tree quiescence; most batches activate nothing.
        if (
          storedEvents.some(
            ({ event }) =>
              event.type === "run.created" ||
              (event.type === "message.updated" && event.payload.createdBy === "user"),
          )
        )
          yield* RunAdmission.reconcile().pipe(Effect.provideService(SqlClient.SqlClient, sql));
        for (const { event } of storedEvents) {
          if (
            event.type === "message.updated" &&
            event.payload.createdBy === "user" &&
            !storedEvents.some(
              ({ event: created }) =>
                created.type === "run.created" &&
                created.payload.userMessageId === event.payload.id,
            )
          )
            yield* RunAdmission.activate(event.threadId, "person").pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
          if (event.type === "run.created")
            yield* RunAdmission.enqueue(event.payload.id).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
        }
        if (
          storedEvents.some(
            ({ event }) =>
              event.type === "run.created" ||
              event.type === "run.updated" ||
              event.type === "provider-turn.updated",
          )
        )
          yield* RunAdmission.reconcile().pipe(Effect.provideService(SqlClient.SqlClient, sql));
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
      });

    // Native completion and checkpoint writes do not share the Thread command lock.
    const updateDelegatedCompletionOnly = Effect.fnUntraced(function* (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
      runId: RunId | undefined,
    ) {
      if (runId === undefined) return events;
      return yield* Effect.forEach(events, (event) =>
        Effect.gen(function* () {
          if (event.type !== "run.updated" || event.payload.id !== runId) return event;
          const { runs } = yield* projectionStore.getThreadRecords(event.threadId, ["runs"], {
            runIds: [runId],
          });
          const current = runs[0];
          return current === undefined
            ? event
            : {
                ...event,
                payload: { ...current, delegatedCompletion: event.payload.delegatedCompletion },
              };
        }),
      );
    });

    const writeProviderBackgroundTasks = (event: ProviderThreadUpdate) =>
      commitThenPublish(
        Effect.gen(function* () {
          const offered = event.payload;
          const rows = yield* sql<{ payload_json: string }>`
            SELECT thread.payload_json
            FROM orchestration_v2_projection_provider_threads thread
            JOIN orchestration_v2_projection_provider_sessions session
              ON session.provider_session_id = thread.provider_session_id
            WHERE thread.provider_thread_id = ${offered.id}
              AND thread.provider_session_id = ${offered.providerSessionId}
              AND thread.thread_id = ${event.threadId}
              AND thread.status <> 'closed'
              AND session.status IN ('starting', 'ready', 'running', 'waiting')
          `;
          if (rows[0] === undefined) return { bound: false, events: [] };
          const current = yield* decodeProviderThread(rows[0].payload_json);
          if (
            current.nativeThreadRef?.nativeId !== offered.nativeThreadRef?.nativeId ||
            current.providerInstanceId !== offered.providerInstanceId
          )
            return { bound: false, events: [] };
          const pendingBackgroundTasks = offered.pendingBackgroundTasks ?? [];
          if (
            JSON.stringify(current.pendingBackgroundTasks ?? []) ===
            JSON.stringify(pendingBackgroundTasks)
          )
            return { bound: true, events: [] };
          const committed = yield* eventStore.append({
            events: [
              {
                ...event,
                backgroundTasksOnly: true,
                payload: { ...current, pendingBackgroundTasks, updatedAt: event.occurredAt },
              },
            ],
          });
          yield* applyStoredEvents(committed);
          return { bound: true, events: committed };
        }),
        ({ events }) => publishStoredEvents(events),
      ).pipe(
        Effect.map(({ bound }) => bound),
        Effect.mapError((cause) => new EventSinkWriteError({ eventCount: 1, cause })),
      );

    const clearRetiredSessionRosters = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        const cleared: ProviderThreadUpdate[] = [];
        const seen = new Set<string>();
        for (const event of events) {
          if (
            event.type !== "provider-session.updated" ||
            (event.payload.status !== "stopped" && event.payload.status !== "error") ||
            seen.has(event.payload.id)
          )
            continue;
          seen.add(event.payload.id);
          const rows = yield* sql<{ payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE provider_session_id = ${event.payload.id}
              AND thread_id IS NOT NULL AND status <> 'closed'
              AND json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
          `;
          for (const row of rows) {
            const current = yield* decodeProviderThread(row.payload_json);
            if (current.appThreadId === null) continue;
            cleared.push({
              id: EventId.make(`${event.id}:background:${current.id}`),
              type: "provider-thread.updated",
              backgroundTasksOnly: true,
              threadId: current.appThreadId,
              driver: current.driver,
              providerInstanceId: current.providerInstanceId,
              occurredAt: event.occurredAt,
              payload: { ...current, pendingBackgroundTasks: [], updatedAt: event.occurredAt },
            });
          }
        }
        return cleared.length === 0 ? events : [...events, ...cleared];
      });

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      return yield* commitThenPublish(
        Effect.gen(function* () {
          if (input.expectedProviderTurn !== undefined) {
            const expected = input.expectedProviderTurn;
            const rows = yield* sql<{
              readonly run_attempt_id: RunAttemptId | null;
              readonly status: string;
            }>`
              SELECT run_attempt_id, status FROM orchestration_v2_projection_provider_turns
              WHERE provider_turn_id = ${expected.id}
            `;
            if (rows[0]?.status !== "running" || rows[0].run_attempt_id !== expected.runAttemptId)
              return [];
          }
          const events = yield* updateDelegatedCompletionOnly(
            input.events,
            input.updateDelegatedCompletionOnlyRunId,
          );
          const normalized = yield* normalizeEvents(
            input.guardProviderRequestUpdates === true
              ? yield* guardProviderRequests(events)
              : events,
          );
          const committed = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: yield* clearRetiredSessionRosters(normalized),
          });
          yield* applyStoredEvents(committed);
          yield* effectOutbox.enqueue(input.effects);
          return committed;
        }),
        (storedEvents) =>
          Effect.gen(function* () {
            if (input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            yield* publishStoredEvents(storedEvents);
          }),
      );
    });

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        return yield* commitThenPublish(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly status: string;
              readonly active_attempt_id: string | null;
            }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              current === undefined ||
              current.status !== input.expectedStatus ||
              current.active_attempt_id !== input.activeAttemptId
            ) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }

            const normalized = yield* normalizeEvents(
              input.guardProviderRequestUpdates === true
                ? yield* guardProviderRequests(input.events)
                : input.events,
            );
            const storedEvents = yield* eventStore.append({
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              events: normalized,
            });
            yield* applyStoredEvents(storedEvents);
            yield* effectOutbox.enqueue(input.effects ?? []);
            return { committed: true as const, storedEvents };
          }),
          (result) =>
            Effect.gen(function* () {
              if (!result.committed) return;
              if (input.effects !== undefined && input.effects.length > 0) {
                yield* effectOutbox.notifyAvailable(input.effects.length);
              }
              yield* publishStoredEvents(result.storedEvents);
            }),
        );
      },
    );

    const writeIfProviderThreadOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadOwner",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadOwner"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.providerThreadId,
        "orchestration_v2.run_id": input.runId,
        "orchestration_v2.active_attempt_id": input.activeAttemptId,
        "orchestration_v2.expected_last_run_ordinal": input.expectedLastRunOrdinal,
      });

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly active_attempt_id: string | null;
            readonly last_run_ordinal: number | null;
          }>`
            SELECT
              json_extract(r.payload_json, '$.activeAttemptId') AS active_attempt_id,
              p.last_run_ordinal
            FROM orchestration_v2_projection_provider_threads p
            JOIN orchestration_v2_projection_runs r
              ON r.run_id = ${input.runId}
             AND r.thread_id = p.thread_id
            WHERE p.provider_thread_id = ${input.providerThreadId}
            LIMIT 1
          `;
          const current = rows[0];
          if (
            current === undefined ||
            current.active_attempt_id !== input.activeAttemptId ||
            current.last_run_ordinal !== input.expectedLastRunOrdinal
          ) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(
            input.guardProviderRequestUpdates === true
              ? yield* guardProviderRequests(input.events)
              : input.events,
          );
          const storedEvents = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents };
        }),
        (result) => (result.committed ? publishStoredEvents(result.storedEvents) : Effect.void),
      );
    });

    const existingCommandResult = (commandId: CommandId) =>
      Effect.gen(function* () {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const result = yield* commitThenPublish(
        Effect.gen(function* () {
          const reserved = yield* commandReceipts.insertIfAbsent({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (!reserved) {
            const existing = yield* existingCommandResult(input.commandId);
            return { ...existing, committed: false as const, cancelledEffectIds: [] };
          }

          const normalized = yield* normalizeEvents(
            yield* updateDelegatedCompletionOnly(
              input.events,
              input.updateDelegatedCompletionOnlyRunId,
            ),
          );
          const storedEvents = yield* eventStore.append({
            commandId: input.commandId,
            events: normalized,
          });
          // No-op controls retain their command receipt so a late retry cannot affect new work.
          const sequence =
            storedEvents.at(-1)?.sequence ??
            (yield* eventStore.latestSequence({ threadId: input.threadId }));
          yield* applyStoredEvents(storedEvents);
          if (
            input.commandType === "queue.resume" ||
            input.commandType === "queued-message.promote-to-steer"
          )
            yield* RunAdmission.activate(input.threadId, "person").pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
          yield* effectOutbox.enqueue(input.effects);
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          };
          yield* commandReceipts.upsert(receipt);
          const cancelledEffectIds =
            input.cancelUnsettledEffects === undefined
              ? []
              : yield* effectOutbox.cancelUnsettled({
                  threadId: input.threadId,
                  ...input.cancelUnsettledEffects,
                });
          return { receipt, storedEvents, committed: true as const, cancelledEffectIds };
        }),
        (result) =>
          Effect.gen(function* () {
            yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
            if (result.committed && input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            if (result.committed) yield* publishStoredEvents(result.storedEvents);
          }),
      );
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: sequence,
            status: "rejected",
            error: input.error,
          };
          const inserted = yield* commandReceipts.insertIfAbsent(receipt);
          if (inserted) {
            return receipt;
          }
          const existing = yield* commandReceipts.getByCommandId(input.commandId);
          return Option.getOrElse(existing, () => receipt);
        }),
      );
    });

    const existingProjectReceipt = (commandId: CommandId) =>
      commandReceipts.getProjectByCommandId(commandId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(`Command ${commandId} was already used by a thread command.` as const),
            onSome: Effect.succeed,
          }),
        ),
      );

    const commitProjectCommandEffect = Effect.fn("orchestrationV2.EventSink.commitProjectCommand")(
      function* (input: Parameters<EventSinkV2Shape["commitProjectCommand"]>[0]) {
        const result = yield* commitThenPublish(
          Effect.gen(function* () {
            const reserved: CommandReceiptStore.ProjectCommandReceiptV2 = {
              commandId: input.commandId,
              projectId: input.projectId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: 0,
              status: "accepted",
              error: null,
            };
            if (!(yield* commandReceipts.insertIfAbsent(reserved))) {
              return { receipt: yield* existingProjectReceipt(input.commandId), event: undefined };
            }
            const event = yield* eventStore.appendProjectEvent(input.event);
            yield* projectStore.apply(event);
            const receipt = { ...reserved, resultSequence: event.sequence };
            yield* commandReceipts.upsert(receipt);
            return { receipt, event };
          }),
          (result) =>
            result.event === undefined ? Effect.void : eventStore.publishCommitted([result.event]),
        );
        return { receipt: result.receipt, committed: result.event !== undefined };
      },
    );

    const commitRejectedProjectCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedProjectCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedProjectCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipt: CommandReceiptStore.ProjectCommandReceiptV2 = {
            commandId: input.commandId,
            projectId: input.projectId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: yield* eventStore.latestApplicationSequence,
            status: "rejected",
            error: input.error,
          };
          return (yield* commandReceipts.insertIfAbsent(receipt))
            ? receipt
            : yield* existingProjectReceipt(input.commandId);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
      readonly eventType?: OrchestrationV2DomainEvent["type"];
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: Parameters<EventSinkV2Shape["stream"]>[0]) => {
      const afterSequence = input?.afterSequence ?? 0;
      const matches = (stored: OrchestrationV2StoredEvent) =>
        (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
        (input?.eventType === undefined || stored.event.type === input.eventType);
      // A cursor at its thread's newest event missed nothing, however old it is.
      const assertRetainedHistory = Effect.gen(function* () {
        if (afterSequence >= (yield* eventStore.prunedThroughSequence)) return;
        const head = yield* eventStore.latestSequence(
          input?.threadId === undefined ? undefined : { threadId: input.threadId },
        );
        if (afterSequence >= head) return;
        return yield* new EventSinkStreamError({
          afterSequence,
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          cause: "Events after this cursor were pruned; reload a snapshot.",
        });
      });
      const replayRetained = (throughSequence: number) =>
        catchUp({
          afterSequence,
          throughSequence,
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
        }).pipe(Stream.filter(matches));
      // Pruning publishes its boundary before deleting, so checking again after the read also
      // catches a pass that ran during it.
      const replay = (throughSequence: number) =>
        input?.afterSequence !== undefined && input.capturedCursor !== true
          ? Stream.fromEffectDrain(assertRetainedHistory).pipe(
              Stream.concat(replayRetained(throughSequence)),
              Stream.concat(Stream.fromEffectDrain(assertRetainedHistory)),
            )
          : replayRetained(throughSequence);
      return Stream.unwrap(
        Effect.gen(function* () {
          let pubsub = liveEvents;
          if (input?.eventType !== undefined) {
            const existing = liveEventsByType.get(input.eventType);
            if (existing !== undefined) {
              pubsub = existing;
            } else {
              const created = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
              pubsub = liveEventsByType.get(input.eventType) ?? created;
              liveEventsByType.set(input.eventType, pubsub);
            }
          }
          if (input?.bounded === true) {
            return replayAndBufferProjectedLiveEvents({
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: eventStore.latestSequence(),
              afterSequence,
              filter: matches,
              replay,
              project: (stored) => ({ ...stored, event: projectDomainEventForWire(stored.event) }),
            });
          }
          const subscription = yield* PubSub.subscribe(pubsub);
          const highWater = yield* eventStore.latestSequence();
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(matches),
          );
          return Stream.concat(replay(highWater), live);
        }),
      );
    };

    return EventSinkV2.of({
      writeProviderBackgroundTasks,
      write: (input) =>
        writeEffect({ ...input, effects: [] }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeWithEffects: (input) =>
        writeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadOwner: (input) =>
        writeIfProviderThreadOwnerEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      commitProjectCommand: (input) =>
        commitProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 1, cause }),
          ),
        ),
      commitRejectedProjectCommand: (input) =>
        commitRejectedProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 0, cause }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);

/**
 * Event sink layer for application compositions that already own the
 * persistence services. Keeping the outbox instance shared with the worker is
 * important because enqueue notifications are in-memory wakeups backed by the
 * durable SQL queue.
 */
export const layerFromStores = layerBase;

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = layerBase.pipe(
  Layer.provide(
    Layer.mergeAll(
      CommandReceiptStore.layer,
      EffectOutbox.layer,
      ProjectStore.layer,
      TurnItemPositionStore.layer,
    ),
  ),
);

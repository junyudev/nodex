import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provideMerge(database)),
  ProjectionStore.layer.pipe(Layer.provideMerge(database)),
);
const layerTest = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
);

const providerInstanceId = ProviderInstanceId.make("codex");

const makeThread = (threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread => ({
  id: threadId,
  projectId: ProjectId.make(`project:${threadId}`),
  title: "Pruned history",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const threadCreated = (thread: OrchestrationV2AppThread, now: DateTime.Utc) =>
  ({
    id: EventId.make(`event:${thread.id}:created`),
    type: "thread.created",
    threadId: thread.id,
    providerInstanceId,
    occurredAt: now,
    payload: thread,
  }) satisfies OrchestrationV2DomainEvent;

const commandItem = (
  threadId: ThreadId,
  now: DateTime.Utc,
  revision: number,
  output: string = `output ${revision}`,
): OrchestrationV2DomainEvent => {
  const payload: OrchestrationV2TurnItem = {
    id: TurnItemId.make(`turn-item:${threadId}:command`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 10,
    status: "completed",
    title: "command",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input: "run",
    output,
  };
  return {
    id: EventId.make(`event:${threadId}:command:${revision}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload,
  };
};

const remainingEventIds = (threadId: ThreadId) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly event_id: string }>`
      SELECT event_id FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence
    `,
  ).pipe(Effect.map((rows) => rows.map((row) => row.event_id)));

const prunedThrough = Effect.flatMap(
  EventStore.EventStoreV2,
  (store) => store.prunedThroughSequence,
);

it.effect("prunes covered events once the retained day has passed", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    for (const revision of [0, 1, 2])
      yield* sink.write({ events: [commandItem(threadId, now, revision)] });

    // The first pass only marks the head; nothing is a day old yet.
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
    const markedThrough = yield* eventStore.latestSequence();
    assert.equal(yield* prunedThrough, 0);

    yield* sink.write({ events: [commandItem(threadId, now, 3)] });
    const highWater = yield* eventStore.latestSequence();
    const projection = yield* projections.getThreadProjection(threadId);

    yield* TestClock.adjust("23 hours");
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 0);
    yield* TestClock.adjust("1 hour");
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 3);

    assert.deepEqual(yield* remainingEventIds(threadId), [
      "event:thread:prune:created",
      "event:thread:prune:command:3",
    ]);
    assert.equal(yield* prunedThrough, markedThrough);
    assert.equal(yield* eventStore.latestSequence(), highWater);
    assert.equal(yield* eventStore.latestSequence({ threadId }), highWater);
    assert.deepEqual(yield* projections.getThreadProjection(threadId), projection);

    // The next stream version still follows the retained head.
    yield* sink.write({ events: [commandItem(threadId, now, 4)] });
    assert.isAbove(yield* eventStore.latestSequence(), highWater);
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect("keeps a stream's newest event even when it is below the boundary", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune-idle");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    yield* sink.write({ events: [commandItem(threadId, now, 0)] });
    const head = yield* eventStore.latestSequence({ threadId });
    yield* maintenance.pruneEventStore();
    yield* TestClock.adjust("1 day");
    yield* maintenance.pruneEventStore();
    assert.equal(yield* eventStore.latestSequence({ threadId }), head);
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect("keeps every event a command committed, so a late retry replays it exactly", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune-command");
    const commandId = CommandId.make("command:prune-retry");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    yield* sink.write({ commandId, events: [commandItem(threadId, now, 0)] });
    const committed = yield* sink.readByCommandId({ commandId }).pipe(Stream.runCollect);
    yield* sink.write({ events: [commandItem(threadId, now, 1)] });
    yield* sink.write({ events: [commandItem(threadId, now, 2)] });

    yield* maintenance.pruneEventStore();
    yield* TestClock.adjust("1 day");
    assert.equal((yield* maintenance.pruneEventStore()).deletedEventCount, 1);

    assert.deepEqual(
      Array.from(yield* sink.readByCommandId({ commandId }).pipe(Stream.runCollect)),
      Array.from(committed),
    );
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect("keeps events that readers other than replay still depend on", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune-dependents");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    const raw = (eventId: string, eventType: string, payload: string) => sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${eventId}, 'thread', ${threadId},
        (SELECT MAX(stream_version) + 1 FROM orchestration_events WHERE stream_id = ${threadId}),
        ${eventType}, '2026-11-01T00:00:00.000Z', 'server', ${payload}, '{}', 2
      )`;
    yield* raw("event:ownerless", "provider-thread.updated", '{"id":"p1","appThreadId":null}');
    yield* raw("event:owned", "provider-thread.updated", '{"id":"p2","appThreadId":"t"}');
    yield* raw("migration:v1:message:a", "message.updated", '{"id":"a"}');
    yield* sql`INSERT INTO orchestration_v2_legacy_imports ${sql.insert({
      thread_id: threadId,
      source_updated_at: "2026-11-01T00:00:00.000Z",
      shell_imported_at: "2026-11-01T00:00:00.000Z",
      transcript_imported_at: null,
    })}`;
    yield* sink.write({ events: [commandItem(threadId, now, 0)] });

    yield* maintenance.pruneEventStore();
    yield* TestClock.adjust("1 day");
    yield* maintenance.pruneEventStore();
    assert.deepEqual(yield* remainingEventIds(threadId), [
      "event:thread:prune-dependents:created",
      // Importing an execution store finds this provider thread's owner through its event.
      "event:ownerless",
      // An unfinished transcript import decides which messages are left from these.
      "migration:v1:message:a",
      "event:thread:prune-dependents:command:0",
    ]);

    yield* sql`UPDATE orchestration_v2_legacy_imports
      SET transcript_imported_at = '2026-11-01T00:00:00.000Z' WHERE thread_id = ${threadId}`;
    yield* TestClock.adjust("1 day");
    yield* maintenance.pruneEventStore();
    assert.notInclude(yield* remainingEventIds(threadId), "migration:v1:message:a");
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect("resumes a pass that a stopped process left unfinished", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune-resume");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    // More than one page, so the interruption lands between deletes.
    for (let revision = 0; revision < 120; revision += 1)
      yield* sink.write({ events: [commandItem(threadId, now, revision)] });
    yield* maintenance.pruneEventStore();
    yield* TestClock.adjust("1 day");

    const interrupted = yield* Effect.exit(maintenance.pruneEventStore(Effect.interrupt));
    assert.isTrue(Exit.isFailure(interrupted));
    const partial = yield* remainingEventIds(threadId);
    assert.isAbove(partial.length, 2);

    yield* maintenance.pruneEventStore();
    assert.deepEqual(yield* remainingEventIds(threadId), [
      "event:thread:prune-resume:created",
      "event:thread:prune-resume:command:119",
    ]);
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect("makes a client whose cursor predates pruning reload instead of skipping events", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:prune-cursor");
    const idleThreadId = ThreadId.make("thread:prune-idle-cursor");
    yield* sink.write({ events: [threadCreated(makeThread(idleThreadId, now), now)] });
    const idleCursor = yield* eventStore.latestSequence({ threadId: idleThreadId });
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    yield* sink.write({ events: [commandItem(threadId, now, 0)] });
    const staleCursor = yield* eventStore.latestSequence();
    yield* sink.write({ events: [commandItem(threadId, now, 1)] });
    yield* maintenance.pruneEventStore();
    yield* sink.write({ events: [commandItem(threadId, now, 2)] });
    const liveCursor = yield* eventStore.latestSequence();
    yield* TestClock.adjust("1 day");
    yield* maintenance.pruneEventStore();

    // Replay finishes and the stream stays open on live events, or it fails on the gap.
    const replay = (afterSequence: number, id: ThreadId = threadId) =>
      Effect.gen(function* () {
        const fiber = yield* sink
          .stream({ threadId: id, afterSequence })
          .pipe(Stream.runDrain, Effect.timeoutOption("1 second"), Effect.forkChild);
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber).pipe(Effect.exit);
      });
    assert.isTrue(Exit.isFailure(yield* replay(staleCursor)));

    // A cursor at the boundary or later, or at an idle thread's own newest event, missed nothing.
    assert.deepEqual(yield* replay(liveCursor), Exit.succeed(Option.none()));
    assert.deepEqual(yield* replay(idleCursor, idleThreadId), Exit.succeed(Option.none()));

    // A reader that captured its cursor moments ago is not checked: another thread's cursor
    // can sit below the boundary without having missed anything.
    const captured = yield* sink
      .stream({ threadId, afterSequence: staleCursor, capturedCursor: true })
      .pipe(Stream.take(1), Stream.runCollect);
    assert.lengthOf(Array.from(captured), 1);
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

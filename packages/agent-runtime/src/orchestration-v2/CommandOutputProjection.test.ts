import { assert, it } from "@effect/vitest";
import {
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
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provideMerge(database)),
  ProjectionStore.layer.pipe(Layer.provideMerge(database)),
);
const layerTest = Layer.mergeAll(stores, EventSink.layer.pipe(Layer.provide(stores)));

const providerInstanceId = ProviderInstanceId.make("codex");

const makeThread = (threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread => ({
  id: threadId,
  projectId: ProjectId.make(`project:${threadId}`),
  title: "Command output",
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

it.effect("stores command output compressed and reads it back whole", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:output");
    const output = `日本語 "quoted"\ttab\u0000nul\u001b[31m 😀 ${"line\n".repeat(2_000)}`;
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    yield* sink.write({ events: [commandItem(threadId, now, 0, output)] });

    const rows = yield* sql<{
      readonly embedded: string | null;
      readonly compressed: number;
      readonly output_bytes: number;
      readonly decompressed: string;
    }>`
      SELECT json_extract(payload_json, '$.output') AS embedded,
        length(output_zstd) AS compressed, output_bytes,
        zstd_text(output_zstd) AS decompressed
      FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`;
    assert.isNull(rows[0]?.embedded);
    assert.equal(rows[0]?.output_bytes, Buffer.byteLength(output));
    assert.isBelow(rows[0]?.compressed ?? Infinity, Buffer.byteLength(output) / 4);
    assert.equal(rows[0]?.decompressed, output);

    const projection = yield* projections.getThreadProjection(threadId);
    const item = projection.turnItems[0];
    assert.equal(item?.type === "command_execution" ? item.output : null, output);
    const point = yield* projections.getTurnItem({
      threadId,
      itemId: TurnItemId.make(`turn-item:${threadId}:command`),
    });
    assert.equal(point?.type === "command_execution" ? point.output : null, output);
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect("keeps stored output when a later snapshot of the item omits it", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:output-kept");
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    yield* sink.write({ events: [commandItem(threadId, now, 0, "kept output")] });
    const later = commandItem(threadId, now, 1);
    if (later.type !== "turn-item.updated" || later.payload.type !== "command_execution")
      return assert.fail("expected a command item");
    const { output: _output, ...withoutOutput } = later.payload;
    yield* sink.write({ events: [{ ...later, payload: withoutOutput }] });

    const item = yield* projections.getTurnItem({
      threadId,
      itemId: TurnItemId.make(`turn-item:${threadId}:command`),
    });
    assert.equal(item?.type === "command_execution" ? item.output : null, "kept output");
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

it.effect("bounds an oversized output in both the event and the projection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:output-bound");
    const output = `start ${"x".repeat(1024 * 1024)} final`;
    yield* sink.write({ events: [threadCreated(makeThread(threadId, now), now)] });
    const [stored] = yield* sink.write({ events: [commandItem(threadId, now, 0, output)] });
    const event = stored?.event;
    const eventOutput =
      event?.type === "turn-item.updated" && event.payload.type === "command_execution"
        ? (event.payload.output ?? "")
        : "";
    assert.isAtMost(Buffer.byteLength(eventOutput), 256 * 1024);
    assert.isTrue(eventOutput.endsWith(" final"));

    const rows = yield* sql<{ readonly output_bytes: number; readonly decompressed: string }>`
      SELECT output_bytes, zstd_text(output_zstd) AS decompressed
      FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`;
    assert.equal(rows[0]?.decompressed, eventOutput);
    assert.equal(rows[0]?.output_bytes, Buffer.byteLength(eventOutput));
  }).pipe(Effect.provide(Layer.fresh(layerTest))),
);

import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { make, type RuntimeMessageAdmission } from "./RuntimeMessageReceipts.ts";

const input: RuntimeMessageAdmission = {
  messageId: MessageId.make("message"),
  threadId: ThreadId.make("thread"),
  commandId: CommandId.make("command"),
  fingerprint: "a".repeat(64),
  mode: "auto",
};
// These fixtures exercise the persisted command/receipt contract, including delayed queued items.
const accepted = Effect.fnUntraced(function* (intent: "turn_start" | "steer" | null) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_command_receipts
    (command_id,aggregate_kind,aggregate_id,command_type,accepted_at,result_sequence,status,error)
    VALUES('command','thread','thread','message.dispatch','2026-10-27T00:00:00Z',1,'accepted',NULL)`;
  const events = [
    { type: "message.updated", payload: { id: "message", runId: "run", text: "x".repeat(100000) } },
    ...(intent
      ? [
          {
            type: "turn-item.updated",
            payload: { type: "user_message", messageId: "message", inputIntent: intent },
          },
        ]
      : []),
  ];
  for (const [index, event] of events.entries())
    yield* sql`INSERT INTO orchestration_events
      (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,actor_kind,payload_json,metadata_json,application_event_version)
      VALUES(${`event-${index}`},'thread','thread',${index},${event.type},'2026-10-27T00:00:00Z','command','agent',${JSON.stringify(event.payload)},'{}',2)`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json)
    VALUES('run','thread',1,'codex','codex','running','2026-10-27T00:00:00Z','{"delegatedTaskId":"task"}')`;
});

it.effect(
  "replays canonical delivery after mutable configuration and message state have changed",
  () =>
    Effect.gen(function* () {
      const owner = yield* make;
      assert.isNull(yield* owner.replay(input));
      yield* owner.admit(input);
      assert.isNull(yield* owner.replay(input), "Admission alone never claims delivery");
      yield* accepted("turn_start");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed' WHERE run_id='run'`;
      const replay = yield* (yield* make).replay(input);
      assert.deepEqual(replay, {
        messageId: input.messageId,
        runId: "run",
        status: "completed",
        delivery: "started",
        taskId: "task",
      });
      assert.deepEqual((yield* sql`SELECT COUNT(*) AS count FROM orchestration_events`)[0], {
        count: 2,
      });
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("binds one immutable request through concurrent admission and owner recreation", () =>
  Effect.gen(function* () {
    const owner = yield* make;
    yield* Effect.all([owner.admit(input), owner.admit(input)], { concurrency: 2 });
    const recreated = yield* make;
    for (const changed of [
      { ...input, fingerprint: "b".repeat(64) },
      { ...input, threadId: ThreadId.make("foreign") },
      { ...input, commandId: CommandId.make("foreign-command") },
    ]) {
      assert.equal((yield* recreated.admit(changed).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* recreated.replay(changed).pipe(Effect.result))._tag, "Failure");
    }
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(
      (yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_message_admissions`)[0],
      { count: 1 },
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "retains queued delivery when its Run later starts, and rejects missing canonical evidence",
  () =>
    Effect.gen(function* () {
      const owner = yield* make;
      yield* owner.admit({ ...input, mode: "queue" });
      yield* accepted(null);
      assert.equal((yield* owner.replay(input))?.delivery, "queued");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id='run'`;
      assert.equal((yield* owner.replay(input).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("distinguishes a restarted steering message from a newly started Run", () =>
  Effect.gen(function* () {
    const owner = yield* make;
    yield* owner.admit({ ...input, mode: "restart" });
    yield* accepted("steer");
    assert.equal((yield* owner.replay(input))?.delivery, "restarted");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "stages original launch settings and independent attachment bytes before admission, then releases the duplicate body on acceptance",
  () =>
    Effect.gen(function* () {
      const owner = yield* make;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const source = path.join(config.attachmentsDir, "draft-source.txt");
      yield* fs.writeFileString(source, "original");
      const request = {
        ...input,
        launchId: "launch",
        sessionId: "session",
        title: "Draft",
        acceptedAt: 1,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "original-model" },
        interactionMode: "plan" as const,
        message: { messageId: input.messageId, text: "", attachments: [] },
        resources: [{ name: "evidence.txt", mimeType: "text/plain", sizeBytes: 8, source }],
      };
      const staged = yield* owner.stage(request);
      yield* fs.remove(source);
      const recreated = yield* make;
      assert.deepEqual(yield* recreated.stage(request), staged);
      assert.equal(staged.interactionMode, "plan");
      assert.deepEqual(staged.modelSelection, request.modelSelection);
      assert.equal(
        yield* fs.readFileString(
          path.join(config.attachmentsDir, attachmentRelativePath(staged.message.attachments[0]!)!),
        ),
        "original",
      );
      yield* accepted("turn_start");
      assert.isNull(
        yield* recreated.launch(input),
        "The canonical receipt atomically releases pending launch context",
      );
      assert.equal((yield* recreated.replay(input))?.delivery, "started");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqlitePersistence.layerMemory,
          ServerConfig.layerTest(process.cwd(), { prefix: "runtime-message-launch-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);

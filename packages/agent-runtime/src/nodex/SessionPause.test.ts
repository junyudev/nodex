import { it, assert } from "@effect/vitest";
import { CommandId, ThreadId, RunId } from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { make } from "./SessionPause.ts";
const database = Sqlite.layerMemory;
const layer = Layer.mergeAll(
  database,
  Outbox.layer.pipe(Layer.provide(database)),
  Layer.mock(ProjectionStoreV2)({
    getThread: () =>
      Effect.succeed({
        id: ThreadId.make("root"),
        lineage: { rootThreadId: ThreadId.make("root") },
      } as never),
    getExecutionActors: () =>
      Effect.succeed({
        items: [{ threadId: ThreadId.make("root"), providerSessionId: null, activeRunId: null }],
        nextCursor: null,
      }),
    getExecutionDetachBarrier: () => Effect.succeed(null),
  }),
  Layer.mock(OrchestratorV2)({ dispatch: () => Effect.succeed({} as never) }),
);
it.effect("pause remains requested while an earlier native start is still in flight", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* Outbox.EffectOutboxV2;
    yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES('root','project','Work','codex','full-access','default','today','today','{"lineage":{"rootThreadId":"root"}}')`;
    yield* outbox.enqueue([
      {
        id: "native-start",
        commandId: CommandId.make("native-start"),
        threadId: ThreadId.make("root"),
        request: { type: "provider-turn.start", runId: RunId.make("run") },
      },
    ]);
    assert.isTrue(
      Option.isSome(yield* outbox.claimNext({ workerId: "native", leaseDurationMs: 1000 })),
    );
    const pause = yield* make;
    assert.equal(
      (yield* pause.pause({ threadId: "root", revision: "person-hold" })).status,
      "requested",
    );
    yield* outbox.succeed({ effectId: "native-start", workerId: "native" });
    assert.equal(
      (yield* pause.pause({ threadId: "root", revision: "person-hold" })).status,
      "stopped",
    );
  }).pipe(Effect.provide(layer)),
);

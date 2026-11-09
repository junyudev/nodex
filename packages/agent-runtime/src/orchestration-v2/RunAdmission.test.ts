import { assert, it } from "@effect/vitest";
import {
  CommandId,
  RunId,
  ThreadId,
  ProviderSessionId,
  RuntimeRequestId,
} from "@nodex/runtime-contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Admission from "./RunAdmission.ts";
import * as Outbox from "./EffectOutbox.ts";
import { readSessionDetails } from "./SessionReadDetails.ts";

const layer = Outbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const put = Effect.fn("test.put")(function* (
  id: string,
  createdBy: "user" | "agent" | "system",
  extra: object = {},
  root = id,
  thread = id,
  runExtra: object = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES(${thread}, 'project', ${thread}, 'codex', 'full-access', 'default', ${now}, ${now}, ${JSON.stringify({ lineage: { rootThreadId: root } })}) ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    VALUES(${"message:" + id}, ${thread}, 'user', 0, ${now}, ${now}, ${JSON.stringify({ createdBy, creationSource: createdBy === "user" ? "web" : "server", text: "person continuation automatic", ...extra })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
    VALUES(${id}, ${thread}, (SELECT COUNT(*)+1 FROM orchestration_v2_projection_runs WHERE thread_id = ${thread}), 'codex', 'codex', 'starting', ${now}, ${JSON.stringify({ userMessageId: "message:" + id, ...runExtra })})`;
  yield* Admission.enqueue(id);
});
const start = (
  id: string,
  thread = id,
  request: Outbox.OrchestrationEffectRequestV2 = {
    type: "provider-turn.start",
    runId: RunId.make(id),
  },
) =>
  Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2;
    yield* outbox.enqueue([
      {
        id: "effect:" + id,
        commandId: CommandId.make(id),
        threadId: ThreadId.make(thread),
        request,
      },
    ]);
  });
const claim = Effect.gen(function* () {
  const outbox = yield* Outbox.EffectOutboxV2;
  return yield* outbox.claimNext({ workerId: "test", leaseDurationMs: 1000 });
});
const finish = Effect.fn("test.finish")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const outbox = yield* Outbox.EffectOutboxV2;
  yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = ${id}`;
  yield* outbox.succeed({ effectId: "effect:" + id, workerId: "test" });
  yield* Admission.reconcile();
});
const live = Effect.fn("test.live")(function* (id: string, thread = id) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_instance_id, provider_thread_id, status, payload_json)
    VALUES(${id + ":attempt"}, ${thread}, ${id}, 1, 'node', 'codex', 'codex', 'provider-thread', 'running', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, payload_json)
    VALUES(${id + ":turn"}, ${thread}, 'provider-thread', 'node', ${id + ":attempt"}, 1, 'running', '{}')`;
});
const automatic = (id: string) => put(id, "system").pipe(Effect.andThen(start(id)));
const take = (id: string) =>
  claim.pipe(
    Effect.tap((result) =>
      Effect.sync(() => assert.equal(Option.getOrThrow(result).id, "effect:" + id)),
    ),
  );
const occupied = automatic("occupied").pipe(Effect.andThen(take("occupied")));

it.effect("person chats never wait when automatic capacity is full", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* occupied;
    for (let i = 0; i < 6; i++) {
      const id = `person:${i}`;
      yield* put(id, "user");
      yield* start(id);
      yield* take(id);
      assert.deepEqual(yield* Admission.readWaiting(id), []);
    }
    yield* automatic("queued");
    assert.isTrue(Option.isNone(yield* claim));
  }).pipe(Effect.provide(layer)),
);

for (const [name, extra] of [
  ["delegated completion", { delegatedCompletion: { taskId: "child" } }],
  ["live question", { notification: { kind: "delegated_task_question" } }],
  ["other notification", { notification: { kind: "milestone" } }],
] as const)
  it.effect(`${name} wakes continue at capacity one`, () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* occupied;
      yield* put("parent", "user");
      yield* start("parent");
      yield* take("parent");
      yield* finish("parent");
      yield* put("wake", "agent", extra, "parent", "parent");
      yield* start("wake", "parent");
      yield* take("wake");
      assert.deepEqual(yield* Admission.readWaiting("parent"), []);
    }).pipe(Effect.provide(layer)),
  );

it.effect("delegated starts and follow-ups never wait and share the root episode", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* occupied;
    yield* put("parent", "user");
    yield* start("parent");
    yield* take("parent");
    for (const id of ["child", "grandchild"]) {
      yield* put(id, "agent", {}, "parent");
      yield* start(id);
      yield* take(id);
    }
    yield* finish("child");
    yield* put("followup", "agent", {}, "parent", "child");
    yield* start("followup", "child");
    yield* take("followup");
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(
      yield* sql`SELECT root_thread_id, class FROM orchestration_v2_work_episodes WHERE active = 1 ORDER BY root_thread_id`,
      [
        { root_thread_id: "occupied", class: "automatic" },
        { root_thread_id: "parent", class: "person" },
      ],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a parent answers its child's live question while another automatic tree holds the slot",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* occupied;
      yield* put("parent", "user");
      yield* start("parent");
      yield* take("parent");
      yield* finish("parent");
      yield* put("child", "agent", {}, "parent");
      yield* start("child");
      yield* take("child");
      const sql = yield* SqlClient.SqlClient;
      const outbox = yield* Outbox.EffectOutboxV2;
      yield* outbox.succeed({ effectId: "effect:child", workerId: "test" });
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'waiting' WHERE run_id = 'child'`;
      yield* live("child");
      yield* put(
        "wake",
        "agent",
        { notification: { kind: "delegated_task_question" } },
        "parent",
        "parent",
      );
      yield* start("wake", "parent");
      yield* take("wake");
      yield* start("answer", "child", {
        type: "runtime-request.respond",
        runId: RunId.make("child"),
        activationClass: "continuation",
        providerSessionId: ProviderSessionId.make("session"),
        requestId: RuntimeRequestId.make("question"),
        answers: { question: "answer" },
      });
      yield* take("answer");
      assert.deepEqual(yield* Admission.readWaiting("parent"), []);
      assert.deepEqual(yield* Admission.readWaiting("child"), []);
    }).pipe(Effect.provide(layer)),
);

it.effect("recovery, retries and steering bypass capacity without releasing the tree", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* occupied;
    yield* put("person", "user");
    yield* start("person", "person", {
      type: "run.recover",
      runId: RunId.make("person"),
      attemptOrdinal: 2,
    });
    yield* take("person");
    const outbox = yield* Outbox.EffectOutboxV2;
    yield* outbox.retry({
      effectId: "effect:person",
      workerId: "test",
      error: "retry",
      delayMs: 0,
    });
    yield* take("person");
    assert.deepEqual(yield* Admission.readWaiting("person"), []);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "automatic starts use FIFO positions and retain native background liveness across the whole tree",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* occupied;
      yield* put("child", "agent", {}, "occupied");
      yield* start("child");
      yield* take("child");
      yield* live("child");
      yield* automatic("second");
      yield* automatic("third");
      assert.deepEqual((yield* readSessionDetails("third", 1)).waitingAdmissions, [
        { runId: "third", position: 2, waitingSince: "1970-01-01T00:00:00.000Z" },
      ]);
      yield* finish("occupied");
      yield* finish("child");
      assert.isTrue(Option.isNone(yield* claim), "native background work retains the episode");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status = 'completed' WHERE thread_id = 'child'`;
      yield* take("second");
      assert.equal((yield* Admission.readWaiting("third"))[0]?.position, 1);
      yield* finish("second");
      yield* take("third");
    }).pipe(Effect.provide(layer)),
);

it.effect("a person's activation releases a waiting automatic tree in normal Thread order", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* occupied;
    yield* automatic("waiting");
    yield* put("person", "user", {}, "waiting", "waiting");
    yield* start("person", "waiting");
    assert.deepEqual(yield* Admission.readWaiting("waiting"), []);
    yield* take("waiting");
    assert.isTrue(Option.isNone(yield* claim), "the Thread lane still orders starts");
    yield* finish("waiting");
    yield* take("person");
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(
      yield* sql`SELECT class FROM orchestration_v2_work_episodes WHERE root_thread_id = 'waiting'`,
      [{ class: "person" }],
    );
  }).pipe(Effect.provide(layer)),
);

for (const origin of ["user", "system"] as const)
  it.effect(`an idle ${origin} tree's continuation inherits its previous episode class`, () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* put("root", origin);
      yield* start("root");
      yield* take("root");
      yield* finish("root");
      yield* occupied;
      yield* put("wake", "agent", { notification: { kind: "wake" } }, "root", "root");
      yield* start("wake", "root");
      yield* take("wake");
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT class, active FROM orchestration_v2_work_episodes WHERE root_thread_id = 'root'`,
        [{ class: origin === "user" ? "person" : "automatic", active: 1 }],
      );
    }).pipe(Effect.provide(layer)),
  );

it.effect(
  "later root messages from Agents or the Host are automatic starts, regardless of ordinal or words",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* put("root", "user");
      yield* start("root");
      yield* take("root");
      yield* finish("root");
      yield* occupied;
      yield* put("agent-start", "agent", {}, "root", "root");
      yield* start("agent-start", "root");
      assert.equal((yield* Admission.readWaiting("root"))[0]?.runId, "agent-start");
    }).pipe(Effect.provide(layer)),
);

it.effect("lowering capacity never preempts episodes; increases admit the next waiting tree", () =>
  Effect.gen(function* () {
    yield* Admission.configure(2);
    yield* automatic("first");
    yield* automatic("second");
    yield* take("first");
    yield* take("second");
    yield* Admission.configure(1);
    yield* automatic("third");
    yield* finish("first");
    assert.isTrue(Option.isNone(yield* claim));
    yield* Admission.configure(2);
    yield* take("third");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "startup reconciliation preserves FIFO and inherited classes and releases stale episodes",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* occupied;
      yield* automatic("second");
      yield* automatic("third");
      const before = yield* Admission.readWaiting("third");
      yield* Admission.restore();
      yield* Admission.restore();
      assert.deepEqual(yield* Admission.readWaiting("third"), before);
      assert.isTrue(Option.isNone(yield* claim));
      yield* finish("occupied");
      yield* Admission.restore();
      yield* take("second");
      yield* finish("second");
      yield* Admission.restore();
      yield* take("third");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "execution holds gate person and continuation effects, and release only after native retirement",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* occupied;
      yield* live("occupied");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_execution_pauses VALUES('occupied','revision','now')`;
      yield* automatic("next");
      assert.isTrue(Option.isNone(yield* claim));
      yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status = 'completed'`;
      const outbox = yield* Outbox.EffectOutboxV2;
      yield* outbox.succeed({ effectId: "effect:occupied", workerId: "test" });
      yield* take("next");
      yield* start("recovery", "occupied", {
        type: "run.recover",
        runId: RunId.make("occupied"),
        attemptOrdinal: 2,
      });
      assert.isTrue(Option.isNone(yield* claim));
      yield* sql`DELETE FROM orchestration_v2_execution_pauses`;
      yield* take("recovery");
    }).pipe(Effect.provide(layer)),
);

it.effect("pending replacement starts retain an episode after the foreground Run completes", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* occupied;
    const outbox = yield* Outbox.EffectOutboxV2;
    yield* outbox.succeed({ effectId: "effect:occupied", workerId: "test" });
    yield* start("recover", "occupied", {
      type: "run.recover",
      runId: RunId.make("occupied"),
      attemptOrdinal: 2,
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'occupied'`;
    yield* automatic("next");
    yield* Admission.reconcile();
    assert.equal((yield* Admission.readWaiting("next"))[0]?.position, 1);
    yield* take("recover");
    assert.isTrue(Option.isNone(yield* claim));
    yield* outbox.succeed({ effectId: "effect:recover", workerId: "test" });
    yield* take("next");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "reopening the execution store retains waiting order and native liveness without leaking episodes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-admission-" });
      const database = SqlitePersistence.layerFromPath(path.join(directory, "runtime.sqlite"));
      const runtime = Outbox.layer.pipe(Layer.provideMerge(database));
      yield* Effect.gen(function* () {
        yield* Admission.configure(1);
        yield* occupied;
        yield* live("occupied");
        yield* finish("occupied");
        yield* automatic("second");
        yield* automatic("third");
      }).pipe(Effect.provide(runtime));
      yield* Effect.gen(function* () {
        yield* Admission.restore();
        assert.equal((yield* Admission.readWaiting("third"))[0]?.position, 2);
        assert.isTrue(Option.isNone(yield* claim));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status = 'completed'`;
        yield* Admission.restore();
        yield* take("second");
        yield* finish("second");
      }).pipe(Effect.provide(runtime));
      yield* Effect.gen(function* () {
        yield* Admission.restore();
        yield* take("third");
        yield* finish("third");
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          yield* sql`SELECT root_thread_id FROM orchestration_v2_work_episodes WHERE active = 1`,
          [],
        );
      }).pipe(Effect.provide(runtime));
    }).pipe(Effect.provide(NodeServices.layer)),
);

for (const [name, author, message, run] of [
  ["Agent answer", "agent", { respondedBy: { senderThreadId: "parent" } }, {}],
  ["context recovery", "user", {}, { contextRecovery: { failedRunId: "root" } }],
  ["steering fallback", "agent", {}, { continuationOfRunId: "root" }],
  ["restart continuation", "agent", {}, { restartContinuationOfRunId: "root" }],
] as const)
  it.effect(`${name} reactivates an automatic episode without a capacity wait`, () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* automatic("root");
      yield* take("root");
      yield* finish("root");
      yield* occupied;
      yield* put("continuation", author, message, "root", "root", run);
      yield* start("continuation", "root");
      yield* take("continuation");
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT class, active FROM orchestration_v2_work_episodes WHERE root_thread_id = 'root'`,
        [{ class: "automatic", active: 1 }],
      );
      assert.deepEqual(yield* Admission.readWaiting("root"), []);
    }).pipe(Effect.provide(layer)),
  );

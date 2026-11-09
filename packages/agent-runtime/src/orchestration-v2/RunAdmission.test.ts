import { assert, it } from "@effect/vitest";
import {
  CommandId,
  RunId,
  ThreadId,
  ProviderSessionId,
  RuntimeRequestId,
  ProviderThreadId,
  ProviderTurnId,
  MessageId,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
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
  ordinal = 1,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES(${id}, 'project', ${id}, 'codex', 'full-access', 'default', ${now}, ${now}, ${JSON.stringify({ lineage: { rootThreadId: "root:" + id } })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
    VALUES(${"message:" + id}, ${id}, 'user', 0, ${now}, ${now}, ${JSON.stringify({ createdBy, creationSource: createdBy === "user" ? "web" : "server", text: "person continuation start", ...extra })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
    VALUES(${id}, ${id}, ${ordinal}, 'codex', 'codex', 'starting', ${now}, ${JSON.stringify({ userMessageId: "message:" + id })})`;
  yield* Admission.enqueue(id, id);
});
const start = (
  id: string,
  request: Outbox.OrchestrationEffectRequestV2 = {
    type: "provider-turn.start",
    runId: RunId.make(id),
  },
) =>
  Effect.gen(function* () {
    const outbox = yield* Outbox.EffectOutboxV2;
    yield* outbox.enqueue([
      { id: "effect:" + id, commandId: CommandId.make(id), threadId: ThreadId.make(id), request },
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
});
const live = Effect.fn("test.live")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_instance_id, provider_thread_id, status, payload_json)
    VALUES(${id + ":attempt"}, ${id}, ${id}, 1, 'node', 'codex', 'codex', 'provider-thread', 'running', '{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, payload_json)
    VALUES(${id + ":turn"}, ${id}, 'provider-thread', 'node', ${id + ":attempt"}, 1, 'running', '{}')`;
  yield* Admission.reconcile();
});

it.effect("orders trusted person, continuation and start provenance, FIFO within each class", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* put("start", "system");
    yield* start("start");
    yield* put("continue", "agent", { notification: { summary: "wake" } });
    yield* start("continue");
    yield* put("person1", "user");
    yield* start("person1");
    yield* put("person2", "user");
    yield* start("person2");
    const initial = yield* Admission.readWaiting("start");
    assert.equal(initial[0]?.position, 4);
    for (const id of ["person1", "person2", "continue", "start"]) {
      assert.equal(Option.getOrThrow(yield* claim).threadId, id);
      yield* finish(id);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("reserves one of N permits for a person without preempting native work", () =>
  Effect.gen(function* () {
    yield* Admission.configure(3);
    for (const id of ["a", "b", "c"]) {
      yield* put(id, "system");
      yield* start(id);
    }
    assert.equal(Option.getOrThrow(yield* claim).threadId, "a");
    assert.equal(Option.getOrThrow(yield* claim).threadId, "b");
    assert.isTrue(Option.isNone(yield* claim));
    yield* put("person", "user");
    yield* start("person");
    assert.equal(Option.getOrThrow(yield* claim).threadId, "person");
    yield* live("a");
    yield* finish("a");
    assert.isTrue(Option.isNone(yield* claim), "a UI completion cannot release live native work");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status = 'completed' WHERE thread_id = 'a'`;
    assert.equal(Option.getOrThrow(yield* claim).threadId, "c");
  }).pipe(Effect.provide(layer)),
);

it.effect("at N=1 automatic work progresses, but a person wins the next slot", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* put("running", "system");
    yield* start("running");
    yield* claim;
    yield* put("automatic", "system");
    yield* start("automatic");
    yield* put("person", "user");
    yield* start("person");
    assert.isTrue(Option.isNone(yield* claim));
    yield* finish("running");
    assert.equal(Option.getOrThrow(yield* claim).threadId, "person");
    yield* finish("person");
    assert.equal(Option.getOrThrow(yield* claim).threadId, "automatic");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a person's replacement start promotes waiting automatic recovery ahead of other wakes",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* put("running", "system");
      yield* start("running");
      yield* claim;
      yield* put("wake", "system", { notification: { summary: "wake" } });
      yield* start("wake");
      yield* put("recovery", "system", { notification: { summary: "retry" } });
      yield* start("recovery", {
        type: "provider-turn.start",
        runId: RunId.make("recovery"),
        admissionClass: "person",
      });
      assert.deepEqual(
        (yield* Admission.readWaiting("recovery")).map(({ class: kind, position }) => ({
          kind,
          position,
        })),
        [{ kind: "person", position: 1 }],
      );
      assert.isTrue(Option.isNone(yield* claim));
      yield* finish("running");
      assert.equal(Option.getOrThrow(yield* claim).threadId, "recovery");
    }).pipe(Effect.provide(layer)),
);

it.effect("steering and answering reuse an admitted permit and bypass a queued start", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* put("person", "user");
    yield* start("person");
    yield* claim;
    const outbox = yield* Outbox.EffectOutboxV2;
    yield* outbox.succeed({ effectId: "effect:person", workerId: "test" });
    for (const [id, request] of [
      [
        "steer",
        {
          type: "provider-turn.steer",
          providerSessionId: ProviderSessionId.make("s"),
          providerThreadId: ProviderThreadId.make("t"),
          providerTurnId: ProviderTurnId.make("u"),
          messageId: MessageId.make("m"),
        },
      ],
      [
        "answer",
        {
          type: "runtime-request.respond",
          providerSessionId: ProviderSessionId.make("s"),
          requestId: RuntimeRequestId.make("q"),
          answers: {},
        },
      ],
    ] as const) {
      yield* outbox.enqueue([
        { id, commandId: CommandId.make(id), threadId: ThreadId.make("person"), request },
      ]);
      assert.equal(Option.getOrThrow(yield* claim).id, id);
      yield* outbox.succeed({ effectId: id, workerId: "test" });
    }
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM orchestration_v2_run_admissions WHERE state = 'admitted'`;
    assert.equal(rows[0]?.count, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "parks a blocking parent, counts its child separately and re-admits the parent as a continuation",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* put("parent", "user");
      yield* start("parent");
      yield* claim;
      yield* live("parent");
      const outbox = yield* Outbox.EffectOutboxV2;
      yield* outbox.succeed({ effectId: "effect:parent", workerId: "test" });
      const childEnded = yield* Deferred.make<void>();
      const parked = yield* Admission.whileParked("parent", Deferred.await(childEnded)).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* put("child", "agent");
      yield* start("child");
      assert.equal(Option.getOrThrow(yield* claim).threadId, "child");
      yield* Deferred.succeed(childEnded, undefined);
      yield* Effect.yieldNow;
      assert.equal((yield* Admission.readWaiting("parent"))[0]?.class, "continuation");
      yield* finish("child");
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(parked);
      assert.deepEqual(yield* Admission.readWaiting("parent"), []);
    }).pipe(Effect.provide(layer)),
);

it.effect("reconciles restart permits only after native liveness is resolved", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* put("native", "user");
    yield* start("native");
    yield* claim;
    yield* live("native");
    const outbox = yield* Outbox.EffectOutboxV2;
    yield* outbox.reconcileAfterProcessLoss;
    yield* put("next", "user");
    yield* start("next");
    assert.isTrue(Option.isNone(yield* claim));
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'cancelled' WHERE run_id = 'native'`;
    assert.isTrue(Option.isNone(yield* claim));
    yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status = 'cancelled' WHERE thread_id = 'native'`;
    assert.equal(Option.getOrThrow(yield* claim).threadId, "next");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "gates first starts, queued starts, recovery attempts and native restarts before claims",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* put("running", "user");
      yield* start("running");
      yield* claim;
      const requests: Extract<Outbox.OrchestrationEffectRequestV2, { runId: unknown }>[] = [
        { type: "provider-turn.start", runId: RunId.make("first") },
        { type: "provider-turn.start", runId: RunId.make("queued") },
        { type: "run.recover", runId: RunId.make("recovery"), attemptOrdinal: 2 },
        {
          type: "provider-turn.restart",
          runId: RunId.make("restart"),
          providerSessionId: ProviderSessionId.make("s"),
          providerThreadId: ProviderThreadId.make("t"),
          providerTurnId: ProviderTurnId.make("u"),
          interruptedAttemptId: "attempt" as never,
        },
      ];
      for (const request of requests) {
        yield* put(request.runId, "system");
        yield* start(request.runId, request);
      }
      assert.isTrue(Option.isNone(yield* claim));
      yield* finish("running");
      for (const id of ["first", "queued", "recovery", "restart"]) {
        assert.equal(Option.getOrThrow(yield* claim).threadId, id);
        yield* finish(id);
      }
    }).pipe(Effect.provide(layer)),
);

it.effect("publishes live 1-based machine queue positions in bounded Session details", () =>
  Effect.gen(function* () {
    yield* put("start", "system");
    yield* put("wake", "agent", { delegatedCompletion: { generation: 1 } });
    yield* put("person", "user");
    const details = yield* readSessionDetails("wake", 1);
    assert.deepEqual(
      details.waitingAdmissions.map(({ class: kind, position, runId }) => ({
        class: kind,
        position,
        runId,
      })),
      [{ class: "continuation", position: 2, runId: "wake" }],
    );
    assert.isString(details.waitingAdmissions[0]?.waitingSince);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'cancelled' WHERE run_id = 'person'`;
    yield* Admission.reconcile();
    assert.equal((yield* readSessionDetails("wake", 1)).waitingAdmissions[0]?.position, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "captures Page, root and request identity once, independently of later message edits",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_admission_context(thread_id, page_id) VALUES ('root:person', 'page')`;
      yield* put("person", "user");
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{"createdBy":"system"}' WHERE thread_id = 'person'`;
      yield* Admission.enqueue("person", "another-request");
      const rows = yield* sql<{
        class: string;
        root_thread_id: string;
        page_id: string;
        request_id: string;
      }>`SELECT class, root_thread_id, page_id, request_id FROM orchestration_v2_run_admissions`;
      assert.deepEqual(rows, [
        { class: "person", root_thread_id: "root:person", page_id: "page", request_id: "person" },
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "an outbox retry releases unused capacity and re-enters as a continuation at its durable deadline",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* put("retry", "user");
      yield* start("retry");
      yield* claim;
      const outbox = yield* Outbox.EffectOutboxV2;
      yield* outbox.retry({
        effectId: "effect:retry",
        workerId: "test",
        error: "not started",
        delayMs: 5000,
      });
      assert.equal((yield* Admission.readWaiting("retry"))[0]?.class, "continuation");
      assert.isTrue(Option.isSome(yield* outbox.nextClaimableAt));
      yield* put("person", "user");
      yield* start("person");
      assert.equal(Option.getOrThrow(yield* claim).threadId, "person");
      yield* finish("person");
      yield* TestClock.adjust("5 seconds");
      assert.equal(Option.getOrThrow(yield* claim).threadId, "retry");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a native replacement transfers its existing slot rather than deadlocking at capacity one",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* put("native", "user");
      yield* start("native");
      yield* claim;
      yield* live("native");
      const outbox = yield* Outbox.EffectOutboxV2;
      yield* outbox.succeed({ effectId: "effect:native", workerId: "test" });
      yield* put("replacement", "user");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_runs SET thread_id = 'native', ordinal = 2 WHERE run_id = 'replacement'`;
      yield* outbox.enqueue([
        {
          id: "effect:replacement",
          commandId: CommandId.make("replace"),
          threadId: ThreadId.make("native"),
          request: {
            type: "provider-turn.restart",
            runId: RunId.make("replacement"),
            providerSessionId: ProviderSessionId.make("s"),
            providerThreadId: ProviderThreadId.make("t"),
            providerTurnId: ProviderTurnId.make("native:turn"),
            interruptedAttemptId: "native:attempt" as never,
          },
        },
      ]);
      assert.equal(Option.getOrThrow(yield* claim).id, "effect:replacement");
      const rows = yield* sql<{
        run_id: string;
      }>`SELECT run_id FROM orchestration_v2_run_admissions WHERE state = 'admitted'`;
      assert.deepEqual(rows, [{ run_id: "replacement" }]);
    }).pipe(Effect.provide(layer)),
);

it.effect("a person steering a parked parent re-admits it ahead of automatic resumptions", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* put("parent", "user");
    yield* start("parent");
    yield* claim;
    yield* live("parent");
    const outbox = yield* Outbox.EffectOutboxV2;
    yield* outbox.succeed({ effectId: "effect:parent", workerId: "test" });
    const ended = yield* Deferred.make<void>();
    const parked = yield* Admission.whileParked("parent", Deferred.await(ended)).pipe(
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* put("child", "agent");
    yield* start("child");
    yield* claim;
    yield* outbox.enqueue([
      {
        id: "person:steer",
        commandId: CommandId.make("steer"),
        threadId: ThreadId.make("parent"),
        request: {
          type: "provider-turn.steer",
          runId: RunId.make("parent"),
          admissionClass: "person",
          providerSessionId: ProviderSessionId.make("s"),
          providerThreadId: ProviderThreadId.make("t"),
          providerTurnId: ProviderTurnId.make("parent:turn"),
          messageId: MessageId.make("human"),
        },
      },
    ]);
    assert.equal((yield* Admission.readWaiting("parent"))[0]?.class, "person");
    assert.isTrue(Option.isNone(yield* claim));
    yield* finish("child");
    assert.equal(Option.getOrThrow(yield* claim).id, "person:steer");
    yield* Deferred.succeed(ended, undefined);
    yield* Fiber.join(parked);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a parent stays parked until all parallel children finish without holding their capacity",
  () =>
    Effect.gen(function* () {
      yield* Admission.configure(1);
      yield* put("parent", "user");
      yield* start("parent");
      yield* claim;
      yield* live("parent");
      const outbox = yield* Outbox.EffectOutboxV2;
      yield* outbox.succeed({ effectId: "effect:parent", workerId: "test" });
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      let returned = 0;
      const done = Effect.sync(() => {
        returned++;
      });
      const waits = [
        yield* Admission.whileParked("parent", Deferred.await(first)).pipe(
          Effect.tap(() => done),
          Effect.forkChild,
        ),
        yield* Admission.whileParked("parent", Deferred.await(second)).pipe(
          Effect.tap(() => done),
          Effect.forkChild,
        ),
      ];
      yield* Effect.yieldNow;
      for (const id of ["first-child", "second-child"]) {
        yield* put(id, "agent");
        yield* start(id);
      }
      assert.equal(Option.getOrThrow(yield* claim).threadId, "first-child");
      yield* finish("first-child");
      yield* Deferred.succeed(first, undefined);
      yield* TestClock.adjust("100 millis");
      assert.equal(returned, 0);
      assert.equal(Option.getOrThrow(yield* claim).threadId, "second-child");
      yield* finish("second-child");
      yield* Deferred.succeed(second, undefined);
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(waits[0]!);
      yield* Fiber.join(waits[1]!);
      assert.equal(returned, 2);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_run_admissions WHERE state = 'admitted'`)[0]
          ?.count,
        1,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("re-admits a pending continuation when its predecessor's native permit settles", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* put("native", "user");
    yield* start("native");
    yield* claim;
    yield* live("native");
    const outbox = yield* Outbox.EffectOutboxV2;
    yield* outbox.succeed({ effectId: "effect:native", workerId: "test" });
    yield* outbox.enqueue([
      {
        id: "recovery:next",
        commandId: CommandId.make("recover"),
        threadId: ThreadId.make("native"),
        request: { type: "run.recover", runId: RunId.make("native"), attemptOrdinal: 2 },
      },
    ]);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status = 'failed' WHERE thread_id = 'native'`;
    yield* Admission.reconcile();
    assert.equal(Option.getOrThrow(yield* claim).id, "recovery:next");
    const active = yield* sql<{
      class: string;
      request_id: string;
    }>`SELECT class, request_id FROM orchestration_v2_run_admissions WHERE state = 'admitted'`;
    assert.deepEqual(active, [{ class: "continuation", request_id: "recovery:next" }]);
  }).pipe(Effect.provide(layer)),
);

it.effect("applies capacity changes without preempting permits already in use", () =>
  Effect.gen(function* () {
    yield* Admission.configure(1);
    yield* put("automatic", "system");
    yield* start("automatic");
    yield* claim;
    yield* put("person", "user");
    yield* start("person");
    assert.isTrue(Option.isNone(yield* claim));
    yield* Admission.configure(2);
    assert.equal(Option.getOrThrow(yield* claim).threadId, "person");
    yield* Admission.configure(1);
    yield* put("next", "user");
    yield* start("next");
    assert.isTrue(Option.isNone(yield* claim));
    yield* finish("automatic");
    assert.isTrue(Option.isNone(yield* claim));
    yield* finish("person");
    assert.equal(Option.getOrThrow(yield* claim).threadId, "next");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a durable root pause blocks starts and recovery without consuming a permit or input",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Admission.configure(1);
      yield* put("held", "user");
      yield* start("held");
      yield* sql`INSERT INTO orchestration_v2_execution_pauses VALUES('root:held','hold-1','today')`;
      const outbox = yield* Outbox.EffectOutboxV2;
      yield* outbox.enqueue([
        {
          id: "recover:held",
          commandId: CommandId.make("recover:held"),
          threadId: ThreadId.make("held"),
          request: { type: "run.recover", runId: RunId.make("held"), attemptOrdinal: 2 },
        },
      ]);
      assert.isTrue(Option.isNone(yield* claim));
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM orchestration_v2_run_admissions WHERE state='admitted'`)[0]
          ?.count,
        0,
      );
      assert.equal((yield* outbox.get("effect:held"))._tag, "Some");
      yield* put("free", "user");
      yield* start("free");
      assert.equal(Option.getOrThrow(yield* claim).threadId, "free");
      yield* finish("free");
      yield* outbox.reconcileAfterProcessLoss;
      assert.equal(Option.getOrThrow(yield* outbox.get("effect:held")).status, "pending");
      assert.equal(Option.getOrThrow(yield* outbox.get("recover:held")).status, "pending");
      assert.isTrue(Option.isNone(yield* claim));
      yield* sql`DELETE FROM orchestration_v2_execution_pauses`;
      assert.equal(Option.getOrThrow(yield* claim).threadId, "held");
    }).pipe(Effect.provide(layer)),
);

it.effect("pause releases capacity after native retirement and preserves the waiting work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Admission.configure(1);
    yield* put("active", "user");
    yield* start("active");
    assert.equal(Option.getOrThrow(yield* claim).threadId, "active");
    yield* live("active");
    yield* sql`INSERT INTO orchestration_v2_execution_pauses VALUES('root:active','hold-1','today')`;
    yield* sql`UPDATE orchestration_v2_projection_runs SET status='queued' WHERE run_id='active'`;
    yield* put("next", "user");
    yield* start("next");
    assert.isTrue(Option.isNone(yield* claim));
    yield* sql`UPDATE orchestration_v2_projection_provider_turns SET status='interrupted' WHERE thread_id='active'`;
    const outbox = yield* Outbox.EffectOutboxV2;
    yield* outbox.succeed({ effectId: "effect:active", workerId: "test" });
    assert.equal(Option.getOrThrow(yield* claim).threadId, "next");
    assert.equal(
      (yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_v2_projection_runs WHERE run_id='active'`)[0]?.status,
      "queued",
    );
  }).pipe(Effect.provide(layer)),
);

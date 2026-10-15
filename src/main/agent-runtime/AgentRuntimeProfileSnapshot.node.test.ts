import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import { AgentRuntimeProcessError } from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";
import { make as makeAdmission } from "./AgentRuntimeSnapshotAdmission";
import { make } from "./AgentRuntimeProfileSnapshot";

const fixture = Effect.gen(function* () {
  const calls: string[] = [];
  let rejection: AgentRuntimeProcessError | null = null;
  const snapshot = {
    leaseId: "lease",
    runtimeId: "runtime",
    runtimeGeneration: "generation",
    sequence: 7,
    databasePath: "/profile/agent-runtime/userdata/.profile-snapshot-copy/agent-runtime.sqlite",
    attachmentsPath: "/profile/agent-runtime/userdata/attachments",
    environmentIdPath: "/profile/agent-runtime/userdata/environment-id",
  };
  const connection = {
    request: (method: string, input: unknown) =>
      Effect.suspend<unknown, AgentRuntimeProcessError, never>(() => {
        calls.push(method);
        if (method === "storage.snapshot.acquire")
          return rejection ? Effect.fail(rejection) : Effect.succeed(snapshot);
        if (method === "storage.snapshot.release") {
          assert.deepEqual(input, { leaseId: "lease" });
          return Effect.succeed({ released: true });
        }
        return Effect.succeed({ stopped: true });
      }),
  } as unknown as AgentRuntimeProcessConnection;
  const runtime = {
    get: () => Effect.succeed(connection),
    inspect: Effect.succeed(null),
    withStopped: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      Effect.sync(() => calls.push("stop")).pipe(Effect.andThen(operation)),
  } as unknown as AgentRuntimeSupervisor["Service"];
  const admission = yield* makeAdmission();
  const owner = yield* make(runtime, admission, {
    prepareRestore: (source) =>
      Effect.sync(() => {
        calls.push("preserve-source");
        return { ...source, databasePath: "/profile/runtime/snapshots/copy.sqlite" };
      }),
  });
  return {
    owner,
    admission,
    calls,
    snapshot,
    runtime,
    reject: (reason: AgentRuntimeProcessError["reason"]) => {
      rejection = new AgentRuntimeProcessError({ reason, message: "refused" });
    },
  };
});

it.effect("keeps never-used Agent execution cold while a content backup holds admission", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const owner = yield* make(f.runtime, f.admission, { isUnused: Effect.succeed(true) });
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const capturing = yield* owner
      .withOptionalSnapshot((source) =>
        Effect.gen(function* () {
          assert.isUndefined(source);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return "content backup";
        }),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    assert.isEmpty(f.calls);
    assert.isTrue(
      (yield* f.admission.withWriter(Effect.void).pipe(Effect.exit))._tag === "Failure",
    );
    yield* Deferred.succeed(release, undefined);
    assert.strictEqual(yield* Fiber.join(capturing), "content backup");
    assert.strictEqual(yield* f.admission.withWriter(Effect.succeed(1)), 1);
  }),
);

it.effect(
  "releases the exact physical snapshot before returning successful or failed capture",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      assert.strictEqual(
        yield* f.owner.withSnapshot((snapshot) => Effect.succeed(snapshot.runtimeId)),
        "runtime",
      );
      assert.deepEqual(f.calls, ["storage.snapshot.acquire", "storage.snapshot.release"]);
      const failure = yield* f.owner
        .withSnapshot(() => Effect.fail("copy failed"))
        .pipe(Effect.flip);
      assert.strictEqual(failure, "copy failed");
      assert.deepEqual(f.calls.slice(2), ["storage.snapshot.acquire", "storage.snapshot.release"]);
      assert.strictEqual(yield* f.admission.withWriter(Effect.succeed(1)), 1);
    }),
);

it.effect("preserves the online database before stopping execution for atomic restore", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const restored = yield* f.owner.withRestore((source) =>
      Effect.sync(() => {
        f.calls.push("replace-profile");
        assert.strictEqual(source.databasePath, "/profile/runtime/snapshots/copy.sqlite");
        return "restored";
      }),
    );
    assert.strictEqual(restored, "restored");
    assert.deepEqual(f.calls, [
      "storage.snapshot.acquire",
      "preserve-source",
      "stop",
      "replace-profile",
    ]);
  }),
);

it.effect("disconnect interruption releases the lease and Session admission", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const started = yield* Deferred.make<void>();
    const capturing = yield* f.owner
      .withSnapshot(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(capturing);
    assert.deepEqual(f.calls, ["storage.snapshot.acquire", "storage.snapshot.release"]);
    assert.strictEqual(yield* f.admission.withWriter(Effect.succeed(2)), 2);
  }),
);

it.effect(
  "a known busy refusal keeps execution alive while uncertain admission closes its process",
  () =>
    Effect.gen(function* () {
      const refused = yield* fixture;
      refused.reject("rejected");
      yield* refused.owner.withSnapshot(() => Effect.void).pipe(Effect.flip);
      assert.deepEqual(refused.calls, ["storage.snapshot.acquire"]);
      const uncertain = yield* fixture;
      uncertain.reject("request");
      yield* uncertain.owner.withSnapshot(() => Effect.void).pipe(Effect.flip);
      assert.deepEqual(uncertain.calls, ["storage.snapshot.acquire", "shutdown"]);
    }),
);

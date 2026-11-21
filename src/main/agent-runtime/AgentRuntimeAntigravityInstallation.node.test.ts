import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  antigravityInspection,
  antigravityOperation,
  managedAntigravityExecutable,
} from "../../shared/antigravity-runtime.test-support";
import type { AntigravityRuntimeOperation } from "../../shared/antigravity-runtime";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import { make } from "./AgentRuntimeAntigravityInstallation";

const setup = Effect.gen(function* () {
  const session = { generation: "generation1", running: false };
  const starts: string[] = [];
  const refreshes: (readonly string[])[] = [];
  let pending: AntigravityRuntimeOperation | null = null;
  let retainers = 0;
  const inspection = antigravityInspection({
    managed: managedAntigravityExecutable,
    instances: [
      {
        instanceId: "antigravity-a",
        source: "managed",
        version: managedAntigravityExecutable.version,
        executablePath: managedAntigravityExecutable.executablePath,
        configuredBinaryPath: null,
        issue: null,
      },
    ],
    canRemove: true,
  });
  let executable = inspection;
  const connection = () =>
    ({
      identity: { runtimeGeneration: session.generation },
      request: (method: string, input: { operationId: string }) =>
        Effect.sync(() => {
          switch (method) {
            case "providers.install.read":
              return { ...executable, runtimeGeneration: session.generation };
            case "providers.install.start":
            case "providers.install.remove":
              pending = antigravityOperation({
                operationId: input.operationId,
                runtimeGeneration: session.generation,
                kind: method === "providers.install.remove" ? "remove" : "install",
                cancellable: method === "providers.install.start",
              });
              return pending;
            case "providers.install.operation.cancel":
              pending = {
                ...pending!,
                phase: "cancelled",
                revision: pending!.revision + 1,
                cancellable: false,
              };
              return pending;
            case "providers.install.operation.read":
              return pending;
            default:
              throw new Error(method);
          }
        }),
    }) as unknown as AgentRuntimeProcessConnection;
  const owner = yield* make(
    {
      get: () =>
        Effect.sync(() => {
          starts.push(session.generation);
          session.running = true;
          return connection();
        }),
      currentConnection: Effect.sync(() => (session.running ? connection() : null)),
      retained: (effect) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            retainers++;
          }),
          () => effect,
          () =>
            Effect.sync(() => {
              retainers--;
            }),
        ),
    },
    (ids) =>
      Effect.sync(() => {
        refreshes.push(ids);
      }),
  );
  return {
    owner,
    session,
    starts,
    refreshes,
    inspection,
    retainers: () => retainers,
    report: (patch: Partial<AntigravityRuntimeOperation>) => {
      pending = { ...pending!, ...patch };
    },
    removeExecutable: () => {
      executable = antigravityInspection({ instances: inspection.instances });
      pending = { ...pending!, phase: "succeeded", revision: 2, result: executable };
    },
  };
});

it.effect(
  "passively reads while stopped, then tracks a single operation through newer progress and completion",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        const { owner } = fixture;
        assert.isNull((yield* owner.read).inspection);
        assert.deepEqual(fixture.starts, []);

        const started = yield* owner.start;
        const id = started.operation!.operationId;
        assert.deepEqual(fixture.starts, ["generation1"]);
        assert.equal((yield* owner.start).operation?.operationId, id);
        assert.equal((yield* owner.remove).operation?.operationId, id);
        assert.equal(fixture.retainers(), 1);

        fixture.report({
          revision: 3,
          progress: { phase: "downloading", downloadedBytes: 42, totalBytes: 100 },
        });
        yield* TestClock.adjust("300 millis");
        const progress = yield* owner.readOperation(id);
        assert.equal(progress.operation?.progress?.downloadedBytes, 42);
        assert.isAbove(progress.revision, started.revision);

        fixture.report({
          revision: 2,
          progress: { phase: "downloading", downloadedBytes: 10, totalBytes: 100 },
        });
        yield* TestClock.adjust("300 millis");
        assert.deepEqual(yield* owner.readOperation(id), progress);

        fixture.report({
          revision: 4,
          phase: "succeeded",
          cancellable: false,
          result: fixture.inspection,
        });
        yield* TestClock.adjust("300 millis");
        assert.equal((yield* owner.readOperation(id)).inspection?.managed?.version, "1.5.13");
        assert.deepEqual(fixture.refreshes, [["antigravity-a"]]);
        assert.equal(fixture.retainers(), 0);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "fences cancellation and progress across runtime generations, then refreshes after removal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        const { owner } = fixture;
        assert.equal((yield* owner.check).inspection?.managed?.version, "1.5.13");
        const first = (yield* owner.start).operation!.operationId;
        assert.equal((yield* owner.cancel(first)).operation?.phase, "cancelled");
        yield* TestClock.adjust("300 millis");
        assert.deepEqual(fixture.refreshes, []);

        const second = (yield* owner.start).operation!.operationId;
        const oldCancel = yield* Effect.result(owner.cancel(first));
        assert.equal(oldCancel._tag, "Failure");
        fixture.session.generation = "generation2";
        yield* TestClock.adjust("300 millis");
        assert.equal((yield* owner.readOperation(second)).operation?.phase, "failed");
        assert.isNull((yield* owner.read).operation);

        fixture.session.generation = "generation1";
        const removal = (yield* owner.remove).operation!;
        assert.isFalse(removal.cancellable);
        fixture.removeExecutable();
        yield* TestClock.adjust("300 millis");
        assert.isNull((yield* owner.readOperation(removal.operationId)).inspection?.managed);
        assert.deepEqual(fixture.refreshes, [["antigravity-a"]]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);

import { assert, it } from "@effect/vitest";
import type { AgentRuntimeOperations, AgentThreadAuthority } from "@nodex/agent-runtime/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { CodexComposerPredictionConfiguration } from "../codex-application/CodexComposerPrediction";
import {
  AgentRuntimeProcessError,
  type AgentRuntimeProcessConnection,
} from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";
import { run } from "./AgentRuntimeSessionPredictions";

const configuration: CodexComposerPredictionConfiguration = {
  is_enabled: true,
  prompt: "Predict the next message.",
  prompt_version: "test",
  prediction_reasoning_effort: "low",
};

const fixture = (options?: {
  readonly generation?: string;
  readonly authority?: Partial<AgentThreadAuthority>;
  readonly authorityEffect?: Effect.Effect<Partial<AgentThreadAuthority>, AgentRuntimeProcessError>;
  readonly predictionEffect?: Effect.Effect<unknown, AgentRuntimeProcessError>;
}) => {
  const requests: Array<{ method: string; input: unknown }> = [];
  const generation = options?.generation ?? "generation:1";
  const authority = {
    runtimeGeneration: generation,
    rootThreadId: "thread:root",
    threadId: "thread:root",
    status: "completed",
    archived: false,
    hasNativeBackgroundWork: false,
    nativeThreadRef: { driver: "codex", nativeId: "native:root", strength: "strong" },
    ...options?.authority,
  } satisfies Partial<AgentThreadAuthority>;
  const connection = {
    identity: { runtimeId: "runtime", runtimeGeneration: generation },
    request: (method: string, input: unknown) =>
      Effect.suspend(() => {
        requests.push({ method, input });
        if (method === "thread.authority")
          return options?.authorityEffect ?? Effect.succeed(authority);
        if (method === "native.prediction.request")
          return options?.predictionEffect ?? Effect.succeed({ text: "Continue" });
        if (method === "native.prediction.clear") return Effect.succeed(null);
        return Effect.die(`Unexpected ${method}`);
      }),
  } as unknown as AgentRuntimeProcessConnection;
  const transition: AgentRuntimeActivityTransition = {
    connection,
    sessionId: "session:root",
    rootThreadId: "thread:root",
    before: {
      sessionId: "session:root",
      threadId: "thread:root",
      status: "running",
      activeRunId: "run:1",
      pendingRequestCount: 0,
      activeTaskCount: 0,
      resumesAutomatically: false,
      providerInstanceId: "codex",
      model: "gpt",
      updatedAt: "2026-10-23T00:00:00.000Z",
    },
    after: null,
    endedRun: { runId: "run:1", status: "completed" },
  };
  return { requests, transition, authority };
};

it.effect("prepares a completed root on its existing Runtime without a mounted Composer", () =>
  Effect.gen(function* () {
    const f = fixture();
    const observe = (transitions: Stream.Stream<AgentRuntimeActivityTransition>) =>
      run({
        transitions,
        configuration: Effect.succeed(configuration),
        configurationChanges: Stream.never,
      });
    yield* observe(Stream.empty);
    assert.deepEqual(f.requests, []);
    yield* observe(Stream.succeed(f.transition));
    assert.deepEqual(f.requests, [
      { method: "thread.authority", input: { threadId: "thread:root", runId: "run:1" } },
      {
        method: "native.prediction.request",
        input: {
          threadId: "thread:root",
          latestRunId: "run:1",
          generationTrigger: "live",
          configuration,
        } satisfies AgentRuntimeOperations["native.prediction.request"]["input"],
      },
    ]);
  }),
);

it.effect("skips disabled, unfinished, delegated and unsupported execution", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* run({
      transitions: Stream.succeed(f.transition),
      configuration: Effect.succeed({ ...configuration, is_enabled: false }),
      configurationChanges: Stream.never,
    });
    yield* run({
      transitions: Stream.fromIterable([
        { ...f.transition, endedRun: null },
        { ...f.transition, endedRun: { runId: "run:1", status: "interrupted" } },
        { ...f.transition, after: f.transition.before },
        {
          ...f.transition,
          after: { ...f.transition.before!, status: "background", activeRunId: null },
        },
      ]),
      configuration: Effect.succeed(configuration),
      configurationChanges: Stream.never,
    });
    assert.deepEqual(f.requests, []);
    for (const authority of [
      { status: "failed" as const },
      { archived: true },
      { hasNativeBackgroundWork: true },
      { rootThreadId: "different:root" },
      { threadId: "thread:child" },
      { runtimeGeneration: "retired:generation" },
      {
        nativeThreadRef: {
          driver: "claude-agent",
          nativeId: "native:root",
          strength: "strong" as const,
        },
      },
    ]) {
      const skipped = fixture({ authority });
      yield* run({
        transitions: Stream.succeed(skipped.transition),
        configuration: Effect.succeed(configuration),
        configurationChanges: Stream.never,
      });
      assert.deepEqual(
        skipped.requests.map(({ method }) => method),
        ["thread.authority"],
      );
    }
  }),
);

it.effect("a preference change cancels delayed admission before any native inference", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const delayedStage of ["configuration", "authority"]) {
        const changes = yield* PubSub.unbounded<void>();
        const entered = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const delayed = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
        const f = fixture(delayedStage === "authority" ? { authorityEffect: delayed } : {});
        const observer = yield* run({
          transitions: Stream.succeed(f.transition),
          configuration: delayedStage === "configuration" ? delayed : Effect.succeed(configuration),
          configurationChanges: Stream.fromPubSub(changes),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* PubSub.publish(changes, undefined);
        yield* Deferred.await(interrupted);
        yield* Fiber.join(observer);
        assert.deepEqual(
          f.requests.map(({ method }) => method),
          delayedStage === "configuration" ? [] : ["thread.authority"],
        );
      }
    }),
  ),
);

it.effect("a preference change also clears inference already owned by the Runtime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      const entered = yield* Deferred.make<void>();
      const f = fixture({
        predictionEffect: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const observer = yield* run({
        transitions: Stream.succeed(f.transition),
        configuration: Effect.succeed(configuration),
        configurationChanges: Stream.fromPubSub(changes),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* PubSub.publish(changes, undefined);
      yield* Fiber.join(observer);
      assert.deepEqual(f.requests.at(-1), {
        method: "native.prediction.clear",
        input: { threadId: "thread:root" },
      });
    }),
  ),
);

it.effect("a retired connection cannot stop predictions for subsequent completed roots", () =>
  Effect.gen(function* () {
    const retired = fixture({
      authorityEffect: Effect.fail(
        new AgentRuntimeProcessError({ reason: "closed", message: "Runtime replaced" }),
      ),
    });
    const current = fixture({ generation: "generation:2" });
    yield* run({
      transitions: Stream.fromIterable([retired.transition, current.transition]),
      configuration: Effect.succeed(configuration),
      configurationChanges: Stream.never,
    });
    assert.equal(
      current.requests.filter(({ method }) => method === "native.prediction.request").length,
      1,
    );
  }),
);

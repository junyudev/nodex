import { assert, it } from "@effect/vitest";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  CodexApplicationIngressOverflow,
  CodexApplicationRequestGenerationUnavailable,
  make,
  makeWithCapacities,
} from "./CodexApplicationRequestInbox";

it.effect("keeps exact request occurrences lossless and settles each at most once", () =>
  Effect.gen(function* () {
    const rootScope = yield* Scope.make();
    const generationScope = yield* Scope.make();
    const inbox = yield* make.pipe(Effect.provideService(Scope.Scope, rootScope));
    const generation = yield* inbox
      .openGeneration("local", 1)
      .pipe(Effect.provideService(Scope.Scope, generationScope));

    const first = yield* generation.admit({
      requestId: 7,
      protocol: "extension",
      method: "approval",
      params: { n: 1 },
    });
    const second = yield* generation.admit({
      requestId: 7,
      protocol: "extension",
      method: "approval",
      params: { n: 2 },
    });
    const admitted = yield* inbox.occurrences.pipe(
      Stream.filter((occurrence) => occurrence.kind === "request"),
      Stream.take(2),
      Stream.runCollect,
    );

    assert.deepEqual([...admitted], [first, second]);
    assert.notStrictEqual(first.occurrenceToken, second.occurrenceToken);
    assert.isTrue(yield* inbox.settle(second, { kind: "result", value: "second" }));
    assert.isTrue(yield* inbox.settle(first, { kind: "result", value: "first" }));
    assert.isFalse(yield* inbox.settle(first, { kind: "result", value: "duplicate" }));

    const settled = yield* generation.settlements.pipe(Stream.take(2), Stream.runCollect);
    assert.deepEqual(
      [...settled].map(({ occurrence, outcome }) => ({
        token: occurrence.occurrenceToken,
        outcome,
      })),
      [
        { token: second.occurrenceToken, outcome: { kind: "result", value: "second" } },
        { token: first.occurrenceToken, outcome: { kind: "result", value: "first" } },
      ],
    );

    yield* Scope.close(generationScope, Exit.void);
    yield* Scope.close(rootScope, Exit.void);
  }),
);

it.effect("namespaces durable occurrence identities across Inbox lifetimes", () =>
  Effect.gen(function* () {
    const admitFirst = (rootScope: Scope.Scope, generationScope: Scope.Scope) =>
      Effect.gen(function* () {
        const inbox = yield* make.pipe(Effect.provideService(Scope.Scope, rootScope));
        const generation = yield* inbox
          .openGeneration("local", 1)
          .pipe(Effect.provideService(Scope.Scope, generationScope));
        return yield* generation.admit({
          requestId: 1,
          protocol: "extension",
          method: "approval",
          params: {},
        });
      });

    const firstRoot = yield* Scope.make();
    const firstGeneration = yield* Scope.make();
    const first = yield* admitFirst(firstRoot, firstGeneration);

    const secondRoot = yield* Scope.make();
    const secondGeneration = yield* Scope.make();
    const second = yield* admitFirst(secondRoot, secondGeneration);

    assert.strictEqual(first.occurrenceToken, 1);
    assert.strictEqual(second.occurrenceToken, 1);
    assert.notStrictEqual(first.occurrenceId, second.occurrenceId);

    yield* Scope.close(firstGeneration, Exit.void);
    yield* Scope.close(firstRoot, Exit.void);
    yield* Scope.close(secondGeneration, Exit.void);
    yield* Scope.close(secondRoot, Exit.void);
  }),
);

it.effect("fences stale generation leases and rejects all live occurrences explicitly", () =>
  Effect.gen(function* () {
    const rootScope = yield* Scope.make();
    const firstScope = yield* Scope.make();
    const inbox = yield* make.pipe(Effect.provideService(Scope.Scope, rootScope));
    const first = yield* inbox
      .openGeneration("remote:a", 4)
      .pipe(Effect.provideService(Scope.Scope, firstScope));
    const outstanding = yield* first.admit({
      requestId: "same",
      protocol: "extension",
      method: "user-input",
      params: {},
    });
    const closing = CodexAppServerRequestError.internalError("Endpoint generation is closing");

    assert.strictEqual(yield* first.rejectOutstanding(closing), 1);
    assert.isFalse(yield* inbox.settle(outstanding, { kind: "abandon" }));
    const rejection = yield* first.settlements.pipe(Stream.runHead);
    assert.strictEqual(rejection._tag, "Some");
    if (rejection._tag === "Some") assert.strictEqual(rejection.value.outcome.kind, "error");

    yield* Scope.close(firstScope, Exit.void);
    const staleExit = yield* first
      .admit({ requestId: "late", protocol: "extension", method: "approval", params: {} })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(staleExit));
    if (Exit.isFailure(staleExit)) {
      assert.strictEqual(
        (Cause.squash(staleExit.cause) as CodexApplicationRequestGenerationUnavailable).reason,
        "closed",
      );
    }

    const replacementScope = yield* Scope.make();
    const replacement = yield* inbox
      .openGeneration("remote:a", 4)
      .pipe(Effect.provideService(Scope.Scope, replacementScope));
    const current = yield* replacement.admit({
      requestId: "same",
      protocol: "extension",
      method: "user-input",
      params: {},
    });
    assert.isTrue(current.occurrenceToken > outstanding.occurrenceToken);

    yield* Scope.close(replacementScope, Exit.void);
    yield* Scope.close(rootScope, Exit.void);
  }),
);

it.effect("withdraws queued and in-flight interpretation when its Endpoint generation closes", () =>
  Effect.gen(function* () {
    const rootScope = yield* Scope.make();
    const generationScope = yield* Scope.make();
    const inbox = yield* make.pipe(Effect.provideService(Scope.Scope, rootScope));
    const generation = yield* inbox
      .openGeneration("remote:a", 9)
      .pipe(Effect.provideService(Scope.Scope, generationScope));
    const inFlight = yield* generation.admit({
      requestId: "in-flight",
      protocol: "extension",
      method: "approval",
      params: {},
    });
    const queued = yield* generation.admit({
      requestId: "queued",
      protocol: "extension",
      method: "user-input",
      params: {},
    });
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const interpretationFiber = yield* inbox
      .interpret(
        inFlight,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(interrupted, undefined)),
        ),
      )
      .pipe(Effect.forkIn(rootScope, { startImmediately: true }));
    yield* Deferred.await(started);

    yield* Scope.close(generationScope, Exit.void);
    assert.deepEqual(yield* Fiber.join(interpretationFiber), { kind: "withdrawn" });
    yield* Deferred.await(interrupted);

    let lateInterpretationRan = false;
    assert.deepEqual(
      yield* inbox.interpret(
        queued,
        Effect.sync(() => {
          lateInterpretationRan = true;
        }),
      ),
      { kind: "withdrawn" },
    );
    assert.isFalse(lateInterpretationRan);
    assert.isFalse(yield* inbox.settle(queued, { kind: "result", value: "stale" }));
    yield* Scope.close(rootScope, Exit.void);
  }),
);

it.effect("fails only the exact generation after a canonical consequence failure", () =>
  Effect.gen(function* () {
    const rootScope = yield* Scope.make();
    const generationScope = yield* Scope.make();
    const inbox = yield* make.pipe(Effect.provideService(Scope.Scope, rootScope));
    const generation = yield* inbox
      .openGeneration("local", 3)
      .pipe(Effect.provideService(Scope.Scope, generationScope));
    const occurrence = yield* generation.admit({
      requestId: "bad-consequence",
      protocol: "extension",
      method: "test/fail",
      params: {},
    });
    const termination = yield* generation.termination.pipe(Effect.flip, Effect.forkChild);

    const cause = new Error("projection failed");
    assert.isTrue(yield* inbox.failGeneration(occurrence, cause));
    assert.isFalse(yield* inbox.failGeneration(occurrence, cause));
    const error = yield* Fiber.join(termination);
    assert.strictEqual(error.hostId, "local");
    assert.strictEqual(error.generation, 3);
    assert.strictEqual(error.occurrenceId, occurrence.occurrenceId);
    assert.strictEqual(error.cause, cause);

    yield* Scope.close(generationScope, Exit.void);
    yield* Scope.close(rootScope, Exit.void);
  }),
);

it.effect("fails closed when canonical occurrence capacity is exhausted", () =>
  Effect.gen(function* () {
    const rootScope = yield* Scope.make();
    const generationScope = yield* Scope.make();
    const inbox = yield* makeWithCapacities({ occurrences: 1, settlements: 1 }).pipe(
      Effect.provideService(Scope.Scope, rootScope),
    );
    const generation = yield* inbox
      .openGeneration("local", 5)
      .pipe(Effect.provideService(Scope.Scope, generationScope));
    const termination = yield* generation.termination.pipe(Effect.flip, Effect.forkChild);

    yield* inbox.publishNotification({
      hostId: "local",
      generation: 5,
      protocol: "extension",
      method: "test/first",
      params: {},
    });
    yield* inbox.publishNotification({
      hostId: "local",
      generation: 5,
      protocol: "extension",
      method: "test/overflow",
      params: {},
    });
    const error = yield* Fiber.join(termination);

    assert.isTrue(Schema.is(CodexApplicationIngressOverflow)(error.cause));
    if (Schema.is(CodexApplicationIngressOverflow)(error.cause)) {
      assert.strictEqual(error.cause.channel, "occurrences");
      assert.strictEqual(error.cause.capacity, 1);
    }
    const late = yield* generation
      .admit({
        requestId: "late",
        protocol: "extension",
        method: "test/late",
        params: {},
      })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(late));
    if (Exit.isFailure(late)) {
      assert.strictEqual(
        (Cause.squash(late.cause) as CodexApplicationRequestGenerationUnavailable).reason,
        "overflow",
      );
    }

    yield* Scope.close(generationScope, Exit.void);
    yield* Scope.close(rootScope, Exit.void);
  }),
);

it.effect(
  "fails a giant occurrence before queue retention and recovers on a fresh generation",
  () =>
    Effect.gen(function* () {
      const rootScope = yield* Scope.make();
      const failedScope = yield* Scope.make();
      const inbox = yield* makeWithCapacities({
        occurrences: 4,
        settlements: 1,
        occurrenceBytes: 16_384,
        singleOccurrenceBytes: 4_096,
      }).pipe(Effect.provideService(Scope.Scope, rootScope));
      const failed = yield* inbox
        .openGeneration("local", 7)
        .pipe(Effect.provideService(Scope.Scope, failedScope));
      const termination = yield* failed.termination.pipe(Effect.flip, Effect.forkChild);

      yield* inbox.publishNotification({
        hostId: "local",
        generation: 7,
        protocol: "extension",
        method: "test/giant",
        params: { text: "x".repeat(8_192) },
      });
      const failure = yield* Fiber.join(termination);
      assert.isTrue(Schema.is(CodexApplicationIngressOverflow)(failure.cause));
      if (Schema.is(CodexApplicationIngressOverflow)(failure.cause)) {
        assert.strictEqual(failure.cause.channel, "occurrence-bytes");
        assert.strictEqual(failure.cause.maximumOccurrenceBytes, 4_096);
      }

      yield* Scope.close(failedScope, Exit.void);
      const recoveredScope = yield* Scope.make();
      const recovered = yield* inbox
        .openGeneration("local", 8)
        .pipe(Effect.provideService(Scope.Scope, recoveredScope));
      yield* inbox.publishNotification({
        hostId: "local",
        generation: 8,
        protocol: "extension",
        method: "test/recovered",
        params: { text: "small" },
      });
      const delivered = yield* inbox.occurrences.pipe(Stream.take(1), Stream.runCollect);
      assert.strictEqual([...delivered][0]?.method, "test/recovered");
      assert.strictEqual(recovered.generation, 8);

      yield* Scope.close(recoveredScope, Exit.void);
      yield* Scope.close(rootScope, Exit.void);
    }),
);

it.effect(
  "releases all 4096 FIFO byte reservations after consumption before enforcing the next overflow",
  () =>
    Effect.gen(function* () {
      const rootScope = yield* Scope.make();
      const generationScope = yield* Scope.make();
      const inbox = yield* makeWithCapacities({
        occurrences: 4_096,
        settlements: 1,
        occurrenceBytes: 8 * 1024 * 1024,
        singleOccurrenceBytes: 8 * 1024,
      }).pipe(Effect.provideService(Scope.Scope, rootScope));
      const generation = yield* inbox
        .openGeneration("local", 9)
        .pipe(Effect.provideService(Scope.Scope, generationScope));

      const publishSmall = (index: number) =>
        inbox.publishNotification({
          hostId: "local",
          generation: 9,
          protocol: "extension",
          method: `test/small/${index}`,
          params: { index },
        });
      const indexes = Array.from({ length: 4_096 }, (_, index) => index);
      yield* Effect.forEach(indexes, publishSmall, { discard: true });
      const consumed = yield* inbox.occurrences.pipe(Stream.take(4_096), Stream.runCollect);
      assert.strictEqual([...consumed].length, 4_096);

      yield* publishSmall(4_096);
      const recovered = yield* inbox.occurrences.pipe(Stream.take(1), Stream.runCollect);
      assert.strictEqual([...recovered][0]?.method, "test/small/4096");

      const termination = yield* generation.termination.pipe(Effect.flip, Effect.forkChild);
      yield* Effect.forEach(indexes, publishSmall, { discard: true });
      yield* inbox.publishNotification({
        hostId: "local",
        generation: 9,
        protocol: "extension",
        method: "test/overflow-after-recovery",
        params: {},
      });
      const failure = yield* Fiber.join(termination);
      assert.isTrue(Schema.is(CodexApplicationIngressOverflow)(failure.cause));
      if (Schema.is(CodexApplicationIngressOverflow)(failure.cause)) {
        assert.strictEqual(failure.cause.channel, "occurrences");
        assert.strictEqual(failure.cause.capacity, 4_096);
      }

      yield* Scope.close(generationScope, Exit.void);
      yield* Scope.close(rootScope, Exit.void);
    }),
);

it.effect("fails the exact generation instead of dropping a request settlement", () =>
  Effect.gen(function* () {
    const rootScope = yield* Scope.make();
    const generationScope = yield* Scope.make();
    const inbox = yield* makeWithCapacities({ occurrences: 4, settlements: 1 }).pipe(
      Effect.provideService(Scope.Scope, rootScope),
    );
    const generation = yield* inbox
      .openGeneration("remote:a", 6)
      .pipe(Effect.provideService(Scope.Scope, generationScope));
    const first = yield* generation.admit({
      requestId: "first",
      protocol: "extension",
      method: "test/first",
      params: {},
    });
    const second = yield* generation.admit({
      requestId: "second",
      protocol: "extension",
      method: "test/second",
      params: {},
    });
    const termination = yield* generation.termination.pipe(Effect.flip, Effect.forkChild);

    assert.isTrue(yield* inbox.settle(first, { kind: "result", value: null }));
    assert.isFalse(yield* inbox.settle(second, { kind: "result", value: null }));
    const error = yield* Fiber.join(termination);

    assert.isTrue(Schema.is(CodexApplicationIngressOverflow)(error.cause));
    if (Schema.is(CodexApplicationIngressOverflow)(error.cause)) {
      assert.strictEqual(error.cause.channel, "settlements");
      assert.strictEqual(error.cause.capacity, 1);
    }
    yield* Scope.close(generationScope, Exit.void);
    yield* Scope.close(rootScope, Exit.void);
  }),
);

import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { CodexApplicationNotificationOccurrence } from "../../codex-runtime/CodexApplicationRequestInbox";
import { ConversationEntityMap, live as conversationEntityMapLive } from "./ConversationEntityMap";

const build = Effect.fn("ConversationEntityMapTest.build")(function* (scope: Scope.Scope) {
  const context = yield* Layer.buildWithScope(conversationEntityMapLive, scope);
  return Context.get(context, ConversationEntityMap);
});

it.effect("serializes commands admitted to the same Thread generation", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const conversations = yield* build(scope);
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const order: string[] = [];
    const first = yield* conversations
      .runCommand(
        "thread-a",
        Effect.sync(() => order.push("first:start")).pipe(
          Effect.andThen(Deferred.succeed(firstStarted, undefined)),
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.andThen(Effect.sync(() => order.push("first:end"))),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(firstStarted);
    const second = yield* conversations
      .runCommand(
        "thread-a",
        Effect.sync(() => order.push("second")),
      )
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;

    assert.deepEqual(order, ["first:start"]);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.deepEqual(order, ["first:start", "first:end", "second"]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps different Thread generations causally independent", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const conversations = yield* build(scope);
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const first = yield* conversations
      .runCommand(
        "thread-a",
        Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(firstStarted);
    const second = yield* conversations
      .runCommand("thread-b", Deferred.succeed(secondStarted, undefined))
      .pipe(Effect.forkChild);

    yield* Deferred.await(secondStarted);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("marks every loaded generation non-live after connection loss", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const conversations = yield* build(scope);
    const first = conversations.entity("thread-a");
    const second = conversations.entity("thread-b");
    first.setResumeState("resumed");
    first.setStreamRole("owner");
    first.setStreaming(true);
    second.setResumeState("resuming");
    second.setStreamRole("follower");
    second.setStreaming(true);

    assert.deepEqual(conversations.markAllNeedsResume(), ["thread-a", "thread-b"]);

    for (const aggregate of [first, second]) {
      assert.strictEqual(aggregate.readResumeState(), "needs_resume");
      assert.isNull(aggregate.readStreamRole());
      assert.isFalse(aggregate.isStreaming());
    }
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("never mixes deferred Thread starts across host generations", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const conversations = yield* build(scope);
    const aggregate = conversations.entity("thread-generation-fence");
    const occurrence = (generation: number): CodexApplicationNotificationOccurrence => ({
      kind: "notification",
      protocol: "generated",
      hostId: "local",
      generation,
      occurrenceId: `local:${generation}:started`,
      occurrenceToken: generation,
      method: "thread/started",
      params: { thread: { id: "thread-generation-fence", turns: [] } },
    });

    assert.strictEqual(
      aggregate.offerProtocolOccurrence({
        occurrence: occurrence(1),
        startsThread: true,
        deferThreadStart: { hostId: "local", generation: 1 },
      }),
      "buffered",
    );
    assert.strictEqual(
      aggregate.offerProtocolOccurrence({
        occurrence: occurrence(2),
        startsThread: true,
        deferThreadStart: { hostId: "local", generation: 2 },
      }),
      "generation-mismatch",
    );
    assert.deepEqual(aggregate.takeThreadStartEventBuffer({ hostId: "local", generation: 2 }), {
      kind: "generation-mismatch",
      events: [occurrence(1)],
    });
    assert.isNull(aggregate.takeThreadStartEventBuffer({ hostId: "local", generation: 1 }));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("close interrupts the live lane and fences it from the next generation", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const conversations = yield* build(scope);
    const aggregate = conversations.entity("thread-a");
    const firstGeneration = aggregate.generation;
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    let queuedEntered = false;
    const active = yield* conversations
      .runCommand(
        "thread-a",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const queued = yield* conversations
      .runCommand(
        "thread-a",
        Effect.sync(() => {
          queuedEntered = true;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;

    yield* conversations.retire("thread-a");
    yield* Deferred.await(interrupted);
    assert.strictEqual((yield* Fiber.await(active))._tag, "Failure");
    assert.strictEqual((yield* Fiber.await(queued))._tag, "Failure");
    assert.isFalse(queuedEntered);
    assert.isNull(conversations.current("thread-a"));

    yield* conversations.runCommand("thread-a", Effect.void);
    const secondGeneration = conversations.current("thread-a")?.generation;
    assert.isDefined(secondGeneration);
    assert.notStrictEqual(secondGeneration, firstGeneration);

    aggregate.reset();
    assert.strictEqual(conversations.current("thread-a")?.generation, secondGeneration);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("Main Scope close interrupts every lane and releases aggregate generations", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const conversations = yield* build(ownerScope);
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const active = yield* conversations
      .runCommand(
        "thread-a",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);

    yield* Scope.close(ownerScope, Exit.void);
    yield* Deferred.await(interrupted);
    assert.strictEqual((yield* Fiber.await(active))._tag, "Failure");
    assert.isNull(conversations.current("thread-a"));
  }),
);

it.effect(
  "drains accepted execution before sealing handoff and leaves recovery commands available",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const conversations = yield* build(scope);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const moving = yield* Deferred.make<void>();
      const finishMove = yield* Deferred.make<void>();
      const admission = yield* conversations
        .admitExecution(
          "thread-a",
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const move = yield* conversations
        .withExecutionHandoff(
          "thread-a",
          Deferred.succeed(moving, undefined).pipe(Effect.andThen(Deferred.await(finishMove))),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(moving));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(admission);
      yield* Deferred.await(moving);
      const rejected = yield* conversations
        .admitExecution("thread-a", Effect.die("must not submit"))
        .pipe(Effect.result);
      assert.strictEqual(rejected._tag, "Failure");
      let recovered = false;
      yield* conversations.runCommand(
        "thread-a",
        Effect.sync(() => {
          recovered = true;
        }),
      );
      assert.isTrue(recovered);
      yield* conversations.admitExecution("other-thread", Effect.void);
      yield* Deferred.succeed(finishMove, undefined);
      yield* Fiber.join(move);
      yield* conversations.admitExecution("thread-a", Effect.void);
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("reopens admission after handoff fails or is interrupted", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const conversations = yield* build(scope);
    const failed = yield* conversations
      .withExecutionHandoff("thread-a", Effect.fail("move failed"))
      .pipe(Effect.result);
    assert.strictEqual(failed._tag, "Failure");
    yield* conversations.admitExecution("thread-a", Effect.void);
    const started = yield* Deferred.make<void>();
    const moving = yield* conversations
      .withExecutionHandoff(
        "thread-a",
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(moving);
    yield* conversations.admitExecution("thread-a", Effect.void);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "retains recovery admission protection across Thread retirement until verified repair",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const conversations = yield* build(scope);
      const before = yield* conversations.executionEpoch("thread-a");
      yield* conversations.withExecutionHandoff(
        "thread-a",
        conversations.setRecoveryRequired("thread-a", true),
      );
      const rejected = yield* conversations
        .admitExecution("thread-a", Effect.die("must not execute"))
        .pipe(Effect.result);
      assert.strictEqual(rejected._tag, "Failure");
      yield* conversations.retire("thread-a");
      const reopened = yield* conversations
        .admitExecution("thread-a", Effect.die("must remain blocked"))
        .pipe(Effect.result);
      assert.strictEqual(reopened._tag, "Failure");
      yield* conversations.withExecutionHandoff(
        "thread-a",
        conversations.setRecoveryRequired("thread-a", false),
      );
      const stale = yield* conversations
        .admitExecution("thread-a", Effect.die("old receipt"), before)
        .pipe(Effect.result);
      assert.strictEqual(stale._tag, "Failure");
      yield* conversations.admitExecution(
        "thread-a",
        Effect.void,
        yield* conversations.executionEpoch("thread-a"),
      );
      yield* Scope.close(scope, Exit.void);
    }),
);

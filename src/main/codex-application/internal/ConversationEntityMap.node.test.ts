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
    conversations.entity("thread-a");
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
    conversations.entity("thread-a");
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
    conversations.entity("thread-a");
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
    conversations.entity("thread-a");
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
    conversations.entity("thread-a");
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

    yield* conversations.runCommand(
      "thread-a",
      Effect.sync(() => conversations.entity("thread-a")),
    );
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
    conversations.entity("thread-a");
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

it.effect.each([true, false])(
  "replacement admission cannot inherit an aggregate whose old cleanup is still settling (materialized: %s)",
  (materialized) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const conversations = yield* build(scope);
      if (materialized) conversations.entity("thread-a");
      const retiredGenerations: number[] = [];
      const subscription = conversations.subscribeRetired((_id, generation) =>
        retiredGenerations.push(generation),
      );
      const entered = yield* Deferred.make<void>();
      const cleanupEntered = yield* Deferred.make<void>();
      const finishCleanup = yield* Deferred.make<void>();
      const replacementEntered = yield* Deferred.make<void>();
      const finishReplacement = yield* Deferred.make<void>();
      const old = yield* conversations
        .runCommand(
          "thread-a",
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(cleanupEntered, undefined).pipe(
                Effect.andThen(Deferred.await(finishCleanup)),
              ),
            ),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      if (!materialized) assert.isNull(conversations.current("thread-a"));
      const retiring = yield* conversations.retire("thread-a").pipe(Effect.forkChild);
      yield* Deferred.await(cleanupEntered);
      const replacement = yield* conversations
        .runCommand(
          "thread-a",
          Effect.sync(() => conversations.entity("thread-a")).pipe(
            Effect.andThen(Deferred.succeed(replacementEntered, undefined)),
            Effect.andThen(Deferred.await(finishReplacement)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(replacementEntered);
      const replacementEntity = conversations.current("thread-a")!;
      assert.strictEqual(retiredGenerations.length, 1);
      assert.notStrictEqual(replacementEntity.generation, retiredGenerations[0]);
      yield* Deferred.succeed(finishCleanup, undefined);
      yield* Fiber.join(retiring);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(old)));
      assert.strictEqual(conversations.current("thread-a"), replacementEntity);
      yield* Deferred.succeed(finishReplacement, undefined);
      yield* Fiber.join(replacement);
      subscription[Symbol.dispose]();
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect(
  "a rejected terminal result preserves the generation and pending terminal work remains cancellable",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const conversations = yield* build(scope);
      conversations.entity("thread-a");
      assert.isFalse(
        yield* conversations.runTerminalCommand("thread-a", Effect.succeed(false), (v) => v),
      );
      const entity = conversations.current("thread-a");
      const rejected = yield* conversations
        .runTerminalCommand("thread-a", Effect.fail("denied"), () => true)
        .pipe(Effect.result);
      assert.strictEqual(rejected._tag, "Failure");
      yield* conversations.runCommand("thread-a", Effect.void);
      assert.strictEqual(conversations.current("thread-a"), entity);
      const entered = yield* Deferred.make<void>();
      const terminal = yield* conversations
        .runTerminalCommand(
          "thread-a",
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          () => true,
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      let queuedEntered = false;
      const queued = yield* conversations
        .runCommand(
          "thread-a",
          Effect.sync(() => {
            queuedEntered = true;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(terminal)));
      assert.isTrue(Exit.isFailure(yield* Fiber.await(queued)));
      assert.isFalse(queuedEntered);
      assert.isNull(conversations.current("thread-a"));
    }),
);

it.effect(
  "drains accepted execution before sealing handoff and leaves recovery commands available",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const conversations = yield* build(scope);
      conversations.entity("thread-a");
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const moving = yield* Deferred.make<void>();
      const finishMove = yield* Deferred.make<void>();
      const admission = yield* conversations
        .admitExecution(
          "thread-a",
          { hostId: "local", generation: 1 },
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
        .admitExecution(
          "thread-a",
          { hostId: "local", generation: 1 },
          Effect.die("must not submit"),
        )
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
      yield* conversations.admitExecution(
        "other-thread",
        { hostId: "local", generation: 1 },
        Effect.void,
      );
      yield* Deferred.succeed(finishMove, undefined);
      yield* Fiber.join(move);
      yield* conversations.admitExecution(
        "thread-a",
        { hostId: "local", generation: 1 },
        Effect.void,
      );
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("reopens admission after handoff fails or is interrupted", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const conversations = yield* build(scope);
    conversations.entity("thread-a");
    const failed = yield* conversations
      .withExecutionHandoff("thread-a", Effect.fail("move failed"))
      .pipe(Effect.result);
    assert.strictEqual(failed._tag, "Failure");
    yield* conversations.admitExecution(
      "thread-a",
      { hostId: "local", generation: 1 },
      Effect.void,
    );
    const started = yield* Deferred.make<void>();
    const moving = yield* conversations
      .withExecutionHandoff(
        "thread-a",
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(moving);
    yield* conversations.admitExecution(
      "thread-a",
      { hostId: "local", generation: 1 },
      Effect.void,
    );
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("Profile close interrupts a handoff still waiting for an active execution permit", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const conversations = yield* build(scope);
    conversations.entity("thread-a");
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const active = yield* conversations
      .admitExecution(
        "thread-a",
        { hostId: "local", generation: 1 },
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    let handoffEntered = false;
    const handoff = yield* conversations
      .withExecutionHandoff(
        "thread-a",
        Effect.sync(() => {
          handoffEntered = true;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const closing = yield* Scope.close(scope, Exit.void).pipe(
      Effect.andThen(Deferred.succeed(closed, undefined)),
      Effect.forkChild,
    );
    yield* Effect.gen(function* () {
      for (let attempt = 0; attempt < 20 && !(yield* Deferred.isDone(closed)); attempt += 1) {
        yield* Effect.yieldNow;
      }
      assert.isTrue(yield* Deferred.isDone(closed));
      assert.isTrue(yield* Deferred.isDone(interrupted));
      assert.isFalse(handoffEntered);
      assert.isNull(conversations.current("thread-a"));
      assert.isTrue(Exit.isFailure(yield* Fiber.await(active)));
      assert.isTrue(Exit.isFailure(yield* Fiber.await(handoff)));
    }).pipe(
      Effect.ensuring(
        Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(closing))),
      ),
    );
  }),
);

it.effect(
  "native closure targets a cold execution lease and caller cancellation clears that lease",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const conversations = yield* build(scope);
      const entered = yield* Deferred.make<void>();
      const execution = yield* conversations
        .admitExecution(
          "cold",
          { hostId: "local", generation: 1 },
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.isNull(conversations.current("cold")?.readCanonicalState());
      assert.isNull(
        conversations.captureNativeTerminalTarget("cold", { hostId: "remote", generation: 1 }),
      );
      assert.isNull(
        conversations.captureNativeTerminalTarget("cold", { hostId: "local", generation: 2 }),
      );
      const target = conversations.captureNativeTerminalTarget("cold", {
        hostId: "local",
        generation: 1,
      });
      assert.isNotNull(target);
      yield* conversations.runThreadObservation("cold", Effect.succeed(true), {
        generation: target!,
        isTerminal: Boolean,
      });
      assert.isTrue(Exit.isFailure(yield* Fiber.await(execution)));
      assert.isNull(conversations.current("cold"));
      const nextEntered = yield* Deferred.make<void>();
      const pending = yield* conversations
        .admitExecution(
          "cold",
          { hostId: "local", generation: 1 },
          Deferred.succeed(nextEntered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(nextEntered);
      yield* Fiber.interrupt(pending);
      assert.isNull(
        conversations.captureNativeTerminalTarget("cold", { hostId: "local", generation: 1 }),
      );
      yield* conversations.runCommand("cold", Effect.void);
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("temporary lane borrowing does not own resources acquired in the caller Scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const callerScope = yield* Scope.make();
    const conversations = yield* build(scope);
    conversations.entity("thread-a");
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let released = 0;
    const command = yield* conversations
      .runCommand(
        "thread-a",
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              released += 1;
            }),
          );
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(finish);
        }),
      )
      .pipe(Effect.provideService(Scope.Scope, callerScope), Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Effect.yieldNow;
    assert.strictEqual(released, 0);
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(command);
    assert.strictEqual(released, 0);
    yield* Scope.close(callerScope, Exit.void);
    assert.strictEqual(released, 1);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "global observations serialize with workspace changes without creating native authority",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const conversations = yield* build(scope);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order: string[] = [];
      const observation = yield* conversations
        .runThreadObservation(
          "cold-global",
          Effect.gen(function* () {
            order.push("read-source-host");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            order.push("delete-source-row");
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.isNull(conversations.current("cold-global"));
      const handoff = yield* conversations
        .runCommand(
          "cold-global",
          Effect.sync(() => {
            order.push("commit-other-host");
          }),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepEqual(order, ["read-source-host"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(observation);
      yield* Fiber.join(handoff);
      assert.deepEqual(order, ["read-source-host", "delete-source-row", "commit-other-host"]);
      assert.isNull(conversations.current("cold-global"));
      assert.isNull(
        conversations.captureNativeTerminalTarget("cold-global", {
          hostId: "local",
          generation: 1,
        }),
      );
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("Profile closure cannot readmit a global observation waiting behind a command", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const conversations = yield* build(scope);
    const entered = yield* Deferred.make<void>();
    const active = yield* conversations
      .runCommand(
        "cold-global",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    let applications = 0;
    const waiting = yield* conversations
      .runThreadObservation(
        "cold-global",
        Effect.sync(() => {
          applications += 1;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(active)));
    assert.isTrue(Exit.isFailure(yield* Fiber.await(waiting)));
    assert.strictEqual(applications, 0);
    assert.isNull(conversations.current("cold-global"));
  }),
);

it.effect(
  "cancelling a waiting global observation cannot replay it after terminal retirement",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const conversations = yield* build(scope);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const terminal = yield* conversations
        .runTerminalCommand(
          "cold-global",
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(true),
          ),
          Boolean,
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      let applications = 0;
      const waiting = yield* conversations
        .runThreadObservation(
          "cold-global",
          Effect.sync(() => {
            applications += 1;
          }),
        )
        .pipe(
          Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
          Effect.forkChild,
        );
      yield* Effect.yieldNow;
      const cancelling = yield* Fiber.interrupt(waiting).pipe(Effect.forkChild);
      yield* Deferred.await(cancelled);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(cancelling);
      assert.isTrue(yield* Fiber.join(terminal));
      assert.isTrue(Exit.isFailure(yield* Fiber.await(waiting)));
      assert.strictEqual(applications, 0);
      yield* conversations.runCommand("cold-global", Effect.void);
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect(
  "caller cancellation after terminal acceptance cannot strand or close a replacement",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const conversations = yield* build(scope);
      conversations.entity("thread-a");
      const entered = yield* Deferred.make<void>();
      const cleanupEntered = yield* Deferred.make<void>();
      const finishCleanup = yield* Deferred.make<void>();
      const active = yield* conversations
        .admitExecution(
          "thread-a",
          { hostId: "local", generation: 1 },
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(cleanupEntered, undefined).pipe(
                Effect.andThen(Deferred.await(finishCleanup)),
              ),
            ),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const previous = conversations.current("thread-a");
      const terminal = yield* conversations
        .runTerminalCommand("thread-a", Effect.succeed(true), (result) => result)
        .pipe(Effect.forkChild);
      yield* Deferred.await(cleanupEntered);
      const cancelled = yield* Fiber.interrupt(terminal).pipe(Effect.forkChild);
      yield* conversations.runCommand(
        "thread-a",
        Effect.sync(() => conversations.entity("thread-a")),
      );
      const replacement = conversations.current("thread-a");
      assert.isNotNull(replacement);
      assert.notStrictEqual(replacement?.generation, previous?.generation);
      yield* Deferred.succeed(finishCleanup, undefined);
      yield* Fiber.join(cancelled);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(active)));
      assert.strictEqual(conversations.current("thread-a"), replacement);
      yield* conversations.runCommand("thread-a", Effect.void);
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect(
  "retains recovery admission protection across Thread retirement until verified repair",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const conversations = yield* build(scope);
      conversations.entity("thread-a");
      const before = yield* conversations.executionEpoch("thread-a");
      yield* conversations.withExecutionHandoff(
        "thread-a",
        conversations.setRecoveryRequired("thread-a", true),
      );
      const rejected = yield* conversations
        .admitExecution(
          "thread-a",
          { hostId: "local", generation: 1 },
          Effect.die("must not execute"),
        )
        .pipe(Effect.result);
      assert.strictEqual(rejected._tag, "Failure");
      yield* conversations.retire("thread-a");
      const reopened = yield* conversations
        .admitExecution(
          "thread-a",
          { hostId: "local", generation: 1 },
          Effect.die("must remain blocked"),
        )
        .pipe(Effect.result);
      assert.strictEqual(reopened._tag, "Failure");
      yield* conversations.withExecutionHandoff(
        "thread-a",
        conversations.setRecoveryRequired("thread-a", false),
      );
      const stale = yield* conversations
        .admitExecution(
          "thread-a",
          { hostId: "local", generation: 1 },
          Effect.die("old receipt"),
          before,
        )
        .pipe(Effect.result);
      assert.strictEqual(stale._tag, "Failure");
      yield* conversations.admitExecution(
        "thread-a",
        { hostId: "local", generation: 1 },
        Effect.void,
        yield* conversations.executionEpoch("thread-a"),
      );
      yield* Scope.close(scope, Exit.void);
    }),
);

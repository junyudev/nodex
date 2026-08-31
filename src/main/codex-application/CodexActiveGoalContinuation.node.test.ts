import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { ConversationEntityState } from "./internal/ConversationEntityState";
import { make } from "./CodexActiveGoalContinuation";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

const activeConversation = (): ConversationEntityState =>
  ({
    readResumeState: () => "resumed",
    readSnapshot: () => ({
      threadGoal: { status: "active" },
      latestThreadSettings: { summary: "detailed" },
      pendingSteers: [],
      statusType: "idle",
      statusActiveFlags: [],
    }),
    readCanonicalState: () => ({ turns: [] }),
    readServerRequests: () => [],
    readStreamRole: () => "owner",
    isStreaming: () => true,
  }) as unknown as ConversationEntityState;

const makeRuntime = (input: {
  readonly eligible: () => boolean;
  readonly subagentsSettled?: () => boolean;
  readonly continueGoal: () => Effect.Effect<void>;
  readonly events?: CodexApplicationEventHub["Service"]["events"];
}) =>
  make.pipe(
    Effect.provideService(
      CodexApplicationEventHub,
      CodexApplicationEventHub.of({
        events: input.events ?? Stream.empty,
        publish: () => undefined,
      }),
    ),
    Effect.provideService(
      ConversationEntityMap,
      ConversationEntityMap.of({
        current: () => (input.eligible() ? activeConversation() : null),
      } as unknown as ConversationEntityMap["Service"]),
    ),
    Effect.provideService(
      CodexSubagentDirectory,
      CodexSubagentDirectory.of({
        readOverview: () => {
          const settled = input.subagentsSettled?.() ?? true;
          return Effect.succeed({
            rootThreadId: "thread-1",
            revision: 1,
            generation: 1,
            completeness: settled ? "complete" : "incomplete",
            active: {
              rows: [],
              knownCount: settled ? 0 : 1,
              totalCount: settled ? 0 : null,
              continuation: null,
            },
            done: {
              rows: [],
              knownCount: 0,
              totalCount: settled ? 0 : null,
              continuation: null,
            },
          });
        },
      } as unknown as CodexSubagentDirectory["Service"]),
    ),
    Effect.provideService(
      CodexThreadSettingsRuntime,
      CodexThreadSettingsRuntime.of({
        awaitCurrent: () => Effect.void,
        update: () => Effect.die("the active fixture already has the canonical summary"),
        remoteUpdateSupport: () => "supported",
      } as unknown as CodexThreadSettingsRuntime["Service"]),
    ),
    Effect.provideService(
      CodexThreadGoalRuntime,
      CodexThreadGoalRuntime.of({
        set: () => input.continueGoal().pipe(Effect.as(null)),
      } as unknown as CodexThreadGoalRuntime["Service"]),
    ),
    Effect.provideService(
      CodexTurnCommands,
      CodexTurnCommands.of({
        continueGoal: () => Effect.die("supported settings continue through thread/goal/set"),
      } as unknown as CodexTurnCommands["Service"]),
    ),
  );

it.effect("coalesces callers behind one delayed semantic continuation", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const release = yield* Deferred.make<void>();
    const runtime = yield* makeRuntime({
      eligible: () => true,
      continueGoal: () =>
        Effect.sync(() => {
          attempts += 1;
        }).pipe(Effect.andThen(Deferred.await(release))),
    });
    yield* runtime.request("thread-1");
    yield* runtime.request("thread-1");

    yield* TestClock.adjust("249 millis");
    assert.strictEqual(attempts, 0);
    yield* TestClock.adjust("1 millis");
    assert.strictEqual(attempts, 1);
    yield* Deferred.succeed(release, undefined);
    yield* Effect.yieldNow;
  }),
);

it.effect("rechecks canonical eligibility after the continuation delay", () =>
  Effect.gen(function* () {
    let eligible = true;
    let attempts = 0;
    const runtime = yield* makeRuntime({
      eligible: () => eligible,
      continueGoal: () => Effect.sync(() => void (attempts += 1)),
    });
    yield* runtime.request("thread-1");
    eligible = false;
    yield* TestClock.adjust("1 second");
    assert.strictEqual(attempts, 0);
  }),
);

it.effect("waits for a complete and settled subagent tree before continuing", () =>
  Effect.gen(function* () {
    let settled = false;
    let attempts = 0;
    const runtime = yield* makeRuntime({
      eligible: () => true,
      subagentsSettled: () => settled,
      continueGoal: () => Effect.sync(() => void (attempts += 1)),
    });

    yield* runtime.request("thread-1");
    yield* TestClock.adjust("1 second");
    assert.strictEqual(attempts, 0);

    settled = true;
    yield* runtime.request("thread-1");
    yield* TestClock.adjust("1 second");
    assert.strictEqual(attempts, 1);
  }),
);

it.effect("retries when a repair invalidation lands after an incomplete tree check", () =>
  Effect.gen(function* () {
    let settled = false;
    let attempts = 0;
    const invalidations = yield* PubSub.unbounded<never>();
    const runtime = yield* makeRuntime({
      eligible: () => true,
      subagentsSettled: () => settled,
      continueGoal: () => Effect.sync(() => void (attempts += 1)),
      events: Stream.fromPubSub(invalidations),
    });

    yield* runtime.request("thread-1");
    yield* TestClock.adjust("250 millis");
    assert.strictEqual(attempts, 0);

    settled = true;
    yield* PubSub.publish(invalidations, {
      kind: "codex",
      value: { type: "subagentOverviewInvalidated", rootThreadId: "thread-1" },
    } as never);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("250 millis");
    assert.strictEqual(attempts, 1);
  }),
);

it.effect("clears a pending keyed continuation", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const runtime = yield* makeRuntime({
      eligible: () => true,
      continueGoal: () => Effect.sync(() => void (attempts += 1)),
    });
    yield* runtime.request("thread-1");
    yield* runtime.clear("thread-1");
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(attempts, 0);
  }),
);

it.effect("interrupts active continuation work when its Scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let attempts = 0;
    let interrupted = false;
    const release = yield* Deferred.make<void>();
    const runtime = yield* makeRuntime({
      eligible: () => true,
      continueGoal: () => {
        attempts += 1;
        return Deferred.await(release).pipe(
          Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
        );
      },
    }).pipe(Effect.provideService(Scope.Scope, scope));
    yield* runtime.request("thread-1");
    yield* TestClock.adjust("250 millis");
    assert.strictEqual(attempts, 1);
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(interrupted);
  }),
);

import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { assert, it } from "@effect/vitest";
import type { TurnStartResponse } from "@nodex/codex-app-server-protocol/v2/TurnStartResponse";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { CodexTurnPresentation } from "./CodexTurnPresentation";
import { CodexAutoThreadTitle } from "./CodexAutoThreadTitle";
import {
  make,
  type CodexFreshThreadLaunch,
  type CodexFreshThreadLaunchIdentity,
} from "./CodexFreshThreadLaunchRuntime";
import { CodexThreadLaunchCompletion } from "./CodexThreadLaunchCompletion";
import { CodexTurnCommands } from "./CodexTurnCommands";

const launch = (): CodexFreshThreadLaunch =>
  ({
    nativeStart: { hostId: "local", generation: 1, response: { thread: { id: "thread-1" } } },
    launchId: "launch-1",
    rendererClientId: "renderer-1",
    projectId: "project-1",
    sessionId: "session-1",
    threadId: "thread-1",
    runInTarget: "localProject",
    startedAt: 1,
    clientUserMessageId: "message-1",
    firstTurn: { prompt: "Hello", overrides: { clientUserMessageId: "message-1" } },
    goalObjective: "",
    rawGoalDraft: null,
    heartbeatAutomation: null,
  }) as unknown as CodexFreshThreadLaunch;

const identity: CodexFreshThreadLaunchIdentity = {
  launchId: "launch-1",
  ownerClientId: "renderer-1",
  threadId: "thread-1",
};

const request = { threadId: "thread-1", input: [], clientUserMessageId: "message-1" };

const turnStart = (): TurnStartResponse =>
  ({ turn: { id: "turn-1", status: "inProgress", items: [] } }) as unknown as TurnStartResponse;

interface HarnessOptions {
  readonly beforeAdopt?: Effect.Effect<void>;
  readonly start?: Effect.Effect<TurnStartResponse>;
  readonly rollback?: () => void;
}

const makeHarness = (options: HarnessOptions = {}) => {
  let adoptionCalls = 0;
  const failures: string[] = [];
  const retired = new Set<() => void>();
  const released: unknown[] = [];
  const managers = CodexMainConversationManagers.of({ get: () => (options.beforeAdopt ?? Effect.void).pipe(Effect.map(() => {
    adoptionCalls++;
    return { hostId: "local", generation: 1, assertCurrent: () => {}, onDispose: (callback: () => void) => { retired.add(callback); return { [Symbol.dispose]: () => retired.delete(callback) }; }, findOwner: async () => "renderer-1" };
  })) } as unknown as CodexMainConversationManagers["Service"]);
  const acceptedPlans: Parameters<CodexTurnCommands["Service"]["prepareNativeStart"]>[2][] = [];
  const turns = CodexTurnCommands.of({
    prepareNativeStart: (_threadId: string, _prompt: string, overrides: Parameters<CodexTurnCommands["Service"]["prepareNativeStart"]>[2]) => Effect.sync(() => {
      acceptedPlans.push(overrides);
      return { request, context: {} };
    }),
    releasePreparedNativeStart: () => {},
    executePreparedNativeStart: () => (options.start ?? Effect.succeed(turnStart())).pipe(
      Effect.onExit((exit) => Exit.isFailure(exit) ? Effect.sync(() => options.rollback?.()) : Effect.void),
    ),
  } as unknown as CodexTurnCommands["Service"]);
  const completion = CodexThreadLaunchCompletion.of({
    accepted: () => Effect.void,
    failed: (_launch, message) => {
      failures.push(message ?? "failed");
    },
  });
  const runtime = make.pipe(
    Effect.provideService(CodexMainConversationManagers, managers),
    Effect.provideService(CodexThreadLaunchCompletion, completion),
    Effect.provideService(CodexTurnCommands, turns),
    Effect.provideService(CodexTurnPresentation, CodexTurnPresentation.of({ releaseClaim: (claim: unknown) => released.push(claim) } as never)),
    Effect.provideService(
      CodexAutoThreadTitle,
      CodexAutoThreadTitle.of({
        scheduleFirstTurn: () => Effect.void,
        scheduleAddedThread: () => Effect.void,
      }),
    ),
  );
  return { adoptionCalls: () => adoptionCalls, failures, runtime, acceptedPlans, released, retire: () => { for (const callback of [...retired]) callback(); } };
};

it.effect("single-flights renderer adoption and the first Turn start", () =>
  Effect.gen(function* () {
    const releaseAdoption = yield* Deferred.make<void>();
    const releaseStart = yield* Deferred.make<void>();
    let starts = 0;
    const harness = makeHarness({
      beforeAdopt: Deferred.await(releaseAdoption),
      start: Effect.sync(() => {
        starts += 1;
      }).pipe(Effect.andThen(Deferred.await(releaseStart)), Effect.as(turnStart())),
    });
    const service = yield* harness.runtime;
    service.register(launch());
    const firstAdoption = yield* Effect.forkChild(service.adopt(identity), {
      startImmediately: true,
    });
    const secondAdoption = yield* Effect.forkChild(service.adopt(identity), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseAdoption, undefined);
    yield* Fiber.join(firstAdoption);
    yield* Fiber.join(secondAdoption);
    assert.strictEqual(harness.adoptionCalls(), 1);

    yield* service.prepare(identity);
    const firstStart = yield* Effect.forkChild(service.start(identity, request), { startImmediately: true });
    const secondStart = yield* Effect.forkChild(service.start(identity, request), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    assert.strictEqual(starts, 1);
    yield* Deferred.succeed(releaseStart, undefined);
    yield* Fiber.join(firstStart);
    yield* Fiber.join(secondStart);
    assert.isNull(service.reservation(identity.threadId));
  }),
);

it.effect("interrupts an active first Turn when the owning Scope closes", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const started = yield* Deferred.make<void>();
    let rollbacks = 0;
    const harness = makeHarness({
      start: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      rollback: () => {
        rollbacks += 1;
      },
    });
    const service = yield* harness.runtime.pipe(Effect.provideService(Scope.Scope, ownerScope));
    service.register(launch());
    yield* service.adopt(identity);
    yield* service.prepare(identity);
    const fiber = yield* Effect.forkChild(service.start(identity, request), { startImmediately: true });
    yield* Deferred.await(started);
    yield* Scope.close(ownerScope, Exit.void);
    assert.strictEqual((yield* Fiber.await(fiber))._tag, "Failure");
    assert.strictEqual(rollbacks, 1);
  }),
);

it.effect("releases a prepared launch when its renderer window closes", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const service = yield* harness.runtime;
    service.register(launch());

    service.releaseRenderer(identity.ownerClientId, new Error("window closed"));

    assert.isNull(service.reservation(identity.threadId));
    assert.deepEqual(harness.failures, ["Message could not be sent because its window closed."]);
  }),
);

it.effect("carries the Main origin claim through fresh renderer ownership adoption", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = makeHarness();
      const runtime = yield* harness.runtime;
      const presentationClaim = { ticketId: "origin-ticket", submissionId: "message-1" };
      runtime.register({ ...launch(), presentationClaim });
      yield* runtime.adopt(identity);
      yield* runtime.prepare(identity);
      yield* runtime.start(identity, request);
      assert.strictEqual(harness.acceptedPlans[0]?.presentationClaim, presentationClaim);
    }),
  ),
);

it.effect("retires an adopted launch and its unclaimed presentation with the host manager", () => Effect.gen(function* () {
  const harness = makeHarness();
  const runtime = yield* harness.runtime;
  const presentationClaim = { ticketId: "ticket", submissionId: "message-1" };
  runtime.register({ ...launch(), presentationClaim });
  yield* runtime.adopt(identity);
  harness.retire();
  assert.isNull(runtime.reservation(identity.threadId));
  assert.deepEqual(harness.released, [presentationClaim]);
  assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.prepare(identity))));
}));

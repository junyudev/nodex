import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

const pending: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-10-19T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};
const unanswered: ServerProvider = {
  ...pending,
  status: "error",
  message: "Timed out while checking Codex app-server provider status.",
};
const ready: ServerProvider = {
  ...pending,
  version: "0.163.0",
  status: "ready",
  auth: { status: "authenticated" },
  message: undefined,
};

// Nodex never reports client activity, so no provider-status background demand exists.
const hostWithoutDemand = Layer.succeed(
  ProviderHost.ProviderHost,
  ProviderHost.ProviderHost.of({
    paths: {
      cwd: process.cwd(),
      baseDir: "/nodex",
      stateDir: "/nodex/userdata",
      providerStatusCacheDir: "/nodex/caches",
      attachmentsDir: "/nodex/userdata/attachments",
    },
    settings: {
      get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: () => Effect.succeed(false),
    resolveAttachmentPath: () => null,
    credentials: () => Effect.die("unused"),
  }),
);

/** Lets every runnable fiber, including the provider's refresh loop, reach its next wait. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

/** A provider whose checks answer in order, then keep giving the last answer. */
const providerAnswering = (answers: ReadonlyArray<ServerProvider>) =>
  Effect.gen(function* () {
    const checks = yield* Ref.make(0);
    const provider = yield* makeManagedServerProvider<{ readonly enabled: boolean }>({
      resolveMaintenance: () => Effect.die("unused"),
      getSettings: Effect.succeed({ enabled: true }),
      streamSettings: Stream.empty,
      haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
      initialSnapshot: () => Effect.succeed(pending),
      checkProvider: Ref.updateAndGet(checks, (count) => count + 1).pipe(
        Effect.map((count) => answers[Math.min(count, answers.length) - 1]!),
      ),
      refreshInterval: "5 minutes",
    });
    yield* provider.initialCheck;
    yield* settle;
    return checks;
  });

const advance = (duration: Duration.Input) =>
  TestClock.adjust(duration).pipe(Effect.andThen(settle));

const run = <A, E>(
  effect: Effect.Effect<A, E, ProviderHost.ProviderHost | import("effect/Scope").Scope>,
) =>
  Effect.scoped(effect).pipe(Effect.provide(Layer.mergeAll(hostWithoutDemand, TestClock.layer())));

describe("provider check recovery", () => {
  it.effect("retries a check that ended without an answer, then follows the health interval", () =>
    run(
      Effect.gen(function* () {
        const checks = yield* providerAnswering([unanswered, ready]);
        yield* advance("14 seconds");
        assert.strictEqual(yield* Ref.get(checks), 1);
        yield* advance("1 second");
        assert.strictEqual(yield* Ref.get(checks), 2);
        yield* advance("10 minutes");
        assert.strictEqual(yield* Ref.get(checks), 2);
      }),
    ),
  );

  it.effect("doubles the wait while checks keep ending without an answer", () =>
    run(
      Effect.gen(function* () {
        const checks = yield* providerAnswering([unanswered]);
        yield* advance("15 seconds");
        assert.strictEqual(yield* Ref.get(checks), 2);
        yield* advance("29 seconds");
        assert.strictEqual(yield* Ref.get(checks), 2);
        yield* advance("1 second");
        assert.strictEqual(yield* Ref.get(checks), 3);
        yield* advance("60 seconds");
        assert.strictEqual(yield* Ref.get(checks), 4);
      }),
    ),
  );

  it.effect("leaves a signed-out provider for the user instead of retrying it", () =>
    run(
      Effect.gen(function* () {
        const checks = yield* providerAnswering([
          { ...unanswered, auth: { status: "unauthenticated" } },
        ]);
        yield* advance("10 minutes");
        assert.strictEqual(yield* Ref.get(checks), 1);
      }),
    ),
  );
});

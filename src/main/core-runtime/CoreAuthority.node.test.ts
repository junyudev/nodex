import { HostInvocation } from "../../host/HostInvocation";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import type { LibraryReadSnapshot } from "../core-client/types";
import { createFakeCoreHandshake, FakeCoreClient } from "../core-client/testing/fake-core-client";
import { CoreTransportError } from "../core-client/local-http";
import { MainShutdown, layer as shutdownLayer } from "../app/MainShutdown";
import { CoreAuthority, CoreSessionAccess, live as authorityLive } from "./CoreAuthority";
import { coreRuntimeError } from "./CoreRuntimeError";
import type { CoreTransportSession } from "./CoreTransport";
import { fromLaunch } from "./CoreTransport";

const snapshot = (generation: number): LibraryReadSnapshot => ({
  contract_version: 6,
  commit_head: generation,
  store_epoch: "epoch-a",
  value: {
    commit_seq: generation,
    kind: "metadata",
    library_id: "library-a",
    profile_id: "profile-a",
  },
});

const lostGeneration = (): CoreTransportError =>
  new CoreTransportError("unreachable", "connect", "ECONNREFUSED", null);

const generationClient = (input: {
  readonly generation: number;
  readonly read: () => Promise<LibraryReadSnapshot>;
  readonly storeEpoch?: string;
}): CoreGenerationClient => {
  const handshake = createFakeCoreHandshake({
    profileId: "profile-a",
    libraryId: "library-a",
    storeEpoch: input.storeEpoch ?? "epoch-a",
    connectionBinding: `binding-${input.generation}`,
  });
  const resolvedHandshake = {
    ...handshake,
    generation: {
      ...handshake.generation,
      pid: input.generation,
      readiness_generation: input.generation,
      start_nonce: `generation-${input.generation}`,
    },
  };
  const health = (): ReturnType<CoreGenerationClient["health"]> =>
    Promise.resolve({
      pid: input.generation,
      start_nonce: `generation-${input.generation}`,
      status: "ready" as const,
    } as Awaited<ReturnType<CoreGenerationClient["health"]>>);
  const client = new FakeCoreClient();
  return Object.assign(client, {
    handshake: resolvedHandshake,
    forProject: () => generationClient(input),
    health,
    libraryRead: input.read,
    shutdown: () => Promise.resolve({ status: "draining" as const }),
  });
};

const session = (client: CoreGenerationClient): CoreTransportSession => ({
  client,
  launch: {
    executablePath: "/tmp/nodex-core",
    startedProcessId: null,
    timings: {
      artifactValidationMs: 0,
      connectMs: 0,
      disposition: "reused",
      reason: "reused_compatible",
      selectionMs: 0,
      totalMs: 0,
    },
  },
  release: Effect.void,
});

const buildAuthority = (
  launch: (signal: AbortSignal) => Promise<CoreTransportSession>,
  options: Parameters<typeof authorityLive>[0] = {},
) =>
  authorityLive({ jitter: false, retryBase: "1 second", retryCap: "1 second", ...options }).pipe(
    Layer.provideMerge(Layer.merge(shutdownLayer, fromLaunch(launch))),
  );

it.effect("coalesces concurrent same-authority recovery and replays safe operations", () =>
  Effect.gen(function* () {
    let launches = 0;
    const initial = generationClient({
      generation: 1,
      read: () => Promise.reject(lostGeneration()),
    });
    const replacement = generationClient({
      generation: 2,
      read: () => Promise.resolve(snapshot(2)),
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      buildAuthority(() => {
        launches += 1;
        return Promise.resolve(session(launches === 1 ? initial : replacement));
      }),
      scope,
    );
    const access = Context.get(context, CoreSessionAccess);
    const authority = Context.get(context, CoreAuthority);

    const results = yield* Effect.all(
      Array.from({ length: 50 }, () =>
        access.use("library.read", (client) => client.libraryRead({ kind: "metadata" })),
      ),
      { concurrency: "unbounded" },
    );

    assert.strictEqual(launches, 2);
    assert.isTrue(results.every((result) => result.commit_head === 2));
    assert.deepEqual(yield* SubscriptionRef.get(authority.state), {
      kind: "ready",
      generation: "generation-2",
    });
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("fails fast on authority identity drift and requests a process relaunch", () =>
  Effect.gen(function* () {
    let launches = 0;
    const initial = generationClient({
      generation: 1,
      read: () => Promise.reject(lostGeneration()),
    });
    const drifted = generationClient({
      generation: 2,
      storeEpoch: "epoch-b",
      read: () => Promise.resolve(snapshot(2)),
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      buildAuthority(() => {
        launches += 1;
        return Promise.resolve(session(launches === 1 ? initial : drifted));
      }),
      scope,
    );
    const access = Context.get(context, CoreSessionAccess);
    const shutdown = Context.get(context, MainShutdown);

    const result = yield* Effect.result(
      access.use("library.read", (client) => client.libraryRead({ kind: "metadata" })),
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "authority-drift");
    assert.deepEqual(yield* shutdown.awaitRequest, { _tag: "AuthorityDriftRelaunch" });
    assert.strictEqual(launches, 2);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("interrupts an owned recovery backoff when the authority scope closes", () =>
  Effect.gen(function* () {
    let launches = 0;
    const initial = generationClient({
      generation: 1,
      read: () => Promise.reject(lostGeneration()),
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      buildAuthority(
        () => {
          launches += 1;
          return launches === 1
            ? Promise.resolve(session(initial))
            : Promise.reject(lostGeneration());
        },
        { maximumRecoveryAttempts: 10 },
      ),
      scope,
    );
    const access = Context.get(context, CoreSessionAccess);
    const operation = yield* access
      .use("library.read", (client) => client.libraryRead({ kind: "metadata" }))
      .pipe(Effect.forkScoped);

    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    assert.isAtLeast(launches, 2);
    yield* Scope.close(scope, Exit.void);
    const exit = yield* Fiber.await(operation);
    assert.isTrue(Exit.isFailure(exit));
    const launchesAtClose = launches;
    yield* TestClock.adjust("1 hour");
    assert.strictEqual(launches, launchesAtClose);
  }),
);

it.effect("releases the current authority generation when its Scope closes", () =>
  Effect.gen(function* () {
    let releases = 0;
    const client = generationClient({
      generation: 1,
      read: () => Promise.resolve(snapshot(1)),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      buildAuthority(() =>
        Promise.resolve({
          ...session(client),
          release: Effect.sync(() => {
            releases += 1;
          }),
        }),
      ),
      scope,
    );

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(releases, 1);
  }),
);

it.effect("fences every later Core operation after canonical application failure", () =>
  Effect.gen(function* () {
    const client = generationClient({
      generation: 1,
      read: () => Promise.resolve(snapshot(1)),
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      buildAuthority(() => Promise.resolve(session(client))),
      scope,
    );
    const authority = Context.get(context, CoreAuthority);
    const access = Context.get(context, CoreSessionAccess);
    const shutdown = Context.get(context, MainShutdown);
    const failure = coreRuntimeError({
      operation: "events.deliver",
      reason: "delivery",
      retryable: false,
    });

    assert.isTrue(yield* authority.failApplication(failure));
    assert.isFalse(yield* authority.failApplication(failure));
    assert.deepEqual(yield* SubscriptionRef.get(authority.state), {
      kind: "unavailable",
      error: failure,
    });
    assert.deepEqual(yield* shutdown.awaitRequest, {
      _tag: "RuntimeFatal",
      subsystem: "core",
      cause: failure,
    });
    const later = yield* access
      .use("library.read", (current) => current.libraryRead({ kind: "metadata" }))
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(later));
    if (Result.isFailure(later)) assert.strictEqual(later.failure, failure);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "keeps concurrent Host invocations separate and never falls back to the local Member",
  () =>
    Effect.gen(function* () {
      const observed: (string | null)[] = [];
      const client = generationClient({
        generation: 1,
        read: () => {
          observed.push(null);
          return Promise.resolve(snapshot(1));
        },
      });
      client.forInvocation = (proof) =>
        Object.assign(Object.create(client) as CoreGenerationClient, {
          libraryRead: () => {
            observed.push(proof);
            return Promise.resolve(snapshot(1));
          },
        });
      const context = yield* Layer.build(buildAuthority(() => Promise.resolve(session(client))));
      const access = Context.get(context, CoreSessionAccess);
      const read = access.use("library.read", (selected) =>
        selected.libraryRead({ kind: "metadata" }),
      );
      yield* Effect.all(
        [
          read.pipe(Effect.provideService(HostInvocation, "proof:Alice")),
          read.pipe(Effect.provideService(HostInvocation, "proof:Bob")),
          read,
        ],
        { concurrency: 3 },
      );
      assert.sameMembers(observed, [null, "proof:Alice", "proof:Bob"]);
      delete client.forInvocation;
      const refused = yield* Effect.result(
        read.pipe(Effect.provideService(HostInvocation, "proof:Bob")),
      );
      assert.equal(refused._tag, "Failure");
      assert.equal(observed.length, 3);
    }),
);

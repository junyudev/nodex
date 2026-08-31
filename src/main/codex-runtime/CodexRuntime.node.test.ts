import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import { make as makeCodexClient } from "@nodex/effect-codex-app-server/client";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import {
  CodexApplicationRequestInbox,
  make as makeApplicationRequestInbox,
} from "./CodexApplicationRequestInbox";
import { CodexAppServerSession } from "./CodexAppServerSession";
import { CodexEndpoint, live as endpointLive, type CodexEndpointConfig } from "./CodexEndpoint";
import {
  CodexEndpointMap,
  live as endpointMapLive,
  type CodexExecutionHostConfig,
} from "./CodexEndpointMap";
import { CodexEventHub, live as eventHubLive } from "./CodexEventHub";
import { CodexGateway, CodexThreadHostResolver, live as gatewayLive } from "./CodexGateway";
import { live as requestSchedulerLive } from "./CodexRequestScheduler";
import { codexRuntimeError, type CodexRuntimeError } from "./CodexRuntimeError";
import { CodexSessionTransport } from "../platform/node/CodexSessionTransport";

interface FakeAttempt {
  readonly generation: number;
  readonly fail: (error: CodexRuntimeError) => Effect.Effect<boolean>;
  readonly input: Queue.Queue<Uint8Array>;
  readonly output: Queue.Queue<string>;
}

interface FakeEndpoint {
  readonly config: CodexExecutionHostConfig;
  readonly attempts: FakeAttempt[];
  readonly releases: number[];
  readonly requests: unknown[];
}

const encoder = new TextEncoder();

const makeTestStdio = Effect.gen(function* () {
  const input = yield* Queue.unbounded<Uint8Array>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();
  return {
    input,
    output,
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
  };
});

const fakeTransport = Layer.succeed(
  CodexSessionTransport,
  CodexSessionTransport.of({
    open: () => Effect.die(new Error("The fake session layer does not open a child process")),
    canonicalPath: (path) => Effect.succeed(path),
  }),
);

const fakeEndpoint = (input: {
  readonly hostId: string;
  readonly kind?: "local" | "remote";
  readonly failGenerations?: ReadonlySet<number>;
  readonly accountEmail?: string;
  readonly respond?: boolean;
}): FakeEndpoint => {
  const attempts: FakeAttempt[] = [];
  const releases: number[] = [];
  const requests: unknown[] = [];
  const sessionLayer: CodexEndpointConfig["sessionLayer"] = (generation) =>
    Layer.effect(
      CodexAppServerSession,
      Effect.gen(function* () {
        yield* CodexSessionTransport;
        if (input.failGenerations?.has(generation) === true) {
          return yield* codexRuntimeError({
            operation: "test.open",
            reason: "spawn",
            retryable: true,
            hostId: input.hostId,
            generation,
          });
        }
        const io = yield* makeTestStdio;
        const client = yield* makeCodexClient(io.stdio);
        const termination = yield* Deferred.make<never, CodexRuntimeError>();
        attempts.push({
          generation,
          fail: (error) => Deferred.fail(termination, error),
          input: io.input,
          output: io.output,
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releases.push(generation);
          }),
        );

        if (input.respond !== false) {
          yield* Effect.forever(
            Queue.take(io.output).pipe(
              Effect.flatMap((line) => {
                const request = JSON.parse(line.trim()) as { readonly id?: string | number };
                requests.push(request);
                if (request.id === undefined) return Effect.void;
                return Queue.offer(
                  io.input,
                  encoder.encode(
                    `${JSON.stringify({
                      id: request.id,
                      result: {
                        account: {
                          type: "chatgpt",
                          email: input.accountEmail ?? `${input.hostId}@example.com`,
                          planType: "plus",
                        },
                        requiresOpenaiAuth: false,
                      },
                    })}\n`,
                  ),
                ).pipe(Effect.asVoid);
              }),
            ),
          ).pipe(Effect.forkScoped);
        }

        return CodexAppServerSession.of({
          hostId: input.hostId,
          generation,
          pid: generation,
          client,
          initialize: {
            codexHome: "/tmp/codex-home",
            platformFamily: "unix",
            platformOs: "macos",
            userAgent: "fake-codex",
          },
          termination: Deferred.await(termination),
        });
      }),
    );
  return {
    attempts,
    releases,
    requests,
    config: {
      kind: input.kind ?? "local",
      hostId: input.hostId,
      sessionLayer,
      retryBase: "1 second",
      retryCap: "1 second",
      jitter: false,
    },
  };
};

const waitForConnection = (
  endpoint: CodexEndpoint["Service"],
  kind: "ready" | "backing-off",
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((yield* SubscriptionRef.get(endpoint.state)).kind === kind) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Endpoint did not enter ${kind}`));
  });

const applicationRequestInboxLive = Layer.effect(
  CodexApplicationRequestInbox,
  makeApplicationRequestInbox,
);
const endpointDependencies = Layer.mergeAll(
  eventHubLive,
  applicationRequestInboxLive,
  fakeTransport,
  requestSchedulerLive,
);

it.effect("retries one owned session at a time and interrupts backoff on scope close", () =>
  Effect.gen(function* () {
    const fake = fakeEndpoint({ hostId: "local", failGenerations: new Set([1]) });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      endpointLive(fake.config).pipe(Layer.provideMerge(endpointDependencies)),
      scope,
    );
    const endpoint = Context.get(context, CodexEndpoint);

    yield* waitForConnection(endpoint, "backing-off");
    yield* TestClock.adjust("1 second");
    const session = yield* endpoint.session;
    assert.strictEqual(session.generation, 2);
    assert.deepEqual(
      fake.attempts.map(({ generation }) => generation),
      [2],
    );

    yield* fake.attempts[0]!.fail(
      codexRuntimeError({
        operation: "test.exit",
        reason: "session-lost",
        retryable: true,
        hostId: "local",
        generation: 2,
      }),
    );
    yield* waitForConnection(endpoint, "backing-off");
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust("1 hour");
    assert.deepEqual(fake.releases, [2]);
    assert.strictEqual(fake.attempts.length, 1);
  }),
);

it.effect("rotates the physical generation when canonical application consequences fail", () =>
  Effect.gen(function* () {
    const fake = fakeEndpoint({ hostId: "local" });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      endpointLive(fake.config).pipe(Layer.provideMerge(endpointDependencies)),
      scope,
    );
    const endpoint = Context.get(context, CodexEndpoint);
    const inbox = Context.get(context, CodexApplicationRequestInbox);
    yield* endpoint.session;

    assert.isTrue(
      yield* inbox.failGeneration(
        {
          kind: "notification",
          protocol: "extension",
          hostId: "local",
          generation: 1,
          occurrenceId: "test:consequence:1",
          occurrenceToken: 1,
          method: "test/failure",
          params: {},
        },
        new Error("canonical projection failed"),
      ),
    );
    yield* waitForConnection(endpoint, "backing-off");
    assert.deepEqual(fake.releases, [1]);
    yield* TestClock.adjust("1 second");
    assert.strictEqual((yield* endpoint.session).generation, 2);

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "admits server requests without blocking later notifications and settles on the same session",
  () =>
    Effect.gen(function* () {
      const fake = fakeEndpoint({ hostId: "local", respond: false });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        endpointLive(fake.config).pipe(Layer.provideMerge(endpointDependencies)),
        scope,
      );
      const endpoint = Context.get(context, CodexEndpoint);
      const events = Context.get(context, CodexEventHub);
      const inbox = Context.get(context, CodexApplicationRequestInbox);
      const notificationFiber = yield* events.events.pipe(
        Stream.filter(
          (event) => event.kind === "notification" && event.value.method === "thread/name/updated",
        ),
        Stream.runHead,
        Effect.forkIn(scope, { startImmediately: true }),
      );

      const session = yield* endpoint.session;
      assert.strictEqual(session.generation, 1);
      const attempt = fake.attempts[0];
      assert.isDefined(attempt);
      if (attempt === undefined) return yield* Effect.die("Missing endpoint attempt");

      yield* Queue.offer(
        attempt.input,
        encoder.encode(
          '{"id":41,"method":"custom/request","params":{"value":1}}\n{"id":42,"method":"custom/failure","params":{"value":2}}\n{"method":"thread/name/updated","params":{"threadId":"thread-a","threadName":"Thread A"}}\n',
        ),
      );

      const observedNotification = yield* Fiber.join(notificationFiber);
      assert.strictEqual(observedNotification._tag, "Some");
      assert.strictEqual(yield* Queue.size(attempt.output), 0);

      const occurrences = yield* inbox.occurrences.pipe(
        Stream.filter((occurrence) => occurrence.kind === "request"),
        Stream.take(2),
        Stream.runCollect,
      );
      const accepted = occurrences[0];
      const rejected = occurrences[1];
      if (accepted === undefined || rejected === undefined) {
        return yield* Effect.die("Missing admitted requests");
      }
      assert.strictEqual(accepted.requestId, 41);
      assert.strictEqual(accepted.method, "custom/request");
      assert.strictEqual(rejected.requestId, 42);
      assert.strictEqual(rejected.method, "custom/failure");
      assert.isTrue(
        yield* inbox.settle(accepted, {
          kind: "result",
          value: { accepted: true },
        }),
      );

      const response = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            id: Schema.Finite,
            result: Schema.Struct({ accepted: Schema.Boolean }),
          }),
        ),
      )((yield* Queue.take(attempt.output)).trim());
      assert.deepEqual(response, { id: 41, result: { accepted: true } });

      assert.isTrue(
        yield* inbox.settle(rejected, {
          kind: "error",
          error: CodexAppServerRequestError.invalidRequest("Rejected by application"),
        }),
      );
      const errorResponse = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            id: Schema.Finite,
            error: Schema.Struct({ code: Schema.Finite, message: Schema.String }),
          }),
        ),
      )((yield* Queue.take(attempt.output)).trim());
      assert.deepEqual(errorResponse, {
        id: 42,
        error: { code: -32_600, message: "Rejected by application" },
      });
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("routes typed requests explicitly across local and thread execution hosts", () =>
  Effect.gen(function* () {
    const local = fakeEndpoint({ hostId: "local", accountEmail: "local@example.com" });
    const remote = fakeEndpoint({
      hostId: "remote-a",
      kind: "remote",
      accountEmail: "remote@example.com",
    });
    const hub = eventHubLive;
    const scheduler = requestSchedulerLive;
    const endpointMap = endpointMapLive(local.config).pipe(
      Layer.provideMerge(
        Layer.mergeAll(hub, applicationRequestInboxLive, fakeTransport, scheduler),
      ),
    );
    const resolver = Layer.succeed(
      CodexThreadHostResolver,
      CodexThreadHostResolver.of({ resolve: () => Effect.succeed("remote-a") }),
    );
    const runtime = gatewayLive({ requestTimeout: "5 seconds" }).pipe(
      Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
    );
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(runtime, scope);
    const gateway = Context.get(context, CodexGateway);
    const endpoints = Context.get(context, CodexEndpointMap);
    yield* gateway.reconcileHost(remote.config);

    const localAccount = yield* gateway.requestLocal("account/read", {});
    const remoteAccount = yield* gateway.requestForThread("thread-a", "account/read", {});
    const remoteExtension = yield* gateway.requestRawForThread(
      "thread-a",
      "thread-follower-command-approval-decision",
      { conversationId: "thread-a", requestId: "approval-1", decision: "decline" },
    );
    assert.strictEqual(localAccount.account?.type, "chatgpt");
    assert.strictEqual(remoteAccount.account?.type, "chatgpt");
    if (localAccount.account?.type === "chatgpt") {
      assert.strictEqual(localAccount.account.email, "local@example.com");
    }
    if (remoteAccount.account?.type === "chatgpt") {
      assert.strictEqual(remoteAccount.account.email, "remote@example.com");
    }
    assert.strictEqual(
      (remoteExtension as { readonly account?: { readonly email?: string } }).account?.email,
      "remote@example.com",
    );

    const remoteRequestCount = remote.requests.length;
    const rerouted = yield* gateway
      .requestForThread(
        "thread-a",
        "account/read",
        {},
        {
          expectedHostId: "local",
          expectedGeneration: 1,
        },
      )
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(rerouted));
    if (Result.isFailure(rerouted)) assert.strictEqual(rerouted.failure.reason, "session-lost");
    assert.strictEqual(remote.requests.length, remoteRequestCount);

    const localRemoval = yield* Effect.result(endpoints.unregister("local"));
    assert.isTrue(Result.isFailure(localRemoval));
    yield* gateway.removeHost("remote-a");
    assert.isFalse(yield* endpoints.has("remote-a"));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "keeps one stable host state cell and subscription across physical config generations",
  () =>
    Effect.gen(function* () {
      const first = fakeEndpoint({ hostId: "local", accountEmail: "first@example.com" });
      const replacement = fakeEndpoint({
        hostId: "local",
        accountEmail: "replacement@example.com",
      });
      const hub = eventHubLive;
      const scheduler = requestSchedulerLive;
      const endpointMap = endpointMapLive(first.config).pipe(
        Layer.provideMerge(
          Layer.mergeAll(hub, applicationRequestInboxLive, fakeTransport, scheduler),
        ),
      );
      const resolver = Layer.succeed(
        CodexThreadHostResolver,
        CodexThreadHostResolver.of({ resolve: () => Effect.succeed("local") }),
      );
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        gatewayLive({ requestTimeout: "5 seconds" }).pipe(
          Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
        ),
        scope,
      );
      const gateway = Context.get(context, CodexGateway);
      const endpoints = Context.get(context, CodexEndpointMap);
      yield* gateway.awaitReady("local");
      const before = yield* endpoints.endpoint("local");
      const replacementReady = yield* gateway.connectionChanges("local").pipe(
        Stream.filter((connection) => connection.kind === "ready" && connection.generation === 2),
        Stream.runHead,
        Effect.forkIn(scope, { startImmediately: true }),
      );

      yield* gateway.reconcileHost(replacement.config);
      const observed = yield* Fiber.join(replacementReady);
      assert.strictEqual(observed._tag, "Some");
      const after = yield* endpoints.endpoint("local");
      assert.strictEqual(after, before);
      assert.strictEqual(after.state, before.state);
      assert.deepEqual(first.releases, [1]);
      assert.deepEqual(
        replacement.attempts.map(({ generation }) => generation),
        [2],
      );

      const staleRequest = yield* gateway
        .requestLocal("account/read", {}, { expectedHostId: "local", expectedGeneration: 1 })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(staleRequest));
      if (Result.isFailure(staleRequest)) {
        assert.strictEqual(staleRequest.failure.reason, "session-lost");
        assert.strictEqual(staleRequest.failure.generation, 1);
      }
      assert.strictEqual(replacement.requests.length, 0);

      const account = yield* gateway.requestLocal("account/read", {});
      assert.strictEqual(account.account?.type, "chatgpt");
      if (account.account?.type === "chatgpt") {
        assert.strictEqual(account.account.email, "replacement@example.com");
      }
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("applies the ordinary request deadline through the gateway scheduler", () =>
  Effect.gen(function* () {
    const local = fakeEndpoint({ hostId: "local", respond: false });
    const hub = eventHubLive;
    const scheduler = requestSchedulerLive;
    const endpointMap = endpointMapLive(local.config).pipe(
      Layer.provideMerge(
        Layer.mergeAll(hub, applicationRequestInboxLive, fakeTransport, scheduler),
      ),
    );
    const resolver = Layer.succeed(
      CodexThreadHostResolver,
      CodexThreadHostResolver.of({ resolve: () => Effect.succeed("local") }),
    );
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      gatewayLive({ requestTimeout: "1 second" }).pipe(
        Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
      ),
      scope,
    );
    const gateway = Context.get(context, CodexGateway);
    const request = yield* gateway
      .requestLocal("account/read", {})
      .pipe(Effect.result, Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(request);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "timeout");
    yield* Scope.close(scope, Exit.void);
  }),
);

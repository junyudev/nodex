import {
  CodexRendererDeliverySink,
  CodexRendererDispatchState,
  CodexRendererRequestOrigin,
} from "./CodexRendererRequestOrigin";
import { makeCodexRendererRequestLifetimes } from "./CodexRendererRequestLifetimes";
import type { CodexNativeDeliveryMessage } from "../../shared/codex-native-request-outcome";
import { CodexHostRequestMetrics } from "./CodexHostRequestMetrics";
import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
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
import {
  CodexExecutionHostAuthState,
  live as executionHostAuthStateLive,
} from "./CodexExecutionHostAuthState";
import { CodexGateway, CodexThreadHostResolver, live as gatewayLive } from "./CodexGateway";
import { CodexRequestScheduler, live as requestSchedulerLive } from "./CodexRequestScheduler";
import { codexRuntimeError, type CodexRuntimeError } from "./CodexRuntimeError";
import { CodexSessionTransport } from "../platform/node/CodexSessionTransport";
import { codexJsonLineTransport } from "../platform/node/CodexJsonLineStream";
import {
  getCodexHostSourceLineBytes,
  shouldChunkCodexHostMessage,
} from "../../shared/codex-host-chunked-message";
import type { CodexAppServerRequestMetrics } from "@nodex/effect-codex-app-server/protocol";

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

const gatewayTestLive = (options: Parameters<typeof gatewayLive>[0]) =>
  gatewayLive(options).pipe(Layer.provide(executionHostAuthStateLive));

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
  readonly hostKind?: string;
  readonly failGenerations?: ReadonlySet<number>;
  readonly accountEmail?: string;
  readonly respond?: boolean;
  readonly physicalJsonl?: boolean;
  readonly framing?: "message";
  readonly ready?: Effect.Effect<void, CodexRuntimeError>;
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
        if (input.ready) yield* input.ready;
        const io = yield* makeTestStdio;
        const hostMetrics = yield* CodexHostRequestMetrics;
        const client = yield* makeCodexClient(
          io.stdio,
          input.physicalJsonl
            ? codexJsonLineTransport(io.stdio.stdin, hostMetrics)
            : { framing: input.framing },
        );
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
          transportKind: input.framing === "message" ? "websocket" : "stdio",
          nativeAppTools: false,
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
      hostKind: input.hostKind,
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

it.effect("connection provenance follows the selected physical session across retries", () =>
  Effect.gen(function* () {
    const fake = fakeEndpoint({ hostId: "local" });
    const context = yield* Layer.buildWithScope(
      endpointLive({ ...fake.config, transportKind: "websocket" }).pipe(
        Layer.provideMerge(endpointDependencies),
      ),
      yield* Scope.Scope,
    );
    const endpoint = Context.get(context, CodexEndpoint);
    const first = yield* endpoint.session;
    assert.strictEqual(first.transportKind, "stdio");
    const ready = yield* SubscriptionRef.get(endpoint.state);
    assert.deepEqual(ready.source, { sourceEpoch: endpoint.sourceEpoch, transportKind: "stdio" });
    yield* fake.attempts[0]!.fail(
      codexRuntimeError({
        operation: "test.exit",
        reason: "session-lost",
        retryable: true,
        hostId: "local",
        generation: 1,
      }),
    );
    yield* waitForConnection(endpoint, "backing-off");
    assert.deepEqual((yield* SubscriptionRef.get(endpoint.state)).source, ready.source);
    yield* TestClock.adjust("1 second");
    assert.strictEqual((yield* endpoint.session).generation, 2);
    assert.deepEqual((yield* SubscriptionRef.get(endpoint.state)).source, ready.source);
  }),
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

it.effect("finishes transport-owned internal requests on the current session after reconnect", () =>
  Effect.gen(function* () {
    const fake = fakeEndpoint({ hostId: "local", respond: false });
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      endpointLive({
        ...fake.config,
        internalServerRequestHandler: (request) =>
          request.method === "attestation/generate"
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ token: "v1.transport-attestation" }),
              )
            : null,
      }).pipe(Layer.provideMerge(endpointDependencies)),
      scope,
    );
    const endpoint = Context.get(context, CodexEndpoint);
    assert.strictEqual((yield* endpoint.session).generation, 1);
    const firstAttempt = fake.attempts[0];
    if (!firstAttempt) return yield* Effect.die("Missing first endpoint attempt");

    yield* Queue.offer(
      firstAttempt.input,
      encoder.encode(
        '{"id":77,"method":"attestation/generate","params":{"ignoredByInternalHandler":true}}\n',
      ),
    );
    yield* Deferred.await(started);
    yield* firstAttempt.fail(
      codexRuntimeError({
        operation: "fixture.disconnect",
        reason: "session-lost",
        retryable: true,
        hostId: "local",
        generation: 1,
      }),
    );
    yield* waitForConnection(endpoint, "backing-off");
    yield* TestClock.adjust("1 second");
    assert.strictEqual((yield* endpoint.session).generation, 2);
    const secondAttempt = fake.attempts[1];
    if (!secondAttempt) return yield* Effect.die("Missing reconnected endpoint attempt");

    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(
      yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        (yield* Queue.take(secondAttempt.output)).trim(),
      ),
      {
        id: 77,
        result: { token: "v1.transport-attestation" },
      },
    );
    assert.strictEqual(yield* Queue.size(firstAttempt.output), 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("reports an internal-handler failure on the current session after reconnect", () =>
  Effect.gen(function* () {
    const fake = fakeEndpoint({ hostId: "local", respond: false });
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      endpointLive({
        ...fake.config,
        internalServerRequestHandler: (request) =>
          request.method === "attestation/generate"
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("attestation failed")),
              )
            : null,
      }).pipe(Layer.provideMerge(endpointDependencies)),
      scope,
    );
    const endpoint = Context.get(context, CodexEndpoint);
    yield* endpoint.session;
    const firstAttempt = fake.attempts[0];
    if (!firstAttempt) return yield* Effect.die("Missing first endpoint attempt");

    yield* Queue.offer(
      firstAttempt.input,
      encoder.encode('{"id":78,"method":"attestation/generate","params":{"ignored":true}}\n'),
    );
    yield* Deferred.await(started);
    yield* firstAttempt.fail(
      codexRuntimeError({
        operation: "fixture.disconnect",
        reason: "session-lost",
        retryable: true,
        hostId: "local",
        generation: 1,
      }),
    );
    yield* waitForConnection(endpoint, "backing-off");
    yield* TestClock.adjust("1 second");
    assert.strictEqual((yield* endpoint.session).generation, 2);
    const secondAttempt = fake.attempts[1];
    if (!secondAttempt) return yield* Effect.die("Missing reconnected endpoint attempt");

    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(
      yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        (yield* Queue.take(secondAttempt.output)).trim(),
      ),
      {
        id: 78,
        error: { code: -32603, message: "Internal server request handler failed" },
      },
    );
    assert.strictEqual(yield* Queue.size(firstAttempt.output), 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("routes typed requests explicitly across local and thread execution hosts", () =>
  Effect.gen(function* () {
    const local = fakeEndpoint({ hostId: "local", accountEmail: "local@example.com" });
    const remote = fakeEndpoint({
      hostId: "remote-a",
      kind: "remote",
      framing: "message",
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
    const runtime = gatewayTestLive({ requestTimeout: "5 seconds" }).pipe(
      Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
    );
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(runtime, scope);
    const gateway = Context.get(context, CodexGateway);
    const endpoints = Context.get(context, CodexEndpointMap);
    yield* gateway.reconcileHost(remote.config);

    const localAccount = yield* gateway.requestLocal("account/read", {});
    yield* gateway.requestLocal("account/read", {}).pipe(
      Effect.provideService(CodexRendererRequestOrigin, {
        requestId: "renderer-native-identity",
        method: "account/read",
        conversationId: "",
        timeoutMs: 0,
        expiresAtMs: null,
      }),
    );
    assert.strictEqual((local.requests.at(-1) as { id: string }).id, "renderer-native-identity");
    const remoteMetrics: CodexAppServerRequestMetrics[] = [];
    const remoteAccount = yield* gateway.requestForThread(
      "thread-a",
      "account/read",
      {},
      {
        onResponseMetrics: (metrics) =>
          Effect.sync(() => {
            remoteMetrics.push(metrics);
          }),
      },
    );
    const remoteExtension = yield* gateway.requestRawForThread(
      "thread-a",
      "thread-follower-command-approval-decision",
      { conversationId: "thread-a", requestId: "approval-1", decision: "decline" },
    );
    assert.strictEqual(localAccount.account?.type, "chatgpt");
    assert.strictEqual(remoteAccount.account?.type, "chatgpt");
    assert.strictEqual(remoteMetrics.length, 1);
    assert.strictEqual(remoteMetrics[0]!.transportKind, "websocket");
    const responseBytes = remoteMetrics[0]!.responseBytes;
    assert.isDefined(responseBytes);
    assert.isAbove(responseBytes!, 0);
    assert.strictEqual(getCodexHostSourceLineBytes(remoteAccount), undefined);
    assert.strictEqual(getCodexHostSourceLineBytes(remoteExtension as object), undefined);
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

it.effect("invalidates host auth at the common typed and raw request boundary", () =>
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
    const runtime = gatewayLive({ requestTimeout: "5 seconds" }).pipe(
      Layer.provideMerge(executionHostAuthStateLive),
      Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
    );
    const context = yield* Layer.buildWithScope(runtime, yield* Scope.Scope);
    const gateway = Context.get(context, CodexGateway);
    const authState = Context.get(context, CodexExecutionHostAuthState);
    yield* gateway.awaitReady("local");
    const attempt = local.attempts[0]!;

    const sendProtocolError = Effect.fn("CodexRuntimeTest.sendProtocolError")(function* (
      request: Effect.Effect<unknown, CodexRuntimeError>,
      data: unknown,
      onWire: () => void = () => {},
    ) {
      const fiber = yield* request.pipe(Effect.result, Effect.forkScoped);
      const wire = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ id: Schema.Union([Schema.String, Schema.Int]) })),
      )((yield* Queue.take(attempt.output)).trim());
      onWire();
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        id: wire.id,
        error: { code: -32_000, message: "configuration rejected", data },
      });
      yield* Queue.offer(attempt.input, encoder.encode(`${encoded}\n`));
      return yield* Fiber.join(fiber);
    });

    const typed = yield* sendProtocolError(gateway.requestLocal("account/read", {}), {
      reason: "cloudRequirements",
      errorCode: "Auth",
    });
    assert.isTrue(Result.isFailure(typed));
    assert.isTrue(yield* authState.isLoginRequired("local"));

    yield* authState.clearLoginRequired("local");
    const raw = yield* sendProtocolError(
      gateway.requestRawOnHost("local", "fixture/raw-auth", {}),
      { reason: "cloudConfigBundle", action: "relogin" },
    );
    assert.isTrue(Result.isFailure(raw));
    assert.isTrue(yield* authState.isLoginRequired("local"));

    yield* authState.clearLoginRequired("local");
    const nonAuth = yield* sendProtocolError(gateway.requestLocal("account/read", {}), {
      reason: "cloudRequirements",
      errorCode: "InvalidConfig",
    });
    assert.isTrue(Result.isFailure(nonAuth));
    assert.isFalse(yield* authState.isLoginRequired("local"));
    for (const method of ["account/logout", "account/sessions/switch"]) {
      const lease = yield* authState.backendLease("local");
      const result = yield* sendProtocolError(
        method === "account/logout"
          ? gateway.requestLocal("account/logout", undefined)
          : gateway.requestRawOnHost("local", method, {}),
        {},
        () => assert.isTrue(lease.aborted),
      );
      assert.isTrue(Result.isFailure(result));
      assert.isFalse((yield* authState.backendLease("local")).aborted);
    }
  }),
);

it.effect("uses the native auth-status deadline for local and remote-control hosts", () =>
  Effect.gen(function* () {
    const local = fakeEndpoint({ hostId: "local", respond: false });
    const remoteControl = fakeEndpoint({
      hostId: "remote-control:environment",
      kind: "remote",
      hostKind: "remote-control",
      respond: false,
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
      CodexThreadHostResolver.of({ resolve: () => Effect.succeed("local") }),
    );
    const runtime = gatewayTestLive({ requestTimeout: 0 }).pipe(
      Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
    );
    const context = yield* Layer.buildWithScope(runtime, yield* Scope.Scope);
    const gateway = Context.get(context, CodexGateway);
    const requestScheduler = Context.get(context, CodexRequestScheduler);
    yield* gateway.reconcileHost(remoteControl.config);
    yield* gateway.awaitReady("local");
    yield* gateway.awaitReady(remoteControl.config.hostId);

    const localRequest = yield* gateway
      .requestOnHost("local", "getAuthStatus", { includeToken: false, refreshToken: false })
      .pipe(Effect.result, Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(29_999);
    assert.strictEqual((yield* requestScheduler.snapshot).current.inFlight, 1);
    yield* TestClock.adjust(1);
    const localResult = yield* Fiber.join(localRequest);
    assert.isTrue(Result.isFailure(localResult));
    if (Result.isFailure(localResult)) assert.strictEqual(localResult.failure.reason, "timeout");

    const beforeRemoteInFlight = (yield* requestScheduler.snapshot).current.inFlight;
    const remoteRequest = yield* gateway
      .requestOnHost(remoteControl.config.hostId, "getAuthStatus", {
        includeToken: false,
        refreshToken: false,
      })
      .pipe(Effect.result, Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(89_999);
    assert.strictEqual(
      (yield* requestScheduler.snapshot).current.inFlight,
      beforeRemoteInFlight + 1,
    );
    yield* TestClock.adjust(1);
    const remoteResult = yield* Fiber.join(remoteRequest);
    assert.isTrue(Result.isFailure(remoteResult));
    if (Result.isFailure(remoteResult)) assert.strictEqual(remoteResult.failure.reason, "timeout");
  }),
);

it.effect(
  "physical thread-start ingress retains raw history for the Inbox and bounds the observational projection",
  () =>
    Effect.gen(function* () {
      const fake = fakeEndpoint({ hostId: "local", respond: false, physicalJsonl: true });
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const context = yield* Layer.buildWithScope(
        endpointLive(fake.config).pipe(Layer.provideMerge(endpointDependencies)),
        scope,
      );
      const endpoint = Context.get(context, CodexEndpoint);
      const inbox = Context.get(context, CodexApplicationRequestInbox);
      const events = Context.get(context, CodexEventHub);
      const observed = yield* events.events.pipe(
        Stream.filter(
          (event) => event.kind === "notification" && event.value.method === "thread/started",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const admitted = yield* inbox.occurrences.pipe(
        Stream.filter(
          (event) => event.kind === "notification" && event.method === "thread/started",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* endpoint.session;
      const text = "raw history ".repeat(200_000);
      const thread: Thread = {
        id: "thread-raw",
        environments: null,
        extra: null,
        sessionId: "session-raw",
        forkedFromId: null,
        parentThreadId: null,
        preview: "raw",
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "paginated",
        modelProvider: "openai",
        model: null,
        reasoningEffort: null,
        createdAt: 1,
        updatedAt: 1,
        recencyAt: 1,
        status: { type: "idle" },
        path: null,
        cwd: "/repo",
        cliVersion: "test",
        originator: null,
        source: "unknown",
        canAcceptDirectInput: true,
        threadSource: "user",
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: "Raw history",
        daybreakEnabled: null,
        turns: [
          {
            id: "turn-raw",
            status: "completed",
            itemsView: "full",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1_000,
            items: [
              {
                type: "agentMessage",
                id: "item-raw",
                text,
                phase: "final_answer",
                delivery: null,
                memoryCitation: null,
                questions: null,
              },
            ],
          },
        ],
      };
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        method: "thread/started",
        params: { thread },
      });
      yield* Queue.offer(fake.attempts[0]!.input, Buffer.from(`${encoded}\n`));
      const occurrence = (yield* Fiber.join(admitted))[0];
      assert.isDefined(occurrence);
      const raw = occurrence!.params as { thread: Thread };
      assert.strictEqual(raw.thread.turns.length, 1);
      const item = raw.thread.turns[0]!.items[0]!;
      assert.strictEqual(item.type, "agentMessage");
      if (item.type === "agentMessage") assert.strictEqual(item.text, text);
      assert.strictEqual(getCodexHostSourceLineBytes(raw), Buffer.byteLength(encoded) + 1);
      const observation = (yield* Fiber.join(observed))[0];
      assert.ok(
        observation?.kind === "notification" && observation.value.method === "thread/started",
      );
      assert.deepEqual((observation.value.params as { thread: Thread }).thread.turns, []);
      assert.strictEqual(endpoint.metrics.receiveState.counts[0], 1);
      assert.strictEqual(endpoint.metrics.receiveState.bytes, Buffer.byteLength(encoded) + 1);
    }),
);

it.effect(
  "gateway consumers retain physical response bytes through typed decoding and honor transport observation priority",
  () =>
    Effect.gen(function* () {
      const local = fakeEndpoint({ hostId: "local", respond: false, physicalJsonl: true });
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
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const context = yield* Layer.buildWithScope(
        gatewayTestLive({ requestTimeout: "5 seconds" }).pipe(
          Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
        ),
        scope,
      );
      const gateway = Context.get(context, CodexGateway);
      yield* gateway.awaitReady("local");
      const attempt = local.attempts[0]!;
      for (const typed of [true, false]) {
        for (const renderer of [true, false]) {
          const priority = renderer ? "background" : "interactive";
          const measured: CodexAppServerRequestMetrics[] = [];
          const scheduling = {
            priority,
            onResponseMetrics: (metrics: CodexAppServerRequestMetrics) =>
              Effect.sync(() => {
                measured.push(metrics);
              }),
          } as const;
          const request = typed
            ? gateway.requestLocal("account/read", {}, scheduling)
            : gateway.requestRawOnHost("local", "account/read", {}, scheduling);
          const pending = yield* request.pipe(
            Effect.provideService(
              CodexRendererRequestOrigin,
              renderer
                ? {
                    requestId: `metrics-${typed}`,
                    method: "account/read",
                    conversationId: "",
                    timeoutMs: 0,
                    expiresAtMs: null,
                  }
                : null,
            ),
            Effect.forkScoped,
          );
          const wire = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ id: Schema.Union([Schema.String, Schema.Int]) })),
          )(yield* Queue.take(attempt.output));
          const result = { account: null, requiresOpenaiAuth: false };
          const encoded =
            (yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              id: wire.id,
              result,
            })) +
            " ".repeat(2048) +
            "\n";
          yield* Queue.offer(attempt.input, Buffer.from(encoded));
          const response = yield* Fiber.join(pending);
          assert.deepEqual(response, result);
          assert.strictEqual(measured.length, 1);
          assert.strictEqual(measured[0]!.responseBytes, Buffer.byteLength(encoded));
          assert.strictEqual(
            measured[0]!.largeInboundCompletedMessageBytesWhilePending,
            renderer ? undefined : 0,
          );
          assert.strictEqual(
            getCodexHostSourceLineBytes(response as object),
            Buffer.byteLength(encoded),
          );
          assert.isTrue(
            shouldChunkCodexHostMessage({ message: { id: wire.id, result: response } }, 512),
          );
        }
      }
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
        gatewayTestLive({ requestTimeout: "5 seconds" }).pipe(
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

it.effect("keeps identical Main reads independent across typed and raw gateway requests", () =>
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
      gatewayTestLive({ requestTimeout: "5 seconds" }).pipe(
        Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
      ),
      scope,
    );
    const gateway = Context.get(context, CodexGateway);
    yield* gateway.awaitReady("local");
    const attempt = local.attempts[0];
    assert.isDefined(attempt);
    const first = yield* gateway.requestLocal("thread/list", {}).pipe(Effect.forkScoped);
    const decodeRequest = Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ id: Schema.Union([Schema.String, Schema.Finite]) })),
    );
    const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
    const firstWire = yield* decodeRequest(yield* Queue.take(attempt.output));
    const second = yield* gateway
      .requestRawOnHost("local", "thread/list", {})
      .pipe(Effect.forkScoped);
    const secondWire = yield* decodeRequest(yield* Queue.take(attempt.output));
    assert.notStrictEqual(firstWire.id, secondWire.id);

    const secondResponse = yield* encodeResponse({
      id: secondWire.id,
      result: { data: [], nextCursor: "second" },
    });
    yield* Queue.offer(attempt.input, encoder.encode(`${secondResponse}\n`));
    assert.deepEqual(yield* Fiber.join(second), { data: [], nextCursor: "second" });
    const firstResponse = yield* encodeResponse({
      id: firstWire.id,
      result: { data: [], nextCursor: "first" },
    });
    yield* Queue.offer(attempt.input, encoder.encode(`${firstResponse}\n`));
    assert.strictEqual((yield* Fiber.join(first)).nextCursor, "first");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "physical coalesced responses retain per-caller timing, internal concurrency and host counters across reconnect",
  () =>
    Effect.gen(function* () {
      const local = fakeEndpoint({ hostId: "local", respond: false, physicalJsonl: true });
      const endpointMap = endpointMapLive(local.config).pipe(
        Layer.provideMerge(endpointDependencies),
      );
      const resolver = Layer.succeed(CodexThreadHostResolver, {
        resolve: () => Effect.succeed("local"),
      });
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const context = yield* Layer.buildWithScope(
        gatewayTestLive({ requestTimeout: "5 seconds" }).pipe(
          Layer.provideMerge(Layer.mergeAll(endpointMap, resolver)),
        ),
        scope,
      );
      const gateway = Context.get(context, CodexGateway);
      const endpoint = yield* Context.get(context, CodexEndpointMap).endpoint("local");
      const scheduler = Context.get(context, CodexRequestScheduler);
      yield* gateway.awaitReady("local");
      yield* TestClock.adjust(1_000);
      const measured = new Map<string, CodexAppServerRequestMetrics>();
      const request = (id: string) =>
        gateway
          .requestRawOnHost(
            "local",
            "thread/read",
            { threadId: "metrics" },
            {
              onResponseMetrics: (metrics) =>
                Effect.sync(() => {
                  measured.set(id, metrics);
                }),
            },
          )
          .pipe(
            Effect.provideService(CodexRendererRequestOrigin, {
              requestId: id,
              method: "thread/read",
              conversationId: "",
              timeoutMs: 0,
              expiresAtMs: null,
              destinationId: id,
            }),
          );
      const decode = Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ id: Schema.Union([Schema.String, Schema.Int]) })),
      );
      const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      const first = yield* request("leader").pipe(Effect.forkScoped);
      const attempt = local.attempts[0]!;
      const firstWire = yield* decode(yield* Queue.take(attempt.output));
      assert.strictEqual(firstWire.id, "leader");
      yield* TestClock.adjust(10);
      const second = yield* request("follower").pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.strictEqual((yield* scheduler.snapshot).totals.coalesced, 1);
      assert.strictEqual(yield* Queue.size(attempt.output), 0);
      assert.strictEqual(endpoint.metrics.receiveState.pendingClientRequests, 2);
      const native = (yield* endpoint.session).client;
      const internal = yield* native.raw
        .request("fixture/internal", {}, { metricsMode: "internal" })
        .pipe(Effect.forkScoped);
      const internalWire = yield* decode(yield* Queue.take(attempt.output));
      assert.strictEqual(endpoint.metrics.receiveState.pendingClientRequests, 2);
      assert.strictEqual(endpoint.metrics.receiveState.pendingInternalRequests, 1);
      yield* TestClock.adjust(30);
      const payload = { text: "x".repeat(20_000) };
      const response = `${yield* encode({ id: firstWire.id, result: payload })}\n`;
      const notification = `${yield* encode({ method: "fixture/notification", params: {}, emittedAtMs: 1_005 })}\n`;
      const internalResponse = `${yield* encode({ id: internalWire.id, result: true })}\n`;
      yield* Queue.offer(attempt.input, Buffer.from(notification + internalResponse + response));
      assert.isTrue(yield* Fiber.join(internal));
      assert.deepEqual(yield* Fiber.join(first), payload);
      assert.deepEqual(yield* Fiber.join(second), payload);
      const leader = measured.get("leader")!;
      const follower = measured.get("follower")!;
      assert.strictEqual(leader.hostRoundTripDurationMs, 40);
      assert.strictEqual(follower.hostRoundTripDurationMs, 30);
      assert.strictEqual(leader.hostReadyWaitDurationMs, 0);
      assert.strictEqual(follower.hostReadyWaitDurationMs, 0);
      assert.strictEqual(leader.clientBusyPeriodPeakHostPendingRequestCount, 3);
      assert.strictEqual(follower.clientBusyPeriodPeakHostPendingRequestCount, 3);
      assert.strictEqual(leader.requestBytes, follower.requestBytes);
      assert.strictEqual(leader.responseBytes, Buffer.byteLength(response));
      assert.strictEqual(follower.responseBytes, leader.responseBytes);
      assert.strictEqual(leader.serverNotificationDeliveryLagMs, 35);
      assert.strictEqual(leader.serverNotificationClockSkewBaselineMs, 35);
      assert.strictEqual(follower.serverNotificationDeliveryLagMs, undefined);
      assert.strictEqual(leader.largeInboundCompletedMessageBytesWhilePending, 0);
      assert.strictEqual(follower.largeInboundCompletedMessageBytesWhilePending, undefined);
      assert.strictEqual(endpoint.metrics.receiveState.pendingClientRequests, 0);
      assert.strictEqual(endpoint.metrics.receiveState.pendingInternalRequests, 0);

      const state = endpoint.metrics.receiveState;
      const receiver = endpoint.metrics.receiver;
      const before = receiver.snapshot();
      yield* attempt.fail(
        codexRuntimeError({
          operation: "fixture.disconnect",
          reason: "session-lost",
          retryable: true,
        }),
      );
      yield* waitForConnection(endpoint, "backing-off");
      yield* TestClock.adjust("1 second");
      yield* endpoint.session;
      assert.strictEqual(endpoint.metrics.receiveState, state);
      assert.notStrictEqual(endpoint.metrics.receiver, receiver);
      assert.deepEqual(endpoint.metrics.receiver.snapshot(), before);
      const afterReconnect = yield* request("reconnected").pipe(Effect.forkScoped);
      const nextAttempt = local.attempts[1]!;
      const nextWire = yield* decode(yield* Queue.take(nextAttempt.output));
      const nextResponse = `${yield* encode({ id: nextWire.id, result: null })}\n`;
      yield* Queue.offer(nextAttempt.input, Buffer.from(nextResponse));
      assert.isNull(yield* Fiber.join(afterReconnect));
      assert.strictEqual(
        measured.get("reconnected")?.clientBusyPeriodPeakHostPendingRequestCount,
        1,
      );
      assert.strictEqual(state.notificationClockSkewBaselineMs, 35);
      assert.strictEqual(state.pendingClientRequests, 0);
      assert.strictEqual(state.pendingInternalRequests, 0);
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
      gatewayTestLive({ requestTimeout: "1 second" }).pipe(
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

it.effect(
  "admits renderer requests before host readiness and expires without sending at the deadline",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const local = fakeEndpoint({ hostId: "local", ready: Deferred.await(ready) });
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
        gatewayTestLive({ requestTimeout: "1 second" }).pipe(
          Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
        ),
        scope,
      );
      const gateway = Context.get(context, CodexGateway);
      const queue = Context.get(context, CodexRequestScheduler);
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const request = yield* gateway.requestLocal("account/read", {}).pipe(
        Effect.provideService(CodexRendererRequestOrigin, {
          requestId: "caller",
          method: "account/read",
          conversationId: "",
          timeoutMs: 100,
          expiresAtMs: now + 100,
        }),
        Effect.result,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* queue.snapshot.pipe(
        Effect.tap(() => Effect.yieldNow),
        Effect.repeat({ until: (snapshot) => snapshot.current.inFlight === 1 }),
      );
      assert.strictEqual(local.attempts.length, 0);
      yield* TestClock.adjust(100);
      const result = yield* Fiber.join(request);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "timeout");
      yield* Deferred.succeed(ready, undefined);
      yield* Effect.yieldNow;
      assert.strictEqual(local.requests.length, 0);
      yield* Scope.close(scope, Exit.void);
    }),
);

for (const raw of [false, true]) {
  it.effect(
    `pushes retained renderer delivery with physical identity and isolates Main callers: raw=${raw}`,
    () =>
      Effect.gen(function* () {
        const local = fakeEndpoint({ hostId: "local", respond: false, physicalJsonl: true });
        const endpointMap = endpointMapLive(local.config).pipe(
          Layer.provideMerge(endpointDependencies),
        );
        const resolver = Layer.succeed(CodexThreadHostResolver, {
          resolve: () => Effect.succeed("local"),
        });
        const context = yield* Layer.buildWithScope(
          gatewayTestLive({ requestTimeout: "1 second" }).pipe(
            Layer.provideMerge(Layer.mergeAll(endpointMap, resolver)),
          ),
          yield* Scope.Scope,
        );
        const gateway = Context.get(context, CodexGateway);
        const scheduler = Context.get(context, CodexRequestScheduler);
        const lifetimes = yield* makeCodexRendererRequestLifetimes;
        const delivered = yield* Queue.unbounded<CodexNativeDeliveryMessage>();
        const rendererDispatch = { dispatched: false };
        const mainDispatch = { dispatched: false };
        const existingCallback = yield* Deferred.make<void>();
        const sink = (message: CodexNativeDeliveryMessage) =>
          Queue.offer(delivered, message).pipe(Effect.asVoid);
        const options = {
          onOutcomeUnknown: () => Deferred.succeed(existingCallback, undefined).pipe(Effect.asVoid),
        };
        yield* gateway.awaitReady("local");
        const attempt = local.attempts[0]!;
        const decodeRequest = Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ id: Schema.String, method: Schema.String })),
        );
        const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
        const params = { threadId: "thread", items: [] };
        const operation = raw
          ? gateway.requestRawOnHost("local", "thread/inject_items", params, options)
          : gateway.requestLocal("thread/inject_items", params, options);
        const request = yield* lifetimes.start(
          "window:injection",
          true,
          operation.pipe(
            Effect.provideService(CodexRendererRequestOrigin, {
              requestId: "renderer-injection",
              method: "thread/inject_items",
              conversationId: "thread",
              retainResponse: true,
              timeoutMs: 0,
              expiresAtMs: null,
            }),
            Effect.provideService(CodexRendererDeliverySink, sink),
            Effect.provideService(CodexRendererDispatchState, rendererDispatch),
          ),
        );
        const wire = yield* decodeRequest(yield* Queue.take(attempt.output));
        assert.deepEqual(wire, { id: "renderer-injection", method: "thread/inject_items" });
        assert.isTrue(rendererDispatch.dispatched);
        yield* lifetimes.abandon("window:injection");
        assert.deepEqual(yield* Queue.take(delivered), {
          type: "mcp-request-delivery",
          hostId: "local",
          update: {
            type: "outcome-unknown",
            delivery: { requestId: wire.id, method: wire.method, stage: "outcome-unknown" },
          },
        });
        yield* Deferred.await(existingCallback);
        yield* lifetimes.abandon("window:injection");
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 0);
        assert.strictEqual((yield* scheduler.snapshot).totals.outcomeUnknown, 1);
        assert.strictEqual(yield* Queue.size(delivered), 0);

        const mainUnknown = yield* Deferred.make<void>();
        const main = yield* gateway
          .requestLocal(
            "turn/steer",
            {
              threadId: "main-thread",
              expectedTurnId: "main-turn",
              input: [],
            },
            {
              timeoutMs: 50,
              retainResponse: true,
              onOutcomeUnknown: () => Deferred.succeed(mainUnknown, undefined).pipe(Effect.asVoid),
            },
          )
          .pipe(
            Effect.provideService(CodexRendererDeliverySink, sink),
            Effect.provideService(CodexRendererDispatchState, mainDispatch),
            Effect.forkScoped,
          );
        const mainWire = yield* decodeRequest(yield* Queue.take(attempt.output));
        assert.isFalse(mainDispatch.dispatched);
        assert.notStrictEqual(mainWire.id, wire.id);
        yield* TestClock.adjust(50);
        yield* Deferred.await(mainUnknown);
        assert.strictEqual(yield* Queue.size(delivered), 0);
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 0);
        yield* Queue.offer(
          attempt.input,
          encoder.encode(
            `${yield* encodeResponse({
              id: mainWire.id,
              result: { turnId: "main-turn" },
            })}\n`,
          ),
        );
        assert.deepEqual(yield* Fiber.join(main), { turnId: "main-turn" });
        yield* Queue.offer(
          attempt.input,
          encoder.encode(`${yield* encodeResponse({ id: wire.id, result: {} })}\n`),
        );
        assert.deepEqual(yield* Fiber.join(request), {});
        assert.strictEqual((yield* scheduler.snapshot).totals.outcomeUnknown, 2);
        assert.strictEqual(yield* Queue.size(delivered), 0);
      }),
  );
}

it.effect("keeps renderer response lifetime independent of the Main response timeout", () =>
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
      gatewayTestLive({ requestTimeout: "1 second" }).pipe(
        Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
      ),
      scope,
    );
    const gateway = Context.get(context, CodexGateway);
    const queue = Context.get(context, CodexRequestScheduler);
    const request = yield* gateway.requestLocal("account/read", {}).pipe(
      Effect.provideService(CodexRendererRequestOrigin, {
        requestId: "caller",
        method: "account/read",
        conversationId: "",
        timeoutMs: 0,
        expiresAtMs: null,
      }),
      Effect.result,
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 seconds");
    assert.strictEqual((yield* queue.snapshot).current.inFlight, 1);
    assert.strictEqual((yield* queue.snapshot).totals.executionTimedOut, 0);
    yield* Fiber.interrupt(request);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rejects renderer admission after terminal initialization failure", () =>
  Effect.gen(function* () {
    const failure = codexRuntimeError({
      operation: "test.initialize",
      reason: "host-unavailable",
      retryable: false,
      hostId: "local",
    });
    const local = fakeEndpoint({ hostId: "local", ready: Effect.fail(failure) });
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
      gatewayTestLive({ requestTimeout: "1 second" }).pipe(
        Layer.provideMerge(Layer.mergeAll(endpointMap, hub, resolver, scheduler)),
      ),
      scope,
    );
    const endpoint = yield* Context.get(context, CodexEndpointMap).endpoint("local");
    yield* endpoint.session.pipe(Effect.result);
    const result = yield* Context.get(context, CodexGateway)
      .requestLocal("account/read", {})
      .pipe(
        Effect.provideService(CodexRendererRequestOrigin, {
          requestId: "after-failure",
          method: "account/read",
          conversationId: "",
          timeoutMs: 0,
          expiresAtMs: null,
        }),
        Effect.result,
      );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure, failure);
    yield* Scope.close(scope, Exit.void);
  }),
);

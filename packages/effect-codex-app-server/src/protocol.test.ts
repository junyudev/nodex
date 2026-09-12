import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import * as CodexRpc from "./rpc.ts";
import * as CodexSchema from "./schema.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const encoder = new TextEncoder();

const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeAccountTokenUsageResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/usage/read"],
);
const decodeAccountRateLimitsResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimits/read"],
);
const decodeConsumeRateLimitResetCreditParams = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_PARAMS["account/rateLimitResetCredit/consume"],
);
const decodeConsumeRateLimitResetCreditResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimitResetCredit/consume"],
);

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  it.effect(
    "reports a failed response to its requesting consumer without counting itself as competing traffic",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
          stdio,
          framing: "message",
        });
        const measured: CodexProtocol.CodexAppServerRequestMetrics[] = [];
        const pending = yield* protocol
          .request(
            "custom/error",
            { value: "中文" },
            {
              requestId: "measured-error",
              onMetrics: (metrics) =>
                Effect.sync(() => {
                  measured.push(metrics);
                }),
            },
          )
          .pipe(Effect.exit, Effect.forkScoped);
        const wire = yield* Queue.take(output);
        const response = encodeUnknownJsonString({
          id: "measured-error",
          error: { code: -32000, message: "failed", data: "x".repeat(16 * 1024) },
        });
        yield* Queue.offer(input, encoder.encode(response));
        assert.isTrue(Exit.isFailure(yield* Fiber.join(pending)));
        assert.strictEqual(measured.length, 1);
        assert.strictEqual(measured[0]!.requestBytes, encoder.encode(wire).length);
        assert.strictEqual(measured[0]!.responseBytes, encoder.encode(response).length);
        assert.strictEqual(measured[0]!.largeInboundCompletedMessageBytesWhilePending, 0);
        assert.strictEqual(measured[0]!.responseReceiveDurationMs, undefined);
      }),
  );

  it.effect("serializes W3C trace context on the JSON-RPC request envelope", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });
      const pending = yield* protocol
        .request(
          "thread/start",
          { cwd: "/workspace" },
          {
            requestId: "traced-request",
            wireTrace: {
              traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
              tracestate: "vendor=value",
            },
          },
        )
        .pipe(Effect.forkScoped);

      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: "traced-request",
        method: "thread/start",
        params: { cwd: "/workspace" },
        trace: {
          traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          tracestate: "vendor=value",
        },
      });
      yield* Queue.offer(input, encodeJsonl({ id: "traced-request", result: {} }));
      assert.deepEqual(yield* Fiber.join(pending), {});
    }),
  );

  it.effect("uses physical frame receipt time rather than dispatch time for notification lag", () =>
    Effect.gen(function* () {
      const { stdio, output } = yield* makeInMemoryStdio();
      const frames = yield* Queue.unbounded<CodexProtocol.CodexAppServerMessageFrame>();
      const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        framing: "message",
        messageFrames: Stream.fromQueue(frames),
      });
      const measured: CodexProtocol.CodexAppServerRequestMetrics[] = [];
      const pending = yield* protocol
        .request(
          "custom/read",
          {},
          {
            requestId: "timed",
            onMetrics: (metrics) =>
              Effect.sync(() => {
                measured.push(metrics);
              }),
          },
        )
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(frames, {
        data: encoder.encode('{"method":"custom/event","emittedAtMs":100}'),
        receivedAtMs: 130,
      });
      yield* Queue.offer(frames, {
        data: encoder.encode('{"id":"timed","result":true}'),
        receivedAtMs: 140,
      });
      assert.strictEqual(yield* Fiber.join(pending), true);
      assert.strictEqual(measured[0]!.serverNotificationDeliveryLagMs, 30);
      assert.strictEqual(measured[0]!.serverNotificationClockSkewBaselineMs, 30);
    }),
  );

  it.effect("message transport accepts payloads above the stdio frame budget", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        framing: "message",
      });
      const content = "x".repeat(17 * 1024 * 1024);
      const pending = yield* protocol
        .request("custom/large", { content }, { requestId: "large-frame" })
        .pipe(Effect.forkScoped);
      const outgoing = yield* Queue.take(output);
      assert.isAbove(outgoing.length, 16 * 1024 * 1024);
      yield* Queue.offer(
        input,
        encoder.encode(encodeUnknownJsonString({ id: "large-frame", result: { content } })),
      );
      const response = yield* Fiber.join(pending);
      assert.deepStrictEqual(response, { content });
    }),
  );
  it.effect("preserves WebSocket message boundaries and sends one JSON envelope per frame", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        framing: "message",
      });
      const pending = yield* protocol
        .request("custom/read", {}, { requestId: "websocket" })
        .pipe(Effect.forkScoped);
      const wire = yield* Queue.take(output);
      assert.isFalse(wire.endsWith("\n"));
      assert.deepStrictEqual(yield* decodeJson(wire), {
        id: "websocket",
        method: "custom/read",
        params: {},
      });
      yield* Queue.offer(
        input,
        encoder.encode('{\n  "id": "websocket",\n  "result": {"text":"multi\\nline"}\n}'),
      );
      assert.deepStrictEqual(yield* Fiber.join(pending), { text: "multi\nline" });
    }),
  );
  it.effect(
    "preserves caller request identity and rejects collisions without replacing the pending result",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });
        const pending = yield* protocol
          .request("custom/read", { value: 1 }, { requestId: "window-request" })
          .pipe(Effect.forkScoped);
        const wire = yield* Queue.take(output);
        assert.deepStrictEqual(yield* decodeJson(wire), {
          id: "window-request",
          method: "custom/read",
          params: { value: 1 },
        });
        const collision = yield* protocol
          .request("custom/read", { value: 2 }, { requestId: "window-request" })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(collision));
        yield* Queue.offer(
          input,
          encodeJsonl({ id: "window-request", result: { value: "first" } }),
        );
        assert.deepStrictEqual(yield* Fiber.join(pending), { value: "first" });
      }),
  );
  it.effect("does not answer a server request that the application reports as withdrawn", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () => Effect.succeed(CodexProtocol.CodexAppServerNoResponse),
      });

      yield* Queue.offer(
        input,
        encodeJsonl({ id: 41, method: "private/request", params: { threadId: "thread-1" } }),
      );
      for (let attempt = 0; attempt < 10; attempt += 1) yield* Effect.yieldNow;

      assert.isTrue(Option.isNone(yield* Queue.poll(output)));
    }),
  );

  it.effect("maps account usage responses to the upstream token usage schema", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/usage/read"],
        CodexSchema.V2GetAccountTokenUsageResponse,
      );
      const decoded = yield* decodeAccountTokenUsageResponse({
        dailyUsageBuckets: [{ startDate: "2026-06-10", tokens: 42 }],
        summary: { lifetimeTokens: 42 },
      });
      assert.deepEqual(decoded, {
        dailyUsageBuckets: [{ startDate: "2026-06-10", tokens: 42 }],
        summary: { lifetimeTokens: 42 },
      });
    }),
  );

  it.effect("maps earned rate-limit reset credits from account rate-limit snapshots", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimits/read"],
        CodexSchema.V2GetAccountRateLimitsResponse,
      );

      const response = {
        rateLimits: {},
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            {
              id: "RateLimitResetCredit_1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_781_654_400,
              expiresAt: 1_784_246_400,
              title: "Full reset",
              description: "Ready to redeem",
            },
            {
              id: "RateLimitResetCredit_2",
              resetType: "unknown",
              status: "unknown",
              grantedAt: 1_781_654_401,
              expiresAt: null,
            },
          ],
        },
      } as const;

      assert.deepEqual(yield* decodeAccountRateLimitsResponse(response), response);
      assert.deepEqual(
        yield* decodeAccountRateLimitsResponse({
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 2, credits: null },
        }),
        {
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 2, credits: null },
        },
      );
    }),
  );

  it.effect("maps the earned rate-limit reset consume request and response", () =>
    Effect.gen(function* () {
      assert.equal(
        CodexRpc.CLIENT_REQUEST_METHODS["account/rateLimitResetCredit/consume"],
        "account/rateLimitResetCredit/consume",
      );
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_PARAMS["account/rateLimitResetCredit/consume"],
        CodexSchema.V2ConsumeAccountRateLimitResetCreditParams,
      );
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimitResetCredit/consume"],
        CodexSchema.V2ConsumeAccountRateLimitResetCreditResponse,
      );

      assert.deepEqual(
        yield* decodeConsumeRateLimitResetCreditParams({
          idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
          creditId: "RateLimitResetCredit_1",
        }),
        {
          idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
          creditId: "RateLimitResetCredit_1",
        },
      );
      assert.deepEqual(yield* decodeConsumeRateLimitResetCreditResponse({ outcome: "reset" }), {
        outcome: "reset",
      });
    }),
  );

  it.effect(
    "encodes requests without a jsonrpc field and routes inbound requests and notifications",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

        const notificationDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingNotification>>();
        const requestDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingRequest>>();

        yield* transport.incomingNotifications.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((notifications) => Deferred.succeed(notificationDeferred, notifications)),
          Effect.forkScoped,
        );

        yield* transport.incomingRequests.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((requests) => Deferred.succeed(requestDeferred, requests)),
          Effect.forkScoped,
        );

        yield* transport.notify("initialized");
        assert.equal(yield* Queue.take(output), '{"method":"initialized"}\n');

        const initializeParams = {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        };

        const pendingInitialize = yield* transport
          .request("initialize", initializeParams)
          .pipe(Effect.forkScoped);
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 1,
          method: "initialize",
          params: initializeParams,
        });

        yield* Queue.offer(
          input,
          encodeJsonl({
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 1,
            result: {
              userAgent: "mock-codex-app-server",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );

        assert.deepEqual(yield* Fiber.join(pendingInitialize), {
          userAgent: "mock-codex-app-server",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        });
        assert.deepEqual(yield* Deferred.await(notificationDeferred), [
          {
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        ]);
        assert.deepEqual(yield* Deferred.await(requestDeferred), [
          {
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          },
        ]);

        yield* transport.respond(77, {
          answers: {
            approved: {
              answers: ["yes"],
            },
          },
        });
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 77,
          result: {
            answers: {
              approved: {
                answers: ["yes"],
              },
            },
          },
        });

        yield* transport.respondError(
          78,
          CodexError.CodexAppServerRequestError.methodNotFound("x/test"),
        );
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 78,
          error: {
            code: -32601,
            message: "Method not found: x/test",
          },
        });

        const trace = {
          traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
          tracestate: "vendor=value",
        };
        yield* transport.respond(79, { ok: true }, trace);
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 79,
          result: { ok: true },
          trace,
        });

        yield* transport.respondError(
          80,
          CodexError.CodexAppServerRequestError.methodNotFound("x/traced"),
          trace,
        );
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 80,
          error: {
            code: -32601,
            message: "Method not found: x/traced",
          },
          trace,
        });
      }),
  );

  it.effect("surfaces JSON encoding failures as protocol parse errors", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(bigintError.operation, "encode-wire-message");
      assert.equal(bigintError.method, "x/test");
      assert.exists(bigintError.cause);
      assert.equal(
        bigintError.message,
        "Codex App Server protocol operation 'encode-wire-message' failed for method 'x/test'.",
      );

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(circularError.operation, "encode-wire-message");
      assert.equal(circularError.method, "x/test");
      assert.exists(circularError.cause);

      const requestError = yield* transport.request("x/request", 1n).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected request encoding to fail"),
        }),
      );
      assert.instanceOf(requestError, CodexError.CodexAppServerProtocolParseError);
      assert.deepInclude(requestError, {
        operation: "encode-wire-message",
        method: "x/request",
        requestId: "1",
      });
    }),
  );

  it.effect("removes interrupted requests before a late response arrives", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const interrupted = yield* transport.request("x/slow", { value: 1 }).pipe(Effect.forkScoped);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 1,
        method: "x/slow",
        params: { value: 1 },
      });
      yield* Fiber.interrupt(interrupted);
      yield* Queue.offer(input, encodeJsonl({ id: 1, result: "late" }));

      const active = yield* transport.request("x/next").pipe(Effect.forkScoped);
      assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
        id: 2,
        method: "x/next",
      });
      yield* Queue.offer(input, encodeJsonl({ id: 2, result: "current" }));
      assert.equal(yield* Fiber.join(active), "current");
    }),
  );

  it.effect("correlates response errors with the originating request", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const response = yield* transport.request("thread/start", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 1,
          error: {
            code: -32602,
            message: "Invalid params",
            data: { field: "cwd" },
          },
        }),
      );

      const error = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected Codex App Server request to fail"),
        }),
      );
      assert.instanceOf(error, CodexError.CodexAppServerRequestError);
      assert.deepInclude(error, {
        code: -32602,
        errorMessage: "Invalid params",
        method: "thread/start",
        requestId: "1",
        operation: "receive-response",
      });
    }),
  );

  it.effect("logs a malformed line safely and continues with the next notification", () =>
    Effect.gen(function* () {
      const secret = "codex-wire-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const events: Array<CodexProtocol.CodexAppServerProtocolLogEvent> = [];
      const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        logIncoming: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });
      const next = yield* protocol.incomingNotifications.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Queue.offer(input, encoder.encode(`{"secret":"${secret}"\n`));
      yield* Queue.offer(input, encodeJsonl({ method: "custom/next", params: { value: "kept" } }));
      assert.deepStrictEqual(yield* Fiber.join(next), [
        { method: "custom/next", params: { value: "kept" } },
      ]);
      const event = events.find(({ stage }) => stage === "decode_failed");
      assert.exists(event);
      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.operation, "decode-wire-message");
      assert.isNumber(payload.issueCount);
      assert.isArray(payload.issueKinds);
      assert.isNumber(payload.maximumPathDepth);
      assert.notProperty(payload, "cause");
      assert.notInclude(encodeUnknownJsonString(event), secret);
    }),
  );

  it.effect("logs unroutable envelope structure without terminating pending requests", () =>
    Effect.gen(function* () {
      const secret = "codex-unroutable-secret-sentinel";
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const events: Array<CodexProtocol.CodexAppServerProtocolLogEvent> = [];
      const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        logIncoming: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });
      const pending = yield* protocol
        .request("custom/read", {}, { requestId: "after-invalid" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(
        input,
        encodeJsonl({ id: true, method: "thread/start", params: { token: secret } }),
      );
      yield* Queue.offer(input, encodeJsonl({ id: "after-invalid", result: { ok: true } }));
      assert.deepStrictEqual(yield* Fiber.join(pending), { ok: true });
      const event = events.find(({ stage }) => stage === "decode_failed");
      assert.exists(event);
      assert.deepInclude(event.payload, {
        operation: "route-wire-message",
        method: "thread/start",
        payloadKind: "object",
        presentFields: ["id", "method", "params"],
      });
      assert.notInclude(encodeUnknownJsonString(event), secret);
    }),
  );

  it.effect("classifies an input stream ending without inventing a cause", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.end(input);

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, CodexError.CodexAppServerInputStreamEndedError);
      assert.equal(error.message, "Codex App Server input stream ended.");
      assert.equal("cause" in error, false);
    }),
  );

  it.effect("fails pending and future commands when the physical protocol terminates", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });
      const pending = yield* transport
        .request("thread/read", { threadId: "thread-1" })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Queue.take(output);

      yield* Queue.end(input);
      const pendingExit = yield* Fiber.join(pending);
      assert.isTrue(pendingExit._tag === "Failure");
      const terminationError = yield* transport.termination.pipe(Effect.flip);
      assert.instanceOf(terminationError, CodexError.CodexAppServerInputStreamEndedError);

      const laterError = yield* transport.notify("initialized").pipe(Effect.flip);
      assert.strictEqual(laterError, terminationError);
    }),
  );

  it.effect("terminates instead of blocking when raw incoming capacity is exhausted", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        incomingCapacity: 1,
      });

      yield* Queue.offer(input, encodeJsonl({ method: "x/first", params: {} }));
      yield* Queue.offer(input, encodeJsonl({ method: "x/second", params: {} }));

      const error = yield* transport.termination.pipe(Effect.flip);
      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.operation, "incoming-capacity");
    }),
  );

  it.effect("bounds retained incoming payload bytes independently of message count", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const first = encodeJsonl({ method: "x/first", params: { value: "a".repeat(32) } });
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        incomingCapacity: 16,
        incomingByteCapacity: first.byteLength + 8,
      });

      yield* Queue.offer(input, first);
      yield* Queue.offer(input, encodeJsonl({ method: "x/second", params: { value: "b" } }));

      const error = yield* transport.termination.pipe(Effect.flip);
      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.operation, "incoming-capacity");
      assert.match(String(error.cause), /bytes/);
    }),
  );

  it.effect("terminates the protocol when one outgoing frame exceeds its physical budget", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        maximumFrameBytes: 64,
      });

      const notifyError = yield* transport
        .notify("x/oversized", { value: "a".repeat(128) })
        .pipe(Effect.flip);
      const terminationError = yield* transport.termination.pipe(Effect.flip);

      assert.instanceOf(notifyError, CodexError.CodexAppServerTransportError);
      assert.equal(notifyError.operation, "outgoing-capacity");
      assert.strictEqual(terminationError, notifyError);
    }),
  );
});

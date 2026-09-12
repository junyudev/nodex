import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import { materializeCodexJson, setCodexReceivedAtMs } from "./transport-values.ts";
import {
  createCodexAppServerReceiveMetrics,
  type CodexAppServerMessageReceipt,
  type CodexAppServerReceiveMetrics,
  type CodexAppServerRequestMetrics,
  type CodexAppServerRequestTrace,
} from "./transport-metrics.ts";
export * from "./transport-metrics.ts";

import * as CodexError from "./errors.ts";
import { JsonRpcId, JsonRpcResponseEnvelope } from "./_internal/shared.ts";
const isJsonRpcId = Schema.is(JsonRpcId);
const isJsonRpcResponseEnvelope = Schema.is(JsonRpcResponseEnvelope);
const isCodexAppServerError = Schema.is(CodexError.CodexAppServerError);

export interface CodexAppServerProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export interface CodexAppServerIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerIncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

/** The app-server withdrew this request, so the client must not write a stale response. */
export const CodexAppServerNoResponse = Symbol.for(
  "@nodex/effect-codex-app-server/CodexAppServerNoResponse",
);

export interface CodexAppServerDecodedMessage {
  readonly value: unknown;
  readonly bytes: number;
  readonly receipt?: CodexAppServerMessageReceipt;
  readonly receivedAtMs?: number;
}

/** W3C trace context serialized on the JSON-RPC request envelope. */
export interface CodexAppServerW3cTraceContext {
  readonly traceparent?: string | null;
  readonly tracestate?: string | null;
}

export interface CodexAppServerRequestOptions {
  readonly requestId?: string;
  readonly preserveResponse?: boolean;
  readonly metricsMode?: "internal" | "deferred";
  /** Mutable transport metrics state. This is not the JSON-RPC W3C trace context. */
  readonly trace?: CodexAppServerRequestTrace;
  readonly wireTrace?: CodexAppServerW3cTraceContext | null;
  readonly observeTransport?: boolean;
  readonly onMetrics?: (metrics: CodexAppServerRequestMetrics) => Effect.Effect<void>;
}

export interface CodexAppServerMessageFrame {
  readonly data: Uint8Array;
  readonly receivedAtMs: number;
}

export interface CodexAppServerPatchedProtocolOptions {
  readonly receiveMetrics?: CodexAppServerReceiveMetrics;
  readonly messageFrames?: Stream.Stream<CodexAppServerMessageFrame, PlatformError.PlatformError>;
  readonly decodedMessages?: Stream.Stream<
    CodexAppServerDecodedMessage,
    PlatformError.PlatformError
  >;
  readonly stdio: Stdio.Stdio;
  /** Message transports preserve each input chunk as one complete JSON envelope. */
  readonly framing?: "jsonl" | "message";
  readonly terminationError?: Effect.Effect<CodexError.CodexAppServerError>;
  /** Maximum decoded messages retained when the protocol is used as a raw Stream source. */
  readonly incomingCapacity?: number;
  /** Maximum encoded messages waiting for the physical writer. */
  readonly outgoingCapacity?: number;
  /** Maximum bytes retained across decoded incoming queues. */
  readonly incomingByteCapacity?: number;
  /** Maximum bytes retained by the physical writer queue. */
  readonly outgoingByteCapacity?: number;
  /** Maximum bytes accepted for one JSONL message in either direction. */
  readonly maximumFrameBytes?: number;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => Effect.Effect<void>;
  readonly onNotification?: (
    notification: CodexAppServerIncomingNotification,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly onRequest?: (
    request: CodexAppServerIncomingRequest,
  ) => Effect.Effect<unknown | typeof CodexAppServerNoResponse, CodexError.CodexAppServerError>;
  readonly onTermination?: (error: CodexError.CodexAppServerError) => Effect.Effect<void>;
}

export interface CodexAppServerPatchedProtocol {
  readonly incomingNotifications: Stream.Stream<
    CodexAppServerIncomingNotification,
    CodexError.CodexAppServerError
  >;
  readonly incomingRequests: Stream.Stream<
    CodexAppServerIncomingRequest,
    CodexError.CodexAppServerError
  >;
  /** Fails exactly once when any physical protocol component stops making progress. */
  readonly termination: Effect.Effect<never, CodexError.CodexAppServerError>;
  readonly request: (
    method: string,
    payload?: unknown,
    options?: CodexAppServerRequestOptions,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly notify: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respond: (
    requestId: string | number,
    result: unknown,
    trace?: CodexAppServerW3cTraceContext | null,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respondError: (
    requestId: string | number,
    error: CodexError.CodexAppServerRequestError,
    trace?: CodexAppServerW3cTraceContext | null,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

interface CodexAppServerPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, CodexError.CodexAppServerError>;
  readonly method: string;
  readonly options?: CodexAppServerRequestOptions;
  readonly trace: CodexAppServerRequestTrace;
  metrics?: CodexAppServerRequestMetrics;
}

interface BufferedMessage<A> {
  readonly bytes: number;
  readonly value: A;
  readonly pendingRequest?: CodexAppServerPendingRequest;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIncomingRequest(value: unknown): value is CodexAppServerIncomingRequest {
  if (!isObject(value) || typeof value.method !== "string") {
    return false;
  }
  return isJsonRpcId(value.id);
}

function isIncomingNotification(value: unknown): value is CodexAppServerIncomingNotification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

function isIncomingResponse(value: unknown): value is typeof JsonRpcResponseEnvelope.Type {
  return isJsonRpcResponseEnvelope(value);
}

const encodeJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const wireEncoder = new TextEncoder();

const encodeWireMessage = (
  message: Record<string, unknown>,
): Effect.Effect<string, CodexError.CodexAppServerProtocolParseError> =>
  encodeJsonString(message).pipe(
    Effect.map((encoded) => `${encoded}\n`),
    Effect.mapError((cause) => {
      const method = typeof message.method === "string" ? message.method : undefined;
      const requestId =
        typeof message.id === "string" || typeof message.id === "number"
          ? String(message.id)
          : undefined;
      return CodexError.CodexAppServerProtocolParseError.fromSchemaError(
        "encode-wire-message",
        cause,
        {
          ...(method === undefined ? {} : { method }),
          ...(requestId === undefined ? {} : { requestId }),
        },
      );
    }),
  );

const decodeWireMessage = (
  line: string,
): Effect.Effect<unknown, CodexError.CodexAppServerProtocolParseError> =>
  decodeJsonString(line).pipe(
    Effect.mapError((cause) =>
      CodexError.CodexAppServerProtocolParseError.fromSchemaError("decode-wire-message", cause),
    ),
  );

const normalizeIncomingError = (
  error: unknown,
  operation: CodexError.CodexAppServerTransportOperation,
): CodexError.CodexAppServerError =>
  isCodexAppServerError(error)
    ? error
    : new CodexError.CodexAppServerTransportError({
        operation,
        cause: error,
      });

const toProtocolMessage = (
  requestId: string | number,
  fields: {
    readonly result?: unknown;
    readonly error?: CodexError.CodexAppServerProtocolErrorShape;
    readonly trace?: CodexAppServerW3cTraceContext | null;
  },
): { readonly [key: string]: unknown } => ({
  id: requestId,
  ...(fields.result !== undefined ? { result: fields.result } : {}),
  ...(fields.error !== undefined ? { error: fields.error } : {}),
  ...(fields.trace == null ? {} : { trace: fields.trace }),
});

export const makeCodexAppServerPatchedProtocol = Effect.fn("makeCodexAppServerPatchedProtocol")(
  function* (
    options: CodexAppServerPatchedProtocolOptions,
  ): Effect.fn.Return<CodexAppServerPatchedProtocol, never, Scope.Scope> {
    const clock = yield* Clock.Clock;
    const receiveMetrics =
      options.receiveMetrics ??
      createCodexAppServerReceiveMetrics({
        transportKind: options.framing === "message" ? "websocket" : "stdio",
      });
    const incomingCapacity = Math.max(1, Math.floor(options.incomingCapacity ?? Infinity));
    const outgoingCapacity = Math.max(1, Math.floor(options.outgoingCapacity ?? Infinity));
    const incomingByteCapacity = Math.max(1, Math.floor(options.incomingByteCapacity ?? Infinity));
    const outgoingByteCapacity = Math.max(1, Math.floor(options.outgoingByteCapacity ?? Infinity));
    const maximumFrameBytes = Math.max(1, Math.floor(options.maximumFrameBytes ?? Infinity));
    const outgoing = yield* Queue.dropping<BufferedMessage<string>, CodexError.CodexAppServerError>(
      outgoingCapacity,
    );
    const incomingNotifications = yield* Queue.dropping<
      BufferedMessage<CodexAppServerIncomingNotification>,
      CodexError.CodexAppServerError
    >(incomingCapacity);
    const incomingRequests = yield* Queue.dropping<
      BufferedMessage<CodexAppServerIncomingRequest>,
      CodexError.CodexAppServerError
    >(incomingCapacity);
    const incomingBufferedBytes = yield* Ref.make(0);
    const outgoingBufferedBytes = yield* Ref.make(0);
    const outgoingAdmission = yield* Semaphore.make(1);
    const pending = yield* Ref.make(new Map<string, CodexAppServerPendingRequest>());
    const nextRequestId = yield* Ref.make(1);
    const remainder = yield* Ref.make("");
    const terminationState = yield* Ref.make<CodexError.CodexAppServerError | null>(null);
    const termination = yield* Deferred.make<never, CodexError.CodexAppServerError>();

    const logProtocol = (event: CodexAppServerProtocolLogEvent) => {
      if (event.direction === "incoming" && !options.logIncoming) {
        return Effect.void;
      }
      if (event.direction === "outgoing" && !options.logOutgoing) {
        return Effect.void;
      }
      return (
        options.logger?.(event) ??
        Effect.logDebug("Codex App Server protocol event").pipe(Effect.annotateLogs({ event }))
      );
    };

    const failAllPending = (error: CodexError.CodexAppServerError) =>
      Ref.get(pending).pipe(
        Effect.flatMap((current) =>
          Effect.forEach([...current.values()], ({ deferred }) => Deferred.fail(deferred, error), {
            discard: true,
          }),
        ),
        Effect.andThen(Ref.set(pending, new Map())),
      );

    const handleTermination = (classify: () => Effect.Effect<CodexError.CodexAppServerError>) =>
      Effect.gen(function* () {
        const error = yield* classify();
        const claimed = yield* Ref.modify(terminationState, (current) =>
          current === null ? ([true, error] as const) : ([false, current] as const),
        );
        if (!claimed) return;

        yield* Effect.all(
          [
            failAllPending(error),
            Queue.fail(outgoing, error),
            Queue.fail(incomingNotifications, error),
            Queue.fail(incomingRequests, error),
            Deferred.fail(termination, error),
          ],
          { discard: true },
        );
        if (options.onTermination) {
          yield* options
            .onTermination(error)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Codex App Server termination observer failed").pipe(
                  Effect.annotateLogs({ cause }),
                ),
              ),
            );
        }
      }).pipe(Effect.uninterruptible);

    const capacityError = (
      operation: "incoming-capacity" | "outgoing-capacity",
      capacity: number,
      unit = "messages",
    ) =>
      new CodexError.CodexAppServerTransportError({
        operation,
        cause: new Error(`Codex App Server protocol capacity ${capacity} ${unit} is exhausted`),
      });

    const reserveBytes = (
      bytes: Ref.Ref<number>,
      amount: number,
      maximum: number,
      operation: "incoming-capacity" | "outgoing-capacity",
    ) =>
      Effect.gen(function* () {
        const reserved = yield* Ref.modify(bytes, (current) =>
          current + amount > maximum
            ? ([false, current] as const)
            : ([true, current + amount] as const),
        );
        if (reserved) return;
        return yield* capacityError(operation, maximum, "bytes");
      });

    const releaseBytes = (bytes: Ref.Ref<number>, amount: number) =>
      Ref.update(bytes, (current) => Math.max(0, current - amount));

    const terminateOutgoingCapacity = (error: CodexError.CodexAppServerTransportError) =>
      handleTermination(() => Effect.succeed(error)).pipe(Effect.andThen(Effect.fail(error)));

    const offerOutgoing = (
      message: Record<string, unknown>,
      pendingRequest?: CodexAppServerPendingRequest,
    ): Effect.Effect<void, CodexError.CodexAppServerError> =>
      outgoingAdmission
        .withPermits(1)(
          Effect.gen(function* () {
            const stopped = yield* Ref.get(terminationState);
            if (stopped !== null) return yield* stopped;
            yield* logProtocol({
              direction: "outgoing",
              stage: "decoded",
              payload: message,
            });
            const jsonl = yield* encodeWireMessage(message);
            const encoded = options.framing === "message" ? jsonl.slice(0, -1) : jsonl;
            const bytes = wireEncoder.encode(encoded).byteLength;
            if (bytes > maximumFrameBytes) {
              return yield* capacityError("outgoing-capacity", maximumFrameBytes, "frame bytes");
            }
            yield* logProtocol({
              direction: "outgoing",
              stage: "raw",
              payload: encoded,
            });
            yield* reserveBytes(
              outgoingBufferedBytes,
              bytes,
              outgoingByteCapacity,
              "outgoing-capacity",
            );
            const accepted = yield* Queue.offer(outgoing, {
              bytes,
              value: encoded,
              pendingRequest,
            });
            if (accepted) return;
            yield* releaseBytes(outgoingBufferedBytes, bytes);
            const terminated = yield* Ref.get(terminationState);
            if (terminated !== null) return yield* terminated;
            return yield* capacityError("outgoing-capacity", outgoingCapacity);
          }),
        )
        .pipe(
          Effect.catchTag("CodexAppServerTransportError", (error) =>
            error.operation === "outgoing-capacity"
              ? terminateOutgoingCapacity(error)
              : Effect.fail(error),
          ),
        );

    const resolvePending = (
      requestId: string,
      handler: (pendingRequest: CodexAppServerPendingRequest) => Effect.Effect<void>,
    ) =>
      Ref.modify(pending, (current) => {
        const pendingRequest = current.get(requestId);
        if (!pendingRequest) {
          return [Effect.void, current] as const;
        }
        const next = new Map(current);
        next.delete(requestId);
        return [handler(pendingRequest), next] as const;
      }).pipe(Effect.flatten);

    const respond = (
      requestId: string | number,
      result: unknown,
      trace?: CodexAppServerW3cTraceContext | null,
    ) => offerOutgoing(toProtocolMessage(requestId, { result, trace }));

    const respondError = (
      requestId: string | number,
      error: CodexError.CodexAppServerRequestError,
      trace?: CodexAppServerW3cTraceContext | null,
    ) => offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError(), trace }));

    const handleResponse = (
      response: typeof JsonRpcResponseEnvelope.Type,
      bytes: number,
      receipt: CodexAppServerMessageReceipt,
    ) => {
      const requestId = String(response.id);
      const protocolError = response.error;
      return resolvePending(requestId, (pendingRequest) =>
        Effect.gen(function* () {
          const completedAtMs = clock.currentTimeMillisUnsafe();
          Object.assign(pendingRequest.trace, { completedAtMs, responseBytes: bytes, receipt });
          pendingRequest.trace.onResponse?.(receipt);
          if (
            pendingRequest.options?.metricsMode === undefined &&
            pendingRequest.options?.onMetrics
          )
            pendingRequest.metrics = receiveMetrics.finishRequest({
              ...pendingRequest.trace,
              completedAtMs,
            });
          if (protocolError !== undefined) {
            yield* Deferred.fail(
              pendingRequest.deferred,
              CodexError.CodexAppServerRequestError.fromProtocolError(
                protocolError,
                pendingRequest.method,
                requestId,
              ),
            );
            return;
          }
          yield* Deferred.succeed(
            pendingRequest.deferred,
            pendingRequest.options?.preserveResponse
              ? response.result
              : materializeCodexJson(response.result),
          );
        }),
      );
    };

    const offerIncoming = <A>(
      queue: Queue.Queue<BufferedMessage<A>, CodexError.CodexAppServerError>,
      value: A,
      bytes: number,
    ) =>
      Effect.gen(function* () {
        yield* reserveBytes(
          incomingBufferedBytes,
          bytes,
          incomingByteCapacity,
          "incoming-capacity",
        );
        const accepted = yield* Queue.offer(queue, { bytes, value });
        if (accepted) return;
        yield* releaseBytes(incomingBufferedBytes, bytes);
        return yield* capacityError("incoming-capacity", incomingCapacity);
      });

    const handleRequest = (request: CodexAppServerIncomingRequest, bytes: number) =>
      Effect.gen(function* () {
        if (!options.onRequest) {
          yield* offerIncoming(incomingRequests, request, bytes);
          return;
        }
        const result = yield* options.onRequest(request);
        if (result !== CodexAppServerNoResponse) yield* respond(request.id, result);
      });

    const handleNotification = (notification: CodexAppServerIncomingNotification, bytes: number) =>
      Effect.gen(function* () {
        if (!options.onNotification) {
          yield* offerIncoming(incomingNotifications, notification, bytes);
          return;
        }
        yield* options.onNotification(notification);
      });

    const routeMessage = (
      message: unknown,
      bytes: number,
      received?: CodexAppServerMessageReceipt,
      receivedAtMs?: number,
    ): Effect.Effect<void, CodexError.CodexAppServerError> => {
      const receipt =
        (options.receiveMetrics ? received : undefined) ??
        receiveMetrics.observeIncoming(message, bytes, {
          receivedAtMs: receivedAtMs ?? clock.currentTimeMillisUnsafe(),
        });
      if (isIncomingRequest(message)) {
        return handleRequest(materializeCodexJson(message) as CodexAppServerIncomingRequest, bytes);
      }
      if (isIncomingNotification(message)) {
        if (typeof message === "object" && message !== null)
          setCodexReceivedAtMs(message, receipt.timing.receivedAtMs);
        if (typeof message.params === "object" && message.params !== null)
          setCodexReceivedAtMs(message.params, receipt.timing.receivedAtMs);
        return handleNotification(
          materializeCodexJson(message) as CodexAppServerIncomingNotification,
          bytes,
        );
      }
      if (isIncomingResponse(message)) {
        return handleResponse(message, bytes, receipt);
      }
      return Effect.fail(
        CodexError.CodexAppServerProtocolParseError.fromUnroutableMessage(message),
      );
    };

    const handleLine = (
      line: string,
      receivedAtMs?: number,
    ): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (line.trim().length === 0) {
        return Effect.void;
      }
      const bytes = wireEncoder.encode(line).byteLength;
      if (bytes > maximumFrameBytes) {
        return Effect.fail(capacityError("incoming-capacity", maximumFrameBytes, "frame bytes"));
      }
      return logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: line,
      }).pipe(
        Effect.flatMap(() => decodeWireMessage(line)),
        Effect.tap((decoded) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: decoded,
          }),
        ),
        Effect.flatMap((message) => routeMessage(message, bytes, undefined, receivedAtMs)),
        Effect.tapErrorTag("CodexAppServerProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              operation: error.operation,
              ...(error.payloadKind === undefined ? {} : { payloadKind: error.payloadKind }),
              ...(error.presentFields === undefined ? {} : { presentFields: error.presentFields }),
              ...(error.method === undefined ? {} : { method: error.method }),
              ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
              ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
              ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
              ...(error.maximumPathDepth === undefined
                ? {}
                : { maximumPathDepth: error.maximumPathDepth }),
            },
          }),
        ),
        Effect.catchTag("CodexAppServerProtocolParseError", () => Effect.void),
      );
    };

    const readInput = options.decodedMessages
      ? options.decodedMessages.pipe(
          Stream.runForEach(({ value, bytes, receipt, receivedAtMs }) =>
            routeMessage(value, bytes, receipt, receivedAtMs).pipe(
              Effect.catchTag("CodexAppServerProtocolParseError", (error) =>
                logProtocol({
                  direction: "incoming",
                  stage: "decode_failed",
                  payload: { operation: error.operation, method: error.method },
                }),
              ),
            ),
          ),
        )
      : options.messageFrames
        ? options.messageFrames.pipe(
            Stream.runForEach((frame) =>
              handleLine(new TextDecoder().decode(frame.data), frame.receivedAtMs),
            ),
          )
        : options.framing === "message"
          ? options.stdio.stdin.pipe(
              Stream.runForEach((frame) => handleLine(new TextDecoder().decode(frame))),
            )
          : options.stdio.stdin.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Ref.modify(remainder, (current) => {
                  const combined = current + chunk;
                  const lines = combined.split("\n");
                  const nextRemainder = lines.pop() ?? "";
                  return [
                    {
                      lines: lines.map((line) => line.replace(/\r$/, "")),
                      remainderBytes: wireEncoder.encode(nextRemainder).byteLength,
                    },
                    nextRemainder,
                  ] as const;
                }).pipe(
                  Effect.flatMap(({ lines, remainderBytes }) =>
                    remainderBytes > maximumFrameBytes
                      ? Effect.fail(
                          capacityError("incoming-capacity", maximumFrameBytes, "frame bytes"),
                        )
                      : Effect.forEach(lines, (line) => handleLine(line), { discard: true }),
                  ),
                ),
              ),
            );
    yield* readInput.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          handleTermination(() =>
            Effect.succeed(normalizeIncomingError(error, "read-input-stream")),
          ),
        onSuccess: () =>
          Ref.get(remainder).pipe(
            Effect.flatMap((line) => (line.trim().length === 0 ? Effect.void : handleLine(line))),
            Effect.matchEffect({
              onFailure: (error) => handleTermination(() => Effect.succeed(error)),
              onSuccess: () =>
                handleTermination(
                  () =>
                    options.terminationError ??
                    Effect.succeed(new CodexError.CodexAppServerInputStreamEndedError({})),
                ),
            }),
          ),
      }),
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(outgoing).pipe(
      Stream.mapEffect((message) =>
        Effect.sync(() => {
          const pendingRequest = message.pendingRequest;
          if (!pendingRequest) return;
          const trace = pendingRequest.trace;
          trace.startedAtMs = clock.currentTimeMillisUnsafe();
          trace.requestBytes = message.bytes - (options.framing === "message" ? 0 : 1);
          if (pendingRequest.options?.metricsMode !== "internal")
            trace.observation = receiveMetrics.startRequest(
              trace.startedAtMs,
              pendingRequest.options?.observeTransport,
            );
          trace.onDispatched?.();
        }).pipe(
          Effect.andThen(releaseBytes(outgoingBufferedBytes, message.bytes)),
          Effect.as(message.value),
        ),
      ),
      Stream.run(options.stdio.stdout()),
      Effect.matchEffect({
        onFailure: (error) =>
          handleTermination(() =>
            Effect.succeed(normalizeIncomingError(error, "write-output-stream")),
          ),
        onSuccess: () =>
          handleTermination(() =>
            Effect.succeed(
              new CodexError.CodexAppServerTransportError({
                operation: "write-output-stream",
                cause: new Error("Codex App Server output stream ended"),
              }),
            ),
          ),
      }),
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      handleTermination(() =>
        Effect.succeed(
          new CodexError.CodexAppServerTransportError({
            operation: "protocol-scope-closed",
            cause: new Error("Codex App Server protocol Scope closed"),
          }),
        ),
      ),
    );

    const request = (method: string, payload?: unknown, options?: CodexAppServerRequestOptions) =>
      Effect.gen(function* () {
        const requestId =
          options?.requestId ??
          (yield* Ref.modify(nextRequestId, (current) => [current, current + 1] as const));
        const deferred = yield* Deferred.make<unknown, CodexError.CodexAppServerError>();
        const trace: CodexAppServerRequestTrace = options?.trace ?? {};
        trace.receiver = receiveMetrics;
        const pendingRequest: CodexAppServerPendingRequest = { deferred, method, options, trace };
        const reserved = yield* Ref.modify(pending, (current) =>
          current.has(String(requestId))
            ? ([false, current] as const)
            : ([true, new Map(current).set(String(requestId), pendingRequest)] as const),
        );
        if (!reserved)
          return yield* new CodexError.CodexAppServerTransportError({
            operation: "duplicate-request-id",
            cause: new Error("Request identity is already pending"),
          });
        const cleanup = Ref.update(pending, (current) => {
          if (current.get(String(requestId))?.deferred !== deferred) return current;
          const next = new Map(current);
          next.delete(String(requestId));
          return next;
        });
        const reportMetrics = Effect.gen(function* () {
          const metrics = pendingRequest.metrics;
          if (!metrics) return;
          yield* Effect.annotateCurrentSpan({
            "app_server.request_id": String(requestId),
            ...Object.fromEntries(
              Object.entries(metrics).map(([key, value]) => [`app_server.${key}`, value]),
            ),
          });
          yield* Effect.logDebug("Codex app-server response received").pipe(
            Effect.annotateLogs({ requestId, method, ...metrics }),
          );
          if (options?.onMetrics) yield* options.onMetrics(metrics);
        });
        const internal = options?.metricsMode !== "deferred" && !options?.onMetrics;
        if (internal) receiveMetrics.beginInternalRequest();
        return yield* offerOutgoing(
          {
            id: requestId,
            method,
            ...(payload !== undefined ? { params: payload } : {}),
            ...(options?.wireTrace !== undefined ? { trace: options.wireTrace } : {}),
          },
          pendingRequest,
        ).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.ensuring(cleanup),
          Effect.ensuring(reportMetrics),
          Effect.ensuring(
            Effect.sync(() => {
              if (internal) receiveMetrics.endInternalRequest();
            }),
          ),
        );
      });

    const notify = (method: string, payload?: unknown) =>
      offerOutgoing({
        method,
        ...(payload !== undefined ? { params: payload } : {}),
      });

    return {
      incomingNotifications: Stream.fromQueue(incomingNotifications).pipe(
        Stream.mapEffect((message) =>
          releaseBytes(incomingBufferedBytes, message.bytes).pipe(Effect.as(message.value)),
        ),
      ),
      incomingRequests: Stream.fromQueue(incomingRequests).pipe(
        Stream.mapEffect((message) =>
          releaseBytes(incomingBufferedBytes, message.bytes).pipe(Effect.as(message.value)),
        ),
      ),
      termination: Deferred.await(termination),
      request,
      notify,
      respond,
      respondError,
    } satisfies CodexAppServerPatchedProtocol;
  },
);

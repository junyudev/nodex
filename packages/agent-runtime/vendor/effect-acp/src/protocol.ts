import * as BoundedQueue from "@t3tools/shared/BoundedQueue";
import type * as AcpCompat from "./compat.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Stdio from "effect/Stdio";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

import * as AcpSchema from "./schema.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import { CLIENT_METHODS } from "./_generated/meta.gen.ts";
import * as AcpError from "./errors.ts";
import { isolateNotificationHandler } from "./_internal/shared.ts";
const isAcpError = Schema.is(AcpError.AcpError);

export interface AcpProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

/** Stable transport identity for an inbound ACP JSON-RPC request. */
export interface AcpRequestContext {
  readonly requestId: string;
  readonly method: string;
}

/** Lossless string identity for JSON-RPC request IDs used by callback maps. */
export function acpRequestIdentity(requestId: AcpError.AcpRequestId): string {
  const prefix = "$t3:jsonrpc:";
  if (typeof requestId === "number") return `${prefix}number:${requestId}`;
  return requestId.startsWith(prefix) ? `${prefix}string:${requestId}` : requestId;
}

export type AcpRequestHandler<Request, Response> = (
  request: Request,
  context: AcpRequestContext,
) => Effect.Effect<Response, AcpError.AcpError>;

export type AcpIncomingNotification =
  | {
      readonly _tag: "SessionUpdate";
      readonly method: typeof CLIENT_METHODS.session_update;
      readonly params:
        | AcpSchema.UpdateSessionNotification
        | AcpSchemaV1.SessionNotification
        | AcpCompat.SessionNotification;
    }
  | {
      readonly _tag: "ElicitationComplete";
      readonly method: typeof CLIENT_METHODS.elicitation_complete | "session/elicitation/complete";
      readonly params: AcpSchema.CompleteElicitationNotification;
    }
  | {
      readonly _tag: "ExtNotification";
      readonly method: string;
      readonly params: unknown;
    };

/** Standard I/O whose input can report provider-specific ACP failures. */
export interface AcpStdio extends Omit<Stdio.Stdio, "stdin"> {
  readonly stdin: Stream.Stream<Uint8Array, PlatformError.PlatformError | AcpError.AcpError>;
}

export interface AcpPatchedProtocolOptions {
  readonly stdio: AcpStdio;
  readonly terminationError?: Effect.Effect<AcpError.AcpError>;
  readonly serverRequestMethods: ReadonlySet<string>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onIncomingRequest?: (
    requestId: string,
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, never>;

  readonly transformSessionUpdate?: (
    notification: AcpSchema.UpdateSessionNotification | AcpSchemaV1.SessionNotification,
  ) =>
    | AcpSchema.UpdateSessionNotification
    | AcpSchemaV1.SessionNotification
    | AcpCompat.SessionNotification;
  readonly onNotification?: (
    notification: AcpIncomingNotification,
  ) => Effect.Effect<void, AcpError.AcpError, never>;
  readonly onExtRequest?: (
    method: string,
    params: unknown,
    context: AcpRequestContext,
  ) => Effect.Effect<unknown, AcpError.AcpError, never>;
  readonly onTermination?: (error: AcpError.AcpError) => Effect.Effect<void, never, never>;
  readonly onOutgoingResponseFailure?: (
    requestId: string,
    error: AcpError.AcpError,
  ) => Effect.Effect<void, never>;
  readonly onOutgoingResponse?: (requestId: string) => Effect.Effect<void, never>;
  readonly testHooks?: {
    readonly onOutgoingWriteAdmitted?: () => Effect.Effect<void>;
    /** Invoked from the stdout writer exit path (after intentional/unexpected handling). */
    readonly onOutgoingWriterExit?: (input: {
      readonly intentionalEnd: boolean;
    }) => Effect.Effect<void>;
  };
}

export interface AcpPatchedProtocol {
  readonly clientProtocol: RpcClient.Protocol["Service"];
  readonly serverProtocol: RpcServer.Protocol["Service"];
  readonly incoming: Stream.Stream<AcpIncomingNotification, AcpError.AcpError>;
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
}

interface AcpPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, AcpError.AcpError>;
  readonly method: string;
}

interface AcpOutgoingWrite {
  readonly acknowledgement?: Deferred.Deferred<void, AcpError.AcpError>;
  readonly payload: string | Uint8Array;
}

interface AcpOutgoingWriterState {
  readonly outstandingAcknowledgements: ReadonlySet<Deferred.Deferred<void, AcpError.AcpError>>;
  readonly intentionalEnd: boolean;
  readonly terminalError?: AcpError.AcpError;
}

const decodeSessionUpdate = Schema.decodeUnknownEffect(
  Schema.Union([AcpSchema.UpdateSessionNotification, AcpSchemaV1.SessionNotification]),
);
const decodeElicitationComplete = Schema.decodeUnknownEffect(
  AcpSchema.CompleteElicitationNotification,
);
const parserFactory = RpcSerialization.ndJsonRpc();
// ndJsonRpc skips lines that are not JSON. A malformed agent line has to end the
// session, so frames are split here and each one goes through the strict codec.
const makeStrictNdJsonRpcParser = () => {
  const codec = RpcSerialization.jsonRpc().makeUnsafe();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    decode: (bytes: Uint8Array | string): ReadonlyArray<unknown> => {
      const chunk = typeof bytes === "string" ? bytes : decoder.decode(bytes, { stream: true });
      BoundedQueue.assertFrameSize(BoundedQueue.encodedBytes(chunk), "ACP wire chunk");
      BoundedQueue.assertFrameSize(
        BoundedQueue.encodedBytes(buffer) + BoundedQueue.encodedBytes(chunk),
        "ACP wire frame",
      );
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.length > BoundedQueue.DEFAULT_MAX_ITEMS)
        throw new BoundedQueue.BufferOverflow({
          label: "ACP wire batch",
          maxItems: BoundedQueue.DEFAULT_MAX_ITEMS,
          maxBytes: BoundedQueue.MAX_FRAME_BYTES,
        });
      return lines.flatMap((line) => codec.decode(line));
    },
    encode: (response: Parameters<typeof codec.encode>[0]) => {
      const encoded = codec.encode(response);
      return encoded === undefined ? undefined : `${encoded}\n`;
    },
  };
};
// Outbound JSON-RPC notification: no `id`, so peers never treat it as a request.
const encodeJsonRpcNotification = Schema.encodeUnknownExit(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      method: Schema.String,
      params: Schema.Unknown,
    }),
  ),
);

const isEffectRpcRequestId = (requestId: AcpError.AcpRequestId): boolean =>
  typeof requestId === "number" && Number.isSafeInteger(requestId);

/**
 * Effect RPC's JSON-RPC codec treats a standard JSON-RPC error object as a
 * defect unless it carries Effect's private `_tag: "Cause"` envelope. ACP
 * agents correctly send the standard `{ code, message, data? }` shape, so
 * restore it to the typed failure channel before handing it to RpcClient.
 */
function normalizeAcpJsonRpcError(
  message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
): RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded {
  if (message._tag !== "Exit" || message.exit._tag !== "Failure") return message;
  const [failure] = message.exit.cause;
  if (
    message.exit.cause.length !== 1 ||
    failure?._tag !== "Die" ||
    !isProtocolError(failure.defect)
  ) {
    return message;
  }
  return {
    ...message,
    exit: {
      _tag: "Failure",
      cause: [{ _tag: "Fail", error: failure.defect }],
    },
  };
}

export const makeAcpPatchedProtocol = Effect.fn("makeAcpPatchedProtocol")(function* (
  options: AcpPatchedProtocolOptions,
): Effect.fn.Return<AcpPatchedProtocol, never, Scope.Scope> {
  const parser = makeStrictNdJsonRpcParser();
  const overflowError = (cause: BoundedQueue.BufferOverflow): AcpError.AcpError =>
    new AcpError.AcpTransportError({ detail: cause.message, cause });
  const serverQueue = yield* BoundedQueue.make<RpcMessage.FromClientEncoded, AcpError.AcpError>({
    label: "ACP server intake",
    mapOverflow: overflowError,
  });
  const clientQueue = yield* BoundedQueue.make<RpcMessage.FromServerEncoded, AcpError.AcpError>({
    label: "ACP client intake",
    mapOverflow: overflowError,
  });
  const notificationQueue = yield* BoundedQueue.broadcast<
    AcpIncomingNotification,
    AcpError.AcpError
  >({ label: "ACP notifications", mapOverflow: overflowError });
  const disconnects = yield* Queue.bounded<number>(1);
  const outgoing = yield* BoundedQueue.make<AcpOutgoingWrite, AcpError.AcpError>({
    label: "ACP outgoing",
    maxBytes: BoundedQueue.MAX_PROMPT_BYTES,
    sizeOf: (write) => BoundedQueue.encodedBytes(write.payload),
    mapOverflow: overflowError,
  });
  const outgoingWriterState = yield* Ref.make<AcpOutgoingWriterState>({
    intentionalEnd: false,
    outstandingAcknowledgements: new Set(),
  });
  const nextRequestId = yield* Ref.make(1);
  const terminationHandled = yield* Ref.make(false);
  const terminationFailure = yield* Deferred.make<never, AcpError.AcpError>();
  const extPending = yield* Ref.make(new Map<string, AcpPendingRequest>());
  const nativeRequestBytes = new Map<string, number>();
  let activeNativeBytes = 0;

  const ensureActive = Ref.get(terminationHandled).pipe(
    Effect.flatMap((terminated) => (terminated ? Deferred.await(terminationFailure) : Effect.void)),
  );

  const logProtocol = (event: AcpProtocolLogEvent) => {
    if (event.direction === "incoming" && !options.logIncoming) {
      return Effect.void;
    }
    if (event.direction === "outgoing" && !options.logOutgoing) {
      return Effect.void;
    }
    return (
      options.logger?.(event) ??
      Effect.logDebug("ACP protocol event").pipe(Effect.annotateLogs({ event }))
    );
  };

  const offerOutgoing = Effect.fn("offerOutgoing")(
    function* (message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded) {
      // RpcClient emits `@effect/rpc/Interrupt` when a pending request's fiber is interrupted.
      // ACP has no such method; agents log it as an error and cannot act on it, so drop it.
      if (message._tag === "Interrupt") {
        return;
      }
      yield* ensureActive;
      yield* logProtocol({
        direction: "outgoing",
        stage: "decoded",
        payload: message,
      });

      const method = message._tag === "Request" ? message.tag : undefined;
      const encodedRequestId =
        message._tag === "Request"
          ? message.id
          : "requestId" in message
            ? message.requestId
            : undefined;
      const requestId = encodedRequestId === "" ? undefined : encodedRequestId;
      const encoded = yield* Effect.try({
        try: () => parser.encode(message),
        catch: (cause) =>
          AcpError.AcpProtocolParseError.fromEncodingError(method, requestId, cause),
      });

      if (encoded) {
        yield* logProtocol({
          direction: "outgoing",
          stage: "raw",
          payload: typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded),
        });

        yield* ensureActive;
        const acknowledgement =
          message._tag === "Exit" ? yield* Deferred.make<void, AcpError.AcpError>() : undefined;
        const admissionError = yield* Ref.modify(outgoingWriterState, (state) => {
          if (state.terminalError !== undefined) {
            return [state.terminalError, state] as const;
          }
          if (acknowledgement === undefined) {
            return [undefined, state] as const;
          }
          return [
            undefined,
            {
              ...state,
              outstandingAcknowledgements: new Set(state.outstandingAcknowledgements).add(
                acknowledgement,
              ),
            },
          ] as const;
        });
        if (admissionError !== undefined) {
          return yield* admissionError;
        }
        if (options.testHooks?.onOutgoingWriteAdmitted !== undefined) {
          yield* options.testHooks.onOutgoingWriteAdmitted();
        }
        yield* BoundedQueue.offer(outgoing, {
          payload: encoded,
          ...(acknowledgement === undefined ? {} : { acknowledgement }),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new AcpError.AcpTransportError({
                detail: "Failed to queue an outgoing ACP message",
                cause,
              }),
          ),
          Effect.filterOrFail(
            (accepted) => accepted,
            () =>
              new AcpError.AcpTransportError({
                detail: "The ACP output queue was closed before accepting a message",
                cause: "Output queue closed",
              }),
          ),
          Effect.tapError((error) =>
            acknowledgement === undefined
              ? Effect.void
              : Ref.update(outgoingWriterState, (state) => {
                  const updated = new Set(state.outstandingAcknowledgements);
                  updated.delete(acknowledgement);
                  return { ...state, outstandingAcknowledgements: updated };
                }).pipe(Effect.andThen(Deferred.fail(acknowledgement, error)), Effect.asVoid),
          ),
        );
        if (acknowledgement !== undefined) {
          yield* Deferred.await(acknowledgement);
        }
        if (message._tag === "Exit") {
          const key = acpRequestIdentity(message.requestId);
          activeNativeBytes -= nativeRequestBytes.get(key) ?? 0;
          nativeRequestBytes.delete(key);
          if (options.onOutgoingResponse !== undefined) yield* options.onOutgoingResponse(key);
        }
      }
    },
    Effect.tapError((error) =>
      error._tag === "AcpTransportError"
        ? handleTermination(() => Effect.succeed(error))
        : Effect.void,
    ),
  );

  const resolveExtPending = (
    requestId: AcpError.AcpRequestId,
    onFound: (pendingRequest: AcpPendingRequest) => Effect.Effect<void>,
  ) =>
    Ref.modify(extPending, (pending) => {
      const pendingKey = acpRequestIdentity(requestId);
      const pendingRequest = pending.get(pendingKey);
      if (!pendingRequest) {
        return [Effect.void, pending] as const;
      }
      const next = new Map(pending);
      next.delete(pendingKey);
      return [onFound(pendingRequest), next] as const;
    }).pipe(Effect.flatten);

  const removeExtPending = (requestId: AcpError.AcpRequestId) =>
    Ref.update(extPending, (pending) => {
      const pendingKey = acpRequestIdentity(requestId);
      if (!pending.has(pendingKey)) {
        return pending;
      }
      const next = new Map(pending);
      next.delete(pendingKey);
      return next;
    });

  const completeExtPendingFailure = (requestId: AcpError.AcpRequestId, error: AcpError.AcpError) =>
    resolveExtPending(requestId, ({ deferred }) => Deferred.fail(deferred, error));

  const completeExtPendingSuccess = (requestId: AcpError.AcpRequestId, value: unknown) =>
    resolveExtPending(requestId, ({ deferred }) => Deferred.succeed(deferred, value));

  const failAllExtPending = (error: AcpError.AcpError) =>
    Ref.getAndSet(extPending, new Map()).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach([...pending.values()], ({ deferred }) => Deferred.fail(deferred, error), {
          discard: true,
        }),
      ),
    );

  const dispatchNotification = (notification: AcpIncomingNotification) =>
    notificationQueue.offer(notification).pipe(
      Effect.flatMap((accepted) =>
        accepted
          ? Effect.void
          : Effect.fail(
              overflowError(
                new BoundedQueue.BufferOverflow({
                  label: "ACP notification observer",
                  maxItems: BoundedQueue.DEFAULT_MAX_ITEMS,
                  maxBytes: BoundedQueue.DEFAULT_MAX_BYTES,
                }),
              ),
            ),
      ),
      Effect.andThen(
        // A failing or dying handler must not stop the reader, or every later
        // message on the connection goes unanswered.
        options.onNotification
          ? isolateNotificationHandler(options.onNotification(notification))
          : Effect.void,
      ),
      Effect.asVoid,
    );

  const clientProtocolError = (error: AcpError.AcpError): RpcMessage.FromServerEncoded => ({
    _tag: "ClientProtocolError",
    error: new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "ACP protocol terminated.",
        cause: error,
      }),
    }),
  });

  const handleTermination = (classify: () => Effect.Effect<AcpError.AcpError>) =>
    Ref.modify(terminationHandled, (handled) => {
      if (handled) {
        return [Effect.void, true] as const;
      }
      return [
        Effect.gen(function* () {
          yield* Effect.sync(() => Queue.offerUnsafe(disconnects, 0));
          const error = yield* classify();
          yield* Deferred.fail(terminationFailure, error);
          yield* failAllExtPending(error);
          nativeRequestBytes.clear();
          activeNativeBytes = 0;
          if (options.onTermination) {
            yield* options.onTermination(error);
          }
          // Clean EOF preserves already accepted responses; overflow discards
          // them because the connection can no longer deliver a complete stream.
          if (error._tag === "AcpInputStreamEndedError" || error._tag === "AcpProcessExitedError")
            yield* BoundedQueue.end(clientQueue);
          else yield* BoundedQueue.fail(clientQueue, error);
          yield* BoundedQueue.fail(serverQueue, error);
          yield* BoundedQueue.fail(outgoing, error);
          yield* notificationQueue.fail(error);
          const pendingWrites = yield* Ref.getAndUpdate(outgoingWriterState, (state) => ({
            ...state,
            terminalError: error,
            outstandingAcknowledgements: new Set<Deferred.Deferred<void, AcpError.AcpError>>(),
          }));
          yield* Effect.forEach(
            pendingWrites.outstandingAcknowledgements,
            (ack) => Deferred.fail(ack, error),
            { discard: true },
          );
        }),
        true,
      ] as const;
    }).pipe(Effect.flatten);

  const respondWithSuccess = (requestId: AcpError.AcpRequestId, value: unknown) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Success",
        value,
      },
    });

  const respondWithError = (requestId: AcpError.AcpRequestId, error: AcpError.AcpRequestError) =>
    offerOutgoing({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: error.toProtocolError(),
          },
        ],
      },
    });

  const handleExtRequest = (message: RpcMessage.RequestEncoded) => {
    if (!options.onExtRequest) {
      return respondWithError(message.id, AcpError.AcpRequestError.methodNotFound(message.tag));
    }
    return options
      .onExtRequest(message.tag, message.payload, {
        requestId: acpRequestIdentity(message.id),
        method: message.tag,
      })
      .pipe(
        Effect.matchCauseEffect({
          // A dying handler answers its own request, like a core handler, and
          // leaves the reader running. A defect wins over a typed failure in
          // the same cause, so it is never hidden behind an expected error.
          onFailure: (cause) => {
            const failure = Cause.hasDies(cause) ? Option.none() : Cause.findErrorOption(cause);
            if (Option.isSome(failure)) {
              return respondWithError(
                message.id,
                AcpError.AcpRequestError.fromExtensionHandlerError(failure.value, message.tag),
              );
            }
            return Effect.logError(
              `ACP extension request handler failed for '${message.tag}'`,
              cause,
            ).pipe(
              Effect.andThen(
                respondWithError(
                  message.id,
                  AcpError.AcpRequestError.internalError(
                    `ACP extension request handler failed for method '${message.tag}'`,
                    undefined,
                    {
                      method: message.tag,
                      operation: "handle-extension-request",
                      cause: Cause.squash(cause),
                    },
                  ),
                ),
              ),
            );
          },
          onSuccess: (value) => respondWithSuccess(message.id, value),
        }),
      );
  };

  const handleRequestEncoded = (message: RpcMessage.RequestEncoded) => {
    if (message.id === "") {
      if (message.tag === CLIENT_METHODS.session_update) {
        return decodeSessionUpdate(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "SessionUpdate",
                method: CLIENT_METHODS.session_update,
                params: options.transformSessionUpdate?.(params) ?? params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError((cause) =>
            AcpError.AcpProtocolParseError.fromSchemaError(
              "decode-notification-payload",
              CLIENT_METHODS.session_update,
              cause,
            ),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      if (
        message.tag === CLIENT_METHODS.elicitation_complete ||
        message.tag === "session/elicitation/complete"
      ) {
        const method = message.tag;
        return decodeElicitationComplete(message.payload).pipe(
          Effect.map(
            (params) =>
              ({
                _tag: "ElicitationComplete",
                method,
                params,
              }) satisfies AcpIncomingNotification,
          ),
          Effect.mapError((cause) =>
            AcpError.AcpProtocolParseError.fromSchemaError(
              "decode-notification-payload",
              method,
              cause,
            ),
          ),
          Effect.flatMap(dispatchNotification),
        );
      }
      return dispatchNotification({
        _tag: "ExtNotification",
        method: message.tag,
        params: message.payload,
      });
    }

    const key = acpRequestIdentity(message.id);
    const bytes = BoundedQueue.encodedBytes(message);
    if (nativeRequestBytes.has(key))
      return Effect.fail(
        new AcpError.AcpProtocolParseError({
          operation: "decode-wire-message",
          cause: "Native request identity reused while pending",
        }),
      );
    if (
      nativeRequestBytes.size >= BoundedQueue.DEFAULT_MAX_ITEMS ||
      activeNativeBytes + bytes > BoundedQueue.DEFAULT_MAX_BYTES
    ) {
      return Effect.fail(
        overflowError(
          new BoundedQueue.BufferOverflow({
            label: "ACP active native requests",
            maxItems: BoundedQueue.DEFAULT_MAX_ITEMS,
            maxBytes: BoundedQueue.DEFAULT_MAX_BYTES,
          }),
        ),
      );
    }
    activeNativeBytes -= nativeRequestBytes.get(key) ?? 0;
    nativeRequestBytes.set(key, bytes);
    activeNativeBytes += bytes;
    const observeIncoming =
      options.onIncomingRequest?.(acpRequestIdentity(message.id), message.tag, message.payload) ??
      Effect.void;

    if (!options.serverRequestMethods.has(message.tag)) {
      return observeIncoming.pipe(
        Effect.andThen(handleExtRequest(message)),
        Effect.catchTags({
          AcpProtocolParseError: (error) =>
            Effect.logWarning(error).pipe(
              Effect.annotateLogs({
                method: message.tag,
                requestId: message.id,
                operation: error.operation,
              }),
              Effect.andThen(
                respondWithError(
                  message.id,
                  AcpError.AcpRequestError.fromExtensionResponseEncodingError(
                    message.tag,
                    message.id,
                    error,
                  ),
                ),
              ),
            ),
        }),
        Effect.asVoid,
      );
    }

    return observeIncoming.pipe(
      Effect.andThen(
        BoundedQueue.offer(serverQueue, message).pipe(
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.void
              : BoundedQueue.failure(serverQueue).pipe(
                  Effect.flatMap((failure) =>
                    Option.isSome(failure) ? Effect.fail(failure.value) : ensureActive,
                  ),
                ),
          ),
        ),
      ),
      Effect.asVoid,
    );
  };

  const forwardToRpcClient = (
    message: RpcMessage.ResponseChunkEncoded | RpcMessage.ResponseExitEncoded,
  ) =>
    isEffectRpcRequestId(message.requestId)
      ? BoundedQueue.offer(clientQueue, message)
          .pipe(
            Effect.flatMap((accepted) =>
              accepted
                ? Effect.void
                : BoundedQueue.failure(clientQueue).pipe(
                    Effect.flatMap((failure) =>
                      Option.isSome(failure) ? Effect.fail(failure.value) : ensureActive,
                    ),
                  ),
            ),
          )
          .pipe(Effect.asVoid)
      : Effect.void;

  const handleExitEncoded = (message: RpcMessage.ResponseExitEncoded) =>
    Ref.get(extPending).pipe(
      Effect.flatMap((pending) => {
        const pendingRequest = pending.get(acpRequestIdentity(message.requestId));
        if (!pendingRequest) {
          return forwardToRpcClient(message);
        }
        if (message.exit._tag === "Success") {
          return completeExtPendingSuccess(message.requestId, message.exit.value);
        }
        const failure = message.exit.cause.find((entry) => entry._tag === "Fail");
        if (failure && isProtocolError(failure.error)) {
          return completeExtPendingFailure(
            message.requestId,
            AcpError.AcpRequestError.fromProtocolError(failure.error, {
              method: pendingRequest.method,
              requestId: message.requestId,
              cause: message.exit.cause,
            }),
          );
        }
        return completeExtPendingFailure(
          message.requestId,
          AcpError.AcpRequestError.fromExtensionResponseFailure(
            pendingRequest.method,
            message.requestId,
            message.exit.cause,
          ),
        );
      }),
    );

  const routeDecodedMessage = (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ): Effect.Effect<void, AcpError.AcpError> => {
    switch (message._tag) {
      case "Request":
        return handleRequestEncoded(message);
      case "Exit":
        return handleExitEncoded(message);
      case "Chunk":
        return Ref.get(extPending).pipe(
          Effect.flatMap((pending) => {
            const pendingRequest = pending.get(acpRequestIdentity(message.requestId));
            return pendingRequest
              ? completeExtPendingFailure(
                  message.requestId,
                  AcpError.AcpRequestError.unsupportedStreamingResponse(
                    pendingRequest.method,
                    message.requestId,
                  ),
                )
              : forwardToRpcClient(message);
          }),
        );
      case "Defect":
      case "ClientProtocolError":
      case "Pong":
        return BoundedQueue.offer(clientQueue, message)
          .pipe(
            Effect.flatMap((accepted) =>
              accepted
                ? Effect.void
                : BoundedQueue.failure(clientQueue).pipe(
                    Effect.flatMap((failure) =>
                      Option.isSome(failure) ? Effect.fail(failure.value) : ensureActive,
                    ),
                  ),
            ),
          )
          .pipe(Effect.asVoid);
      case "Ack":
      case "Interrupt":
      case "Ping":
      case "Eof":
        return BoundedQueue.offer(serverQueue, message)
          .pipe(
            Effect.flatMap((accepted) =>
              accepted
                ? Effect.void
                : BoundedQueue.failure(serverQueue).pipe(
                    Effect.flatMap((failure) =>
                      Option.isSome(failure) ? Effect.fail(failure.value) : ensureActive,
                    ),
                  ),
            ),
          )
          .pipe(Effect.asVoid);
    }
  };

  yield* options.stdio.stdin.pipe(
    Stream.runForEach((data) =>
      (options.logIncoming
        ? logProtocol({
            direction: "incoming",
            stage: "raw",
            payload: typeof data === "string" ? data : new TextDecoder().decode(data),
          })
        : Effect.void
      ).pipe(
        Effect.flatMap(() =>
          Effect.try({
            try: () =>
              (
                parser.decode(data) as ReadonlyArray<
                  RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded
                >
              ).map(normalizeAcpJsonRpcError),
            catch: (cause) =>
              new AcpError.AcpProtocolParseError({
                operation: "decode-wire-message",
                cause,
              }),
          }),
        ),
        Effect.tap((messages) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: messages,
          }),
        ),
        Effect.tapErrorTag("AcpProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              operation: error.operation,
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
        Effect.flatMap((messages) =>
          Effect.forEach(messages, routeDecodedMessage, {
            discard: true,
          }),
        ),
      ),
    ),
    // Anything that ends the reader, including a defect in a callback it runs,
    // terminates the connection so pending requests fail instead of hanging.
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        // The reader's own interruption never gets here: an interrupted fiber
        // skips failure handlers. An interrupt raised inside it ends it too.
        const failure = Cause.findErrorOption(cause);
        const error = Option.isSome(failure) ? failure.value : Cause.squash(cause);
        const normalized: AcpError.AcpError = isAcpError(error)
          ? error
          : new AcpError.AcpTransportError({
              operation: "read-input-stream",
              cause: error,
            });
        return handleTermination(() => Effect.succeed(normalized));
      },
      onSuccess: () =>
        handleTermination(
          () =>
            options.terminationError ?? Effect.succeed(new AcpError.AcpInputStreamEndedError({})),
        ),
    }),
    Effect.forkScoped,
  );

  const failOutgoingWrites = (error: AcpError.AcpError) =>
    Ref.modify(outgoingWriterState, (state) => {
      const terminalError = state.terminalError ?? error;
      return [
        [terminalError, state.outstandingAcknowledgements] as const,
        {
          ...state,
          terminalError,
          outstandingAcknowledgements: new Set<Deferred.Deferred<void, AcpError.AcpError>>(),
        },
      ] as const;
    }).pipe(
      Effect.flatMap((acknowledgements) =>
        Effect.forEach(
          acknowledgements[1],
          (acknowledgement) => Deferred.fail(acknowledgement, acknowledgements[0]),
          { concurrency: "unbounded", discard: true },
        ),
      ),
      Effect.andThen(BoundedQueue.fail(outgoing, error)),
      Effect.asVoid,
    );
  const completeOutgoingWrites = () =>
    Ref.modify(outgoingWriterState, (state) => {
      return [
        state.outstandingAcknowledgements,
        {
          ...state,
          outstandingAcknowledgements: new Set<Deferred.Deferred<void, AcpError.AcpError>>(),
        },
      ] as const;
    }).pipe(
      Effect.flatMap((acknowledgements) =>
        Effect.forEach(
          acknowledgements,
          (acknowledgement) => Deferred.succeed(acknowledgement, undefined),
          { concurrency: "unbounded", discard: true },
        ),
      ),
      Effect.asVoid,
    );
  const acknowledgeOutgoingWrite = (acknowledgement: Deferred.Deferred<void, AcpError.AcpError>) =>
    Ref.update(outgoingWriterState, (state) => {
      const updated = new Set(state.outstandingAcknowledgements);
      updated.delete(acknowledgement);
      return { ...state, outstandingAcknowledgements: updated };
    }).pipe(Effect.andThen(Deferred.succeed(acknowledgement, undefined)), Effect.asVoid);
  yield* BoundedQueue.stream(outgoing).pipe(
    Stream.flatMap((write) => {
      const acknowledgement = write.acknowledgement;
      const completion =
        acknowledgement === undefined
          ? Stream.empty
          : Stream.fromEffect(acknowledgeOutgoingWrite(acknowledgement)).pipe(Stream.drain);
      return Stream.make(write.payload).pipe(Stream.concat(completion));
    }),
    Stream.run(options.stdio.stdout()),
    Effect.onExit((exit) =>
      Exit.match(exit, {
        onFailure: (cause) => {
          const error = new AcpError.AcpTransportError({
            detail: Cause.hasInterruptsOnly(cause)
              ? "The ACP output writer was interrupted while closing"
              : "Failed to write an outgoing ACP message",
            cause,
          });
          return failOutgoingWrites(error).pipe(
            Effect.andThen(
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : handleTermination(() => Effect.succeed(error)),
            ),
          );
        },
        onSuccess: () =>
          Ref.get(outgoingWriterState).pipe(
            Effect.flatMap((state) => {
              // Intentional Queue.end (serverProtocol.end) completes the writer
              // successfully. Do not invent a transport failure or client protocol
              // error for a clean RPC shutdown.
              const handled = state.intentionalEnd
                ? completeOutgoingWrites()
                : (() => {
                    const error = new AcpError.AcpTransportError({
                      detail: "ACP output writer ended before the protocol closed",
                      cause: "Output writer ended",
                    });
                    return failOutgoingWrites(error).pipe(
                      Effect.andThen(handleTermination(() => Effect.succeed(error))),
                    );
                  })();
              return handled.pipe(
                Effect.andThen(
                  options.testHooks?.onOutgoingWriterExit === undefined
                    ? Effect.void
                    : options.testHooks.onOutgoingWriterExit({
                        intentionalEnd: state.intentionalEnd,
                      }),
                ),
              );
            }),
          ),
      }),
    ),
    Effect.forkScoped,
  );

  const clientProtocol = RpcClient.Protocol.of({
    run: (_clientId, f) =>
      BoundedQueue.stream(clientQueue).pipe(
        Stream.runForEach(f),
        Effect.matchEffect({
          onFailure: (error) => f(clientProtocolError(error)),
          onSuccess: () =>
            Deferred.await(terminationFailure).pipe(
              Effect.catch((error) => f(clientProtocolError(error))),
            ),
        }),
        Effect.andThen(Effect.never),
      ),
    send: (_clientId, request) =>
      offerOutgoing(request).pipe(
        Effect.mapError(
          (error) =>
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "Failed to send ACP protocol message.",
                cause: error,
              }),
            }),
        ),
      ),
    supportsAck: true,
    supportsTransferables: false,
    codecFor: parserFactory.codecFor,
  });

  const serverProtocol = RpcServer.Protocol.of({
    run: (f) =>
      BoundedQueue.stream(serverQueue).pipe(
        Stream.runForEach((message) => f(0, message)),
        Effect.catch((error) => handleTermination(() => Effect.succeed(error))),
        Effect.andThen(Effect.never),
      ),
    disconnects,
    send: (_clientId, response) =>
      offerOutgoing(response).pipe(
        Effect.tapError((error) =>
          response._tag === "Exit" && options.onOutgoingResponseFailure !== undefined
            ? options.onOutgoingResponseFailure(acpRequestIdentity(response.requestId), error)
            : Effect.void,
        ),
        Effect.orDie,
      ),
    end: (_clientId) =>
      Ref.update(outgoingWriterState, (state) => ({ ...state, intentionalEnd: true })).pipe(
        Effect.andThen(BoundedQueue.end(outgoing)),
      ),
    clientIds: Effect.succeed(new Set([0])),
    initialMessage: Effect.succeedNone,
    supportsAck: true,
    supportsTransferables: false,
    codecFor: parserFactory.codecFor,
    supportsSpanPropagation: true,
    supportsNotifications: true,
  });

  // JSON-RPC notifications carry no `id`. Encoding a Request without `isNotification`
  // emits an `id`, which real agents (Grok CLI) parse as a malformed request and silently drop.
  // That made `session/cancel` a no-op against Grok while the lenient mock agent accepted it.
  const sendNotification = Effect.fn("sendNotification")(
    function* (method: string, payload: unknown) {
      yield* ensureActive;
      yield* logProtocol({
        direction: "outgoing",
        stage: "decoded",
        payload: { _tag: "Notification", tag: method, payload },
      });
      const exit = encodeJsonRpcNotification({ jsonrpc: "2.0", method, params: payload });
      if (Exit.isFailure(exit)) {
        return yield* AcpError.AcpProtocolParseError.fromEncodingError(
          method,
          undefined,
          Cause.squash(exit.cause),
        );
      }
      const encoded = `${exit.value}\n`;
      yield* logProtocol({ direction: "outgoing", stage: "raw", payload: encoded });
      yield* ensureActive;
      // FIFO queue admission preserves wire ordering against later requests
      // (a session/prompt sent after session/cancel cannot overtake it).
      yield* BoundedQueue.offer(outgoing, { payload: encoded }).pipe(
        Effect.mapError(
          (cause) =>
            new AcpError.AcpTransportError({
              detail: "Failed to queue an outgoing ACP notification",
              cause,
            }),
        ),
        Effect.filterOrFail(
          (accepted) => accepted,
          () =>
            new AcpError.AcpTransportError({
              detail: "The ACP output queue was closed before accepting a notification",
              cause: "Output queue closed",
            }),
        ),
      );
    },
    Effect.tapError((error) =>
      error._tag === "AcpTransportError"
        ? handleTermination(() => Effect.succeed(error))
        : Effect.void,
    ),
  );

  const sendRequest = Effect.fn("sendRequest")(function* (method: string, payload: unknown) {
    yield* ensureActive;
    const requestId = yield* Ref.modify(
      nextRequestId,
      (current) => [current, current + 1] as const,
    );
    if ((yield* Ref.get(extPending)).size >= BoundedQueue.DEFAULT_MAX_ITEMS) {
      const error = overflowError(
        new BoundedQueue.BufferOverflow({
          label: "ACP pending requests",
          maxItems: BoundedQueue.DEFAULT_MAX_ITEMS,
          maxBytes: BoundedQueue.DEFAULT_MAX_BYTES,
        }),
      );
      yield* handleTermination(() => Effect.succeed(error));
      return yield* error;
    }
    const deferred = yield* Deferred.make<unknown, AcpError.AcpError>();
    yield* Ref.update(extPending, (pending) =>
      new Map(pending).set(acpRequestIdentity(requestId), { deferred, method }),
    );
    yield* offerOutgoing({
      _tag: "Request",
      id: requestId,
      tag: method,
      payload,
      headers: [],
    }).pipe(Effect.tapError(() => removeExtPending(requestId)));
    return yield* Deferred.await(deferred).pipe(
      Effect.onInterrupt(() => removeExtPending(requestId)),
    );
  });

  return {
    clientProtocol,
    serverProtocol,
    get incoming() {
      return notificationQueue.stream;
    },
    request: sendRequest,
    notify: sendNotification,
  } satisfies AcpPatchedProtocol;
});

const isProtocolError = Schema.is(AcpSchema.Error);

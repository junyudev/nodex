import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as CodexRpc from "./_generated/meta.gen.ts";
import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import { copyCodexTransportMetadata, materializeCodexJson } from "./transport-values.ts";
import {
  decodeNotificationPayload,
  decodeOptionalPayload,
  encodeOptionalPayload,
} from "./_internal/shared.ts";
import { makeChildStdio, makeTerminationError } from "./_internal/stdio.ts";

export interface CodexAppServerClientOptions {
  readonly receiveMetrics?: CodexProtocol.CodexAppServerReceiveMetrics;
  readonly messageFrames?: CodexProtocol.CodexAppServerPatchedProtocolOptions["messageFrames"];
  readonly decodedMessages?: CodexProtocol.CodexAppServerPatchedProtocolOptions["decodedMessages"];
  readonly framing?: "jsonl" | "message";
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: CodexProtocol.CodexAppServerProtocolLogEvent) => Effect.Effect<void>;
  /** Bounded decoded ingress retained for the application consumer. */
  readonly incomingCapacity?: number;
  /** Bounded encoded egress retained for the physical writer. */
  readonly outgoingCapacity?: number;
}

export type CodexAppServerGeneratedNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly protocol: "generated";
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

export interface CodexAppServerExtensionNotification {
  readonly protocol: "extension";
  readonly method: string;
  readonly params: unknown;
}

export type CodexAppServerNotification =
  | CodexAppServerGeneratedNotification
  | CodexAppServerExtensionNotification;

export type CodexAppServerGeneratedRequest = {
  readonly [M in CodexRpc.ServerRequestMethod]: {
    readonly protocol: "generated";
    readonly id: string | number;
    readonly method: M;
    readonly params: CodexRpc.ServerRequestParamsByMethod[M];
  };
}[CodexRpc.ServerRequestMethod];

export interface CodexAppServerExtensionRequest {
  readonly protocol: "extension";
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

export type CodexAppServerRequest = CodexAppServerGeneratedRequest | CodexAppServerExtensionRequest;

function isPrivateMcpUserVerificationRequest(
  request: CodexProtocol.CodexAppServerIncomingRequest,
): boolean {
  return (
    request.method === "mcpServer/elicitation/request" &&
    typeof request.params === "object" &&
    request.params !== null &&
    !Array.isArray(request.params) &&
    (request.params as Record<string, unknown>).mode === "openai/userVerification"
  );
}

function shouldOfferRawServerRequest(
  request: CodexProtocol.CodexAppServerIncomingRequest,
): boolean {
  return request.method === "attestation/generate" || isPrivateMcpUserVerificationRequest(request);
}

interface CodexAppServerClientRaw {
  readonly request: CodexProtocol.CodexAppServerPatchedProtocol["request"];
  readonly notify: CodexProtocol.CodexAppServerPatchedProtocol["notify"];
  readonly respond: CodexProtocol.CodexAppServerPatchedProtocol["respond"];
  readonly respondError: CodexProtocol.CodexAppServerPatchedProtocol["respondError"];
}

export class CodexAppServerClient extends Context.Service<
  CodexAppServerClient,
  {
    readonly raw: CodexAppServerClientRaw;
    /** The sole once-decoded server-notification stream for this physical connection. */
    readonly notifications: Stream.Stream<
      CodexAppServerNotification,
      CodexError.CodexAppServerError
    >;
    /** The sole once-decoded server-request stream for this physical connection. */
    readonly requests: Stream.Stream<CodexAppServerRequest, CodexError.CodexAppServerError>;
    /** Fails when reader, writer, decoder, queue, Scope, or child-backed transport terminates. */
    readonly termination: Effect.Effect<never, CodexError.CodexAppServerError>;
    readonly request: <M extends CodexRpc.ClientRequestMethod>(
      method: M,
      payload: CodexRpc.ClientRequestParamsByMethod[M],
      options?: CodexProtocol.CodexAppServerRequestOptions,
    ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexError.CodexAppServerError>;
    readonly notify: <M extends CodexRpc.ClientNotificationMethod>(
      method: M,
      payload: CodexRpc.ClientNotificationParamsByMethod[M],
    ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  }
>()("effect-codex-app-server/client/CodexAppServerClient") {}

const capacityError = (capacity: number) =>
  new CodexError.CodexAppServerTransportError({
    operation: "incoming-capacity",
    cause: new Error(`Codex App Server decoded ingress capacity ${capacity} is exhausted`),
  });

export const make = Effect.fn("effect-codex-app-server/CodexAppServerClient.make")(function* (
  stdio: Stdio.Stdio,
  options: CodexAppServerClientOptions = {},
  terminationError?: Effect.Effect<CodexError.CodexAppServerError>,
): Effect.fn.Return<CodexAppServerClient["Service"], never, Scope.Scope> {
  const incomingCapacity = Math.max(1, Math.floor(options.incomingCapacity ?? Infinity));
  const notifications = yield* Queue.dropping<
    CodexAppServerNotification,
    CodexError.CodexAppServerError
  >(incomingCapacity);
  const requests = yield* Queue.dropping<CodexAppServerRequest, CodexError.CodexAppServerError>(
    incomingCapacity,
  );

  const getServerRequestParamSchema = <M extends CodexRpc.ServerRequestMethod>(
    method: M,
  ):
    | Schema.Codec<CodexRpc.ServerRequestParamsByMethod[M], CodexRpc.ServerRequestParamsByMethod[M]>
    | undefined => CodexRpc.SERVER_REQUEST_PARAMS[method] as never;

  const getClientRequestParamSchema = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
  ):
    | Schema.Codec<CodexRpc.ClientRequestParamsByMethod[M], CodexRpc.ClientRequestParamsByMethod[M]>
    | undefined => CodexRpc.CLIENT_REQUEST_PARAMS[method] as never;

  const getClientRequestResponseSchema = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ClientRequestResponsesByMethod[M],
        CodexRpc.ClientRequestResponsesByMethod[M]
      >
    | undefined => CodexRpc.CLIENT_REQUEST_RESPONSES[method] as never;

  const getClientNotificationParamSchema = <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ClientNotificationParamsByMethod[M],
        CodexRpc.ClientNotificationParamsByMethod[M]
      >
    | undefined => CodexRpc.CLIENT_NOTIFICATION_PARAMS[method] as never;

  const offerNotification = (
    notification: CodexAppServerNotification,
  ): Effect.Effect<void, CodexError.CodexAppServerError> =>
    Queue.offer(notifications, notification).pipe(
      Effect.flatMap((accepted) =>
        accepted ? Effect.void : Effect.fail(capacityError(incomingCapacity)),
      ),
    );

  const offerRequest = (
    request: CodexAppServerRequest,
  ): Effect.Effect<typeof CodexProtocol.CodexAppServerNoResponse, CodexError.CodexAppServerError> =>
    Queue.offer(requests, request).pipe(
      Effect.flatMap((accepted) =>
        accepted
          ? Effect.succeed(CodexProtocol.CodexAppServerNoResponse)
          : Effect.fail(capacityError(incomingCapacity)),
      ),
    );

  const dispatchNotification = (
    notification: CodexProtocol.CodexAppServerIncomingNotification,
  ): Effect.Effect<void, CodexError.CodexAppServerError> => {
    if (!(notification.method in CodexRpc.SERVER_NOTIFICATION_PARAMS)) {
      return offerNotification({
        protocol: "extension",
        method: notification.method,
        params: notification.params,
      });
    }

    const method = notification.method as CodexRpc.ServerNotificationMethod;
    const schema = CodexRpc.SERVER_NOTIFICATION_PARAMS[method] as Schema.Codec<unknown, unknown>;
    return decodeNotificationPayload(method, schema, notification.params).pipe(
      Effect.tap((params) =>
        Effect.sync(() => copyCodexTransportMetadata(notification.params, params)),
      ),
      Effect.flatMap((params) =>
        offerNotification({ protocol: "generated", method, params } as CodexAppServerNotification),
      ),
    );
  };

  const dispatchRequest = (
    request: CodexProtocol.CodexAppServerIncomingRequest,
  ): Effect.Effect<
    typeof CodexProtocol.CodexAppServerNoResponse,
    CodexError.CodexAppServerError
  > => {
    if (
      !(request.method in CodexRpc.SERVER_REQUEST_PARAMS) ||
      shouldOfferRawServerRequest(request)
    ) {
      return offerRequest({
        protocol: "extension",
        id: request.id,
        method: request.method,
        params: request.params,
      });
    }

    const method = request.method as CodexRpc.ServerRequestMethod;
    return decodeOptionalPayload(method, getServerRequestParamSchema(method), request.params).pipe(
      Effect.tap((params) => Effect.sync(() => copyCodexTransportMetadata(request.params, params))),
      Effect.mapError((error) =>
        CodexError.CodexAppServerProtocolParseError.fromRequestError(
          "decode-request-payload",
          method,
          error,
        ),
      ),
      Effect.flatMap((params) =>
        offerRequest({
          protocol: "generated",
          id: request.id,
          method,
          params,
        } as CodexAppServerRequest),
      ),
    );
  };

  const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
    stdio,
    ...(options.receiveMetrics === undefined ? {} : { receiveMetrics: options.receiveMetrics }),
    ...(options.messageFrames === undefined ? {} : { messageFrames: options.messageFrames }),
    ...(options.decodedMessages === undefined ? {} : { decodedMessages: options.decodedMessages }),
    ...(options.framing === undefined ? {} : { framing: options.framing }),
    ...(terminationError ? { terminationError } : {}),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    incomingCapacity,
    ...(options.outgoingCapacity === undefined
      ? {}
      : { outgoingCapacity: options.outgoingCapacity }),
    onNotification: dispatchNotification,
    onRequest: dispatchRequest,
    onTermination: (error) =>
      Effect.all([Queue.fail(notifications, error), Queue.fail(requests, error)], {
        discard: true,
      }),
  });

  const request = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
    options?: CodexProtocol.CodexAppServerRequestOptions,
  ): Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexError.CodexAppServerError> =>
    encodeOptionalPayload(method, getClientRequestParamSchema(method), payload).pipe(
      Effect.flatMap((encoded) => transport.request(method, encoded, options)),
      Effect.flatMap((raw) => {
        const materialized = materializeCodexJson(raw);
        return decodeOptionalPayload(
          method,
          getClientRequestResponseSchema(method),
          materialized,
        ).pipe(
          Effect.tap((result) =>
            Effect.sync(() => copyCodexTransportMetadata(materialized, result)),
          ),
        );
      }),
    );

  const notify = <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
    payload: CodexRpc.ClientNotificationParamsByMethod[M],
  ) =>
    encodeOptionalPayload(method, getClientNotificationParamSchema(method), payload).pipe(
      Effect.flatMap((encoded) => transport.notify(method, encoded)),
    );

  return CodexAppServerClient.of({
    raw: {
      request: transport.request,
      notify: transport.notify,
      respond: transport.respond,
      respondError: transport.respondError,
    },
    notifications: Stream.fromQueue(notifications),
    requests: Stream.fromQueue(requests),
    termination: transport.termination,
    request,
    notify,
  });
});

export const layer = (
  stdio: Stdio.Stdio,
  options: CodexAppServerClientOptions = {},
): Layer.Layer<CodexAppServerClient> => Layer.effect(CodexAppServerClient, make(stdio, options));

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: CodexAppServerClientOptions = {},
): Layer.Layer<CodexAppServerClient> =>
  Layer.effect(CodexAppServerClient, makeChildProcessClient(handle, options));

const makeChildProcessClient = Effect.fn(
  "effect-codex-app-server/CodexAppServerClient.makeChildProcessClient",
)(function* (handle: ChildProcessSpawner.ChildProcessHandle, options: CodexAppServerClientOptions) {
  yield* Stream.runDrain(handle.stderr).pipe(Effect.ignore, Effect.forkScoped);
  return yield* make(makeChildStdio(handle), options, makeTerminationError(handle));
});

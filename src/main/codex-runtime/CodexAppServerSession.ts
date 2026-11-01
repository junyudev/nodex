import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CodexAppServerClient } from "@nodex/effect-codex-app-server/client";
import type {
  V1InitializeParams,
  V1InitializeResponse,
} from "@nodex/effect-codex-app-server/schema";
import {
  CodexSessionTransport,
  type CodexSessionProcessConfig,
} from "../platform/node/CodexSessionTransport";
import {
  classifyCodexClientError,
  codexRuntimeError,
  type CodexRuntimeError,
} from "./CodexRuntimeError";

export interface CodexAppServerSessionService {
  readonly hostId: string;
  readonly generation: number;
  readonly pid: number;
  readonly transportKind: "stdio" | "websocket";
  /** True only when this physical app-server Session was launched with Nodex App Tools. */
  readonly nativeAppTools: boolean;
  readonly client: CodexAppServerClient["Service"];
  readonly initialize: V1InitializeResponse;
  readonly termination: Effect.Effect<never, CodexRuntimeError>;
}

export class CodexAppServerSession extends Context.Service<
  CodexAppServerSession,
  CodexAppServerSessionService
>()("nodex/main/codex-runtime/CodexAppServerSession") {}

export interface CodexAppServerSessionOptions extends CodexSessionProcessConfig {
  readonly initializeParams: V1InitializeParams;
  readonly initializeTimeout: Duration.Input;
  readonly expectedCodexHome?: string;
  readonly nativeAppTools?: boolean;
}

export const live = (
  options: CodexAppServerSessionOptions,
): Layer.Layer<CodexAppServerSession, CodexRuntimeError, CodexSessionTransport> =>
  Layer.effect(
    CodexAppServerSession,
    Effect.gen(function* () {
      const transport = yield* CodexSessionTransport;
      const opened = yield* transport.open(options);
      const initialize = yield* opened.client
        .request("initialize", options.initializeParams, { metricsMode: "internal" })
        .pipe(
          Effect.timeout(options.initializeTimeout),
          Effect.tapError(() => Effect.sync(() => opened.onInitializationFailed?.())),
          Effect.mapError((cause) =>
            Cause.isTimeoutError(cause)
              ? codexRuntimeError({
                  operation: "session.initialize",
                  reason: "timeout",
                  retryable: true,
                  hostId: options.hostId,
                  generation: options.generation,
                  pid: opened.pid,
                  cause,
                })
              : classifyCodexClientError({
                  operation: "session.initialize",
                  cause,
                  hostId: options.hostId,
                  generation: options.generation,
                  pid: opened.pid,
                  method: "initialize",
                }),
          ),
        );

      if (options.expectedCodexHome !== undefined) {
        const [actual, expected] = yield* Effect.all([
          transport.canonicalPath(initialize.codexHome),
          transport.canonicalPath(options.expectedCodexHome),
        ]);
        if (actual !== expected) {
          return yield* codexRuntimeError({
            operation: "session.verify-home",
            reason: "initialize",
            retryable: false,
            hostId: options.hostId,
            generation: options.generation,
            pid: opened.pid,
          });
        }
      }

      yield* opened.client.notify("initialized", undefined).pipe(
        Effect.mapError((cause) =>
          classifyCodexClientError({
            operation: "session.initialized",
            cause,
            hostId: options.hostId,
            generation: options.generation,
            pid: opened.pid,
            method: "initialized",
          }),
        ),
      );
      return CodexAppServerSession.of({
        hostId: options.hostId,
        generation: options.generation,
        pid: opened.pid,
        client: opened.client,
        transportKind: opened.transportKind,
        nativeAppTools: options.nativeAppTools === true,
        initialize,
        termination: opened.termination,
      });
    }),
  );

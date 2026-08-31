import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type InitializeRequest,
  type InitializeResponse,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  acpRuntimeError,
  classifyAcpRuntimeError,
  type AcpRuntimeError,
} from "../../agent-backend/acp/AcpRuntimeError";
import type { AcpClientCapabilityHandlers } from "../../agent-backend/acp/AcpClientCapabilityOwner";

export const ACP_DEFAULT_INGRESS_CAPACITY = 128;
export const ACP_DEFAULT_MAXIMUM_LINE_BYTES = 256 * 1024;
export const ACP_DEFAULT_STDERR_TAIL_CHARACTERS = 16 * 1024;
export const ACP_DEFAULT_CALLBACK_CAPACITY = 16;

export interface AcpSessionProcessConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly forceTermination: Duration.Input;
  readonly ingressCapacity?: number;
  readonly maximumLineBytes?: number;
  readonly maximumStderrTailCharacters?: number;
  readonly callbackCapacity?: number;
  readonly capabilities: AcpClientCapabilityHandlers;
}

export interface AcpSessionTransportHandle {
  readonly pid: number;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly initialize: (
    request: InitializeRequest,
  ) => Effect.Effect<InitializeResponse, AcpRuntimeError>;
  readonly newSession: (
    request: NewSessionRequest,
  ) => Effect.Effect<NewSessionResponse, AcpRuntimeError>;
  readonly loadSession: (
    request: LoadSessionRequest,
  ) => Effect.Effect<LoadSessionResponse, AcpRuntimeError>;
  readonly listSessions: (
    request: ListSessionsRequest,
  ) => Effect.Effect<ListSessionsResponse, AcpRuntimeError>;
  readonly deleteSession: (
    request: DeleteSessionRequest,
  ) => Effect.Effect<DeleteSessionResponse, AcpRuntimeError>;
  readonly forkSession: (
    request: ForkSessionRequest,
  ) => Effect.Effect<ForkSessionResponse, AcpRuntimeError>;
  readonly resumeSession: (
    request: ResumeSessionRequest,
  ) => Effect.Effect<ResumeSessionResponse, AcpRuntimeError>;
  readonly closeSession: (
    request: CloseSessionRequest,
  ) => Effect.Effect<CloseSessionResponse, AcpRuntimeError>;
  readonly setSessionMode: (
    request: SetSessionModeRequest,
  ) => Effect.Effect<SetSessionModeResponse, AcpRuntimeError>;
  readonly setSessionConfigOption: (
    request: SetSessionConfigOptionRequest,
  ) => Effect.Effect<SetSessionConfigOptionResponse, AcpRuntimeError>;
  readonly prompt: (request: PromptRequest) => Effect.Effect<PromptResponse, AcpRuntimeError>;
  readonly authenticate: (
    request: AuthenticateRequest,
  ) => Effect.Effect<AuthenticateResponse, AcpRuntimeError>;
  readonly cancel: (sessionId: string) => Effect.Effect<void, AcpRuntimeError>;
  readonly updates: Stream.Stream<SessionNotification>;
  readonly drainUpdates: Effect.Effect<void, AcpRuntimeError>;
  readonly close: (cause?: unknown) => Effect.Effect<void>;
  readonly stderrTail: Effect.Effect<string>;
  readonly termination: Effect.Effect<never, AcpRuntimeError>;
}

export class AcpSessionTransport extends Context.Service<
  AcpSessionTransport,
  {
    readonly open: (
      config: AcpSessionProcessConfig,
    ) => Effect.Effect<AcpSessionTransportHandle, AcpRuntimeError, Scope.Scope>;
  }
>()("nodex/main/platform/node/AcpSessionTransport") {}

interface SpawnedChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Deferred.Deferred<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error?: Error;
  }>;
}

type Ingress =
  | { readonly kind: "update"; readonly notification: SessionNotification }
  | { readonly kind: "barrier"; readonly acknowledged: Deferred.Deferred<void> };

const positiveInteger = (value: number | undefined, fallback: number, name: string): number => {
  const resolved = value ?? fallback;
  if (Number.isSafeInteger(resolved) && resolved > 0) return resolved;
  throw new RangeError(`${name} must be a positive safe integer`);
};

const spawnChild = (
  config: AcpSessionProcessConfig,
  runCallback: (effect: Effect.Effect<boolean>) => Promise<unknown>,
): Effect.Effect<SpawnedChild, AcpRuntimeError, Scope.Scope> =>
  Effect.gen(function* () {
    const exit = yield* Deferred.make<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly error?: Error;
    }>();
    const child = yield* Effect.callback<ChildProcessWithoutNullStreams, AcpRuntimeError>(
      (resume) => {
        let child: ChildProcessWithoutNullStreams | undefined;
        let acquired = false;
        try {
          child = spawn(config.command, [...config.args], {
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            env: { ...config.env },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (cause) {
          resume(
            Effect.fail(
              acpRuntimeError({
                operation: "session.spawn",
                reason: "spawn",
                retryable: true,
                cause,
              }),
            ),
          );
          return;
        }

        const ownedChild = child;
        const onError = (cause: Error) => {
          if (acquired) return;
          resume(
            Effect.fail(
              acpRuntimeError({
                operation: "session.spawn",
                reason: "spawn",
                retryable: true,
                cause,
              }),
            ),
          );
        };
        const onSpawn = () => {
          acquired = true;
          ownedChild.off("error", onError);
          resume(Effect.succeed(ownedChild));
        };
        ownedChild.once("error", onError);
        ownedChild.once("spawn", onSpawn);

        return Effect.sync(() => {
          ownedChild.off("spawn", onSpawn);
          ownedChild.off("error", onError);
          if (!acquired && ownedChild.exitCode === null && ownedChild.signalCode === null) {
            ownedChild.kill("SIGKILL");
          }
        });
      },
    );
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      void runCallback(Deferred.succeed(exit, { code, signal }));
    };
    const onError = (cause: Error) => {
      void runCallback(Deferred.succeed(exit, { code: null, signal: null, error: cause }));
    };
    child.once("exit", onExit);
    child.once("error", onError);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        child.off("exit", onExit);
        child.off("error", onError);
      }),
    );
    return { child, exit };
  });

const terminateChild = (
  spawned: SpawnedChild,
  connection: ClientConnection | undefined,
  forceTermination: Duration.Input,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    connection?.close(new Error("ACP transport scope released"));
    if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) return;
    spawned.child.kill("SIGTERM");
    const exited = yield* Deferred.await(spawned.exit).pipe(
      Effect.as(true),
      Effect.raceFirst(Effect.sleep(forceTermination).pipe(Effect.as(false))),
    );
    if (exited) return;
    spawned.child.kill("SIGKILL");
    yield* Deferred.await(spawned.exit).pipe(
      Effect.raceFirst(Effect.sleep(forceTermination)),
      Effect.ignore,
    );
  });

/** Rejects an unbounded NDJSON record before the SDK's line buffer retains it. */
export const limitAcpNdjsonLines = (
  input: ReadableStream<Uint8Array>,
  maximumLineBytes: number,
): ReadableStream<Uint8Array> => {
  const reader = input.getReader();
  let currentLineBytes = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return reader.read().then((next) => {
        if (next.done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        const chunk = next.value;
        for (const byte of chunk) {
          if (byte === 0x0a) {
            currentLineBytes = 0;
            continue;
          }
          currentLineBytes += 1;
          if (currentLineBytes <= maximumLineBytes) continue;
          const error = new RangeError(`ACP NDJSON line exceeded ${maximumLineBytes} bytes`);
          void reader.cancel(error);
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
      });
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
};

const makeRequest = <A>(input: {
  readonly pid: number;
  readonly method: string;
  readonly evaluate: () => Promise<A>;
}): Effect.Effect<A, AcpRuntimeError> =>
  Effect.tryPromise({
    try: input.evaluate,
    catch: (cause) =>
      classifyAcpRuntimeError({
        operation: "session.request",
        cause,
        pid: input.pid,
        method: input.method,
      }),
  });

export const live: Layer.Layer<AcpSessionTransport> = Layer.succeed(
  AcpSessionTransport,
  AcpSessionTransport.of({
    open: Effect.fn("AcpSessionTransport.open")(function* (config) {
      const ingressCapacity = yield* Effect.try({
        try: () =>
          positiveInteger(
            config.ingressCapacity,
            ACP_DEFAULT_INGRESS_CAPACITY,
            "ACP ingress capacity",
          ),
        catch: (cause) =>
          acpRuntimeError({
            operation: "session.configure",
            reason: "protocol",
            retryable: false,
            cause,
          }),
      });
      const maximumLineBytes = yield* Effect.try({
        try: () =>
          positiveInteger(
            config.maximumLineBytes,
            ACP_DEFAULT_MAXIMUM_LINE_BYTES,
            "ACP maximum line bytes",
          ),
        catch: (cause) =>
          acpRuntimeError({
            operation: "session.configure",
            reason: "protocol",
            retryable: false,
            cause,
          }),
      });
      const maximumStderrTailCharacters = yield* Effect.try({
        try: () =>
          positiveInteger(
            config.maximumStderrTailCharacters,
            ACP_DEFAULT_STDERR_TAIL_CHARACTERS,
            "ACP stderr tail characters",
          ),
        catch: (cause) =>
          acpRuntimeError({
            operation: "session.configure",
            reason: "protocol",
            retryable: false,
            cause,
          }),
      });
      const callbackCapacity = yield* Effect.try({
        try: () =>
          positiveInteger(
            config.callbackCapacity,
            ACP_DEFAULT_CALLBACK_CAPACITY,
            "ACP callback capacity",
          ),
        catch: (cause) =>
          acpRuntimeError({
            operation: "session.configure",
            reason: "protocol",
            retryable: false,
            cause,
          }),
      });
      const callbackFibers = yield* FiberSet.make();
      const runCallback = yield* FiberSet.runtimePromise(callbackFibers)();
      const ingress = yield* Queue.dropping<Ingress>(ingressCapacity);
      let connection: ClientConnection | undefined;
      const spawned = yield* Effect.acquireRelease(spawnChild(config, runCallback), (owned) =>
        terminateChild(owned, connection, config.forceTermination),
      );
      const pid = Number(spawned.child.pid);
      const callbackPermits = yield* Semaphore.make(callbackCapacity);
      const runBoundedCallback = <A>(effect: Effect.Effect<A, AcpRuntimeError>) =>
        runCallback(
          callbackPermits
            .withPermitsIfAvailable(1)(effect)
            .pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      acpRuntimeError({
                        operation: "session.callback",
                        reason: "pressure",
                        retryable: false,
                        pid,
                      }),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
            ),
        );
      let stderrTail = "";
      spawned.child.stderr.setEncoding("utf8");
      spawned.child.stderr.on("data", (chunk: string) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-maximumStderrTailCharacters);
      });

      const application = client({ name: "nodex" })
        .onRequest(methods.client.session.requestPermission, (context) =>
          runBoundedCallback(config.capabilities.requestPermission(context.params)).then(
            (response) => {
              if (response.outcome.outcome !== "cancelled") return response;
              return context.agent
                .notify(methods.agent.session.cancel, { sessionId: context.params.sessionId })
                .then(() => response);
            },
          ),
        )
        .onNotification(methods.client.session.update, (context) =>
          runCallback(
            Queue.offer(ingress, { kind: "update", notification: context.params }).pipe(
              Effect.flatMap((accepted) => {
                if (accepted) return Effect.void;
                const error = acpRuntimeError({
                  operation: "session.ingress",
                  reason: "pressure",
                  retryable: false,
                  pid,
                  sessionId: context.params.sessionId,
                });
                connection?.close(error);
                return Effect.fail(error);
              }),
            ),
          ),
        );
      if (config.capabilities.readTextFile !== undefined) {
        application.onRequest(methods.client.fs.readTextFile, (context) =>
          runBoundedCallback(config.capabilities.readTextFile!(context.params)),
        );
      }
      if (config.capabilities.writeTextFile !== undefined) {
        application.onRequest(methods.client.fs.writeTextFile, (context) =>
          runBoundedCallback(config.capabilities.writeTextFile!(context.params)),
        );
      }
      if (config.capabilities.createTerminal !== undefined) {
        application
          .onRequest(methods.client.terminal.create, (context) =>
            runBoundedCallback(config.capabilities.createTerminal!(context.params)),
          )
          .onRequest(methods.client.terminal.output, (context) =>
            runBoundedCallback(config.capabilities.terminalOutput!(context.params)),
          )
          .onRequest(methods.client.terminal.waitForExit, (context) =>
            runBoundedCallback(config.capabilities.waitForTerminalExit!(context.params)),
          )
          .onRequest(methods.client.terminal.kill, (context) =>
            runBoundedCallback(config.capabilities.killTerminal!(context.params)),
          )
          .onRequest(methods.client.terminal.release, (context) =>
            runBoundedCallback(config.capabilities.releaseTerminal!(context.params)),
          );
      }
      if (config.capabilities.createElicitation !== undefined) {
        application.onRequest(methods.client.elicitation.create, (context) =>
          runBoundedCallback(config.capabilities.createElicitation!(context.params)),
        );
      }
      if (config.capabilities.completeElicitation !== undefined) {
        application.onNotification(methods.client.elicitation.complete, (context) =>
          runBoundedCallback(config.capabilities.completeElicitation!(context.params)),
        );
      }

      const writable = Writable.toWeb(spawned.child.stdin) as WritableStream<Uint8Array>;
      const readable = limitAcpNdjsonLines(
        Readable.toWeb(spawned.child.stdout) as ReadableStream<Uint8Array>,
        maximumLineBytes,
      );
      connection = application.connect(ndJsonStream(writable, readable));
      const ownedConnection = connection;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => ownedConnection.close(new Error("ACP transport scope released"))),
      );
      const connectionClosed = Effect.tryPromise({
        try: () => ownedConnection.closed,
        catch: (cause) =>
          classifyAcpRuntimeError({
            operation: "session.protocol",
            reason: "session-lost",
            retryable: true,
            pid,
            cause,
          }),
      });
      yield* connectionClosed.pipe(
        Effect.ensuring(Queue.shutdown(ingress)),
        Effect.ignore,
        Effect.forkScoped,
      );

      const childTermination = Deferred.await(spawned.exit).pipe(
        Effect.flatMap(({ code, signal, error }) =>
          Effect.fail(
            acpRuntimeError({
              operation: "session.exit",
              reason: "session-lost",
              retryable: true,
              pid,
              cause:
                error ??
                new Error(
                  `ACP agent exited (${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`})${stderrTail ? `: ${stderrTail}` : ""}`,
                ),
            }),
          ),
        ),
      );
      const protocolTermination = connectionClosed.pipe(
        Effect.flatMap(() =>
          Effect.fail(
            classifyAcpRuntimeError({
              operation: "session.protocol",
              reason: "session-lost",
              retryable: true,
              pid,
              cause: ownedConnection.signal.reason ?? new Error("ACP connection closed"),
            }),
          ),
        ),
      );

      const updates: Stream.Stream<SessionNotification> = Stream.fromQueue(ingress).pipe(
        Stream.mapEffect((entry) => {
          if (entry.kind === "update") return Effect.succeed(entry.notification);
          return Deferred.succeed(entry.acknowledged, undefined).pipe(Effect.as(null));
        }),
        Stream.filter((entry): entry is SessionNotification => entry !== null),
      );
      const drainUpdates = Effect.gen(function* () {
        const acknowledged = yield* Deferred.make<void>();
        const accepted = yield* Queue.offer(ingress, { kind: "barrier", acknowledged });
        if (!accepted) {
          const error = acpRuntimeError({
            operation: "session.drain-updates",
            reason: "pressure",
            retryable: false,
            pid,
          });
          ownedConnection.close(error);
          return yield* error;
        }
        yield* Deferred.await(acknowledged);
      });

      return {
        pid,
        protocolVersion: PROTOCOL_VERSION,
        initialize: (request) =>
          makeRequest({
            pid,
            method: methods.agent.initialize,
            evaluate: () => ownedConnection.agent.request(methods.agent.initialize, request),
          }),
        newSession: (request) =>
          makeRequest({
            pid,
            method: methods.agent.session.new,
            evaluate: () => ownedConnection.agent.request(methods.agent.session.new, request),
          }),
        loadSession: (request) =>
          makeRequest({
            pid,
            method: methods.agent.session.load,
            evaluate: () => ownedConnection.agent.request(methods.agent.session.load, request),
          }),
        listSessions: (request) =>
          makeRequest({
            pid,
            method: methods.agent.session.list,
            evaluate: () => ownedConnection.agent.request(methods.agent.session.list, request),
          }),
        deleteSession: (request) =>
          makeRequest({
            pid,
            method: methods.agent.session.delete,
            evaluate: () => ownedConnection.agent.request(methods.agent.session.delete, request),
          }),
        forkSession: (request) =>
          makeRequest({
            pid,
            method: methods.agent.session.fork,
            evaluate: () => ownedConnection.agent.request(methods.agent.session.fork, request),
          }),
        resumeSession: (request) =>
          makeRequest({
            pid,
            method: methods.agent.session.resume,
            evaluate: () => ownedConnection.agent.request(methods.agent.session.resume, request),
          }),
        closeSession: (request) =>
          makeRequest({
            pid,
            method: methods.agent.session.close,
            evaluate: () => ownedConnection.agent.request(methods.agent.session.close, request),
          }),
        setSessionMode: (request) =>
          makeRequest({
            pid,
            method: methods.agent.session.setMode,
            evaluate: () => ownedConnection.agent.request(methods.agent.session.setMode, request),
          }),
        setSessionConfigOption: (request) =>
          makeRequest({
            pid,
            method: methods.agent.session.setConfigOption,
            evaluate: () =>
              ownedConnection.agent.request(methods.agent.session.setConfigOption, request),
          }),
        prompt: (request) =>
          makeRequest({
            pid,
            method: methods.agent.session.prompt,
            evaluate: () => ownedConnection.agent.request(methods.agent.session.prompt, request),
          }),
        authenticate: (request) =>
          makeRequest({
            pid,
            method: methods.agent.authenticate,
            evaluate: () => ownedConnection.agent.request(methods.agent.authenticate, request),
          }),
        cancel: (sessionId) =>
          makeRequest({
            pid,
            method: methods.agent.session.cancel,
            evaluate: () =>
              ownedConnection.agent.notify(methods.agent.session.cancel, { sessionId }),
          }),
        updates,
        drainUpdates,
        close: (cause) =>
          Effect.sync(() => {
            ownedConnection.close(cause);
          }).pipe(Effect.andThen(terminateChild(spawned, undefined, config.forceTermination))),
        stderrTail: Effect.sync(() => stderrTail),
        termination: Effect.raceFirst(childTermination, protocolTermination),
      } satisfies AcpSessionTransportHandle;
    }),
  }),
);

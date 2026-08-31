import {
  PROTOCOL_VERSION,
  type AuthMethod,
  type AuthenticateResponse,
  type ForkSessionResponse,
  type Implementation,
  type InitializeResponse,
  type ListSessionsResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  AcpSessionTransport,
  type AcpSessionProcessConfig,
} from "../../platform/node/AcpSessionTransport";
import { acpRuntimeError, type AcpRuntimeError } from "./AcpRuntimeError";
import { AcpClientCapabilityOwner } from "./AcpClientCapabilityOwner";
import type { AcpBackendCapabilityProfile } from "../../../shared/acp-conversation";

export type { AcpBackendCapabilityProfile } from "../../../shared/acp-conversation";

export const ACP_DEFAULT_EVENT_CAPACITY = 128;
export const ACP_DEFAULT_INITIALIZE_TIMEOUT = "20 seconds";
export const ACP_DEFAULT_REQUEST_TIMEOUT = "30 seconds";
export const ACP_DEFAULT_CANCEL_TIMEOUT = "5 seconds";

export interface AcpSessionRuntimeOptions {
  readonly spawn: Omit<AcpSessionProcessConfig, "capabilities">;
  readonly cwd: string;
  readonly clientInfo: Implementation;
  readonly eventCapacity?: number;
  readonly initializeTimeout?: Duration.Input;
  readonly promptTimeout?: Duration.Input;
  readonly cancelTimeout?: Duration.Input;
  readonly open?: AcpSessionOpenRequest;
}

export type AcpSessionOpenRequest =
  | { readonly kind: "new" }
  | { readonly kind: "load"; readonly sessionId: string }
  | { readonly kind: "resume"; readonly sessionId: string }
  | { readonly kind: "fork"; readonly sessionId: string };

export type AcpSessionOpenResponse =
  | NewSessionResponse
  | LoadSessionResponse
  | ResumeSessionResponse
  | ForkSessionResponse;

export type AcpSessionRuntimeEvent =
  | {
      readonly kind: "session_update";
      readonly sessionId: string;
      readonly turnSequence: number | null;
      readonly update: SessionNotification["update"];
    }
  | {
      readonly kind: "turn_stopped";
      readonly sessionId: string;
      readonly turnSequence: number;
      readonly response: PromptResponse;
    };

export class AcpSessionRuntime extends Context.Service<
  AcpSessionRuntime,
  {
    readonly pid: number;
    /** Null while an initialized Agent is waiting for an advertised authentication method. */
    readonly sessionId: string | null;
    readonly initializeResponse: InitializeResponse;
    readonly openResponse: AcpSessionOpenResponse | null;
    readonly capabilities: AcpBackendCapabilityProfile;
    readonly modes: SessionModeState | null;
    readonly configOptions: readonly SessionConfigOption[];
    readonly events: Stream.Stream<AcpSessionRuntimeEvent>;
    /** Waits until every runtime event already accepted by this Session has reached its consumer. */
    readonly drainEvents: Effect.Effect<void, AcpRuntimeError>;
    readonly prompt: (
      prompt: PromptRequest["prompt"],
    ) => Effect.Effect<PromptResponse, AcpRuntimeError>;
    readonly authenticate: (
      methodId: string,
    ) => Effect.Effect<AuthenticateResponse, AcpRuntimeError>;
    readonly cancel: Effect.Effect<void, AcpRuntimeError>;
    readonly listSessions: Effect.Effect<ListSessionsResponse, AcpRuntimeError>;
    readonly deleteSession: (sessionId: string) => Effect.Effect<void, AcpRuntimeError>;
    readonly setMode: (modeId: string) => Effect.Effect<void, AcpRuntimeError>;
    readonly setConfigOption: (
      configId: string,
      value: string | boolean,
    ) => Effect.Effect<readonly SessionConfigOption[], AcpRuntimeError>;
    readonly termination: Effect.Effect<never, AcpRuntimeError>;
  }
>()("nodex/main/agent-backend/acp/AcpSessionRuntime") {}

interface ActivePrompt {
  readonly turnSequence: number;
  readonly cancelRequested: boolean;
}

type AcpSessionRuntimeIngress =
  | { readonly kind: "event"; readonly event: AcpSessionRuntimeEvent }
  | { readonly kind: "barrier"; readonly acknowledged: Deferred.Deferred<void> };

const initializeInvariant = Schema.Struct({
  protocolVersion: Schema.Literal(PROTOCOL_VERSION),
});
const sessionIdSchema = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const newSessionInvariant = Schema.Struct({ sessionId: sessionIdSchema });
const promptInvariant = Schema.Struct({
  stopReason: Schema.Literals([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
  ]),
});

export const toAcpBackendCapabilityProfile = (
  response: InitializeResponse,
): AcpBackendCapabilityProfile => {
  const capabilities = response.agentCapabilities;
  const sessions = capabilities?.sessionCapabilities;
  const prompt = capabilities?.promptCapabilities;
  return {
    prompt: {
      text: true,
      resourceLink: true,
      image: prompt?.image === true,
      audio: prompt?.audio === true,
      embeddedContext: prompt?.embeddedContext === true,
    },
    session: {
      load: capabilities?.loadSession === true,
      list: sessions?.list != null,
      delete: sessions?.delete != null,
      resume: sessions?.resume != null,
      unstableFork: sessions?.fork != null,
      close: sessions?.close != null,
      additionalDirectories: sessions?.additionalDirectories != null,
    },
    authMethods: (response.authMethods ?? []).map((method) => ({
      id: method.id,
      name: method.name,
      description: method.description ?? null,
      kind: "type" in method && method.type === "terminal" ? "terminal" : "agent",
    })),
  };
};

const validateInvariant = <S extends Schema.Top>(input: {
  readonly schema: S;
  readonly value: unknown;
  readonly operation: string;
  readonly reason: "initialize" | "protocol";
  readonly pid: number;
  readonly method: string;
}): Effect.Effect<void, AcpRuntimeError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(input.schema)(input.value).pipe(
    Effect.asVoid,
    Effect.mapError((cause) =>
      acpRuntimeError({
        operation: input.operation,
        reason: input.reason,
        retryable: false,
        pid: input.pid,
        method: input.method,
        cause,
      }),
    ),
  );

const withDeadline = <A>(input: {
  readonly effect: Effect.Effect<A, AcpRuntimeError>;
  readonly duration: Duration.Input;
  readonly operation: string;
  readonly pid: number;
  readonly method: string;
  readonly sessionId?: string;
}): Effect.Effect<A, AcpRuntimeError> =>
  input.effect.pipe(
    Effect.timeoutOrElse({
      duration: input.duration,
      orElse: () =>
        Effect.fail(
          acpRuntimeError({
            operation: input.operation,
            reason: "timeout",
            retryable: false,
            pid: input.pid,
            method: input.method,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          }),
        ),
    }),
  );

export const layer = (
  options: AcpSessionRuntimeOptions,
): Layer.Layer<
  AcpSessionRuntime,
  AcpRuntimeError,
  AcpSessionTransport | AcpClientCapabilityOwner
> =>
  Layer.effect(
    AcpSessionRuntime,
    Effect.gen(function* () {
      const eventCapacity = yield* Effect.try({
        try: () => {
          const value = options.eventCapacity ?? ACP_DEFAULT_EVENT_CAPACITY;
          if (Number.isSafeInteger(value) && value > 0) return value;
          throw new RangeError("ACP event capacity must be a positive safe integer");
        },
        catch: (cause) =>
          acpRuntimeError({
            operation: "session.configure",
            reason: "protocol",
            retryable: false,
            cause,
          }),
      });
      const ownerScope = yield* Scope.Scope;
      const transportService = yield* AcpSessionTransport;
      const capabilityOwner = yield* AcpClientCapabilityOwner;
      const rootSessionId = yield* Ref.make<string | null>(null);
      const requireRootSession = <A extends { readonly sessionId: string }, B>(
        request: A,
        operation: string,
        evaluate: (request: A) => Effect.Effect<B, AcpRuntimeError>,
      ): Effect.Effect<B, AcpRuntimeError> =>
        Ref.get(rootSessionId).pipe(
          Effect.flatMap((root) => {
            if (root !== null && request.sessionId === root) return evaluate(request);
            return Effect.fail(
              acpRuntimeError({
                operation,
                reason: "authorization",
                retryable: false,
                sessionId: request.sessionId,
                cause: new Error("ACP client capability request is not owned by the root session"),
              }),
            );
          }),
        );
      const handlers = capabilityOwner.handlers;
      const transport = yield* transportService.open({
        ...options.spawn,
        capabilities: {
          requestPermission: (request) =>
            requireRootSession(request, "capability.permission.route", handlers.requestPermission),
          ...(handlers.readTextFile === undefined
            ? {}
            : {
                readTextFile: (request) =>
                  requireRootSession(request, "capability.fs.read.route", handlers.readTextFile!),
              }),
          ...(handlers.writeTextFile === undefined
            ? {}
            : {
                writeTextFile: (request) =>
                  requireRootSession(request, "capability.fs.write.route", handlers.writeTextFile!),
              }),
          ...(handlers.createTerminal === undefined
            ? {}
            : {
                createTerminal: (request) =>
                  requireRootSession(
                    request,
                    "capability.terminal.create.route",
                    handlers.createTerminal!,
                  ),
                terminalOutput: (request) =>
                  requireRootSession(
                    request,
                    "capability.terminal.output.route",
                    handlers.terminalOutput!,
                  ),
                waitForTerminalExit: (request) =>
                  requireRootSession(
                    request,
                    "capability.terminal.wait.route",
                    handlers.waitForTerminalExit!,
                  ),
                killTerminal: (request) =>
                  requireRootSession(
                    request,
                    "capability.terminal.kill.route",
                    handlers.killTerminal!,
                  ),
                releaseTerminal: (request) =>
                  requireRootSession(
                    request,
                    "capability.terminal.release.route",
                    handlers.releaseTerminal!,
                  ),
              }),
          ...(handlers.createElicitation === undefined
            ? {}
            : {
                createElicitation: (request) => {
                  const sessionId = "sessionId" in request ? request.sessionId : undefined;
                  if (typeof sessionId !== "string") return handlers.createElicitation!(request);
                  return requireRootSession(
                    { ...request, sessionId },
                    "capability.elicitation.route",
                    handlers.createElicitation!,
                  );
                },
              }),
          ...(handlers.completeElicitation === undefined
            ? {}
            : { completeElicitation: handlers.completeElicitation }),
        },
      });
      const fatal = yield* Deferred.make<never, AcpRuntimeError>();
      const failRuntime = (error: AcpRuntimeError): Effect.Effect<void> =>
        Deferred.fail(fatal, error).pipe(Effect.andThen(transport.close(error)), Effect.asVoid);
      const raceRuntime = <A>(effect: Effect.Effect<A, AcpRuntimeError>) =>
        Effect.raceFirst(effect, Deferred.await(fatal));

      yield* transport.termination.pipe(
        Effect.catch((error) => failRuntime(error)),
        Effect.forkScoped,
      );

      const initializeResponse = yield* raceRuntime(
        withDeadline({
          effect: transport.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: capabilityOwner.advertised,
            clientInfo: options.clientInfo,
          }),
          duration: options.initializeTimeout ?? ACP_DEFAULT_INITIALIZE_TIMEOUT,
          operation: "session.initialize",
          pid: transport.pid,
          method: "initialize",
        }),
      );
      yield* validateInvariant({
        schema: initializeInvariant,
        value: initializeResponse,
        operation: "session.initialize-response",
        reason: "initialize",
        pid: transport.pid,
        method: "initialize",
      });

      const events = yield* Queue.dropping<AcpSessionRuntimeIngress>(eventCapacity);
      yield* Effect.addFinalizer(() => Queue.shutdown(events));
      const promptLock = yield* Semaphore.make(1);
      const nextTurnSequence = yield* Ref.make(1);
      const activePrompt = yield* Ref.make<ActivePrompt | null>(null);

      const emit = (event: AcpSessionRuntimeEvent): Effect.Effect<void, AcpRuntimeError> =>
        Queue.offer(events, { kind: "event", event }).pipe(
          Effect.flatMap((accepted) => {
            if (accepted) return Effect.void;
            const error = acpRuntimeError({
              operation: "session.events",
              reason: "pressure",
              retryable: false,
              pid: transport.pid,
              sessionId: event.sessionId,
            });
            return failRuntime(error).pipe(Effect.andThen(Effect.fail(error)));
          }),
        );

      yield* transport.updates.pipe(
        Stream.runForEach((notification) => {
          // A process may report child-session activity. The root Session owns only its exact
          // ACP session id; lineage-aware routing is a separate future owner.
          return Ref.get(rootSessionId).pipe(
            Effect.flatMap((root) => {
              if (root === null || notification.sessionId !== root) return Effect.void;
              return Ref.get(activePrompt).pipe(
                Effect.flatMap((active) =>
                  emit({
                    kind: "session_update",
                    sessionId: root,
                    turnSequence: active?.turnSequence ?? null,
                    update: notification.update,
                  }),
                ),
              );
            }),
          );
        }),
        Effect.catch((error) => failRuntime(error)),
        Effect.forkScoped,
      );

      const drainEvents = Effect.gen(function* () {
        const acknowledged = yield* Deferred.make<void>();
        const accepted = yield* Queue.offer(events, { kind: "barrier", acknowledged });
        if (!accepted) {
          const error = acpRuntimeError({
            operation: "session.events.drain",
            reason: "pressure",
            retryable: false,
            pid: transport.pid,
          });
          return yield* failRuntime(error).pipe(Effect.andThen(Effect.fail(error)));
        }
        yield* Deferred.await(acknowledged);
      });

      const eventStream = Stream.fromQueue(events).pipe(
        Stream.mapEffect((entry) => {
          if (entry.kind === "event") return Effect.succeed(entry.event);
          return Deferred.succeed(entry.acknowledged, undefined).pipe(Effect.as(null));
        }),
        Stream.filter((event): event is AcpSessionRuntimeEvent => event !== null),
      );

      const capabilities = toAcpBackendCapabilityProfile(initializeResponse);
      const openRequest = options.open ?? { kind: "new" as const };
      if (openRequest.kind === "load" || openRequest.kind === "resume") {
        yield* validateInvariant({
          schema: newSessionInvariant,
          value: { sessionId: openRequest.sessionId },
          operation: `session.${openRequest.kind}-request`,
          reason: "protocol",
          pid: transport.pid,
          method: `session/${openRequest.kind}`,
        });
        yield* Ref.set(rootSessionId, openRequest.sessionId);
      }
      const unsupported = (operation: string, sessionId?: string) =>
        acpRuntimeError({
          operation,
          reason: "capability",
          retryable: false,
          pid: transport.pid,
          ...(sessionId === undefined ? {} : { sessionId }),
          cause: new Error(`ACP agent did not advertise ${operation}`),
        });
      const authenticateMethod = Effect.fn("AcpSessionRuntime.authenticateMethod")(function* (
        methodId: string,
      ) {
        const method: AuthMethod | undefined = initializeResponse.authMethods?.find(
          (candidate) => candidate.id === methodId,
        );
        if (method === undefined) {
          return yield* acpRuntimeError({
            operation: "session.authenticate",
            reason: "authorization",
            retryable: false,
            pid: transport.pid,
            method: "authenticate",
            cause: new Error("Authentication method was not advertised by the ACP agent"),
          });
        }
        if ("type" in method && method.type === "terminal") {
          return yield* acpRuntimeError({
            operation: "session.authenticate",
            reason: "capability",
            retryable: false,
            pid: transport.pid,
            method: "authenticate",
            cause: new Error("Terminal authentication requires a separate interactive launch"),
          });
        }
        return yield* raceRuntime(
          withDeadline({
            effect: transport.authenticate({ methodId }),
            duration: options.initializeTimeout ?? ACP_DEFAULT_INITIALIZE_TIMEOUT,
            operation: "session.authenticate",
            pid: transport.pid,
            method: "authenticate",
          }),
        );
      });
      const lifecycle = (() => {
        const common = {
          cwd: options.cwd,
          mcpServers: [],
        };
        switch (openRequest.kind) {
          case "new":
            return {
              method: "session/new",
              effect: transport.newSession(common),
              responseSessionId: (response: AcpSessionOpenResponse) =>
                (response as NewSessionResponse).sessionId,
            };
          case "load":
            return {
              method: "session/load",
              effect: capabilities.session.load
                ? transport.loadSession({ ...common, sessionId: openRequest.sessionId })
                : Effect.fail(unsupported("session/load", openRequest.sessionId)),
              responseSessionId: () => openRequest.sessionId,
            };
          case "resume":
            return {
              method: "session/resume",
              effect: capabilities.session.resume
                ? transport.resumeSession({ ...common, sessionId: openRequest.sessionId })
                : Effect.fail(unsupported("session/resume", openRequest.sessionId)),
              responseSessionId: () => openRequest.sessionId,
            };
          case "fork":
            return {
              method: "session/fork",
              effect: capabilities.session.unstableFork
                ? transport.forkSession({ ...common, sessionId: openRequest.sessionId })
                : Effect.fail(unsupported("session/fork", openRequest.sessionId)),
              responseSessionId: (response: AcpSessionOpenResponse) =>
                (response as ForkSessionResponse).sessionId,
            };
        }
      })();
      let opened: {
        readonly sessionId: string;
        readonly response: AcpSessionOpenResponse;
      } | null = null;
      let modes: SessionModeState | null = null;
      let configOptions: readonly SessionConfigOption[] = [];
      const openLock = yield* Semaphore.make(1);
      const openLifecycle = openLock.withPermits(1)(
        Effect.suspend(() => {
          if (opened !== null) return Effect.succeed(opened);
          return raceRuntime(
            withDeadline({
              effect: lifecycle.effect,
              duration: options.initializeTimeout ?? ACP_DEFAULT_INITIALIZE_TIMEOUT,
              operation: `session.${openRequest.kind}`,
              pid: transport.pid,
              method: lifecycle.method,
              ...(openRequest.kind === "new" ? {} : { sessionId: openRequest.sessionId }),
            }),
          ).pipe(
            Effect.flatMap((response) => {
              const sessionId = lifecycle.responseSessionId(response);
              return validateInvariant({
                schema: newSessionInvariant,
                value: { sessionId },
                operation: `session.${openRequest.kind}-response`,
                reason: "protocol",
                pid: transport.pid,
                method: lifecycle.method,
              }).pipe(
                Effect.andThen(Ref.set(rootSessionId, sessionId)),
                Effect.andThen(raceRuntime(transport.drainUpdates)),
                Effect.map(() => {
                  opened = { sessionId, response };
                  modes = response.modes ?? null;
                  configOptions = [...(response.configOptions ?? [])];
                  return opened;
                }),
              );
            }),
          );
        }),
      );
      yield* openLifecycle.pipe(
        Effect.catch((error) => {
          if (error.reason !== "authentication-required") return Effect.fail(error);
          const methods = (initializeResponse.authMethods ?? []).filter(
            (method) => !("type" in method && method.type === "terminal"),
          );
          // A single agent-owned method is unambiguous and can complete headlessly. Multiple
          // methods remain initialized so the renderer can let the user choose one explicitly.
          if (methods.length === 0) {
            return Effect.fail(
              acpRuntimeError({
                operation: "session.authenticate",
                reason: "capability",
                retryable: false,
                pid: transport.pid,
                cause: new Error(
                  "The ACP Agent requires terminal authentication, which this client did not advertise",
                ),
              }),
            );
          }
          if (methods.length > 1) return Effect.void;
          return authenticateMethod(methods[0]!.id).pipe(
            Effect.andThen(openLifecycle),
            Effect.asVoid,
          );
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          const current = opened;
          return current !== null && capabilities.session.close
            ? transport.closeSession({ sessionId: current.sessionId }).pipe(Effect.ignore)
            : Effect.void;
        }),
      );

      const requireOpened = (operation: string) =>
        Effect.suspend(() => {
          if (opened !== null) return Effect.succeed(opened);
          return Effect.fail(
            acpRuntimeError({
              operation,
              reason: "authentication-required",
              retryable: false,
              pid: transport.pid,
              cause: new Error("Authenticate the ACP Agent before opening its session"),
            }),
          );
        });

      const prompt: AcpSessionRuntime["Service"]["prompt"] = (content) =>
        promptLock.withPermits(1)(
          Effect.gen(function* () {
            const session = yield* requireOpened("session.prompt");
            const sessionId = session.sessionId;
            const turnSequence = yield* Ref.getAndUpdate(
              nextTurnSequence,
              (current) => current + 1,
            );
            yield* Ref.set(activePrompt, { turnSequence, cancelRequested: false });
            const request = transport.prompt({ sessionId, prompt: content });
            const response = yield* raceRuntime(
              options.promptTimeout === undefined
                ? request
                : withDeadline({
                    effect: request,
                    duration: options.promptTimeout,
                    operation: "session.prompt",
                    pid: transport.pid,
                    method: "session/prompt",
                    sessionId,
                  }),
            ).pipe(
              Effect.tapError((error) =>
                error.reason === "timeout" ? failRuntime(error) : Effect.void,
              ),
            );
            yield* validateInvariant({
              schema: promptInvariant,
              value: response,
              operation: "session.prompt-response",
              reason: "protocol",
              pid: transport.pid,
              method: "session/prompt",
            }).pipe(Effect.tapError((error) => failRuntime(error)));
            yield* raceRuntime(transport.drainUpdates);
            const cancelRequested = yield* Ref.modify(
              activePrompt,
              (active) =>
                [
                  active?.turnSequence === turnSequence && active.cancelRequested,
                  active?.turnSequence === turnSequence ? null : active,
                ] as const,
            );
            if (cancelRequested && response.stopReason !== "cancelled") {
              const error = acpRuntimeError({
                operation: "session.cancel-response",
                reason: "protocol",
                retryable: false,
                pid: transport.pid,
                method: "session/prompt",
                sessionId,
                cause: new Error(
                  `Cancelled ACP prompt returned stop reason ${response.stopReason}`,
                ),
              });
              yield* failRuntime(error);
              return yield* error;
            }
            yield* emit({ kind: "turn_stopped", sessionId, turnSequence, response });
            return response;
          }).pipe(Effect.ensuring(Ref.set(activePrompt, null))),
        );

      const cancel = Effect.gen(function* () {
        const session = yield* requireOpened("session.cancel");
        const sessionId = session.sessionId;
        const active = yield* Ref.modify(activePrompt, (current) => {
          if (current === null || current.cancelRequested) return [null, current] as const;
          const next = { ...current, cancelRequested: true };
          return [next, next] as const;
        });
        if (active === null) return;
        yield* raceRuntime(
          withDeadline({
            effect: transport.cancel(sessionId),
            duration: options.cancelTimeout ?? ACP_DEFAULT_CANCEL_TIMEOUT,
            operation: "session.cancel-notification",
            pid: transport.pid,
            method: "session/cancel",
            sessionId,
          }),
        ).pipe(Effect.tapError((error) => failRuntime(error)));
        yield* Effect.sleep(options.cancelTimeout ?? ACP_DEFAULT_CANCEL_TIMEOUT).pipe(
          Effect.andThen(Ref.get(activePrompt)),
          Effect.flatMap((current) => {
            if (current?.turnSequence !== active.turnSequence) return Effect.void;
            const error = acpRuntimeError({
              operation: "session.cancel",
              reason: "timeout",
              retryable: false,
              pid: transport.pid,
              method: "session/cancel",
              sessionId,
            });
            return failRuntime(error);
          }),
          Effect.forkIn(ownerScope),
        );
      });

      const authenticate = (methodId: string) =>
        authenticateMethod(methodId).pipe(
          Effect.tap(() => (opened === null ? openLifecycle : Effect.void)),
        );

      const listSessions = capabilities.session.list
        ? raceRuntime(
            withDeadline({
              effect: transport.listSessions({ cwd: options.cwd }),
              duration: ACP_DEFAULT_REQUEST_TIMEOUT,
              operation: "session.list",
              pid: transport.pid,
              method: "session/list",
            }),
          )
        : Effect.fail(unsupported("session/list"));
      const deleteSession = (candidateSessionId: string) => {
        if (!capabilities.session.delete) {
          return Effect.fail(unsupported("session/delete", candidateSessionId));
        }
        return raceRuntime(
          withDeadline({
            effect: transport.deleteSession({ sessionId: candidateSessionId }),
            duration: ACP_DEFAULT_REQUEST_TIMEOUT,
            operation: "session.delete",
            pid: transport.pid,
            method: "session/delete",
            sessionId: candidateSessionId,
          }),
        ).pipe(Effect.asVoid);
      };
      const setMode = (modeId: string) =>
        requireOpened("session.set-mode").pipe(
          Effect.flatMap(({ sessionId }) => {
            if (modes === null || !modes.availableModes.some((mode) => mode.id === modeId)) {
              return Effect.fail(unsupported("session/set_mode", sessionId));
            }
            return raceRuntime(
              withDeadline({
                effect: transport.setSessionMode({ sessionId, modeId }),
                duration: ACP_DEFAULT_REQUEST_TIMEOUT,
                operation: "session.set-mode",
                pid: transport.pid,
                method: "session/set_mode",
                sessionId,
              }),
            ).pipe(Effect.asVoid);
          }),
        );
      const setConfigOption = (configId: string, value: string | boolean) =>
        requireOpened("session.set-config-option").pipe(
          Effect.flatMap(({ sessionId }) => {
            const option = configOptions.find((candidate) => candidate.id === configId);
            if (
              option === undefined ||
              (option.type === "boolean") !== (typeof value === "boolean")
            ) {
              return Effect.fail(unsupported("session/set_config_option", sessionId));
            }
            const request =
              typeof value === "boolean"
                ? ({ sessionId, configId, type: "boolean", value } as const)
                : ({ sessionId, configId, value } as const);
            return raceRuntime(
              withDeadline({
                effect: transport.setSessionConfigOption(request),
                duration: ACP_DEFAULT_REQUEST_TIMEOUT,
                operation: "session.set-config-option",
                pid: transport.pid,
                method: "session/set_config_option",
                sessionId,
              }),
            ).pipe(Effect.map((response) => response.configOptions));
          }),
        );

      return AcpSessionRuntime.of({
        pid: transport.pid,
        get sessionId() {
          return opened?.sessionId ?? null;
        },
        initializeResponse,
        get openResponse() {
          return opened?.response ?? null;
        },
        capabilities,
        get modes() {
          return modes;
        },
        get configOptions() {
          return configOptions;
        },
        events: eventStream,
        drainEvents,
        prompt,
        authenticate,
        cancel,
        listSessions,
        deleteSession,
        setMode,
        setConfigOption,
        termination: Deferred.await(fatal),
      });
    }),
  );

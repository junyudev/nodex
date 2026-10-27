import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as Environment from "../environment/ServerEnvironment.ts";
import { ORCHESTRATION_INSTRUCTIONS } from "./Instructions.ts";
import type {
  AgentHostToolIdentity,
  AgentHostRequest,
  AgentRuntimeConfiguration,
  AgentRuntimeNotification,
} from "./Interface.ts";

type WithoutRequestId<Request> = Request extends { readonly id: string }
  ? Omit<Request, "id">
  : never;

const Result = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("host.result"),
    id: Schema.String,
    success: Schema.Literal(true),
    output: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("host.result"),
    id: Schema.String,
    success: Schema.Literal(false),
    error: Schema.Struct({ message: Schema.String }),
  }),
]);
const decodeResult = Schema.decodeUnknownEffect(Result);
const decodePrepared = Schema.decodeUnknownEffect(
  Schema.Struct({
    instructions: Schema.optional(Schema.String),
    sourceRoots: Schema.optional(Schema.Array(Schema.String)),
  }),
);
const decodeThreadConfig = Schema.decodeUnknownEffect(
  Schema.Struct({
    config: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    environment: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          set: Schema.Record(Schema.String, Schema.String),
          exclude: Schema.Array(Schema.String),
        }),
      ),
    ),
  }),
);

export const make = Effect.fn("AgentRuntime.makeHostBridge")(function* (
  configuration: AgentRuntimeConfiguration,
  notify: (notification: AgentRuntimeNotification) => Effect.Effect<void>,
) {
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const crypto = yield* Crypto.Crypto;
  const runtimeId = yield* environment.getEnvironmentId;
  const runtimeGeneration = yield* crypto.randomUUIDv4();
  const pending = yield* Ref.make<
    ReadonlyMap<string, Deferred.Deferred<unknown, ExecutionHost.ExecutionHostError>>
  >(new Map());
  const prepared = yield* Ref.make<
    ReadonlyMap<
      string,
      ExecutionHost.HostTurnIdentity & {
        readonly runtimeId: string;
        readonly runtimeGeneration: string;
      }
    >
  >(new Map());
  const nativeCalls = yield* Ref.make<
    ReadonlyMap<
      string,
      ExecutionHost.HostTurnIdentity & {
        readonly runtimeId: string;
        readonly runtimeGeneration: string;
        readonly nativeCallId: string;
        readonly nativeCallKey: string;
        readonly sourceNativeThreadId?: string;
        readonly sourceNativeTurnId?: string;
      }
    >
  >(new Map());
  const callRegistration = yield* Deferred.make<void>().pipe(Effect.flatMap(Ref.make));
  const registrationWaiters = yield* Ref.make(0);
  const notifyCallRegistration = Effect.fnUntraced(function* () {
    const next = yield* Deferred.make<void>();
    const previous = yield* Ref.getAndSet(callRegistration, next);
    yield* Deferred.succeed(previous, undefined);
  });
  const nativeSessions = yield* Ref.make<
    ReadonlyMap<
      string,
      ReadonlyMap<
        string,
        {
          readonly providerSessionId: string;
          readonly nativeGeneration: number;
          readonly scope: Scope.Scope;
          readonly incarnationId: string;
          readonly openedAtMs: number;
        }
      >
    >
  >(new Map());
  const registerNativeSession = Effect.fn("AgentRuntime.registerNativeSession")(
    function* (identity: {
      readonly credentialId: string;
      readonly providerSessionId: string;
      readonly nativeGeneration: number;
    }) {
      const scope = yield* Scope.Scope;
      const key = `${identity.providerSessionId}:${identity.nativeGeneration}`;
      const incarnationId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const openedAtMs = yield* Clock.currentTimeMillis;
      yield* Ref.update(nativeSessions, (current) => {
        const members = new Map(current.get(identity.credentialId));
        members.set(key, { ...identity, scope, incarnationId, openedAtMs });
        return new Map(current).set(identity.credentialId, members);
      });
      yield* Effect.addFinalizer(() =>
        Ref.update(nativeSessions, (current) => {
          const members = new Map(current.get(identity.credentialId));
          members.delete(key);
          const next = new Map(current);
          if (members.size === 0) next.delete(identity.credentialId);
          else next.set(identity.credentialId, members);
          return next;
        }).pipe(
          Effect.andThen(
            Ref.update(
              prepared,
              (current) =>
                new Map(
                  [...current].filter(
                    ([, frame]) =>
                      frame.providerSessionId !== identity.providerSessionId ||
                      frame.nativeGeneration !== identity.nativeGeneration,
                  ),
                ),
            ),
          ),
          Effect.andThen(
            Ref.update(
              nativeCalls,
              (current) =>
                new Map(
                  [...current].filter(
                    ([, frame]) =>
                      frame.providerSessionId !== identity.providerSessionId ||
                      frame.nativeGeneration !== identity.nativeGeneration,
                  ),
                ),
            ),
          ),
          Effect.andThen(notifyCallRegistration()),
          Effect.andThen(
            notify({
              type: "execution.native-session.closed",
              runtimeId,
              runtimeGeneration,
              providerSessionId: identity.providerSessionId,
              nativeGeneration: identity.nativeGeneration,
              incarnationId,
            }),
          ),
        ),
      );
    },
  );

  const exchange = Effect.fn("AgentRuntime.hostExchange")(function* (
    message: WithoutRequestId<AgentHostRequest>,
  ) {
    const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const result = yield* Deferred.make<unknown, ExecutionHost.ExecutionHostError>();
    const admitted = yield* Ref.modify(pending, (current) =>
      current.size >= 128
        ? ([false, current] as const)
        : ([true, new Map(current).set(id, result)] as const),
    );
    if (!admitted)
      return yield* Effect.fail(
        new ExecutionHost.ExecutionHostError({
          operation: message.operation,
          message: "Execution host callback queue is full.",
        }),
      );
    return yield* notify({ ...message, id } as AgentHostRequest).pipe(
      Effect.andThen(Deferred.await(result)),
      Effect.onInterrupt(() => notify({ type: "host.cancel", id, runtimeId, runtimeGeneration })),
      Effect.ensuring(
        Ref.update(pending, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
      ),
    );
  });

  const prepareTurn = Effect.fn("AgentRuntime.prepareHostTurn")(function* (
    turn: ExecutionHost.HostTurnIdentity,
  ) {
    if (configuration.host === undefined) return {};
    const identity = { ...turn, runtimeId, runtimeGeneration };
    const output = yield* exchange({ type: "host.request", operation: "turn.prepare", identity });
    const result = yield* decodePrepared(output).pipe(
      Effect.mapError(
        (error) =>
          new ExecutionHost.ExecutionHostError({
            operation: "turn.prepare",
            message: error.message,
          }),
      ),
    );
    yield* Ref.update(prepared, (current) =>
      new Map(current).set(
        JSON.stringify([identity.threadId, identity.providerSessionId, identity.nativeGeneration]),
        identity,
      ),
    );
    return {
      identity,
      ...(result.instructions === undefined ? {} : { instructions: result.instructions }),
      ...(result.sourceRoots === undefined ? {} : { sourceRoots: result.sourceRoots }),
    };
  });

  const prepareThread = Effect.fn("AgentRuntime.prepareHostThread")(function* (input: {
    readonly threadId: string;
    readonly providerInstanceId: string;
    readonly nativeDriver: string;
    readonly cwd: string | null;
  }) {
    if (configuration.host === undefined) return {};
    const output = yield* exchange({
      type: "host.request",
      operation: "thread.prepare",
      identity: {
        runtimeId,
        runtimeGeneration,
        threadId: input.threadId,
        providerInstanceId: input.providerInstanceId,
        nativeDriver: input.nativeDriver,
      },
      cwd: input.cwd,
    }).pipe(
      // Desktop tools may install on first use; a host that cannot answer leaves them out.
      Effect.timeoutOrElse({
        duration: "1 minute",
        orElse: () =>
          Effect.fail(
            new ExecutionHost.ExecutionHostError({
              operation: "thread.prepare",
              message: "The host did not prepare the thread in time.",
            }),
          ),
      }),
    );
    const result = yield* decodeThreadConfig(output).pipe(
      Effect.mapError(
        (error) =>
          new ExecutionHost.ExecutionHostError({
            operation: "thread.prepare",
            message: error.message,
          }),
      ),
    );
    return {
      ...(result.config ? { config: result.config } : {}),
      ...(result.environment ? { environment: result.environment } : {}),
    };
  });

  // Host tools that follow native Turns degrade when the host cannot be told; execution goes on.
  const observeNativeTurn = Effect.fn("AgentRuntime.observeNativeTurn")(function* (input: {
    readonly identity: ExecutionHost.HostTurnIdentity;
    readonly nativeTurnId: string;
    readonly phase: "started" | "ended";
  }) {
    if (configuration.host === undefined) return;
    yield* exchange({
      type: "host.request",
      operation: "turn.native",
      identity: { ...input.identity, runtimeId, runtimeGeneration },
      nativeTurnId: input.nativeTurnId,
      phase: input.phase,
    }).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () =>
          Effect.fail(
            new ExecutionHost.ExecutionHostError({
              operation: "turn.native",
              message: "The host did not observe the Turn in time.",
            }),
          ),
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Host could not observe a native Turn", { cause, phase: input.phase }),
      ),
    );
  });

  const accept = Effect.fn("AgentRuntime.acceptHostResult")(function* (value: unknown) {
    const result = yield* decodeResult(value);
    const waiter = yield* Ref.get(pending).pipe(Effect.map((current) => current.get(result.id)));
    if (waiter === undefined) return false;
    if (result.success) return yield* Deferred.succeed(waiter, result.output);
    return yield* Deferred.fail(
      waiter,
      new ExecutionHost.ExecutionHostError({
        operation: "host.callback",
        message: result.error.message,
      }),
    );
  });

  yield* Effect.addFinalizer(() =>
    Ref.get(pending).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(
          current.values(),
          (waiter) =>
            Deferred.fail(
              waiter,
              new ExecutionHost.ExecutionHostError({
                operation: "shutdown",
                message: "Execution host closed.",
              }),
            ),
          { discard: true },
        ),
      ),
    ),
  );

  type NativeCallIdentity = {
    readonly threadId?: string;
    readonly providerSessionId?: string;
    readonly nativeGeneration?: number;
    readonly providerInstanceId?: string;
    readonly nativeCallId: string;
    readonly nativeThreadId?: string;
    readonly nativeTurnId?: string;
  };
  const resolveNativeCallById = (input: NativeCallIdentity) =>
    Ref.get(nativeCalls).pipe(
      Effect.map((current) => {
        const matches = [...current.values()].filter(
          (frame) =>
            (input.threadId === undefined || frame.threadId === input.threadId) &&
            (input.providerSessionId === undefined ||
              frame.providerSessionId === input.providerSessionId) &&
            (input.nativeGeneration === undefined ||
              frame.nativeGeneration === input.nativeGeneration) &&
            (input.providerInstanceId === undefined ||
              frame.providerInstanceId === input.providerInstanceId) &&
            frame.nativeCallId === input.nativeCallId &&
            (input.nativeThreadId === undefined ||
              frame.sourceNativeThreadId === input.nativeThreadId) &&
            (input.nativeTurnId === undefined || frame.sourceNativeTurnId === input.nativeTurnId),
        );
        const frame = matches.length === 1 ? matches[0] : undefined;
        if (frame === undefined) return undefined;
        const { sourceNativeThreadId: _thread, sourceNativeTurnId: _turn, ...actor } = frame;
        return actor;
      }),
    );
  // Native notifications and HTTP requests are independent transports. Wait for the exact
  // call registration when HTTP wins the race; never substitute the latest foreground Run.
  const awaitNativeCallById = Effect.fn("AgentRuntime.awaitNativeCallById")(function* (
    input: NativeCallIdentity,
  ) {
    const immediate = yield* resolveNativeCallById(input);
    if (immediate !== undefined) return immediate;
    const admitted = yield* Ref.modify(registrationWaiters, (count) =>
      count >= 128 ? ([false, count] as const) : ([true, count + 1] as const),
    );
    if (!admitted) return undefined;
    const registered = yield* Effect.gen(function* () {
      while (true) {
        const changed = yield* Ref.get(callRegistration);
        const actor = yield* resolveNativeCallById(input);
        if (actor !== undefined) return actor;
        const live = yield* Ref.get(nativeSessions).pipe(
          Effect.map((current) =>
            [...current.values()].some((members) =>
              [...members.values()].some(
                (native) =>
                  (input.providerSessionId === undefined ||
                    native.providerSessionId === input.providerSessionId) &&
                  (input.nativeGeneration === undefined ||
                    native.nativeGeneration === input.nativeGeneration),
              ),
            ),
          ),
        );
        if (!live) return undefined;
        yield* Deferred.await(changed);
      }
    }).pipe(
      Effect.timeoutOption("3 seconds"),
      Effect.ensuring(Ref.update(registrationWaiters, (count) => count - 1)),
    );
    return Option.getOrUndefined(registered);
  });

  return {
    runtimeId,
    runtimeGeneration,
    accept,
    readProviderAuth: (input: {
      readonly providerInstanceId: import("@t3tools/contracts").ProviderInstanceId;
      readonly refresh: boolean;
      readonly previousAccountId: string | null;
    }) =>
      exchange({
        type: "host.request",
        operation: "provider.auth",
        identity: { runtimeId, runtimeGeneration, providerInstanceId: input.providerInstanceId },
        refresh: input.refresh,
        previousAccountId: input.previousAccountId,
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ExecutionHost.ProviderAuthentication)),
        Effect.mapError(
          () =>
            new ExecutionHost.ExecutionHostError({
              operation: "provider.auth",
              message: "Configured provider authentication is unavailable.",
            }),
        ),
      ),
    captureNativeToolCall: Effect.fn("AgentRuntime.captureNativeToolCall")(function* (input: {
      readonly identity: ExecutionHost.HostTurnIdentity;
      readonly nativeCallId: string;
      readonly nativeThreadId?: string;
      readonly nativeTurnId?: string;
    }) {
      const token = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const accepted = yield* Ref.modify(nativeCalls, (current) =>
        current.size >= 128
          ? ([false, current] as const)
          : ([
              true,
              new Map(current).set(token, {
                ...input.identity,
                runtimeId,
                runtimeGeneration,
                nativeCallId: input.nativeCallId,
                nativeCallKey: token,
                ...(input.nativeThreadId === undefined
                  ? {}
                  : { sourceNativeThreadId: input.nativeThreadId }),
                ...(input.nativeTurnId === undefined
                  ? {}
                  : { sourceNativeTurnId: input.nativeTurnId }),
              }),
            ] as const),
      );
      if (!accepted)
        return yield* new ExecutionHost.ExecutionHostError({
          operation: "tool.capture",
          message: "Native call capacity is full.",
        });
      yield* notifyCallRegistration();
      return token;
    }),
    resolveNativeCallById,
    awaitNativeCallById,
    resolveNativeToolCall: (token: string) =>
      Ref.get(nativeCalls).pipe(Effect.map((current) => current.get(token))),
    releaseNativeToolCall: (token: string) =>
      Ref.update(nativeCalls, (current) => {
        const next = new Map(current);
        next.delete(token);
        return next;
      }),
    prepareTurn,
    registerNativeSession,
    prepareThread,
    observeNativeTurn,
    onNativeSessionClose: (
      identity: {
        readonly credentialId: string;
        readonly providerSessionId: string;
        readonly nativeGeneration: number;
      },
      cleanup: Effect.Effect<void>,
    ) =>
      Ref.get(nativeSessions).pipe(
        Effect.flatMap((current) => {
          const native = current
            .get(identity.credentialId)
            ?.get(`${identity.providerSessionId}:${identity.nativeGeneration}`);
          return native === undefined ? cleanup : Scope.addFinalizer(native.scope, cleanup);
        }),
      ),
    nativeSessions: (credentialId: string) =>
      Ref.get(nativeSessions).pipe(
        Effect.map((current) =>
          [...(current.get(credentialId)?.values() ?? [])].map(
            ({ providerSessionId, nativeGeneration }) => ({ providerSessionId, nativeGeneration }),
          ),
        ),
      ),
    nativeSessionActor: (
      threadId: string,
      identity: {
        readonly providerSessionId: string;
        readonly nativeGeneration: number;
        readonly incarnationId?: string;
      },
    ) =>
      Effect.gen(function* () {
        const native = [...(yield* Ref.get(nativeSessions)).values()]
          .flatMap((members) => [...members.values()])
          .find(
            (candidate) =>
              candidate.providerSessionId === identity.providerSessionId &&
              candidate.nativeGeneration === identity.nativeGeneration &&
              (identity.incarnationId === undefined ||
                candidate.incarnationId === identity.incarnationId),
          );
        if (native === undefined) return undefined;
        const frame = [...(yield* Ref.get(prepared)).values()].find(
          (candidate) =>
            candidate.threadId === threadId &&
            candidate.providerSessionId === native.providerSessionId &&
            candidate.nativeGeneration === native.nativeGeneration,
        );
        if (frame === undefined) return undefined;
        return {
          ...frame,
          source: "native-session" as const,
          runId: null,
          attemptId: null,
          incarnationId: native.incarnationId,
          admittedAtMs: native.openedAtMs,
        };
      }),
    preparedTurn: (
      threadId: string,
      native?: { readonly providerSessionId: string; readonly nativeGeneration: number },
    ) =>
      Ref.get(prepared).pipe(
        Effect.map((current) =>
          [...current.values()].findLast(
            (frame) =>
              frame.threadId === threadId &&
              (native === undefined ||
                (frame.providerSessionId === native.providerSessionId &&
                  frame.nativeGeneration === native.nativeGeneration)),
          ),
        ),
      ),
    nativeSessionLive: (identity: {
      readonly providerSessionId: string;
      readonly nativeGeneration: number;
    }) =>
      Ref.get(nativeSessions).pipe(
        Effect.map((current) =>
          [...current.values()].some((members) =>
            [...members.values()].some(
              (native) =>
                native.providerSessionId === identity.providerSessionId &&
                native.nativeGeneration === identity.nativeGeneration,
            ),
          ),
        ),
      ),
    preparedRun: (threadId: string, runId: string) =>
      Ref.get(prepared).pipe(
        Effect.map((current) =>
          [...current.values()].find(
            (frame) => frame.threadId === threadId && frame.runId === runId,
          ),
        ),
      ),
    callTool: (identity: AgentHostToolIdentity, tool: string, input: unknown) =>
      exchange({
        type: "host.request",
        operation: "tool.call",
        identity,
        tool,
        input,
      }),
  };
});

export class HostBridge extends Context.Service<
  HostBridge,
  Effect.Success<ReturnType<typeof make>>
>()("@nodex/agent-runtime/HostBridge") {}

export const layer = (
  configuration: AgentRuntimeConfiguration,
  notify: (notification: AgentRuntimeNotification) => Effect.Effect<void>,
) => Layer.effect(HostBridge, make(configuration, notify));

export const layerExecutionHost = Layer.effect(
  ExecutionHost.ExecutionHost,
  Effect.gen(function* () {
    const bridge = yield* HostBridge;
    return {
      threadCreationOwner: "host" as const,
      runtimeGeneration: bridge.runtimeGeneration,
      prepareTurn: bridge.prepareTurn,
      captureNativeToolCall: bridge.captureNativeToolCall,
      releaseNativeToolCall: bridge.releaseNativeToolCall,
      readProviderAuth: bridge.readProviderAuth,
      registerNativeSession: bridge.registerNativeSession,
      prepareThread: bridge.prepareThread,
      observeNativeTurn: bridge.observeNativeTurn,
      toolAvailability: { browser: false, device: false },
      orchestrationInstructions: ORCHESTRATION_INSTRUCTIONS,
    };
  }),
);

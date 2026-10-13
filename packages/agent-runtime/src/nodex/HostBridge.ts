import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
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
  Schema.Struct({ instructions: Schema.optional(Schema.String) }),
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
  const nativeSessions = yield* Ref.make<
    ReadonlyMap<
      string,
      ReadonlyMap<string, { readonly providerSessionId: string; readonly nativeGeneration: number }>
    >
  >(new Map());
  const registerNativeSession = Effect.fn("AgentRuntime.registerNativeSession")(
    function* (identity: {
      readonly credentialId: string;
      readonly providerSessionId: string;
      readonly nativeGeneration: number;
    }) {
      const key = `${identity.providerSessionId}:${identity.nativeGeneration}`;
      yield* Ref.update(nativeSessions, (current) => {
        const members = new Map(current.get(identity.credentialId));
        members.set(key, identity);
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
        }),
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
    yield* Ref.update(prepared, (current) => new Map(current).set(identity.threadId, identity));
    return result.instructions === undefined ? {} : { instructions: result.instructions };
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

  return {
    runtimeId,
    runtimeGeneration,
    accept,
    prepareTurn,
    registerNativeSession,
    nativeSessions: (credentialId: string) =>
      Ref.get(nativeSessions).pipe(
        Effect.map((current) => [...(current.get(credentialId)?.values() ?? [])]),
      ),
    preparedTurn: (threadId: string) =>
      Ref.get(prepared).pipe(Effect.map((current) => current.get(threadId))),
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
      prepareTurn: bridge.prepareTurn,
      registerNativeSession: bridge.registerNativeSession,
      toolAvailability: { browser: false, device: false },
      orchestrationInstructions: ORCHESTRATION_INSTRUCTIONS,
    };
  }),
);

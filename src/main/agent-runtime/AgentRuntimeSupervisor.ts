import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessOptions,
} from "../platform/node/AgentRuntimeProcess";

type HostHandler = AgentRuntimeProcessOptions["host"];

export interface AgentRuntimeSupervisorOptions<Requirements> {
  readonly acquire: (
    host: HostHandler,
  ) => Effect.Effect<AgentRuntimeProcessConnection, unknown, Scope.Scope | Requirements>;
  /** Activated after readiness; restored Runs may await this without blocking boot. */
  readonly activate: (
    connection: AgentRuntimeProcessConnection,
  ) => Effect.Effect<HostHandler, unknown, Scope.Scope | Requirements>;
}

export class AgentRuntimeSupervisorError extends Schema.TaggedError<AgentRuntimeSupervisorError>()(
  "AgentRuntimeSupervisorError",
  { operation: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** One lazy Profile execution process. Failed requests are never automatically resubmitted. */
export const make = Effect.fn("AgentRuntimeSupervisor.make")(function* <Requirements>(
  options: AgentRuntimeSupervisorOptions<Requirements>,
) {
  const dependencies = yield* Effect.context<Requirements>();
  const ownerScope = yield* Scope.fork(yield* Effect.scope);
  const gate = yield* Semaphore.make(1);
  const state = yield* Ref.make<{
    readonly closed: boolean;
    readonly remainingRestarts: number;
    readonly current: {
      readonly connection: AgentRuntimeProcessConnection;
      readonly scope: Scope.Closeable;
    } | null;
  }>({ closed: false, current: null, remainingRestarts: 3 });

  const acquire: (
    recovering: boolean,
  ) => Effect.Effect<AgentRuntimeProcessConnection, AgentRuntimeSupervisorError> = Effect.fn(
    "AgentRuntimeSupervisor.acquire",
  )(
    function* (recovering: boolean) {
      const current = yield* Ref.get(state);
      if (current.closed) return yield* new AgentRuntimeSupervisorError({ operation: "closed" });
      if (current.current) return current.current.connection;
      if (recovering && current.remainingRestarts === 0)
        return yield* new AgentRuntimeSupervisorError({ operation: "recovery-exhausted" });
      const remainingRestarts = recovering ? current.remainingRestarts - 1 : 3;
      yield* Ref.set(state, { ...current, remainingRestarts });
      const generationScope = yield* Scope.fork(ownerScope);
      const hostReady = yield* Deferred.make<HostHandler, Error>();
      const acquired = yield* options
        .acquire((request) =>
          Deferred.await(hostReady).pipe(Effect.flatMap((host) => host(request))),
        )
        .pipe(
          Effect.flatMap((connection) =>
            options.activate(connection).pipe(
              Effect.tap((host) => Deferred.succeed(hostReady, host)),
              Effect.as(connection),
            ),
          ),
          Effect.provideService(Scope.Scope, generationScope),
          Effect.provide(dependencies),
          Effect.exit,
        );
      if (Exit.isFailure(acquired)) {
        yield* Deferred.fail(hostReady, new Error("Agent Runtime Host is unavailable"));
        yield* Scope.close(generationScope, acquired);
        return yield* new AgentRuntimeSupervisorError({
          operation: "start",
          cause: acquired.cause,
        });
      }
      const connection = acquired.value;
      yield* Ref.set(state, {
        closed: false,
        remainingRestarts,
        current: { connection, scope: generationScope },
      });
      yield* connection.terminated.pipe(
        Effect.flatMap(() =>
          gate.withPermit(
            Effect.gen(function* () {
              const current = yield* Ref.get(state);
              if (current.closed || current.current?.connection !== connection) return false;
              yield* Ref.set(state, { ...current, current: null });
              yield* Scope.close(generationScope, Exit.void);
              return true;
            }),
          ),
        ),
        Effect.flatMap((recover) =>
          recover
            ? Effect.sleep("250 millis").pipe(
                Effect.andThen(acquire(true)),
                Effect.retry({ times: 2, schedule: Schedule.spaced("1 second") }),
                Effect.catchCause(() =>
                  Effect.logWarning(
                    "Agent Runtime recovery stopped; the next user operation may retry",
                  ),
                ),
                Effect.asVoid,
              )
            : Effect.void,
        ),
        Effect.forkIn(ownerScope),
      );
      return connection;
    },
    (operation) => gate.withPermit(operation),
  );

  const close = gate.withPermit(
    Effect.gen(function* () {
      if ((yield* Ref.get(state)).closed) return;
      yield* Ref.set(state, { closed: true, current: null, remainingRestarts: 0 });
      yield* Scope.close(ownerScope, Exit.void);
    }),
  );
  yield* Effect.addFinalizer(() => close);
  const get = () => acquire(false);
  const request = Effect.fn("AgentRuntimeSupervisor.request")(function* <
    Method extends AgentRuntimeMethod,
  >(method: Method, input: AgentRuntimeOperations[Method]["input"]) {
    const connection = yield* get();
    return yield* connection.request(method, input);
  });
  return {
    get,
    request,
    close,
    inspect: Ref.get(state).pipe(
      Effect.map((current) => current.current?.connection.identity ?? null),
    ),
  };
});

export class AgentRuntimeSupervisor extends Context.Service<
  AgentRuntimeSupervisor,
  Effect.Success<ReturnType<typeof make<never>>>
>()("nodex/main/agent-runtime/AgentRuntimeSupervisor") {}

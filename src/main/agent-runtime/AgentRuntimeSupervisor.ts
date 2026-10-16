import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeConnectionState } from "../../shared/agent-runtime-api";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessOptions,
} from "../platform/node/AgentRuntimeProcess";

type HostHandler = AgentRuntimeProcessOptions["host"];

export interface AgentRuntimeSupervisorOptions<Requirements> {
  readonly acquire: (
    host: HostHandler,
  ) => Effect.Effect<AgentRuntimeProcessConnection, unknown, Scope.Scope | Requirements>;
  /**
   * Activated after readiness; restored Runs may await this without blocking boot. It and every
   * `get()` caller receive a usage-tracking view of the acquired process that shares its
   * `identity` object, so per-generation state must be keyed by `identity`.
   */
  readonly activate: (
    connection: AgentRuntimeProcessConnection,
  ) => Effect.Effect<HostHandler, unknown, Scope.Scope | Requirements>;
  /** Starts that follow a crash or failed start, admitted per sliding window. */
  readonly restarts?: { readonly limit: number; readonly window: Duration.Input };
  /**
   * Stops a generation after this quiet period with no requests, Host calls or retained
   * observers, once the process reports no live or pending work. The next request restarts it.
   */
  readonly idle?: {
    readonly after: Duration.Input;
    readonly quiescent: (
      connection: AgentRuntimeProcessConnection,
    ) => Effect.Effect<boolean, unknown, Requirements>;
  };
  /** Durable evidence that the stopped store holds no live or pending work. */
  readonly quiescence?: {
    readonly record: Effect.Effect<void, unknown, Requirements>;
    readonly clear: Effect.Effect<void, unknown, Requirements>;
    /** False only while valid evidence proves the stopped store has nothing to resume. */
    readonly startRequired: Effect.Effect<boolean, unknown, Requirements>;
  };
}

export class AgentRuntimeSupervisorError extends Schema.TaggedError<AgentRuntimeSupervisorError>()(
  "AgentRuntimeSupervisorError",
  { operation: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const DEFAULT_RESTARTS = { limit: 3, window: Duration.minutes(5) } as const;
const QUIESCENCE_TIMEOUT = Duration.seconds(5);
const START_FAILED_MESSAGE =
  "Agent execution could not start. Nodex will try again with your next Agent action.";
const EXHAUSTED_MESSAGE =
  "Agent execution stopped unexpectedly several times, so Nodex paused restarts for a few minutes. Your next Agent action after that starts it again.";

interface Usage {
  /** Requests, Host calls and retained observers currently using the process. */
  readonly busy: number;
  /** Product writes in flight; reads and observers cannot leave the store with new work. */
  readonly writes: number;
  /** Advances on every use so a quiet period restarts after any activity. */
  readonly epoch: number;
}

/** One lazy Profile execution process. Failed requests are never automatically resubmitted. */
export const make = Effect.fn("AgentRuntimeSupervisor.make")(function* <Requirements>(
  options: AgentRuntimeSupervisorOptions<Requirements>,
) {
  const dependencies = yield* Effect.context<Requirements>();
  const ownerScope = yield* Scope.fork(yield* Effect.scope);
  const gate = yield* Semaphore.make(1);
  const restartLimit = options.restarts?.limit ?? DEFAULT_RESTARTS.limit;
  const restartWindow = Duration.fromInputUnsafe(
    options.restarts?.window ?? DEFAULT_RESTARTS.window,
  );
  const state = yield* Ref.make<{
    readonly closed: boolean;
    readonly current: {
      readonly connection: AgentRuntimeProcessConnection;
      readonly scope: Scope.Closeable;
    } | null;
    /** Start times of recoveries still inside the restart window. */
    readonly recoveries: readonly number[];
    /** The previous generation crashed or failed to start; the next start is a recovery. */
    readonly unhealthy: boolean;
  }>({ closed: false, current: null, recoveries: [], unhealthy: false });
  const connectionState = yield* SubscriptionRef.make<AgentRuntimeConnectionState>({
    status: "idle",
  });
  const usage = yield* SubscriptionRef.make<Usage>({ busy: 0, writes: 0, epoch: 0 });
  const publish = (next: AgentRuntimeConnectionState) => SubscriptionRef.set(connectionState, next);
  const provide = <A, E>(effect: Effect.Effect<A, E, Requirements>) =>
    effect.pipe(Effect.provide(dependencies));

  const use = (write: number) => (delta: number) =>
    SubscriptionRef.update(usage, (current) => ({
      busy: current.busy + delta,
      writes: current.writes + write * delta,
      epoch: current.epoch + 1,
    }));
  const enter = use(0)(1);
  const leave = use(0)(-1);
  const tracked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      enter,
      () => effect,
      () => leave,
    );
  const writing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      use(1)(1),
      () => effect,
      () => use(1)(-1),
    );
  /** Keeps the current or next generation from idling out while the caller's Scope is open. */
  const retain = Effect.acquireRelease(enter, () => leave).pipe(Effect.asVoid);
  const touch = SubscriptionRef.update(usage, (current) => ({
    ...current,
    epoch: current.epoch + 1,
  }));
  const usageOf = (connection: AgentRuntimeProcessConnection): AgentRuntimeProcessConnection => ({
    identity: connection.identity,
    terminated: connection.terminated,
    notifications: connection.notifications,
    request: (method, input) => tracked(connection.request(method, input)),
    // A live renderer or Session observer is use; per-generation execution observers are not.
    subscribeNotifications: retain.pipe(Effect.andThen(connection.subscribeNotifications)),
    subscribeExecutionNotifications: connection.subscribeExecutionNotifications,
  });
  const ignoreEvidence = (operation: string) => (effect: Effect.Effect<void, unknown>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Agent execution lifecycle evidence could not be updated").pipe(
          Effect.annotateLogs({ operation, cause }),
        ),
      ),
    );
  const clearQuiescence = options.quiescence
    ? provide(options.quiescence.clear).pipe(ignoreEvidence("clear"))
    : Effect.void;
  const recordQuiescence = options.quiescence
    ? provide(options.quiescence.record).pipe(ignoreEvidence("record"))
    : Effect.void;
  const isQuiescent = (connection: AgentRuntimeProcessConnection) =>
    options.idle
      ? provide(options.idle.quiescent(connection)).pipe(
          Effect.timeoutOption(QUIESCENCE_TIMEOUT),
          Effect.map((result) => Option.getOrElse(result, () => false)),
          Effect.catchCause(() => Effect.succeed(false)),
        )
      : Effect.succeed(false);

  /** Stops an idle generation under the gate; `true` ends that generation's idle watch. */
  const stopIfIdle = (
    connection: AgentRuntimeProcessConnection,
    raw: AgentRuntimeProcessConnection,
    epoch: number,
  ) =>
    gate.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const live = current.current;
          if (current.closed || live?.connection !== connection) return true;
          const quiet = (value: Usage) => value.busy === 0 && value.epoch === epoch;
          if (!quiet(yield* SubscriptionRef.get(usage))) return false;
          const quiescent = yield* isQuiescent(raw);
          // A request through an earlier reference may race the report.
          if (!quiescent || !quiet(yield* SubscriptionRef.get(usage))) return false;
          yield* Ref.set(state, { ...current, current: null });
          yield* Scope.close(live.scope, Exit.void);
          yield* recordQuiescence;
          yield* publish({ status: "idle" });
          return true;
        }),
      ),
    );

  const watchIdle = (
    connection: AgentRuntimeProcessConnection,
    raw: AgentRuntimeProcessConnection,
    ended: Deferred.Deferred<void>,
  ) => {
    const idle = options.idle;
    if (!idle) return Effect.void;
    const quiet = SubscriptionRef.changes(usage).pipe(
      Stream.filter((value) => value.busy === 0),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    const disturbed = (epoch: number) =>
      SubscriptionRef.changes(usage).pipe(
        Stream.filter((value) => value.epoch !== epoch),
        Stream.runHead,
        Effect.as(true),
      );
    const watch: Effect.Effect<void> = Effect.gen(function* () {
      while (true) {
        const { epoch } = yield* quiet;
        const interrupted = yield* Effect.raceFirst(
          disturbed(epoch),
          Effect.sleep(idle.after).pipe(Effect.as(false)),
        );
        if (interrupted) continue;
        if (yield* stopIfIdle(connection, raw, epoch)) return;
      }
    });
    return Effect.raceFirst(watch, Deferred.await(ended)).pipe(
      Effect.forkIn(ownerScope),
      Effect.asVoid,
    );
  };

  const acquire: (
    recovering: boolean,
  ) => Effect.Effect<AgentRuntimeProcessConnection, AgentRuntimeSupervisorError> = Effect.fn(
    "AgentRuntimeSupervisor.acquire",
  )(
    function* (recovering: boolean) {
      const current = yield* Ref.get(state);
      if (current.closed) return yield* new AgentRuntimeSupervisorError({ operation: "closed" });
      if (current.current) return current.current.connection;
      const now = yield* Clock.currentTimeMillis;
      const recoveries = current.recoveries.filter(
        (startedAt) => now - startedAt < Duration.toMillis(restartWindow),
      );
      const recovery = recovering || current.unhealthy;
      if (recovery && recoveries.length >= restartLimit) {
        yield* Ref.set(state, { ...current, recoveries });
        yield* publish({ status: "failed", message: EXHAUSTED_MESSAGE });
        return yield* new AgentRuntimeSupervisorError({ operation: "recovery-exhausted" });
      }
      const admitted = recovery ? [...recoveries, now] : recoveries;
      yield* Ref.set(state, { ...current, recoveries: admitted });
      yield* publish(
        recovery ? { status: "restarting", attempt: admitted.length } : { status: "starting" },
      );
      yield* clearQuiescence;
      const generationScope = yield* Scope.fork(ownerScope);
      const ended = yield* Deferred.make<void>();
      yield* Scope.addFinalizer(generationScope, Deferred.succeed(ended, undefined));
      const hostReady = yield* Deferred.make<HostHandler, Error>();
      const acquired = yield* options
        .acquire((request) =>
          tracked(Deferred.await(hostReady).pipe(Effect.flatMap((host) => host(request)))),
        )
        .pipe(
          Effect.map((raw) => ({ raw, connection: usageOf(raw) })),
          Effect.flatMap(({ raw, connection }) =>
            options.activate(connection).pipe(
              Effect.tap((host) => Deferred.succeed(hostReady, host)),
              Effect.as({ raw, connection }),
            ),
          ),
          Effect.provideService(Scope.Scope, generationScope),
          Effect.provide(dependencies),
          Effect.exit,
        );
      if (Exit.isFailure(acquired)) {
        // The readable reason lives only here; callers see a generic start failure.
        yield* Effect.logError("Agent execution process could not start").pipe(
          Effect.annotateLogs({ recovering, cause: Cause.pretty(acquired.cause) }),
        );
        yield* Deferred.fail(hostReady, new Error("Agent Runtime Host is unavailable"));
        yield* Scope.close(generationScope, acquired);
        yield* Ref.update(state, (latest) => ({ ...latest, unhealthy: true }));
        // Automatic recovery reports exhaustion itself; a demand start fails visibly now.
        if (!recovering) yield* publish({ status: "failed", message: START_FAILED_MESSAGE });
        return yield* new AgentRuntimeSupervisorError({
          operation: "start",
          cause: acquired.cause,
        });
      }
      const { raw, connection } = acquired.value;
      yield* Ref.update(state, (latest) => ({
        ...latest,
        unhealthy: false,
        current: { connection, scope: generationScope },
      }));
      yield* publish({ status: "ready", generation: connection.identity.runtimeGeneration });
      yield* watchIdle(connection, raw, ended);
      yield* connection.terminated.pipe(
        Effect.flatMap(() =>
          gate.withPermit(
            Effect.gen(function* () {
              const current = yield* Ref.get(state);
              if (current.closed || current.current?.connection !== connection) return false;
              yield* Ref.set(state, { ...current, current: null, unhealthy: true });
              yield* Scope.close(generationScope, Exit.void);
              return true;
            }),
          ),
        ),
        Effect.flatMap((recover) =>
          recover
            ? Effect.sleep("250 millis").pipe(
                Effect.andThen(acquire(true)),
                Effect.retry({
                  while: (error) => error.operation === "start",
                  schedule: Schedule.spaced("1 second"),
                }),
                Effect.catchCause(() =>
                  Effect.logWarning(
                    "Agent Runtime recovery paused after repeated failures; a later Agent action will retry",
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

  const close = gate
    .withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.closed) return false;
        // Quitting while quiet records that the next launch need not start execution. Reads
        // and observers in flight, such as the request that started the process, add no work.
        const quiescent =
          current.current !== null &&
          (yield* SubscriptionRef.get(usage)).writes === 0 &&
          (yield* isQuiescent(current.current.connection));
        yield* Ref.set(state, { ...current, closed: true, current: null });
        return quiescent;
      }),
    )
    .pipe(
      Effect.tap(() => Scope.close(ownerScope, Exit.void)),
      Effect.flatMap((quiescent) => (quiescent ? recordQuiescence : Effect.void)),
      Effect.andThen(publish({ status: "idle" })),
    );
  yield* Effect.addFinalizer(() => close);
  const get = () => touch.pipe(Effect.andThen(acquire(false)));
  const getUnlessQuiet = Effect.gen(function* () {
    if ((yield* Ref.get(state)).current) return yield* get();
    const required = options.quiescence
      ? yield* provide(options.quiescence.startRequired).pipe(
          Effect.catchCause(() => Effect.succeed(true)),
        )
      : true;
    return required ? yield* get() : null;
  });
  const withStopped = <A, E, R>(
    operation: Effect.Effect<A, E, R>,
    options: {
      readonly retireOnSuccess?: boolean;
      readonly expectedConnection?: AgentRuntimeProcessConnection;
    } = {},
  ) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed)
            return yield* new AgentRuntimeSupervisorError({ operation: "closed" });
          if (
            options.expectedConnection &&
            current.current?.connection !== options.expectedConnection
          )
            return yield* new AgentRuntimeSupervisorError({ operation: "generation-changed" });
          // Recovery observes the cleared identity after the gate opens and never restarts it.
          yield* Ref.set(state, { ...current, current: null });
          if (current.current) yield* Scope.close(current.current.scope, Exit.void);
          yield* publish({ status: "idle" });
          // The operation may replace the store; its contents are unknown until the next start.
          yield* clearQuiescence;
          const result = yield* operation;
          if (options.retireOnSuccess)
            yield* Ref.update(state, (current) => ({ ...current, closed: true }));
          return result;
        }),
      )
      .pipe(
        Effect.tap(() =>
          options.retireOnSuccess ? Scope.close(ownerScope, Exit.void) : Effect.void,
        ),
      );
  const request = Effect.fn("AgentRuntimeSupervisor.request")(function* <
    Method extends AgentRuntimeMethod,
  >(method: Method, input: AgentRuntimeOperations[Method]["input"]) {
    const connection = yield* get();
    return yield* connection.request(method, input);
  });
  return {
    get,
    /**
     * The process when it runs or its stopped store may hold live or pending work; null when
     * durable evidence proves there is nothing to resume, so recovery never starts it for nothing.
     */
    getUnlessQuiet,
    request,
    close,
    withStopped,
    /** Holds the process for the caller's Scope without starting it. */
    retain,
    /** Holds the process for the duration of `operation` without starting it. */
    retained: <A, E, R>(operation: Effect.Effect<A, E, R>) => tracked(operation),
    /** Holds the process like `retained` for a product write that may leave new work. */
    writing,
    inspect: Ref.get(state).pipe(
      Effect.map((current) => current.current?.connection.identity ?? null),
    ),
    connectionState: SubscriptionRef.get(connectionState),
    /** Current state followed by every transition. */
    connectionChanges: SubscriptionRef.changes(connectionState),
  };
});

export class AgentRuntimeSupervisor extends Context.Service<
  AgentRuntimeSupervisor,
  Effect.Success<ReturnType<typeof make<never>>>
>()("nodex/main/agent-runtime/AgentRuntimeSupervisor") {}

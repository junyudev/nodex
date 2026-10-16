import { Data, Deferred, Effect, FiberSet, Queue, Ref, Result } from "effect";
import { acquireIsolatedRunLease } from "../../src/main/core-client/isolated-run-ownership";
import { cleanupIsolatedCore, type IsolatedCoreCleanupStatus } from "../isolated-core-cleanup";
import type {
  IsolatedRunSupervisorDependencies,
  SuperviseIsolatedRunInput,
  SupervisedRunResult,
} from "../isolated-run-contract";

const DEFAULT_CORE_IDLE_TIMEOUT_MS = "30000";
const FOREGROUND_INTERRUPT_GRACE_MS = 1_500;
const FOREGROUND_TERMINATE_GRACE_MS = 1_500;
const FOREGROUND_KILL_GRACE_MS = 1_000;
const FOREGROUND_POLL_INTERVAL_MS = 25;
const DUPLICATE_SIGNAL_WINDOW_MS = 250;

type SupervisorSignal = "SIGINT" | "SIGTERM";
type SupervisedChildProcess = ReturnType<IsolatedRunSupervisorDependencies["spawnChild"]>;

interface ChildOutcome {
  readonly code: number | null;
  readonly error: Error | null;
  readonly signal: NodeJS.Signals | null;
}

interface IsolatedRunState {
  readonly child: SupervisedChildProcess | null;
  readonly childClosed: boolean;
  readonly cleanupAbandoned: boolean;
  readonly lastSignalAt: number | null;
  readonly requestedSignal: SupervisorSignal | null;
  readonly signalCount: number;
  readonly terminationActive: boolean;
  readonly terminationError: Error | null;
  readonly terminationStarted: boolean;
}

type SignalAction = "ForceExit" | "Ignore" | "Terminate";

export interface IsolatedRunExecution {
  readonly childError: Error | null;
  readonly cleanupReason: string | null;
  readonly foregroundTerminationError: Error | null;
  readonly result: SupervisedRunResult;
}

export interface IsolatedRunClock {
  readonly now: Effect.Effect<number, IsolatedRunFailure>;
  sleep(durationMs: number): Effect.Effect<void, IsolatedRunFailure>;
}

export interface IsolatedProcessGroup {
  isAlive(processGroupId: number): Effect.Effect<boolean, IsolatedRunFailure>;
  signal(processGroupId: number, signal: NodeJS.Signals): Effect.Effect<void, IsolatedRunFailure>;
}

export class IsolatedRunFailure extends Data.TaggedError("IsolatedRunFailure")<{
  readonly cause: unknown;
}> {}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const failure = (cause: unknown): IsolatedRunFailure => new IsolatedRunFailure({ cause });

const tryPromise = <A>(
  operation: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, IsolatedRunFailure> => Effect.tryPromise({ try: operation, catch: failure });

const trySync = <A>(operation: () => A): Effect.Effect<A, IsolatedRunFailure> =>
  Effect.try({ try: operation, catch: failure });

const signalExitCode = (signal: SupervisorSignal): number => (signal === "SIGINT" ? 130 : 143);

const childExitCode = (outcome: ChildOutcome, requestedSignal: SupervisorSignal | null): number => {
  if (requestedSignal) return signalExitCode(requestedSignal);
  if (outcome.code !== null) return outcome.code;
  if (outcome.signal === "SIGINT" || outcome.signal === "SIGTERM") {
    return signalExitCode(outcome.signal);
  }
  return 1;
};

const waitForChild = (child: SupervisedChildProcess): Effect.Effect<ChildOutcome> => {
  if (child.exitCode !== null || child.signalCode != null) {
    return Effect.succeed({ code: child.exitCode, error: null, signal: child.signalCode ?? null });
  }
  return Effect.callback<ChildOutcome>((resume) => {
    let spawnError: Error | null = null;
    const handleError = (error: Error): void => {
      spawnError = error;
    };
    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      resume(Effect.succeed({ code, error: spawnError, signal }));
    };
    child.once("error", handleError);
    child.once("close", handleClose);
    return Effect.sync(() => {
      child.off("error", handleError);
      child.off("close", handleClose);
    });
  });
};

export const waitForProcessGroupExit = (input: {
  readonly clock: IsolatedRunClock;
  readonly processGroup: IsolatedProcessGroup;
  readonly processGroupId: number;
  readonly timeoutMs: number;
}): Effect.Effect<boolean, IsolatedRunFailure> =>
  Effect.gen(function* () {
    const deadline = (yield* input.clock.now) + input.timeoutMs;
    while (yield* input.processGroup.isAlive(input.processGroupId)) {
      if ((yield* input.clock.now) >= deadline) return false;
      yield* input.clock.sleep(FOREGROUND_POLL_INTERVAL_MS);
    }
    return true;
  });

export const terminateForegroundProcessGroup = (input: {
  readonly clock: IsolatedRunClock;
  readonly processGroup: IsolatedProcessGroup;
  readonly processGroupId: number;
  readonly requestedSignal: SupervisorSignal;
}): Effect.Effect<void, IsolatedRunFailure> =>
  Effect.gen(function* () {
    const stages = [
      [input.requestedSignal, FOREGROUND_INTERRUPT_GRACE_MS],
      ["SIGTERM", FOREGROUND_TERMINATE_GRACE_MS],
      ["SIGKILL", FOREGROUND_KILL_GRACE_MS],
    ] as const;
    for (const [signal, timeoutMs] of stages) {
      const context = `Isolated foreground process group ${input.processGroupId} after ${signal}`;
      const delivery = yield* Effect.result(
        input.processGroup.signal(input.processGroupId, signal),
      );
      // macOS can reject a signal with EPERM while only unreaped zombies remain.
      // A failed signal is safe only once the existing probe confirms the group is gone.
      const exited = yield* waitForProcessGroupExit({ ...input, timeoutMs }).pipe(
        Effect.mapError((error) =>
          failure(
            new Error(`${context}: exit probe failed: ${asError(error.cause).message}`, {
              cause: error.cause,
            }),
          ),
        ),
      );
      if (exited) return;
      if (Result.isFailure(delivery)) {
        return yield* failure(
          new Error(`${context}: ${asError(delivery.failure.cause).message}`, {
            cause: delivery.failure.cause,
          }),
        );
      }
    }

    return yield* failure(
      new Error(
        `Timed out terminating isolated foreground process group ${input.processGroupId} after SIGKILL`,
      ),
    );
  });

const createClock = (dependencies: IsolatedRunSupervisorDependencies): IsolatedRunClock => ({
  now: trySync(dependencies.now),
  sleep: (durationMs) => tryPromise((signal) => dependencies.delay(durationMs, signal)),
});

const createProcessGroup = (
  dependencies: IsolatedRunSupervisorDependencies,
): IsolatedProcessGroup => ({
  isAlive: (processGroupId) => trySync(() => dependencies.isProcessGroupAlive(processGroupId)),
  signal: (processGroupId, signal) =>
    trySync(() => dependencies.signalProcessGroup(processGroupId, signal)),
});

const initialState: IsolatedRunState = {
  child: null,
  childClosed: false,
  cleanupAbandoned: false,
  lastSignalAt: null,
  requestedSignal: null,
  signalCount: 0,
  terminationActive: false,
  terminationError: null,
  terminationStarted: false,
};

export const superviseIsolatedRunEffect = (input: {
  readonly dependencies: IsolatedRunSupervisorDependencies;
  readonly nodexHome: string;
  readonly onCleanupAbandoned: (exitCode: number) => void;
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly runInput: SuperviseIsolatedRunInput;
}): Effect.Effect<IsolatedRunExecution, IsolatedRunFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const environment: NodeJS.ProcessEnv = {
        ...input.runInput.environment,
        NODEX_INTERNAL_ISOLATED_RUN_ID: input.runId,
        NODEX_CORE_IDLE_TIMEOUT_MS:
          input.runInput.environment.NODEX_CORE_IDLE_TIMEOUT_MS ?? DEFAULT_CORE_IDLE_TIMEOUT_MS,
      };
      const releaseLease = yield* Ref.make(false);
      const lease = yield* Effect.acquireRelease(
        trySync(() =>
          acquireIsolatedRunLease({
            nodexHome: input.nodexHome,
            runId: input.runId,
            supervisorPid: process.pid,
          }),
        ),
        (lease) =>
          Ref.get(releaseLease).pipe(
            Effect.andThen((shouldRelease) =>
              shouldRelease ? Effect.sync(() => lease.release()) : Effect.void,
            ),
          ),
      );
      const state = yield* Ref.make(initialState);
      // Only the first two non-duplicate signals have distinct semantics. A small sliding inbox
      // preserves the latest force-exit intent without letting a signal storm retain memory.
      const signalQueue = yield* Queue.sliding<SupervisorSignal>(8);
      const terminationDone = yield* Deferred.make<void>();
      const clock = createClock(input.dependencies);
      const processGroup = createProcessGroup(input.dependencies);

      const beginForegroundTermination = (requestedSignal: SupervisorSignal) =>
        Effect.gen(function* () {
          const processGroupId = yield* Ref.modify(state, (current) => {
            if (!current.child?.pid || current.childClosed || current.terminationStarted) {
              return [null, current] as const;
            }
            return [
              current.child.pid,
              { ...current, terminationActive: true, terminationStarted: true },
            ] as const;
          });
          if (processGroupId === null) return;

          yield* terminateForegroundProcessGroup({
            clock,
            processGroup,
            processGroupId,
            requestedSignal,
          }).pipe(
            Effect.catch((terminationFailure) =>
              Ref.update(state, (current) => ({
                ...current,
                terminationError: asError(terminationFailure.cause),
              })),
            ),
            Effect.ensuring(
              Ref.update(state, (current) => ({
                ...current,
                terminationActive: false,
              })).pipe(Effect.andThen(Deferred.succeed(terminationDone, undefined))),
            ),
            Effect.forkScoped,
          );
        });

      const processNextSignal = Effect.gen(function* () {
        const signal = yield* Queue.take(signalQueue);
        const observedAtResult = yield* Effect.result(clock.now);
        if (Result.isFailure(observedAtResult)) return;
        const observedAt = observedAtResult.success;
        const action = yield* Ref.modify<IsolatedRunState, SignalAction>(state, (current) => {
          if (
            current.lastSignalAt !== null &&
            observedAt - current.lastSignalAt <= DUPLICATE_SIGNAL_WINDOW_MS
          ) {
            return ["Ignore", current];
          }
          const signalCount = current.signalCount + 1;
          const next = {
            ...current,
            cleanupAbandoned: signalCount > 1 || current.cleanupAbandoned,
            lastSignalAt: observedAt,
            requestedSignal: current.requestedSignal ?? signal,
            signalCount,
          };
          if (signalCount === 1) return ["Terminate", next];
          return ["ForceExit", next];
        });
        if (action === "Ignore") return;
        if (action === "Terminate") {
          yield* beginForegroundTermination(signal);
          return;
        }

        const current = yield* Ref.get(state);
        if (current.child?.pid && (!current.childClosed || current.terminationActive)) {
          yield* processGroup.signal(current.child.pid, "SIGKILL").pipe(Effect.ignore);
        }
        yield* Effect.sync(() => input.onCleanupAbandoned(signalExitCode(signal)));
      });
      const signalWorker = Effect.forever(processNextSignal);

      const runCallback = yield* FiberSet.makeRuntime();
      const handleSigint = (): void => {
        runCallback(Queue.offer(signalQueue, "SIGINT"));
      };
      const handleSigterm = (): void => {
        runCallback(Queue.offer(signalQueue, "SIGTERM"));
      };
      yield* Effect.acquireRelease(
        trySync(() => {
          input.dependencies.signalSource.on("SIGINT", handleSigint);
          try {
            input.dependencies.signalSource.on("SIGTERM", handleSigterm);
          } catch (error) {
            input.dependencies.signalSource.off("SIGINT", handleSigint);
            throw error;
          }
        }),
        () =>
          Effect.sync(() => {
            input.dependencies.signalSource.off("SIGINT", handleSigint);
            input.dependencies.signalSource.off("SIGTERM", handleSigterm);
          }),
      );
      yield* Effect.forkScoped(signalWorker);

      const childPhase = yield* Effect.result(
        Effect.gen(function* () {
          if (input.runInput.prepare !== undefined) {
            yield* tryPromise(() => input.runInput.prepare!({ environment, runId: input.runId }));
          }
          const child = yield* trySync(() =>
            input.dependencies.spawnChild(
              input.runInput.command.command,
              input.runInput.command.args,
              {
                cwd: input.repositoryRoot,
                detached: true,
                env: environment,
                shell: false,
                stdio: "inherit",
              },
            ),
          );
          yield* Ref.update(state, (current) => ({ ...current, child }));
          yield* Effect.addFinalizer(() =>
            Ref.get(state).pipe(
              Effect.andThen((current) =>
                child.pid && !current.childClosed
                  ? processGroup.signal(child.pid, "SIGKILL").pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          );
          const requestedSignal = (yield* Ref.get(state)).requestedSignal;
          if (requestedSignal !== null) yield* beginForegroundTermination(requestedSignal);
          return yield* waitForChild(child);
        }),
      );
      const outcome: ChildOutcome = Result.isFailure(childPhase)
        ? { code: 1, error: asError(childPhase.failure.cause), signal: null }
        : childPhase.success;

      // Signal listeners enqueue synchronously; let their scoped worker publish
      // the requested shutdown before interpreting a simultaneously closed child.
      yield* Effect.yieldNow;
      const beforeCleanup = yield* Ref.get(state);
      if (
        !beforeCleanup.terminationStarted &&
        beforeCleanup.child?.pid &&
        (yield* processGroup.isAlive(beforeCleanup.child.pid))
      ) {
        yield* beginForegroundTermination(beforeCleanup.requestedSignal ?? "SIGTERM");
      }
      yield* Ref.update(state, (current) => ({ ...current, childClosed: true }));
      if ((yield* Ref.get(state)).terminationStarted) yield* Deferred.await(terminationDone);

      const cleanup = yield* tryPromise(() =>
        cleanupIsolatedCore({
          lease,
          nodexHome: input.nodexHome,
          releaseLeaseOnSuccess: false,
          runId: input.runId,
          dependencies: input.dependencies.cleanupDependencies,
        }),
      );
      const finalState = yield* Ref.get(state);
      const safeToDeleteRunRoot =
        cleanup.safeToDeleteRunRoot && !finalState.cleanupAbandoned && !finalState.terminationError;
      if (safeToDeleteRunRoot) yield* Ref.set(releaseLease, true);
      const observedChildExitCode = childExitCode(outcome, finalState.requestedSignal);
      return {
        childError: outcome.error,
        cleanupReason: cleanup.safeToDeleteRunRoot ? null : (cleanup.reason ?? cleanup.status),
        foregroundTerminationError: finalState.terminationError,
        result: {
          childExitCode:
            observedChildExitCode === 0 && !safeToDeleteRunRoot ? 1 : observedChildExitCode,
          cleanupStatus: cleanup.status as IsolatedCoreCleanupStatus,
          safeToDeleteRunRoot,
        },
      };
    }),
  );

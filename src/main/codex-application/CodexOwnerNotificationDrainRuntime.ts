import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import { CODEX_FRAME_TEXT_DELTA_FALLBACK_INTERVAL_MS } from "../../shared/codex-conversation-state/codex-frame-text-delta-queue";

export const DEFAULT_CODEX_OWNER_NOTIFICATION_DRAIN_TIMEOUT =
  CODEX_FRAME_TEXT_DELTA_FALLBACK_INTERVAL_MS * 8;

interface DrainBarrier {
  readonly sentSequence: number;
  readonly ackSequence: number;
  readonly completion: Deferred.Deferred<void, CodexOwnerNotificationDrainTimeout>;
}

interface DrainState {
  sentSequence: number;
  ackSequence: number;
  barrier: DrainBarrier | null;
}

export interface CodexOwnerNotificationDrainRuntimeOptions {
  readonly timeout?: Duration.Input;
}

export class CodexOwnerNotificationDrainTimeout extends Data.TaggedError(
  "CodexOwnerNotificationDrainTimeout",
)<{
  readonly conversationId: string;
  readonly sentSequence: number;
  readonly ackSequence: number;
}> {}

export class CodexOwnerNotificationDrainRuntime extends Context.Service<
  CodexOwnerNotificationDrainRuntime,
  {
    readonly next: (conversationId: string) => number;
    readonly canAck: (conversationId: string, sequence: number) => boolean;
    readonly ack: (conversationId: string, sequence: number) => boolean;
    readonly awaitCurrent: (
      conversationId: string,
    ) => Effect.Effect<void, CodexOwnerNotificationDrainTimeout>;
    readonly resetOwner: (conversationId: string) => void;
    readonly release: (conversationId: string) => void;
    readonly clear: (conversationId: string) => void;
  }
>()("nodex/main/codex-application/CodexOwnerNotificationDrainRuntime") {}

const emptyState = (): DrainState => ({
  sentSequence: 0,
  ackSequence: 0,
  barrier: null,
});

export const make = (
  options: CodexOwnerNotificationDrainRuntimeOptions = {},
): Effect.Effect<CodexOwnerNotificationDrainRuntime["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const states = new Map<string, DrainState>();
    const deadlines = yield* FiberMap.make<string, void, never>();
    const runDeadline = yield* FiberMap.runtime(deadlines)();

    const stateFor = (conversationId: string): DrainState => {
      const existing = states.get(conversationId);
      if (existing) return existing;
      const state = emptyState();
      states.set(conversationId, state);
      return state;
    };

    const finishBarrier = (
      conversationId: string,
      state: DrainState,
      completion: Effect.Effect<boolean>,
    ): void => {
      state.barrier = null;
      runDeadline(conversationId, completion.pipe(Effect.asVoid));
    };

    const awaitCurrent = (
      conversationId: string,
    ): Effect.Effect<void, CodexOwnerNotificationDrainTimeout> =>
      Effect.suspend(() => {
        const state = stateFor(conversationId);
        if (state.ackSequence >= state.sentSequence) return Effect.void;
        if (state.barrier) return Deferred.await(state.barrier.completion);

        return Deferred.make<void, CodexOwnerNotificationDrainTimeout>().pipe(
          Effect.tap((completion) =>
            Effect.sync(() => {
              const barrier: DrainBarrier = {
                sentSequence: state.sentSequence,
                ackSequence: state.ackSequence,
                completion,
              };
              state.barrier = barrier;
              runDeadline(
                conversationId,
                Effect.sleep(
                  options.timeout ?? DEFAULT_CODEX_OWNER_NOTIFICATION_DRAIN_TIMEOUT,
                ).pipe(
                  Effect.andThen(
                    Effect.suspend(() => {
                      if (state.barrier !== barrier) return Effect.void;
                      state.barrier = null;
                      const timeout = new CodexOwnerNotificationDrainTimeout({
                        conversationId,
                        sentSequence: barrier.sentSequence,
                        ackSequence: barrier.ackSequence,
                      });
                      return Effect.logWarning(
                        "Timed out waiting for renderer owner text-delta ack before terminal lifecycle",
                      ).pipe(
                        Effect.annotateLogs({
                          conversationId,
                          sentSequence: barrier.sentSequence,
                          ackSequence: barrier.ackSequence,
                        }),
                        Effect.andThen(Deferred.fail(completion, timeout)),
                        Effect.asVoid,
                      );
                    }),
                  ),
                ),
              );
            }),
          ),
          Effect.andThen((completion) => Deferred.await(completion)),
        );
      });

    const completeAndDelete = (conversationId: string, interrupt: boolean): void => {
      const state = states.get(conversationId);
      states.delete(conversationId);
      const barrier = state?.barrier;
      if (!barrier) {
        runDeadline(conversationId, Effect.void);
        return;
      }
      runDeadline(
        conversationId,
        (interrupt
          ? Deferred.interrupt(barrier.completion)
          : Deferred.succeed(barrier.completion, undefined)
        ).pipe(Effect.asVoid),
      );
    };

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const barriers = [...states.values()].flatMap((state) =>
          state.barrier ? [state.barrier] : [],
        );
        states.clear();
        yield* Effect.forEach(barriers, (barrier) => Deferred.interrupt(barrier.completion), {
          discard: true,
        });
      }),
    );

    return CodexOwnerNotificationDrainRuntime.of({
      next: (conversationId) => {
        const state = stateFor(conversationId);
        state.sentSequence += 1;
        return state.sentSequence;
      },
      canAck: (conversationId, sequence) => {
        const state = states.get(conversationId);
        if (!state) return false;
        return (
          Number.isSafeInteger(sequence) &&
          sequence > state.ackSequence &&
          sequence <= state.sentSequence
        );
      },
      ack: (conversationId, sequence) => {
        const state = states.get(conversationId);
        if (!state) return false;
        if (
          !Number.isSafeInteger(sequence) ||
          sequence <= state.ackSequence ||
          sequence > state.sentSequence
        ) {
          return false;
        }
        state.ackSequence = sequence;
        const barrier = state.barrier;
        if (!barrier || state.ackSequence < state.sentSequence) return true;
        finishBarrier(conversationId, state, Deferred.succeed(barrier.completion, undefined));
        return true;
      },
      awaitCurrent,
      resetOwner: (conversationId) => {
        const state = stateFor(conversationId);
        state.ackSequence = state.sentSequence;
        const barrier = state.barrier;
        if (!barrier) return;
        finishBarrier(conversationId, state, Deferred.succeed(barrier.completion, undefined));
      },
      release: (conversationId) => completeAndDelete(conversationId, false),
      clear: (conversationId) => completeAndDelete(conversationId, true),
    });
  });

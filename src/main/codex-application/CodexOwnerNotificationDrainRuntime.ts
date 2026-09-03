import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

// This is a cross-process liveness deadline, not a renderer frame/flush budget.
export const DEFAULT_CODEX_OWNER_NOTIFICATION_DRAIN_TIMEOUT = 30_000;

interface DrainState {
  sentSequence: number;
  ackSequence: number;
  changed: Deferred.Deferred<void, CodexOwnerNotificationDrainOwnerChanged>;
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
}> {
  override get message(): string {
    return "The conversation window did not finish synchronizing. Try the operation again.";
  }
}

export class CodexOwnerNotificationDrainOwnerChanged extends Data.TaggedError(
  "CodexOwnerNotificationDrainOwnerChanged",
)<{ readonly conversationId: string }> {
  override get message(): string {
    return "The conversation window changed before synchronization completed. Try the operation again.";
  }
}

export type CodexOwnerNotificationDrainError =
  | CodexOwnerNotificationDrainTimeout
  | CodexOwnerNotificationDrainOwnerChanged;

export class CodexOwnerNotificationDrainRuntime extends Context.Service<
  CodexOwnerNotificationDrainRuntime,
  {
    readonly next: (conversationId: string) => number;
    readonly canAck: (conversationId: string, sequence: number) => boolean;
    readonly ack: (conversationId: string, sequence: number) => boolean;
    readonly awaitCurrent: (
      conversationId: string,
    ) => Effect.Effect<void, CodexOwnerNotificationDrainError>;
    readonly resetOwner: (conversationId: string) => void;
    readonly release: (conversationId: string) => void;
    readonly clear: (conversationId: string) => void;
  }
>()("nodex/main/codex-application/CodexOwnerNotificationDrainRuntime") {}

const emptyState = (): DrainState => ({
  sentSequence: 0,
  ackSequence: 0,
  changed: Deferred.makeUnsafe<void, CodexOwnerNotificationDrainOwnerChanged>(),
});

export const make = (
  options: CodexOwnerNotificationDrainRuntimeOptions = {},
): Effect.Effect<CodexOwnerNotificationDrainRuntime["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const states = new Map<string, DrainState>();

    const stateFor = (conversationId: string): DrainState => {
      const existing = states.get(conversationId);
      if (existing) return existing;
      const state = emptyState();
      states.set(conversationId, state);
      return state;
    };

    const notifyProgress = (state: DrainState): void => {
      const changed = state.changed;
      state.changed = Deferred.makeUnsafe<void, CodexOwnerNotificationDrainOwnerChanged>();
      Deferred.doneUnsafe(changed, Effect.void);
    };

    const awaitPrefix = Effect.fn("CodexOwnerNotificationDrainRuntime.awaitPrefix")(function* (
      state: DrainState,
      sentSequence: number,
    ) {
      while (state.ackSequence < sentSequence) yield* Deferred.await(state.changed);
    });

    // Each caller owns its deadline and immutable prefix. Later notifications and canceled
    // callers cannot extend or shorten another operation's synchronization boundary.
    const awaitCurrent = (
      conversationId: string,
    ): Effect.Effect<void, CodexOwnerNotificationDrainError> =>
      Effect.suspend(() => {
        const state = states.get(conversationId);
        if (!state) return Effect.void;
        const sentSequence = state.sentSequence;
        if (state.ackSequence >= sentSequence) return Effect.void;
        return awaitPrefix(state, sentSequence).pipe(
          Effect.timeoutOrElse({
            duration: options.timeout ?? DEFAULT_CODEX_OWNER_NOTIFICATION_DRAIN_TIMEOUT,
            orElse: () => {
              const timeout = new CodexOwnerNotificationDrainTimeout({
                conversationId,
                sentSequence,
                ackSequence: state.ackSequence,
              });
              return Effect.logWarning(
                "Timed out waiting for conversation owner synchronization",
              ).pipe(
                Effect.annotateLogs({
                  conversationId,
                  sentSequence,
                  ackSequence: state.ackSequence,
                }),
                Effect.andThen(Effect.fail(timeout)),
              );
            },
          }),
        );
      });

    const completeAndDelete = (conversationId: string, interrupt: boolean): void => {
      const state = states.get(conversationId);
      states.delete(conversationId);
      if (!state) return;
      Deferred.doneUnsafe(
        state.changed,
        interrupt
          ? Effect.interrupt
          : Effect.fail(new CodexOwnerNotificationDrainOwnerChanged({ conversationId })),
      );
    };

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const completions = [...states.values()].map((state) => state.changed);
        states.clear();
        yield* Effect.forEach(completions, Deferred.interrupt, {
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
        notifyProgress(state);
        return true;
      },
      awaitCurrent,
      resetOwner: (conversationId) => {
        const previous = states.get(conversationId);
        const baseline = previous?.sentSequence ?? 0;
        completeAndDelete(conversationId, false);
        states.set(conversationId, {
          ...emptyState(),
          sentSequence: baseline,
          ackSequence: baseline,
        });
      },
      release: (conversationId) => completeAndDelete(conversationId, false),
      clear: (conversationId) => completeAndDelete(conversationId, true),
    });
  });

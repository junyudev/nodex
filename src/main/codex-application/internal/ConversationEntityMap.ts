import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import type { CodexApplicationProtocolOccurrence } from "../../codex-runtime/CodexApplicationRequestInbox";
import {
  makeConversationEntityStateRegistry,
  type ConversationEntityState,
  type ConversationEntityStateRegistry,
} from "./ConversationEntityState";

export class ConversationExecutionMoving extends Schema.TaggedError<ConversationExecutionMoving>()(
  "ConversationExecutionMoving",
  { threadId: Schema.String, reason: Schema.Literals(["moving", "recovery", "changed"]) },
) {
  override get message(): string {
    if (this.reason === "recovery") return "This chat’s workspace requires recovery";
    if (this.reason === "changed")
      return "The chat’s workspace changed. Prepare the request again.";
    return "This chat is moving to another workspace";
  }
}

interface ConversationExecutionAdmission {
  readonly assertExecutionAvailable: (
    threadId: string,
  ) => Effect.Effect<void, ConversationExecutionMoving>;
  readonly admitExecution: <A, E, R>(
    threadId: string,
    source: Pick<CodexApplicationProtocolOccurrence, "hostId" | "generation">,
    operation: Effect.Effect<A, E, R>,
    expectedEpoch?: number,
  ) => Effect.Effect<A, E | ConversationExecutionMoving, R>;
  readonly executionEpoch: (threadId: string) => Effect.Effect<number>;
  readonly setRecoveryRequired: (threadId: string, required: boolean) => Effect.Effect<void>;
  readonly withExecutionHandoff: <A, E, R>(
    threadId: string,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ConversationExecutionMoving, R>;
}

export class ConversationEntityMap extends Context.Service<
  ConversationEntityMap,
  ConversationExecutionAdmission & {
    readonly subscribeRetired: ConversationEntityStateRegistry["subscribeRetired"];
    readonly subscribeCanonicalMutations: ConversationEntityStateRegistry["subscribeCanonicalMutations"];
    readonly forHost: ConversationEntityStateRegistry["forHost"];
    readonly registerThreadMetadata: (thread: Thread) => void;
    readonly readThreadMetadata: (threadId: string) => Thread | null;
    /** Acquires the canonical semantic capability for one Thread generation. */
    readonly entity: (threadId: string) => ConversationEntityState;
    /** Pure query that never creates or resurrects a Thread generation. */
    readonly current: (threadId: string) => ConversationEntityState | null;
    /** Captures an existing native lifecycle; a utility command cannot create one. */
    readonly captureNativeTerminalTarget: (
      threadId: string,
      source: Pick<CodexApplicationProtocolOccurrence, "hostId" | "generation">,
    ) => number | null;
    /** Serializes complete application commands within the current Thread generation. */
    readonly runCommand: <A, E, R>(
      threadId: string,
      operation: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Serializes a global observation without materializing or reviving a native lifecycle. */
    readonly runThreadObservation: <A, E, R>(
      threadId: string,
      operation: Effect.Effect<A, E, R>,
      terminal?: { readonly generation: number; readonly isTerminal: (result: A) => boolean },
    ) => Effect.Effect<A, E, R>;
    /** Seals a terminal command's generation before releasing its permit, then retires it. */
    readonly runTerminalCommand: <A, E, R>(
      threadId: string,
      operation: Effect.Effect<A, E, R>,
      isTerminal: (result: A) => boolean,
    ) => Effect.Effect<A, E, R>;
    /** Marks every loaded Thread non-live after the app-server connection is lost. */
    readonly markAllNeedsResume: () => readonly string[];
    /** Closes the exact live generation and interrupts its active or queued commands. */
    readonly retire: (threadId: string) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/internal/ConversationEntityMap") {}

class ConversationCausalLane extends Context.Service<
  ConversationCausalLane,
  {
    readonly generation: number;
    readonly forkExclusive: <A, E, R>(
      operation: Effect.Effect<A, E, R>,
      isTerminal?: (result: A) => boolean,
    ) => Effect.Effect<Fiber.Fiber<A, E>, never, R>;
    readonly assertExecutionAvailable: Effect.Effect<void, ConversationExecutionMoving>;
    readonly forkExecution: <A, E, R>(
      operation: Effect.Effect<A, E, R>,
      source: Pick<CodexApplicationProtocolOccurrence, "hostId" | "generation">,
      expectedEpoch?: number,
    ) => Effect.Effect<Fiber.Fiber<A, E | ConversationExecutionMoving>, never, R>;
    readonly executionEpoch: Effect.Effect<number>;
    readonly forkExecutionHandoff: <A, E, R>(
      operation: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Fiber.Fiber<A, E | ConversationExecutionMoving>, never, R>;
  }
>()("nodex/main/codex-application/ConversationCausalLane") {}

const causalLaneLayer = (
  threadId: string,
  aggregates: ConversationEntityStateRegistry,
  recoveryRequired: ReadonlySet<string>,
  nextExecutionEpoch: () => number,
): Layer.Layer<ConversationCausalLane> =>
  Layer.effect(
    ConversationCausalLane,
    Effect.gen(function* () {
      const generation = aggregates.reserveGeneration(threadId);
      const semaphore = yield* Semaphore.make(1);
      const executionAdmissions = yield* Semaphore.make(1);
      const ownerScope = yield* Effect.scope;
      let executionMoving = false;
      let executionEpoch = nextExecutionEpoch();
      let sealed = false;
      const isCurrent = () => !sealed && aggregates.isCurrentGeneration(threadId, generation);

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => aggregates.releaseGeneration(threadId, generation)),
      );
      const forkOwned = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => (isCurrent() ? operation : Effect.interrupt)).pipe(
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );

      const assertExecutionAvailable = Effect.suspend(() =>
        executionMoving || recoveryRequired.has(threadId)
          ? Effect.fail(
              new ConversationExecutionMoving({
                threadId,
                reason: recoveryRequired.has(threadId) ? "recovery" : "moving",
              }),
            )
          : Effect.void,
      );

      const forkExecution = <A, E, R>(
        operation: Effect.Effect<A, E, R>,
        source: Pick<CodexApplicationProtocolOccurrence, "hostId" | "generation">,
        expectedEpoch?: number,
      ): Effect.Effect<Fiber.Fiber<A, E | ConversationExecutionMoving>, never, R> =>
        forkOwned(
          executionAdmissions.withPermit(
            Effect.suspend(() => (isCurrent() ? assertExecutionAvailable : Effect.interrupt)).pipe(
              Effect.andThen(
                Effect.suspend((): Effect.Effect<A, E | ConversationExecutionMoving, R> =>
                  expectedEpoch !== undefined && expectedEpoch !== executionEpoch
                    ? Effect.fail(new ConversationExecutionMoving({ threadId, reason: "changed" }))
                    : Effect.acquireUseRelease(
                        Effect.sync(() =>
                          aggregates.acquire(threadId).retainNativeExecution(source),
                        ),
                        () => operation,
                        (lease) => Effect.sync(() => lease[Symbol.dispose]()),
                      ),
                ),
              ),
            ),
          ),
        );

      return ConversationCausalLane.of({
        generation,
        forkExclusive: (operation, isTerminal) =>
          forkOwned(
            semaphore.withPermit(
              Effect.suspend(() => {
                if (!isCurrent()) return Effect.interrupt;
                if (!isTerminal) return operation;
                return operation.pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (Exit.isSuccess(exit) && isTerminal(exit.value)) sealed = true;
                    }),
                  ),
                );
              }),
            ),
          ),
        assertExecutionAvailable,
        executionEpoch: Effect.sync(() => executionEpoch),
        forkExecution,
        // Drain requests already admitted before sealing new execution. The command lane remains
        // available to interruption, relocation and rollback inside the handoff transaction.
        forkExecutionHandoff: (operation) =>
          forkOwned(
            Effect.acquireUseRelease(
              Effect.acquireUseRelease(
                // Only waiting for the drained permit is cancellable. Once acquired, publishing
                // moving and installing its rollback remain inside the outer acquisition mask.
                executionAdmissions.take(1).pipe(Effect.interruptible),
                () =>
                  Effect.suspend(() =>
                    !isCurrent()
                      ? Effect.interrupt
                      : executionMoving
                        ? Effect.fail(
                            new ConversationExecutionMoving({ threadId, reason: "moving" }),
                          )
                        : Effect.void,
                  ).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        executionMoving = true;
                        executionEpoch = nextExecutionEpoch();
                      }),
                    ),
                  ),
                () => executionAdmissions.release(1).pipe(Effect.asVoid),
              ),
              () => operation,
              () =>
                Effect.sync(() => {
                  executionMoving = false;
                }),
            ),
          ),
      });
    }),
  );

/**
 * Profile-scoped owner of private Thread entities and their single causal command lanes.
 * A lane is cached until explicit Thread close or Main Scope close; no consumer can observe its
 * semaphore, Scope, or lifecycle bookkeeping.
 */
export const live: Layer.Layer<ConversationEntityMap> = Layer.effect(
  ConversationEntityMap,
  Effect.gen(function* () {
    const profileScope = yield* Effect.scope;
    const aggregates = makeConversationEntityStateRegistry();
    const recoveryRequired = new Set<string>();
    let executionEpoch = 0;
    yield* Effect.addFinalizer(() => Effect.sync(aggregates.releaseAll));
    const lanes = yield* LayerMap.make(
      (threadId: string) =>
        causalLaneLayer(threadId, aggregates, recoveryRequired, () => ++executionEpoch),
      { idleTimeToLive: Duration.infinity },
    );

    // Read-only lane queries need no retained borrow after acquiring their capability.
    const lane = (threadId: string): Effect.Effect<ConversationCausalLane["Service"]> =>
      Effect.scoped(
        lanes
          .contextEffect(threadId)
          .pipe(Effect.map((context) => Context.get(context, ConversationCausalLane))),
      );

    // Register the fiber while its lane is borrowed, then release the borrow before joining it.
    // Retirement can interrupt admitted work without a close racing an unregistered fiber.
    const forkInLane = <A, E, R>(
      threadId: string,
      fork: (
        lane: ConversationCausalLane["Service"],
        acceptedTerminal: () => void,
      ) => Effect.Effect<Fiber.Fiber<A, E>, never, R>,
    ) =>
      Effect.contextWith((callerContext: Context.Context<R>) => {
        let terminal = false;
        return Effect.scoped(
          lanes.contextEffect(threadId).pipe(
            Effect.map((context) => Context.get(context, ConversationCausalLane)),
            Effect.flatMap((current) =>
              fork(current, () => {
                terminal = true;
              }).pipe(
                Effect.provideContext(callerContext),
                Effect.map((fiber) => ({
                  fiber,
                  generation: current.generation,
                  acceptedTerminal: () => terminal,
                })),
              ),
            ),
          ),
        );
      });
    const retireGeneration = (threadId: string, generation: number) =>
      Effect.suspend(() => {
        if (!aggregates.isCurrentGeneration(threadId, generation)) return Effect.void;
        // Invalidation removes the key before old fiber cleanup settles. Publish retirement first
        // so a replacement lookup cannot inherit the old aggregate during that asynchronous close.
        aggregates.releaseGeneration(threadId, generation);
        return lanes.invalidate(threadId);
      });
    const runInLane = <A, E, R>(
      threadId: string,
      fork: (
        lane: ConversationCausalLane["Service"],
        acceptedTerminal: () => void,
      ) => Effect.Effect<Fiber.Fiber<A, E>, never, R>,
    ) =>
      Effect.acquireUseRelease(
        forkInLane(threadId, fork),
        ({ fiber }) => Fiber.join(fiber),
        ({ fiber, generation, acceptedTerminal }) =>
          (acceptedTerminal() ? Fiber.await(fiber) : Fiber.interrupt(fiber)).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                acceptedTerminal() ? retireGeneration(threadId, generation) : Effect.void,
              ),
            ),
          ),
      );

    const runThreadObservation = <A, E, R>(
      threadId: string,
      operation: Effect.Effect<A, E, R>,
      terminal?: { readonly generation: number; readonly isTerminal: (result: A) => boolean },
    ): Effect.Effect<A, E, R> => {
      const attempt = (): Effect.Effect<A, E, R> => {
        let entered = false;
        let admittedGeneration: number | undefined;
        return runInLane(threadId, (current, acceptedTerminal) => {
          admittedGeneration = current.generation;
          const ownsTarget = terminal?.generation === current.generation;
          return current.forkExclusive(
            Effect.suspend(() => {
              entered = true;
              return operation;
            }),
            ownsTarget
              ? (result) => {
                  const accepted = terminal.isTerminal(result);
                  if (accepted) acceptedTerminal();
                  return accepted;
                }
              : undefined,
          );
        }).pipe(
          Effect.catchCause((cause) =>
            !entered &&
            admittedGeneration !== undefined &&
            !aggregates.isCurrentGeneration(threadId, admittedGeneration) &&
            profileScope.state._tag !== "Closed" &&
            Cause.hasInterruptsOnly(cause)
              ? Effect.suspend(attempt)
              : Effect.failCause(cause),
          ),
        );
      };
      return Effect.suspend(attempt);
    };

    return ConversationEntityMap.of({
      subscribeRetired: aggregates.subscribeRetired,
      subscribeCanonicalMutations: aggregates.subscribeCanonicalMutations,
      forHost: aggregates.forHost,
      registerThreadMetadata: aggregates.registerThreadMetadata,
      readThreadMetadata: aggregates.readThreadMetadata,
      entity: aggregates.acquire,
      current: aggregates.current,
      captureNativeTerminalTarget: (threadId, source) => {
        const target = aggregates.current(threadId);
        return target?.hasNativeLifecycle(source) ? target.generation : null;
      },
      runCommand: (threadId, operation) =>
        runInLane(threadId, (current) => current.forkExclusive(operation)),
      runThreadObservation,
      runTerminalCommand: (threadId, operation, isTerminal) =>
        runInLane(threadId, (current, acceptedTerminal) =>
          current.forkExclusive(operation, (result) => {
            const terminal = isTerminal(result);
            if (terminal) acceptedTerminal();
            return terminal;
          }),
        ),
      assertExecutionAvailable: (threadId) =>
        lane(threadId).pipe(Effect.flatMap((current) => current.assertExecutionAvailable)),
      admitExecution: (threadId, source, operation, expectedEpoch) =>
        runInLane(threadId, (current) => current.forkExecution(operation, source, expectedEpoch)),
      executionEpoch: (threadId) =>
        lane(threadId).pipe(Effect.flatMap((current) => current.executionEpoch)),
      setRecoveryRequired: (threadId, required) =>
        Effect.sync(() => {
          if (required) recoveryRequired.add(threadId);
          else recoveryRequired.delete(threadId);
        }),
      withExecutionHandoff: (threadId, operation) =>
        runInLane(threadId, (current) => current.forkExecutionHandoff(operation)),
      markAllNeedsResume: aggregates.markAllNeedsResume,
      retire: (threadId) => {
        const generation = aggregates.currentGeneration(threadId);
        if (generation !== undefined) return retireGeneration(threadId, generation);
        return Effect.suspend(() => {
          if (aggregates.currentGeneration(threadId) !== undefined) return Effect.void;
          aggregates.removeThreadMetadata(threadId);
          return lanes.invalidate(threadId);
        });
      },
    });
  }),
);

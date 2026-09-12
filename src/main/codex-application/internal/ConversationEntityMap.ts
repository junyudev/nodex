import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Semaphore from "effect/Semaphore";
import {
  makeConversationEntityStateRegistry,
  type ConversationEntityState,
  type ConversationEntityStateRegistry,
} from "./ConversationEntityState";

export class ConversationEntityMap extends Context.Service<
  ConversationEntityMap,
  {
    readonly subscribeRetired: ConversationEntityStateRegistry["subscribeRetired"];
    readonly subscribeCanonicalMutations: ConversationEntityStateRegistry["subscribeCanonicalMutations"];
    readonly forHost: ConversationEntityStateRegistry["forHost"];
    readonly registerThreadMetadata: (thread: Thread) => void;
    readonly readThreadMetadata: (threadId: string) => Thread | null;
    /** Acquires the canonical semantic capability for one Thread generation. */
    readonly entity: (threadId: string) => ConversationEntityState;
    /** Pure query that never creates or resurrects a Thread generation. */
    readonly current: (threadId: string) => ConversationEntityState | null;
    /** Serializes complete application commands within the current Thread generation. */
    readonly runCommand: <A, E, R>(
      threadId: string,
      operation: Effect.Effect<A, E, R>,
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
    readonly runExclusive: <A, E, R>(operation: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("nodex/main/codex-application/ConversationCausalLane") {}

const causalLaneLayer = (
  threadId: string,
  aggregates: ConversationEntityStateRegistry,
): Layer.Layer<ConversationCausalLane> =>
  Layer.effect(
    ConversationCausalLane,
    Effect.gen(function* () {
      const generation = aggregates.acquire(threadId).generation;
      const semaphore = yield* Semaphore.make(1);
      const ownerScope = yield* Effect.scope;

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => aggregates.releaseGeneration(threadId, generation)),
      );

      const runExclusive = <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.acquireUseRelease(
          semaphore
            .withPermit(operation)
            .pipe(Effect.forkIn(ownerScope, { startImmediately: true })),
          Fiber.join,
          Fiber.interrupt,
        );

      return ConversationCausalLane.of({ runExclusive });
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
    const aggregates = makeConversationEntityStateRegistry();
    yield* Effect.addFinalizer(() => Effect.sync(aggregates.releaseAll));
    const lanes = yield* LayerMap.make(
      (threadId: string) => causalLaneLayer(threadId, aggregates),
      { idleTimeToLive: Duration.infinity },
    );

    // Release the RcMap borrow before running the command. The cached lane owns the command fiber,
    // so explicit invalidation can close that owner Scope instead of waiting on its own borrower.
    const lane = (threadId: string): Effect.Effect<ConversationCausalLane["Service"]> =>
      Effect.scoped(
        lanes
          .contextEffect(threadId)
          .pipe(Effect.map((context) => Context.get(context, ConversationCausalLane))),
      );

    return ConversationEntityMap.of({
      subscribeRetired: aggregates.subscribeRetired,
      subscribeCanonicalMutations: aggregates.subscribeCanonicalMutations,
      forHost: aggregates.forHost,
      registerThreadMetadata: aggregates.registerThreadMetadata,
      readThreadMetadata: aggregates.readThreadMetadata,
      entity: aggregates.acquire,
      current: aggregates.current,
      runCommand: (threadId, operation) =>
        lane(threadId).pipe(Effect.flatMap((current) => current.runExclusive(operation))),
      markAllNeedsResume: aggregates.markAllNeedsResume,
      retire: (threadId) => {
        const generation = aggregates.current(threadId)?.generation;
        return lanes
          .invalidate(threadId)
          .pipe(
            Effect.ensuring(
              generation === undefined
                ? Effect.sync(() => aggregates.removeThreadMetadata(threadId))
                : Effect.sync(() => aggregates.releaseGeneration(threadId, generation)),
            ),
          );
      },
    });
  }),
);

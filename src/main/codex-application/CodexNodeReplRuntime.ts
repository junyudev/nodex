import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodexEndpointMap } from "../codex-runtime/CodexEndpointMap";
import { cleanupNodeReplExecutions } from "../platform/node/CodexNodeReplCleanup";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import type { ConversationEntityState } from "./internal/ConversationEntityState";

export class NodeReplCleanupError extends Schema.TaggedError<NodeReplCleanupError>()(
  "NodeReplCleanupError",
  { cause: Schema.Defect() },
) {}
export class CodexNodeReplRuntime extends Context.Service<
  CodexNodeReplRuntime,
  {
    readonly cleanup: (
      hostId: string,
      sessionId: string,
      turnId: string,
      expectedGeneration?: number,
    ) => Effect.Effect<void>;
    readonly cleanupForOwner: (
      hostId: string,
      threadId: string,
      turnId: string,
      peerId: string | null,
    ) => Effect.Effect<void, NodeReplCleanupError>;
  }
>()("nodex/main/codex-application/CodexNodeReplRuntime") {}

/** Cleanup is bounded and best effort; failure must not prevent a native interrupt. */
export const make = Effect.gen(function* () {
  const endpoints = yield* CodexEndpointMap;
  const managers = yield* CodexMainConversationManagers;
  const entities = yield* ConversationEntityMap;
  const runCleanup = Effect.fn("CodexNodeReplRuntime.runCleanup")(
    function* (
      hostId: string,
      sessionId: string,
      turnId: string,
      manager: MainConversationManager,
      generation: number,
      admitted?: { readonly threadId: string; readonly entity: ConversationEntityState },
    ) {
      if (hostId !== endpoints.localHostId) return;
      const invalidated = () =>
        new NodeReplCleanupError({
          cause: new Error("Node execution cleanup lifetime ended"),
        });
      const assertCurrent = () => {
        manager.assertCurrent(generation);
        if (!admitted) return;
        const state = admitted.entity.readCanonicalState();
        if (
          entities.current(admitted.threadId) !== admitted.entity ||
          state?.hostId !== hostId ||
          state.sessionId !== sessionId
        )
          throw invalidated();
      };
      const check = Effect.try({
        try: assertCurrent,
        catch: (cause) => new NodeReplCleanupError({ cause }),
      });
      const operation = Effect.gen(function* () {
        yield* check;
        const endpoint = yield* endpoints.endpoint(hostId);
        yield* check;
        const session = yield* endpoint.session;
        yield* check;
        if (session.hostId !== hostId || session.generation !== generation)
          return yield* invalidated();
        const execute = Effect.tryPromise({
          try: (signal) =>
            cleanupNodeReplExecutions({
              codexHome: session.initialize.codexHome,
              sessionId,
              turnId,
              signal,
            }),
          catch: (cause) => new NodeReplCleanupError({ cause }),
        });
        const result = yield* Effect.raceFirst(session.termination, execute);
        yield* check;
        if (result.failedCount > 0)
          yield* Effect.logWarning("Failed to kill some active node_repl executions").pipe(
            Effect.annotateLogs({ sessionId, turnId, failedCount: result.failedCount }),
          );
      });
      // Borrow the existing owners in one operation Scope; cancellation reaches the Node signal.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const subscriptions: Disposable[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const subscription of subscriptions) subscription[Symbol.dispose]();
            }),
          );
          const retired = Effect.callback<never, NodeReplCleanupError>((resume) => {
            const cancel = () => resume(Effect.fail(invalidated()));
            try {
              subscriptions.push(manager.onConnectionReset(cancel));
              subscriptions.push(manager.onDispose(cancel));
              if (admitted)
                subscriptions.push(
                  entities.subscribeRetired((id, generation) => {
                    if (id === admitted.threadId && generation === admitted.entity.generation)
                      cancel();
                  }),
                );
              assertCurrent();
            } catch (cause) {
              resume(Effect.fail(new NodeReplCleanupError({ cause })));
            }
          });
          yield* Effect.raceFirst(retired, operation);
        }),
      );
    },
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) =>
      cause instanceof NodeReplCleanupError ? cause : new NodeReplCleanupError({ cause }),
    ),
  );
  const cleanup = Effect.fn("CodexNodeReplRuntime.cleanup")(
    function* (hostId: string, sessionId: string, turnId: string, expectedGeneration?: number) {
      if (hostId !== endpoints.localHostId) return;
      const manager = yield* managers.get(hostId);
      yield* runCleanup(
        hostId,
        sessionId,
        turnId,
        manager,
        expectedGeneration ?? manager.generation,
      );
    },
    Effect.catch((cause) =>
      Effect.logWarning("Failed to clean active node_repl executions").pipe(
        Effect.annotateLogs({ cause }),
      ),
    ),
  );
  const cleanupForOwner = Effect.fn("CodexNodeReplRuntime.cleanupForOwner")(
    function* (hostId: string, threadId: string, turnId: string, peerId: string | null) {
      const manager = yield* managers.get(hostId);
      const generation = manager.generation;
      const entity = entities.current(threadId);
      const ownerId = yield* Effect.tryPromise({
        try: () => manager.findOwner(threadId),
        catch: (cause) => new NodeReplCleanupError({ cause }),
      });
      yield* Effect.try(() => manager.assertCurrent(generation));
      const state = entity?.readCanonicalState();
      if (
        !entity ||
        !peerId ||
        ownerId !== peerId ||
        entities.current(threadId) !== entity ||
        state?.hostId !== hostId ||
        !state.sessionId
      )
        return yield* new NodeReplCleanupError({
          cause: new Error("Node execution cleanup requires the current conversation owner"),
        });
      yield* runCleanup(hostId, state.sessionId, turnId, manager, generation, { threadId, entity });
    },
    Effect.mapError((cause) =>
      cause instanceof NodeReplCleanupError ? cause : new NodeReplCleanupError({ cause }),
    ),
  );
  return CodexNodeReplRuntime.of({
    cleanup,
    cleanupForOwner,
  });
});

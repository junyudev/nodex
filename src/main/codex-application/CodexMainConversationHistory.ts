import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { ConversationStreamRole } from "../../shared/codex-conversation-stream";
import {
  canonicalHistoryPermissionContext,
  createCodexCanonicalHydratedConversationState,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  CanonicalCompleteHistoryLoader,
  hasCompleteCanonicalConversationHistory,
} from "../../shared/codex-conversation-state/codex-complete-history-loader";
import type { CanonicalHistoryClient } from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexMainConversationManagers,
  MainConversationManagerError,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import type { ConversationEntityState } from "./internal/ConversationEntityState";

interface HistoryLifetime {
  readonly manager: MainConversationManager;
  readonly entity: ConversationEntityState;
  readonly owner: ConversationStreamRole;
  readonly generation: number;
}

interface HistoryLoaderEntry {
  readonly lifetime: HistoryLifetime;
  readonly loader: CanonicalCompleteHistoryLoader;
  readonly dispose: () => void;
}

export class CodexMainConversationHistory extends Context.Service<
  CodexMainConversationHistory,
  {
    readonly loadComplete: (
      hostId: string,
      conversationId: string,
    ) => Effect.Effect<number, MainConversationManagerError>;
  }
>()("nodex/main/codex-application/CodexMainConversationHistory") {}

/** Native history writes the Main owner's document through the same draft loaders as a window. */
export const make = Effect.gen(function* () {
  const managers = yield* CodexMainConversationManagers;
  const entities = yield* ConversationEntityMap;
  const gateway = yield* CodexGateway;
  const capabilities = yield* CodexAppServerCapabilities;
  const callbacks = yield* ScopedCallbackRuntime;
  const loaders = new Map<MainConversationManager, Map<string, HistoryLoaderEntry>>();
  const assertLifetime = ({ manager, entity, owner, generation }: HistoryLifetime): void => {
    manager.assertCurrent(generation);
    if (
      entities.current(entity.threadId) !== entity ||
      entity.readCanonicalState()?.hostId !== manager.hostId ||
      owner.role !== "owner" ||
      manager.stream.getRole(entity.threadId) !== owner
    )
      throw new Error("Complete history no longer belongs to the admitted conversation owner");
  };
  const checkLifetime = (lifetime: HistoryLifetime) =>
    Effect.try({
      try: () => assertLifetime(lifetime),
      catch: (cause) =>
        new MainConversationManagerError({ hostId: lifetime.manager.hostId, cause }),
    });
  const createLoader = (lifetime: HistoryLifetime) =>
    Effect.gen(function* () {
      yield* checkLifetime(lifetime);
      const { manager, entity, generation: nativeGeneration } = lifetime;
      const existing = loaders.get(manager)?.get(entity.threadId);
      if (
        existing?.lifetime.entity === entity &&
        existing.lifetime.owner === lifetime.owner &&
        existing.lifetime.generation === nativeGeneration
      )
        return existing.loader;
      existing?.dispose();
      const capability = yield* capabilities.forHost(manager.hostId);
      yield* checkLifetime(lifetime);
      const readConversation = (id: string) => {
        assertLifetime(lifetime);
        if (id !== entity.threadId) throw new Error("History loader conversation mismatch");
        return entity.readCanonicalState();
      };
      const client: CanonicalHistoryClient = {
        hostId: manager.hostId,
        supportsPaginatedHistory: () => capability.flags.paginatedHistory,
        getConversation: readConversation,
        sendRequest: (method, params, options) => {
          assertLifetime(lifetime);
          return callbacks
            .runPromise(
              checkLifetime(lifetime).pipe(
                Effect.andThen(
                  gateway.requestOnHost(manager.hostId, method, params, {
                    priority: options?.priority,
                    timeoutMs: options?.timeoutMs,
                    source: options?.source,
                    expectedHostId: manager.hostId,
                    expectedGeneration: nativeGeneration,
                  }),
                ),
              ),
            )
            .then((response) => {
              assertLifetime(lifetime);
              return response;
            });
        },
        updateConversation: (id, recipe, broadcast = true) => {
          readConversation(id);
          entity.mutateCanonicalState(recipe, Date.now(), broadcast);
        },
        broadcastSnapshot: (id) => {
          readConversation(id);
          manager.stream.broadcastSnapshot(id);
        },
        mapTurns: (id, turns, pagination) => {
          const state = readConversation(id);
          const metadata = entities.readThreadMetadata(id);
          const context = state?.hydrationContext;
          if (!state || !metadata || !context || !state.currentPermissions)
            throw new Error("History hydration context unavailable");
          return residentConversationTurns(
            createCodexCanonicalHydratedConversationState(
              { ...metadata, turns: [...turns] },
              {
                hostId: manager.hostId,
                model: context.model,
                reasoningEffort: context.reasoningEffort,
                cwd: context.cwd ?? metadata.cwd ?? "/",
                ...canonicalHistoryPermissionContext(state.currentPermissions),
                latestThreadSettings: context.latestThreadSettings,
                turnItemsPaginationById: pagination,
                pendingRequests: state.requests,
                hasUnreadTurn: state.hasUnreadTurn,
              },
            ),
          );
        },
      };
      const loader = new CanonicalCompleteHistoryLoader(client);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        connectionReset[Symbol.dispose]();
        disposal[Symbol.dispose]();
        retirement[Symbol.dispose]();
        loader[Symbol.dispose]();
        const entries = loaders.get(manager);
        if (entries?.get(entity.threadId)?.loader === loader) entries.delete(entity.threadId);
        if (entries?.size === 0) loaders.delete(manager);
      };
      const connectionReset = manager.onConnectionReset(dispose);
      const disposal = manager.onDispose(dispose);
      const retirement = entities.subscribeRetired((id, generation) => {
        if (id === entity.threadId && generation === entity.generation) dispose();
      });
      let entries = loaders.get(manager);
      if (!entries) {
        entries = new Map();
        loaders.set(manager, entries);
      }
      entries.set(entity.threadId, { lifetime, loader, dispose });
      return loader;
    });
  const acquisitionLocks = new WeakMap<MainConversationManager, Semaphore.Semaphore>();
  const acquire = Effect.fn("CodexMainConversationHistory.acquire")(function* (
    lifetime: HistoryLifetime,
  ) {
    const { manager } = lifetime;
    let lock = acquisitionLocks.get(manager);
    if (!lock) {
      lock = yield* Semaphore.make(1);
      acquisitionLocks.set(manager, lock);
    }
    return yield* lock.withPermit(createLoader(lifetime));
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entries of loaders.values()) for (const entry of entries.values()) entry.dispose();
    }),
  );
  return CodexMainConversationHistory.of({
    loadComplete: (hostId, conversationId) =>
      Effect.gen(function* () {
        const manager = yield* managers.get(hostId);
        const owner = manager.stream.getRole(conversationId);
        const entity = entities.current(conversationId);
        if (owner?.role !== "owner" || !entity)
          return yield* new MainConversationManagerError({
            hostId,
            cause: new Error("no-client-found: thread stream owner became unavailable"),
          });
        const lifetime: HistoryLifetime = {
          manager,
          entity,
          owner,
          generation: manager.generation,
        };
        yield* checkLifetime(lifetime);
        const before = entity.readCanonicalState();
        const complete = before ? hasCompleteCanonicalConversationHistory(before) : false;
        const beforeRevision = manager.stream.getRevision(conversationId);
        const loader = yield* acquire(lifetime);
        yield* Effect.tryPromise({
          try: () => loader.load(conversationId),
          catch: (cause) => new MainConversationManagerError({ hostId, cause }),
        });
        yield* checkLifetime(lifetime);
        const afterRevision = manager.stream.getRevision(conversationId);
        const revision =
          !complete && afterRevision !== null && afterRevision > (beforeRevision ?? 0)
            ? afterRevision
            : manager.stream.broadcastSnapshot(conversationId);
        if (revision === null)
          return yield* new MainConversationManagerError({
            hostId,
            cause: new Error("no-client-found: thread stream owner became unavailable"),
          });
        return revision;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof MainConversationManagerError
            ? cause
            : new MainConversationManagerError({ hostId, cause }),
        ),
      ),
  });
});

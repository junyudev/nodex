import { parseCodexAppServerMessage } from "../codex/codex-app-server-message-parser";
import {
  CanonicalConversationRetention,
  shouldKeepCanonicalConversationLoaded,
} from "../../shared/codex-canonical-retention";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { applyPatches, type Patch } from "immer";
import type { CodexCanonicalConversationState } from "../../shared/types";
import type {
  ConversationCoordinationHost,
  ConversationCoordinationEvent,
  ConversationFollowerRequest,
} from "../../shared/codex-client-coordination";
import { ConversationCoordinationViewTarget } from "../../shared/codex-coordination-view";
import {
  ConversationStream,
  type ConversationStreamRole,
} from "../../shared/codex-conversation-stream";
import { createConversationStreamServiceTransport } from "../../shared/codex-stream-service-transport";
import { receiveConversationStreamServiceEvent } from "../../shared/codex-stream-service-events";
import { threadReadStateIdentityKey } from "../codex/thread-read-state-identity";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexConversationPeerRuntime } from "../platform/node/CodexConversationPeerRuntime";
import { connectCoordinationPeer } from "../platform/node/CodexCoordinationPeer";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { CodexThreadReadState } from "./CodexThreadReadState";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import type { ThreadReadStateContext } from "../../shared/codex-thread-read-state";

export class MainConversationManagerError extends Data.TaggedError("MainConversationManagerError")<{
  readonly hostId: string;
  readonly cause: unknown;
}> {}
export interface MainConversationManager {
  readonly hostId: string;
  readonly context: ThreadReadStateContext;
  readonly generation: number;
  readonly stream: ConversationStream<CodexCanonicalConversationState, Patch>;
  readonly assertCurrent: (nativeGeneration?: number) => void;
  readonly onDispose: (callback: () => void) => Disposable;
  readonly onConnectionReset: (callback: () => void) => Disposable;
  readonly findOwner: (threadId: string) => Promise<string | null>;
  readonly coordination: ConversationCoordinationHost;
  readonly subscribeQueuedMessages: (
    callback: (event: ConversationCoordinationEvent) => void,
  ) => Disposable;
}
interface Instance {
  readonly manager: MainConversationManager;
  readonly scope: Scope.Closeable;
  readonly sourceEpoch: string | undefined;
  generation: number;
  connected: boolean;
  readonly connectionResetCallbacks: Set<() => void>;
}
interface HostEntry {
  readonly lock: Semaphore.Semaphore;
  serial: number;
  identityReady: boolean;
  instance: Instance | null;
}
type FollowerHandler = (
  hostId: string,
  request: ConversationFollowerRequest,
) => Effect.Effect<unknown, MainConversationManagerError>;

/** Main retains its peer manager while the authenticated execution host identity is unchanged. */
export class CodexMainConversationManagers extends Context.Service<
  CodexMainConversationManagers,
  {
    readonly get: (
      hostId: string,
    ) => Effect.Effect<MainConversationManager, MainConversationManagerError>;
    readonly current: (hostId: string) => MainConversationManager | null;
    readonly role: (hostId: string, threadId: string) => ConversationStreamRole | null;
    readonly dispatchFollowerRequest: FollowerHandler;
    readonly registerFollowerHandler: (handler: FollowerHandler) => Disposable;
    readonly retire: (hostId: string) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexMainConversationManagers") {}

export const make = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const gateway = yield* CodexGateway;
  const readState = yield* CodexThreadReadState;
  const entities = yield* ConversationEntityMap;
  const callbacks = yield* ScopedCallbackRuntime;
  const endpoints = yield* CodexConversationPeerRuntime;
  const entries = new Map<string, HostEntry>();
  const retentionByManager = new WeakMap<MainConversationManager, CanonicalConversationRetention>();
  let disposed = false;
  let followerHandler: FollowerHandler | undefined;
  const fail = (hostId: string, cause: unknown) =>
    new MainConversationManagerError({ hostId, cause });
  const current = (hostId: string): MainConversationManager | null => {
    const entry = entries.get(hostId);
    if (disposed || !entry?.identityReady) return null;
    return entry.instance?.manager ?? null;
  };
  const retire = (hostId: string) =>
    Effect.gen(function* () {
      const entry = entries.get(hostId);
      if (!entry) return;
      entry.serial += 1;
      entry.identityReady = false;
      const old = entry.instance;
      entry.instance = null;
      if (old) {
        yield* Scope.close(old.scope, Exit.void);
        for (const entity of entities.forHost(hostId)) yield* entities.retire(entity.threadId);
      }
    });
  const resetNativeConnection = Effect.fn("CodexMainConversationManagers.resetNativeConnection")(
    function* (instance: Instance) {
      if (!instance.connected) return;
      instance.connected = false;
      for (const callback of instance.connectionResetCallbacks) callback();
      const now = yield* Clock.currentTimeMillis;
      const { manager } = instance;
      for (const entity of entities.forHost(manager.hostId)) {
        entity.mutateCanonicalState((draft) => {
          draft.connectedEnvironmentIds = undefined;
          if (draft.turnHistory?.kind !== "canonical") return;
          draft.turnHistory.history.generation += 1;
          draft.turnHistory.history.isComplete = false;
        }, now);
      }
      manager.stream.resetAfterReconnect();
      for (const entity of entities.forHost(manager.hostId)) {
        entity.setResumeState("needs_resume");
        entity.setStreaming(false);
      }
    },
  );
  const get = (
    hostId: string,
  ): Effect.Effect<MainConversationManager, MainConversationManagerError> =>
    Effect.gen(function* () {
      if (disposed) return yield* fail(hostId, new Error("Main conversation managers disposed"));
      let entry = entries.get(hostId);
      if (!entry) {
        entry = { lock: yield* Semaphore.make(1), serial: 0, identityReady: false, instance: null };
        entries.set(hostId, entry);
      }
      const selected = entry;
      return yield* selected.lock.withPermit(
        Effect.gen(function* () {
          const connection = yield* gateway
            .connection(hostId)
            .pipe(Effect.mapError((cause) => fail(hostId, cause)));
          if (connection.kind !== "ready")
            return yield* fail(hostId, new Error("Native host is not ready"));
          const serial = selected.serial;
          const captured = yield* readState.captureContext(hostId);
          const latestConnection = yield* gateway
            .connection(hostId)
            .pipe(Effect.mapError((cause) => fail(hostId, cause)));
          if (
            !captured ||
            disposed ||
            serial !== selected.serial ||
            latestConnection.kind !== "ready" ||
            latestConnection.generation !== connection.generation ||
            latestConnection.source?.sourceEpoch !== connection.source?.sourceEpoch ||
            !(yield* captured.isCurrent.pipe(Effect.mapError((cause) => fail(hostId, cause))))
          )
            return yield* fail(hostId, new Error("Host identity is unavailable"));
          const previous = selected.instance;
          if (
            previous &&
            previous.sourceEpoch === connection.source?.sourceEpoch &&
            previous.manager.context.executionHostKey === captured.context.executionHostKey &&
            threadReadStateIdentityKey(previous.manager.context.identity) ===
              threadReadStateIdentityKey(captured.context.identity)
          ) {
            if (previous.generation !== connection.generation)
              yield* resetNativeConnection(previous);
            previous.generation = connection.generation;
            previous.connected = true;
            selected.identityReady = true;
            return previous.manager;
          }
          if (previous) yield* retire(hostId);
          const creationSerial = selected.serial;
          const instanceScope = yield* Scope.fork(scope, "sequential");
          if (disposed || selected.serial !== creationSerial) {
            yield* Scope.close(instanceScope, Exit.void);
            return yield* fail(hostId, new Error("Manager construction retired"));
          }
          let manager: MainConversationManager;
          const disposalCallbacks = new Set<() => void>();
          const connectionResetCallbacks = new Set<() => void>();
          const queuedMessageCallbacks = new Set<(event: ConversationCoordinationEvent) => void>();
          const assertCurrent = (nativeGeneration?: number) => {
            if (disposed || !selected.identityReady || selected.instance?.manager !== manager)
              throw new Error("Hosted conversation manager retired");
            if (
              nativeGeneration !== undefined &&
              (!selected.instance.connected || selected.instance.generation !== nativeGeneration)
            )
              throw new Error("Native conversation connection retired");
          };
          const report = (operation: string, cause: unknown) =>
            callbacks.fork(
              Effect.logWarning("Main conversation peer failed").pipe(
                Effect.annotateLogs({ hostId, operation, cause }),
              ),
            );
          const peer = connectCoordinationPeer(
            endpoints.getEndpoint,
            () => view,
            (cause) => {
              report("transport", cause);
            },
          );
          let retention: CanonicalConversationRetention | undefined;
          const schedule = (callback: () => void, delay: number) => {
            const fiber = callbacks.fork(
              Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(callback))),
            );
            return () => {
              if (fiber) callbacks.fork(Fiber.interrupt(fiber));
            };
          };
          const stream = new ConversationStream<CodexCanonicalConversationState, Patch>({
            hostId,
            isLocalHost: hostId === gateway.localHostId,
            canHandleOwnerlessDynamicTool: () => false,
            transport: createConversationStreamServiceTransport(peer.host),
            getConversation: (threadId) =>
              entities.current(threadId)?.readCanonicalState() ?? undefined,
            normalizeSnapshot: (document) => document,
            applyPatches: (document, patches) => applyPatches(document, patches),
            setConversation: (document) => {
              assertCurrent();
              entities.entity(document.id).installFollowerCanonicalState(document);
            },
            notifyConversation: (threadId) => {
              retention?.reconcile(threadId);
            },
            onRoleChanged: (threadId, role) => {
              entities.current(threadId)?.setStreamRole(role?.role ?? null);
              retention?.reconcile(threadId);
            },
            onFollowersChanged: (threadId) => {
              retention?.reconcile(threadId);
            },
            onOwnerUnavailable: (threadId) => {
              entities.current(threadId)?.setResumeState("needs_resume");
            },
            onError: (operation, _threadId, cause) => {
              report(operation, cause);
            },
            schedule,
          });
          const view = new ConversationCoordinationViewTarget(
            (requestedHost) => {
              assertCurrent();
              if (requestedHost !== hostId) throw new Error("Conversation host mismatch");
              return {
                getStreamRole: (threadId) => stream.getRole(threadId),
                handleThreadFollowerRequest: (request) => {
                  assertCurrent();
                  const conversationId =
                    request.params &&
                    typeof request.params === "object" &&
                    "conversationId" in request.params
                      ? request.params.conversationId
                      : null;
                  if (
                    typeof conversationId !== "string" ||
                    stream.getRole(conversationId)?.role !== "owner"
                  ) {
                    return Promise.reject(
                      new Error("no-client-found: thread stream owner became unavailable"),
                    );
                  }
                  if (!followerHandler)
                    return Promise.reject(new Error("Conversation actions are not ready"));
                  return callbacks.runPromise(followerHandler(hostId, request)).then((result) => {
                    assertCurrent();
                    return { method: request.method, result };
                  });
                },
              };
            },
            (method, event) => {
              assertCurrent();
              receiveConversationStreamServiceEvent(stream, hostId, method, event);
              if (method === "threadQueuedFollowUpsChanged")
                for (const callback of queuedMessageCallbacks) callback(event);
            },
          );
          manager = {
            hostId,
            get generation() {
              return instance.generation;
            },
            context: captured.context,
            stream,
            assertCurrent,
            onDispose: (callback) => {
              assertCurrent();
              disposalCallbacks.add(callback);
              return {
                [Symbol.dispose]() {
                  disposalCallbacks.delete(callback);
                },
              };
            },
            onConnectionReset: (callback) => {
              assertCurrent();
              connectionResetCallbacks.add(callback);
              return {
                [Symbol.dispose]() {
                  connectionResetCallbacks.delete(callback);
                },
              };
            },
            coordination: peer.host,
            subscribeQueuedMessages: (callback) => {
              assertCurrent();
              queuedMessageCallbacks.add(callback);
              return {
                [Symbol.dispose]() {
                  queuedMessageCallbacks.delete(callback);
                },
              };
            },
            findOwner: (threadId) => {
              assertCurrent();
              return peer.host.findThreadOwner({ hostId, conversationId: threadId });
            },
          };
          const instance: Instance = {
            manager,
            generation: connection.generation,
            sourceEpoch: connection.source?.sourceEpoch,
            connected: true,
            scope: instanceScope,
            connectionResetCallbacks,
          };
          selected.instance = instance;
          selected.identityReady = true;
          retention = new CanonicalConversationRetention({
            getConversation: (id) => entities.current(id)?.readCanonicalState(),
            getRole: (id) => stream.getRole(id)?.role ?? null,
            ownsHistory: (id) => stream.ownsConversationHistoryStream(id),
            hasActiveView: () => false,
            hasFollowers: (id) => stream.hasFollowersOrPendingReconnect(id),
            shouldKeepLoaded: (state) => {
              const context = entities.current(state.id)?.readRetentionState();
              return shouldKeepCanonicalConversationLoaded(
                state,
                context?.primaryRequest ?? null,
                context?.ephemeralSide ?? false,
              );
            },
            isEphemeralSide: (state) =>
              entities.current(state.id)?.readRetentionState().ephemeralSide ?? false,
            unsubscribe: (id) => {
              const nativeGeneration = manager.generation;
              assertCurrent(nativeGeneration);
              return callbacks
                .runPromise(
                  gateway.requestOnHost(
                    hostId,
                    "thread/unsubscribe",
                    { threadId: id },
                    {
                      expectedHostId: hostId,
                      expectedGeneration: nativeGeneration,
                    },
                  ),
                )
                .then((response) => {
                  assertCurrent(nativeGeneration);
                  return response;
                });
            },
            releaseHistory: (id) => {
              assertCurrent();
              entities.current(id)?.releasePassiveHistory();
            },
            completeUnsubscribe: (id, options) => {
              assertCurrent();
              entities.current(id)?.completeHistoryUnsubscribe(options.retainHistory);
            },
            clearOwnership: (id) => stream.removeConversation(id),
            now: Date.now,
            schedule,
            scheduleMicrotask: (callback) => {
              queueMicrotask(callback);
            },
          });
          retentionByManager.set(manager, retention);
          for (const entity of entities.forHost(hostId)) retention.reconcile(entity.threadId);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              retention?.dispose();
              stream.dispose();
              peer.dispose();
              for (const callback of disposalCallbacks) callback();
              disposalCallbacks.clear();
              for (const callback of connectionResetCallbacks) callback();
              connectionResetCallbacks.clear();
              queuedMessageCallbacks.clear();
            }),
          ).pipe(Effect.provideService(Scope.Scope, instanceScope));
          return manager;
        }),
      );
    });
  const subscription = entities.subscribeCanonicalMutations((event) => {
    const document = event.after ?? event.before;
    if (!document) return;
    const manager = current(document.hostId);
    if (!manager) return;
    const retention = retentionByManager.get(manager);
    if (event.after) retention?.reconcile(event.threadId);
    else retention?.remove(event.threadId);
    if (
      event.origin !== "local" ||
      !event.after ||
      !event.broadcast ||
      manager.stream.getRole(event.threadId)?.role !== "owner"
    )
      return;
    if (event.patches) manager.stream.broadcastPatches(event.threadId, event.patches);
    else manager.stream.broadcastSnapshot(event.threadId);
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      disposed = true;
      subscription[Symbol.dispose]();
      for (const hostId of entries.keys()) yield* retire(hostId);
      entries.clear();
    }),
  );
  yield* gateway.events.pipe(
    Stream.runForEach((event) => {
      if (event.kind === "connection") {
        const connection = event.value;
        if (connection.kind === "ready") {
          const entry = entries.get(connection.hostId);
          if (entry) {
            entry.serial += 1;
            entry.identityReady = false;
          }
          callbacks.fork(get(connection.hostId).pipe(Effect.ignore));
          return Effect.void;
        }
        if (connection.kind === "stopped") return retire(connection.hostId);
        const instance = entries.get(connection.hostId)?.instance;
        if (instance) return resetNativeConnection(instance);
        return Effect.void;
      }
      const notification = event.value;
      if (
        notification.method === "thread/started" ||
        notification.method === "thread/status/changed" ||
        notification.method === "turn/completed" ||
        notification.method === "serverRequest/resolved"
      ) {
        const manager = current(event.hostId);
        const parsed = parseCodexAppServerMessage(notification);
        if (
          manager &&
          event.generation === manager.generation &&
          parsed.success &&
          parsed.data.kind === "notification"
        ) {
          const value = parsed.data.notification;
          if (value.method === "thread/started")
            retentionByManager.get(manager)?.notificationHandled(value.params.thread.id);
          else if (
            value.method === "thread/status/changed" ||
            value.method === "turn/completed" ||
            value.method === "serverRequest/resolved"
          )
            retentionByManager.get(manager)?.notificationHandled(value.params.threadId);
        }
      }
      if (event.hostId !== gateway.localHostId || event.value.method !== "account/updated")
        return Effect.void;
      for (const entry of entries.values()) {
        entry.serial += 1;
        entry.identityReady = false;
      }
      for (const hostId of entries.keys()) callbacks.fork(get(hostId).pipe(Effect.ignore));
      return Effect.void;
    }),
    Effect.forkScoped({ startImmediately: true }),
  );
  return CodexMainConversationManagers.of({
    get,
    current,
    role: (hostId, threadId) => current(hostId)?.stream.getRole(threadId) ?? null,
    retire,
    dispatchFollowerRequest: (hostId, request) =>
      Effect.suspend(() =>
        followerHandler
          ? followerHandler(hostId, request)
          : Effect.fail(
              new MainConversationManagerError({
                hostId,
                cause: new Error("Conversation actions are not ready"),
              }),
            ),
      ),
    registerFollowerHandler: (handler) => {
      followerHandler = handler;
      return {
        [Symbol.dispose]() {
          if (followerHandler === handler) followerHandler = undefined;
        },
      };
    },
  });
});

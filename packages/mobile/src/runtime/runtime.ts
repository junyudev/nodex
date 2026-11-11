import type {
  AgentChoice,
  ChatResponse,
  InboxDecision,
  InboxScope,
  MobileMethod,
  MobileParams,
  PushPreferences,
} from "@nodex/mobile-protocol";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makeChats } from "./chats";
import { Connection, makeConnection } from "./connection";
import { Files, makeFileCache } from "./files";
import { Lists, makeLists, type ChatListInput, type InboxFilter } from "./lists";
import { mintId, retryOperation } from "./operations";
import { makeNotifications, type DeliveredNotificationTarget } from "./notifications";
import { Outbox, makeOutbox } from "./outbox";
import {
  adaptPlatform,
  Platform,
  platformClock,
  type LocalImage,
  type MobilePlatform,
} from "./platform";
import { createProjection, type Projection } from "./projection";
import { RpcClient, makeRpcClient, RpcFailure, disconnected } from "./rpc-client";
import { readStored } from "./storage";

type Preferences = {
  projectId: string | null;
  agent: AgentChoice | null;
  location: "local" | "worktree";
};
const defaultPreferences: Preferences = { projectId: null, agent: null, location: "local" };
const preferencesKey = (hostId: string) => `nodex.mobile.preferences.v1:${hostId}`;
const makeApplication = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const platform = yield* Platform;
  const rpc = yield* makeRpcClient;
  const connection = yield* makeConnection.pipe(Effect.provideService(RpcClient, rpc));
  const withConnection = Effect.provideService(Connection, connection);
  const files = yield* makeFileCache.pipe(withConnection);
  const outbox = yield* makeOutbox.pipe(withConnection);
  const lists = yield* makeLists.pipe(withConnection, Effect.provideService(Outbox, outbox));
  const chats = yield* makeChats.pipe(
    withConnection,
    Effect.provideService(Files, files),
    Effect.provideService(Lists, lists),
  );
  const notifications = yield* makeNotifications.pipe(withConnection);
  const preferences = new Map<string | null, Projection<Preferences>>();
  function getPreferences(hostId: string | null) {
    const existing = preferences.get(hostId);
    if (existing) return existing;
    const store = createProjection(
      hostId
        ? readStored(platform.storage, preferencesKey(hostId), defaultPreferences)
        : defaultPreferences,
    );
    preferences.set(hostId, store);
    return store;
  }
  const storePreferences = (hostId: string, patch: Partial<Preferences>) =>
    Effect.try({
      try: () => {
        const store = getPreferences(hostId);
        const previous = store.getState();
        const next = {
          projectId: patch.projectId === undefined ? previous.projectId : patch.projectId,
          agent: patch.agent === undefined ? previous.agent : patch.agent,
          location: patch.location ?? previous.location,
        };
        platform.storage.set(preferencesKey(hostId), JSON.stringify(next));
        store.setState(next, true);
      },
      catch: () => new RpcFailure("internal", "Could not save your chat preferences.", false),
    });
  return {
    scope,
    connection,
    outbox,
    lists,
    files,
    chats,
    notifications,
    getPreferences,
    setPreferences: (hostId: string | null, patch: Partial<Preferences>) =>
      hostId && connection.activeHostId() === hostId
        ? storePreferences(hostId, patch)
        : Effect.void,
    forgetHost: Effect.fnUntraced(function* (hostId: string) {
      yield* notifications.forgetSpace(hostId);
      yield* connection.forgetHost(hostId);
      yield* outbox.forgetHost(hostId);
      yield* lists.forgetHost(hostId);
      yield* files.forgetHost(hostId);
      preferences.delete(hostId);
      platform.storage.remove(preferencesKey(hostId));
    }),
    decideInbox: Effect.fnUntraced(function* (pageId: string, decision: InboxDecision) {
      const operationId = mintId(platform);
      const result = yield* retryOperation(connection, () =>
        rpc.request("inbox.decide", { operationId, entryId: pageId, decision }),
      );
      yield* lists.invalidate(["inbox", "projects", "chats"]);
      return { undoToken: result.undoToken, sessionId: result.sessionId };
    }),
    undoInbox: Effect.fnUntraced(function* (undoToken: string) {
      const operationId = mintId(platform);
      yield* retryOperation(connection, () =>
        rpc.request("inbox.undo", { operationId, undoToken }),
      );
      yield* lists.invalidate(["inbox", "projects", "chats"]);
    }),
    fetchInboxEntry: (pageId: string) =>
      retryOperation(connection, () => rpc.request("inbox.message", { entryId: pageId })),
    startChat: Effect.fnUntraced(function* (
      input: Preferences & { text: string; images: LocalImage[] },
    ) {
      const hostId = (yield* connection.requireLink).hello.host.id;
      const sessionId = mintId(platform),
        launchId = mintId(platform),
        messageId = mintId(platform);
      const { images, text, projectId, agent, location } = input;
      const result = yield* files.withImageUploads(images, (fileRefs) =>
        rpc.request("chats.start", {
          sessionId,
          launchId,
          messageId,
          projectId,
          agent,
          location,
          text,
          fileRefs,
        }),
      );
      if (connection.hosts.getState().hosts.some((host) => host.hostId === hostId))
        yield* storePreferences(hostId, { projectId, agent, location }).pipe(Effect.ignore);
      if (connection.activeHostId() === hostId) yield* lists.invalidate(["chats"]);
      return { sessionId: result.sessionId };
    }),
    fetchChatItem: (sessionId: string, itemId: string) =>
      retryOperation(connection, () => rpc.request("chat.item", { sessionId, itemId })),
    setChatArchived: Effect.fnUntraced(function* (sessionId: string, archived: boolean) {
      yield* retryOperation(connection, () =>
        rpc.request("chat.setArchived", { sessionId, archived }),
      );
      yield* lists.invalidate(["chats"]);
    }),
  };
});
class MobileApplication extends Context.Service<
  MobileApplication,
  Effect.Success<typeof makeApplication>
>()("nodex/mobile/Application") {}

/** The phone's only execution edge. Application services never allocate another runtime. */
export function createMobileRuntime(
  platform: MobilePlatform,
  options?: { scheduler?: Scheduler.Scheduler; clock?: Clock.Clock },
) {
  const foundation = Layer.mergeAll(
    Layer.succeed(Platform, adaptPlatform(platform)),
    Layer.succeed(Clock.Clock, options?.clock ?? platformClock(platform)),
    Layer.succeed(Scheduler.Scheduler, options?.scheduler ?? new Scheduler.MixedScheduler()),
  );
  const managed = ManagedRuntime.make(
    Layer.effect(MobileApplication, makeApplication).pipe(Layer.provideMerge(foundation)),
  );
  const app = managed.runSync(MobileApplication);
  const bind = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
    effect.pipe(Scope.provide(app.scope));
  const sync = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => managed.runSync(bind(effect));
  const promise = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
    managed.runPromiseExit(bind(effect)).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      throw Cause.hasInterruptsOnly(exit.cause) ? disconnected() : Cause.squash(exit.cause);
    });
  const { connection, lists, outbox, files, chats } = app;
  let disposed = false;
  const release = (effect: Effect.Effect<void>) => () => {
    if (!disposed) sync(effect);
  };
  const views = new WeakMap<object, unknown>();
  function cached<A extends object, B>(resource: A, build: (resource: A) => B): B {
    const previous = views.get(resource);
    if (previous) return previous as B;
    const view = build(resource);
    views.set(resource, view);
    return view;
  }
  const reads = <
    T extends {
      attach: Effect.Effect<Effect.Effect<void>, unknown>;
      refresh: Effect.Effect<void>;
      reconnect: Effect.Effect<void>;
      watched(): boolean;
    },
  >(
    resource: T,
  ) =>
    cached(resource, (item) => ({
      ...item,
      attach() {
        const detach = sync(item.attach);
        return release(detach);
      },
      refresh: () => sync(item.refresh),
      reconnect: () => sync(item.reconnect),
    }));
  const listView = <
    T extends {
      attach: Effect.Effect<Effect.Effect<void>, unknown>;
      refresh: Effect.Effect<void>;
      reconnect: Effect.Effect<void>;
      watched(): boolean;
      loadMore: Effect.Effect<void>;
      store: unknown;
    },
  >(
    resource: T,
  ) =>
    cached(resource, (item) => ({
      ...item,
      attach() {
        const detach = sync(item.attach);
        return release(detach);
      },
      refresh: () => sync(item.refresh),
      loadMore: () => sync(item.loadMore),
    }));
  return {
    connection: {
      state: connection.state,
      hosts: connection.hosts,
      pairWithUri: (uri: string) =>
        promise(connection.pairWithUri(uri)).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code !== "disconnected")
            throw error;
          throw Object.assign(new Error("Could not reach your desktop."), {
            code: "unreachable",
          });
        }),
      activateHost: (hostId: string) => {
        sync(connection.activateHost(hostId));
      },
      forgetHost: (hostId: string) => promise(connection.forgetHost(hostId)),
      reconnectNow: () => {
        sync(connection.reconnectNow);
      },
      activeHostId: connection.activeHostId,
      activeLink: connection.activeLink,
      requireLink: () => sync(connection.requireLink),
      assertLink: (link: Parameters<typeof connection.assertLink>[0]) => {
        sync(connection.assertLink(link));
      },
      rpc: {
        request: <M extends MobileMethod>(method: M, params: MobileParams<M>) =>
          promise(connection.rpc.request(method, params)),
        get droppedEvents() {
          return connection.rpc.droppedEvents;
        },
        on: <K extends Parameters<typeof connection.rpc.events>[0]>(
          event: K,
          handler: (data: import("@nodex/mobile-protocol").MobileEventData<K>) => void,
        ) => {
          const fiber = sync(
            connection.rpc.events(event).pipe(
              Stream.runForEach((data) => Effect.sync(() => handler(data))),
              Effect.forkIn(app.scope, { startImmediately: true }),
            ),
          );
          return () => {
            sync(Fiber.interrupt(fiber));
          };
        },
      },
    },
    lists: {
      projects: lists.projects,
      agents: lists.agents,
      projectReads: reads(lists.projectReads),
      agentReads: reads(lists.agentReads),
      inbox: (hostId: string | null, scope: InboxScope, filter: InboxFilter) =>
        listView(sync(lists.inbox(hostId, scope, filter))),
      chats: (hostId: string | null, input: ChatListInput) =>
        listView(sync(lists.chats(hostId, input))),
    },
    outbox: {
      store: outbox.store,
      visiblePending: outbox.visiblePending,
      captureToInbox: (input: Parameters<typeof outbox.captureToInbox>[0]) =>
        sync(outbox.captureToInbox(input)),
      retryCapture: (id: string) => {
        sync(outbox.retryCapture(id));
      },
      discardCapture: (id: string) => {
        sync(outbox.discardCapture(id));
      },
    },
    files: {
      get: (hostId: string | null, ref: string | null) =>
        cached(sync(files.get(hostId, ref)), (file) => ({
          store: file.store,
          attach() {
            const detach = sync(file.attach);
            return release(detach);
          },
        })),
    },
    resolveFileUri: (ref: string) => promise(files.resolve(ref)),
    chats: {
      get: (hostId: string | null, sessionId: string) =>
        cached(sync(chats.get(hostId, sessionId)), (chat) => ({
          store: chat.store,
          attach() {
            const detach = sync(chat.attach);
            return release(detach);
          },
          loadOlder: () => {
            sync(chat.loadOlder);
          },
          send: (text: string, images: LocalImage[], delivery: "queue" | "steer") =>
            promise(chat.send(text, images, delivery)),
          stop: () => promise(chat.stop),
          respond: (requestId: string, runId: string | null, response: ChatResponse) =>
            promise(chat.respond(requestId, runId, response)),
        })),
      markChatRead: (sessionId: string) => {
        managed.runFork(chats.markChatRead(sessionId));
      },
    },
    notifications: {
      state: app.notifications.state,
      enable: () => promise(app.notifications.enable),
      retry: () => promise(app.notifications.retry),
      setPreferences: (patch: Partial<PushPreferences>) =>
        promise(app.notifications.setPreferences(patch)),
      dismissOffer: () => {
        sync(app.notifications.dismissOffer);
      },
      clearDelivered: (target: DeliveredNotificationTarget) => {
        managed.runFork(app.notifications.clearDelivered(target));
      },
    },
    getPreferences: app.getPreferences,
    setPreferences: (hostId: string | null, patch: Partial<Preferences>) => {
      sync(app.setPreferences(hostId, patch));
    },
    forgetHost: (hostId: string) => promise(app.forgetHost(hostId)),
    decideInbox: (pageId: string, decision: InboxDecision) =>
      promise(app.decideInbox(pageId, decision)),
    undoInbox: (undoToken: string) => promise(app.undoInbox(undoToken)),
    fetchInboxEntry: (pageId: string) => promise(app.fetchInboxEntry(pageId)),
    startChat: (input: Parameters<typeof app.startChat>[0]) => promise(app.startChat(input)),
    fetchChatItem: (sessionId: string, itemId: string) =>
      promise(app.fetchChatItem(sessionId, itemId)),
    setChatArchived: (sessionId: string, archived: boolean) =>
      promise(app.setChatArchived(sessionId, archived)),
    dispose() {
      disposed = true;
      return managed.dispose();
    },
  };
}
export type MobileRuntime = ReturnType<typeof createMobileRuntime>;

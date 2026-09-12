import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import { CodexPeerClient } from "../platform/node/CodexPeerClient";
import { acquireCodexPeerEndpointManager } from "../platform/node/CodexPeerEndpoint";
import { CodexConversationPeerRuntime } from "../platform/node/CodexConversationPeerRuntime";
import { ScopedCallbackRuntime, layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { threadReadStateHostKeys } from "../codex/thread-read-state-identity";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import type { ThreadReadStateEvent } from "../../shared/codex-thread-read-state";
import {
  ProjectWorkspace,
  type DesktopProjectWorkspaceThread,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub, make as makeEventHub } from "./CodexApplicationEventHub";
import { make } from "./CodexThreadReadState";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";

const buildRuntime = Effect.fn("CodexThreadReadStateTest.buildRuntime")(function* (
  workspace: ProjectWorkspaceService,
  initiallyUnread = false,
  endpoint?: string,
) {
  const scope = yield* Scope.make();
  const conversationsContext = yield* Layer.buildWithScope(conversationRuntimeMapLive, scope);
  const conversations = Context.get(conversationsContext, ConversationEntityMap);
  const events = yield* makeEventHub.pipe(Effect.provideService(Scope.Scope, scope));
  let unread = initiallyUnread ? ["thread-a"] : [];
  const persistedWrites: boolean[] = [];
  const callbacks = yield* Layer.build(callbackLayer).pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  const readState = yield* make.pipe(
    Effect.provideService(ScopedCallbackRuntime, Context.get(callbacks, ScopedCallbackRuntime)),
    Effect.provideService(CodexConversationPeerRuntime, {
      registerWindowPeer: () => () => {},
      resolvePeerClientId: () => Promise.resolve(null),
      getEndpoint: () =>
        endpoint ? Promise.resolve(endpoint) : Promise.reject(new Error("test peer unavailable")),
    }),
    Effect.provideService(CodexApplicationEventHub, events),
    Effect.provideService(ConversationEntityMap, conversations),
    Effect.provideService(
      ProjectWorkspace,
      ProjectWorkspace.of({
        ...workspace,
        selectThreadReadStateIdentity: () => Effect.void,
        readIdentityThreadReadState: () =>
          Effect.succeed({ [threadReadStateHostKeys([]).local!]: unread }),
        setIdentityThreadUnread: (_key, _host, thread, value) =>
          Effect.sync(() => {
            persistedWrites.push(value);
            unread = value ? [...unread, thread] : unread.filter((id) => id !== thread);
          }),
        clearIdentityThreadReadState: () =>
          Effect.sync(() => {
            unread = [];
          }),
      }),
    ),
    Effect.provideService(CodexGateway, {
      requestLocal: (method: string) =>
        Effect.succeed(
          method === "account/read"
            ? { account: { type: "apiKey" }, requiresOpenaiAuth: false }
            : { authMethod: "apikey", authToken: null, requiresOpenaiAuth: true },
        ),
      localHostId: "local",
      events: Stream.never,
    } as unknown as CodexGateway["Service"]),
    Effect.provideService(CodexThreadHostResolver, { resolve: () => Effect.succeed("local") }),
    Effect.provideService(ApplicationSettings, {
      snapshot: () => Effect.succeed({ executionHosts: { sshHosts: [] } }),
    } as unknown as ApplicationSettings["Service"]),
    Effect.provideService(Scope.Scope, scope),
  );
  return { scope, conversations, events, readState, persistedWrites };
});

it.effect(
  "persists authenticated membership before projecting Workspace and resident conversation state",
  () =>
    Effect.gen(function* () {
      let workspaceUnread = true;
      const workspaceThread = () =>
        ({
          threadId: "thread-a",
          archived: false,
          hasUnreadTurn: workspaceUnread,
        }) as DesktopProjectWorkspaceThread;
      const runtime = yield* buildRuntime(
        {
          getThread: () => Effect.succeed(workspaceThread()),
          setThreadUnread: (_threadId: string, hasUnreadTurn: boolean) => {
            workspaceUnread = hasUnreadTurn;
            return Effect.succeed(workspaceThread());
          },
        } as unknown as ProjectWorkspaceService,
        true,
      );
      const aggregate = runtime.conversations.entity("thread-a");
      aggregate.seedHasUnreadTurn(true);
      const published: ThreadReadStateEvent[] = [];
      const opened = yield* runtime.readState.openSession((event) =>
        Effect.sync(() => {
          published.push(event);
        }),
      );
      if (opened.status !== "ready") throw new Error("Read state unavailable");

      assert.isTrue(yield* runtime.readState.set({ threadId: "thread-a", hasUnreadTurn: false }));
      assert.isFalse(workspaceUnread);
      assert.isFalse(aggregate.readHasUnreadTurn());
      assert.deepEqual(published, [
        {
          type: "changed",
          origin: "external",
          threadId: "thread-a",
          hostId: "local",
          hasUnreadTurn: false,
        },
      ]);
      yield* Scope.close(runtime.scope, Exit.void);
    }),
);

it.effect("persists reducer commits from the typed application event path", () =>
  Effect.gen(function* () {
    const writes: boolean[] = [];
    const runtime = yield* buildRuntime({
      getThread: () => Effect.succeed(null),
      setThreadUnread: (_threadId: string, hasUnreadTurn: boolean) => {
        writes.push(hasUnreadTurn);
        return Effect.succeed({ hasUnreadTurn } as DesktopProjectWorkspaceThread);
      },
    } as unknown as ProjectWorkspaceService);

    runtime.events.publish({
      kind: "conversationReadStateCommitted",
      value: { threadId: "thread-a", hasUnreadTurn: true },
    });
    for (let attempt = 0; attempt < 100 && runtime.persistedWrites.length === 0; attempt += 1) {
      yield* Effect.yieldNow;
    }
    assert.deepEqual(runtime.persistedWrites, [true]);
    assert.deepEqual(writes, []);
    yield* Scope.close(runtime.scope, Exit.void);
  }),
);

it.effect("publishes context-bearing read-state changes over the production Main peer", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(join(tmpdir(), "nodex-read-state-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const endpoints = yield* acquireCodexPeerEndpointManager(directory, () => {});
    const endpoint = yield* Effect.tryPromise(() => endpoints.getOrStartRouterEndpoint());
    const observer = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new CodexPeerClient(
            () => Promise.resolve(endpoint),
            () => {},
          ),
      ),
      (peer) => Effect.sync(() => peer.dispose()),
    );
    const broadcast = yield* Deferred.make<unknown>();

    observer.addBroadcastHandler("thread-read-state-changed", (message) => {
      Deferred.doneUnsafe(broadcast, Exit.succeed(message.params));
    });
    yield* Effect.tryPromise(() => observer.waitUntilInitialized({ timeoutMs: 1000 }));
    const runtime = yield* buildRuntime(
      {
        getThread: () => Effect.succeed(null),
        setThreadUnread: () => Effect.die("unloaded thread has no Workspace projection"),
      } as unknown as ProjectWorkspaceService,
      false,
      endpoint,
    );
    yield* Effect.addFinalizer(() => Scope.close(runtime.scope, Exit.void));
    assert.isTrue(yield* runtime.readState.set({ threadId: "thread-a", hasUnreadTurn: true }));
    assert.deepEqual(yield* Deferred.await(broadcast), {
      hostId: "local",
      conversationId: "thread-a",
      hasUnreadTurn: true,
      context: {
        identity: { kind: "execution-storage", authMode: "apikey" },
        executionHostKey: threadReadStateHostKeys([]).local,
      },
    });
  }).pipe(Effect.scoped),
);

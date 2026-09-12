/* oxlint-disable effecttsgo/async-function, effecttsgo/global-timers -- Exercises the real MessagePort/socket boundary with scoped native resources. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { ScopedCallbackRuntime, layer as callbackLayer } from "../../app/ScopedCallbackRuntime";
import { makeIdentityReadState } from "../../codex-application/CodexIdentityReadState";
import { CodexThreadReadStateService } from "./CodexThreadReadStateService";
import { RpcSession, RpcTarget } from "capnweb";
import { applyPatches, enablePatches, type Patch } from "immer";
import { expect, vi } from "vitest";
import type { ConversationCoordinationHost } from "../../../shared/codex-client-coordination";
import type { ThreadReadStateEvent } from "../../../shared/codex-thread-read-state";
import { ConversationCoordinationViewTarget } from "../../../shared/codex-coordination-view";
import { ConversationStream } from "../../../shared/codex-conversation-stream";
import {
  ConversationServicePortTransport,
  type ConversationServicePort,
} from "../../../shared/codex-service-port";
import { createConversationStreamServiceTransport } from "../../../shared/codex-stream-service-transport";
import { receiveConversationStreamServiceEvent } from "../../../shared/codex-stream-service-events";
import { acquireCodexPeerEndpointManager } from "../node/CodexPeerEndpoint";
import { connectCoordinationPeer } from "../node/CodexCoordinationPeer";
import { connectConversationService } from "./CodexConversationService";
import { ConversationServiceRoot } from "../../../shared/codex-service-root";
import { requestConversationFollower } from "../../../shared/codex-follower-request";

enablePatches();
type Document = { id: string; text: string };

function adaptPort(port: MessageChannel["port1"]): ConversationServicePort {
  return {
    start: () => port.start(),
    postMessage: (value) => port.postMessage(value),
    close: () => port.close(),
    on: (event, listener) =>
      event === "message"
        ? port.on("message", (data: unknown) => listener({ data }))
        : port.on("close", listener),
  };
}

function manager(endpoint: string, hostId = "local", direct = false) {
  const errors = vi.fn();
  const documents = new Map<string, Document>([["thread", { id: "thread", text: "initial" }]]);
  const request = vi.fn(async (input: { method: string; params: unknown }) => ({
    method: input.method,
    result: { ok: true },
  }));
  const ownerUnavailable = vi.fn();
  const broadcasts = vi.fn();
  const view = new ConversationCoordinationViewTarget(
    (requestedHost) => {
      if (requestedHost !== hostId) throw new Error("Unknown host");
      return { getStreamRole: (id) => stream.getRole(id), handleThreadFollowerRequest: request };
    },
    (method, event) => {
      broadcasts(method, event);
      receiveConversationStreamServiceEvent(stream, hostId, method, event);
    },
  );
  const connection = (() => {
    if (direct)
      return connectCoordinationPeer(
        () => Promise.resolve(endpoint),
        () => view,
        errors,
      );
    const { port1, port2 } = new MessageChannel();
    const transport = new ConversationServicePortTransport(adaptPort(port2));
    const session = new RpcSession<ConversationServiceRoot<ConversationCoordinationHost>>(
      transport,
      new ConversationServiceRoot(view),
    );
    const service = connectConversationService(
      adaptPort(port1),
      () => Promise.resolve(endpoint),
      errors,
    );
    return {
      host: session.getRemoteMain().services.clientCoordination,
      getClientId: service.getClientId,
      dispose: () => {
        service.dispose();
        transport.abort(new Error("test finished"));
      },
    };
  })();
  const host = connection.host;
  const stream = new ConversationStream<Document, Patch>({
    hostId,
    isLocalHost: hostId === "local",
    canHandleOwnerlessDynamicTool: () => false,
    transport: createConversationStreamServiceTransport(host),
    getConversation: (id) => documents.get(id),
    setConversation: (document) => {
      documents.set(document.id, document);
    },
    normalizeSnapshot: (document) => document,
    applyPatches: (document, patches) => applyPatches(document, [...patches]),
    notifyConversation: () => {},
    onRoleChanged: () => {},
    onFollowersChanged: () => {},
    onOwnerUnavailable: ownerUnavailable,
    onError: errors,
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  });
  return {
    stream,
    documents,
    host,
    errors,
    request,
    ownerUnavailable,
    broadcasts,
    getClientId: connection.getClientId,
    dispose: () => {
      stream.dispose();
      connection.dispose();
    },
  };
}

const network = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "nodex-coordination-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  const endpoints = yield* acquireCodexPeerEndpointManager(directory, () => {});
  return yield* Effect.tryPromise(() => endpoints.getOrStartRouterEndpoint());
});

it.effect("connects a direct Main peer and two window peers through the same ownership route", () =>
  Effect.gen(function* () {
    const endpoint = yield* network;
    const acquire = (direct: boolean) =>
      Effect.acquireRelease(
        Effect.sync(() => manager(endpoint, "local", direct)),
        (value) => Effect.sync(value.dispose),
      );
    const main = yield* acquire(true);
    const firstWindow = yield* acquire(false);
    const secondWindow = yield* acquire(false);
    yield* Effect.tryPromise(async () => {
      main.stream.setRole("thread", { role: "owner" });
      firstWindow.stream.setFollowing("thread", true);
      secondWindow.stream.setFollowing("thread", true);
      await vi.waitFor(() => expect(main.stream.getFollowerClientIds("thread")).toHaveLength(2));
      const ownerId = await firstWindow.host.findThreadOwner({
        hostId: "local",
        conversationId: "thread",
      });
      expect(ownerId).toBe(await main.getClientId());
      expect(await firstWindow.getClientId()).not.toBe(ownerId);
      const patches: Patch[] = [{ op: "replace", path: ["text"], value: "from Main" }];
      main.documents.set("thread", { id: "thread", text: "from Main" });
      main.stream.broadcastPatches("thread", patches);
      await vi.waitFor(() => {
        expect(firstWindow.documents.get("thread")?.text).toBe("from Main");
        expect(secondWindow.documents.get("thread")?.text).toBe("from Main");
      });
      expect(
        await firstWindow.host.requestThreadFollower({
          hostId: "local",
          targetClientId: ownerId ?? undefined,
          request: {
            method: "thread-follower-compact-thread",
            params: { conversationId: "thread" },
          },
        }),
      ).toMatchObject({ resultType: "success", handledByClientId: ownerId, result: { ok: true } });
      expect(main.request).toHaveBeenCalledOnce();
      main.dispose();
      await vi.waitFor(() => expect(firstWindow.ownerUnavailable).toHaveBeenCalled());
      firstWindow.stream.setRole("thread", { role: "owner" });
      await vi.waitFor(() =>
        expect(secondWindow.stream.getRole("thread")).toMatchObject({ role: "follower" }),
      );
      const replacement = await secondWindow.host.findThreadOwner({
        hostId: "local",
        conversationId: "thread",
      });
      expect(replacement).toBeTruthy();
      expect(replacement).not.toBe(ownerId);
      expect(
        await secondWindow.host.requestThreadFollower({
          hostId: "local",
          targetClientId: replacement ?? undefined,
          request: {
            method: "thread-follower-compact-thread",
            params: { conversationId: "thread" },
          },
        }),
      ).toMatchObject({ resultType: "success", handledByClientId: replacement });
      expect(firstWindow.request).toHaveBeenCalledOnce();
      expect(secondWindow.request).not.toHaveBeenCalled();
      expect(main.errors).not.toHaveBeenCalled();
      expect(firstWindow.errors).not.toHaveBeenCalled();
      expect(secondWindow.errors).not.toHaveBeenCalled();
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "replicates between independent managers through both RPC ports and the socket router",
  () =>
    Effect.gen(function* () {
      const endpoint = yield* network;
      const create = (hostId = "local") =>
        Effect.acquireRelease(
          Effect.sync(() => manager(endpoint, hostId)),
          (value) => Effect.sync(value.dispose),
        );
      const owner = yield* create();
      const follower = yield* create();
      const remote = yield* create("remote");
      yield* Effect.tryPromise(async () => {
        owner.stream.setRole("thread", { role: "owner" });
        follower.stream.setFollowing("thread", true);
        remote.stream.setFollowing("thread", true);
        await vi.waitFor(() => expect(follower.stream.getRole("thread")?.role).toBe("follower"));
        const ownerId = await follower.host.findThreadOwner({
          hostId: "local",
          conversationId: "thread",
        });
        expect(ownerId).toBeTruthy();
        expect(follower.stream.getRole("thread")).toEqual({
          role: "follower",
          ownerClientId: ownerId,
        });
        expect(owner.stream.getFollowerClientIds("thread")).toHaveLength(1);
        const revision = owner.stream.getRevision("thread");
        const patches: Patch[] = [{ op: "replace", path: ["text"], value: "汉字 😀" }];
        owner.documents.set("thread", { id: "thread", text: "汉字 😀" });
        owner.stream.broadcastPatches("thread", patches);
        await vi.waitFor(() => expect(follower.documents.get("thread")?.text).toBe("汉字 😀"));
        expect(follower.stream.getRevision("thread")).toBe((revision ?? 0) + 1);
        expect(remote.documents.get("thread")?.text).toBe("initial");
        expect(remote.stream.getRole("thread")).toBeNull();
        const result = await requestConversationFollower(
          follower.host,
          "thread-follower-compact-thread",
          { conversationId: "thread" },
          { hostId: "local", targetClientId: ownerId ?? undefined },
        );
        expect(result).toMatchObject({
          resultType: "success",
          handledByClientId: ownerId,
          result: { ok: true },
        });
        expect(owner.request).toHaveBeenCalledOnce();
        expect(follower.request).not.toHaveBeenCalled();
        expect(owner.errors).not.toHaveBeenCalled();
        expect(follower.errors).not.toHaveBeenCalled();
      });
    }).pipe(Effect.scoped),
);

it.effect(
  "surfaces follower response mismatches and reports owner disconnects without a recovery publication",
  () =>
    Effect.gen(function* () {
      const endpoint = yield* network;
      const owner = yield* Effect.acquireRelease(
        Effect.sync(() => manager(endpoint)),
        (value) => Effect.sync(value.dispose),
      );
      const follower = yield* Effect.acquireRelease(
        Effect.sync(() => manager(endpoint)),
        (value) => Effect.sync(value.dispose),
      );
      yield* Effect.tryPromise(async () => {
        owner.stream.setRole("thread", { role: "owner" });
        follower.stream.setFollowing("thread", true);
        await vi.waitFor(() => expect(follower.stream.getRole("thread")?.role).toBe("follower"));
        const role = follower.stream.getRole("thread");
        if (role?.role !== "follower") throw new Error("Follower was not connected");
        owner.request.mockResolvedValueOnce({ method: "wrong-method", result: { ok: true } });
        expect(
          await follower.host.requestThreadFollower({
            hostId: "local",
            targetClientId: role.ownerClientId,
            request: {
              method: "thread-follower-compact-thread",
              params: { conversationId: "thread" },
            },
          }),
        ).toMatchObject({ resultType: "error", error: "thread-follower-response-method-mismatch" });
        const revision = follower.stream.getRevision("thread");
        owner.dispose();
        await vi.waitFor(() =>
          expect(follower.ownerUnavailable).toHaveBeenCalledWith("thread", role.ownerClientId),
        );
        expect(follower.stream.getRevision("thread")).toBe(revision);
      });
    }).pipe(Effect.scoped),
);

it.effect("relays archive and queued follow-up events across RPC and socket peers", () =>
  Effect.gen(function* () {
    const endpoint = yield* network;
    const create = () =>
      Effect.acquireRelease(
        Effect.sync(() => manager(endpoint)),
        (value) => Effect.sync(value.dispose),
      );
    const sender = yield* create();
    const receiver = yield* create();
    yield* Effect.tryPromise(async () => {
      // An awaited request proves both peers have registered before the broadcasts begin.
      await sender.host.findThreadOwner({ hostId: "local", conversationId: "thread" });
      await receiver.host.findThreadOwner({ hostId: "local", conversationId: "thread" });
      for (const method of [
        "threadArchived",
        "threadUnarchived",
        "threadQueuedFollowUpsChanged",
      ] as const) {
        const params = {
          hostId: "remote",
          conversationId: "thread",
          state: { entries: [{ id: "queued", text: "继续 😀" }] },
        };
        await sender.host[method](params);
        await vi.waitFor(() =>
          expect(receiver.broadcasts).toHaveBeenCalledWith(method, {
            sourceClientId: expect.any(String),
            params,
          }),
        );
        expect(
          sender.broadcasts.mock.calls.filter(([received]) => received === method),
        ).toHaveLength(0);
      }
    });
  }),
);

it("opens read state without registering a conversation socket peer", async () => {
  const { port1, port2 } = new MessageChannel();
  const transport = new ConversationServicePortTransport(adaptPort(port2));
  const endpoint = vi.fn(() => Promise.reject(new Error("No peer should be acquired")));
  class ReadState extends RpcTarget {
    getExecutionHostKeys() {
      return Promise.resolve({});
    }
    open() {
      return Promise.resolve({ status: "unavailable" as const });
    }
  }
  const errors = vi.fn();
  const remote = new RpcSession<ConversationServiceRoot<ConversationCoordinationHost>>(
    transport,
    new ConversationServiceRoot(undefined),
  ).getRemoteMain();
  const service = connectConversationService(adaptPort(port1), endpoint, errors, new ReadState());
  try {
    const services = await remote.services;
    expect(await services.threadReadState!.open(() => {})).toEqual({ status: "unavailable" });
    expect(endpoint).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    service.dispose();
    transport.abort(new Error("test finished"));
    remote[Symbol.dispose]();
  }
});

it.effect(
  "delivers every read-state update through the window RPC and retires sessions even during opening",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const callbacks = yield* ScopedCallbackRuntime;
      let retireDuringOpen = false;
      const values: Record<string, string[]> = {};
      const owner = yield* makeIdentityReadState({
        readIdentity: Effect.succeed({ kind: "execution-storage", authMode: "none" }),
        hostKeys: Effect.succeed({ local: "local-key" }),
        read: () => Effect.sync(() => values),
        write: (_key, host, thread, unread) =>
          Effect.sync(() => {
            values[host] = unread
              ? [...(values[host] ?? []), thread]
              : (values[host] ?? []).filter((id) => id !== thread);
          }),
        clear: () => Effect.void,
        select: () => Effect.void,
        project: () => Effect.void,
        accepted: () => Effect.void,
      });
      yield* Effect.tryPromise(async () => {
        const { port1, port2 } = new MessageChannel();
        const transport = new ConversationServicePortTransport(adaptPort(port2));
        const remote = new RpcSession<ConversationServiceRoot<ConversationCoordinationHost>>(
          transport,
          new ConversationServiceRoot(undefined),
        ).getRemoteMain();
        const service = connectConversationService(
          adaptPort(port1),
          () => Promise.reject(new Error("Unexpected peer")),
          () => {},
          new CodexThreadReadStateService(
            {
              captureContext: owner.captureContext,
              getExecutionHostKeys: owner.hostKeys,
              openSession: (notify) =>
                owner
                  .open(notify)
                  .pipe(
                    Effect.tap(() => (retireDuringOpen ? owner.retire("identity") : Effect.void)),
                  ),
              set: () => Effect.succeed(false),
              persistProjected: () => Effect.void,
            },
            callbacks,
            scope,
          ),
        );
        try {
          const api = (await remote.services).threadReadState!;
          const changes: ThreadReadStateEvent[] = [];
          // RPC releases listener capabilities; disposable spies would clear their own evidence.
          const observe = (event: ThreadReadStateEvent) => {
            changes.push(event);
          };
          const first = await api.open(observe);
          const second = await api.open(observe);
          if (first.status !== "ready" || second.status !== "ready") throw new Error("Unavailable");
          expect(
            await first.session.set({ hostId: "local", threadId: "thread", hasUnreadTurn: true }),
          ).toEqual({ status: "ok" });
          await vi.waitFor(() => expect(changes).toHaveLength(2));
          await first.session.unsubscribe();
          expect(
            await first.session.set({ hostId: "local", threadId: "late", hasUnreadTurn: true }),
          ).toEqual({ status: "retired" });
          expect(
            await second.session.set({ hostId: "local", threadId: "other", hasUnreadTurn: true }),
          ).toEqual({ status: "ok" });
          expect(values["local-key"]).toEqual(["thread", "other"]);
          await vi.waitFor(() => expect(changes).toHaveLength(3));
          const beforeBurst = changes.length;
          const threadIds = Array.from({ length: 1025 }, (_, index) => `burst-${index}`);
          await callbacks.runPromise(
            Effect.forEach(
              threadIds,
              (threadId) =>
                owner.acceptBroadcast({
                  hostId: "local",
                  threadId,
                  hasUnreadTurn: true,
                  context: { identity: second.identity, executionHostKey: "local-key" },
                }),
              { discard: true },
            ),
          );
          await vi.waitFor(() => expect(changes).toHaveLength(beforeBurst + threadIds.length));
          expect(
            changes
              .slice(beforeBurst)
              .map((event) => (event.type === "changed" ? event.threadId : null)),
          ).toEqual(threadIds);
          expect(changes.every((event) => event.type === "changed")).toBe(true);
          expect(
            await second.session.set({
              hostId: "local",
              threadId: "after-burst",
              hasUnreadTurn: true,
            }),
          ).toEqual({ status: "ok" });
          const reopened = await api.open(() => {});
          if (reopened.status !== "ready") throw new Error("Read state unavailable after burst");
          expect(reopened.unreadThreadIdsByHostId.local).toEqual([
            "thread",
            "other",
            ...threadIds,
            "after-burst",
          ]);
          await reopened.session.unsubscribe();
          retireDuringOpen = true;
          const openingEvents: ThreadReadStateEvent[] = [];
          const retired = await api.open((event) => {
            openingEvents.push(event);
          });
          if (retired.status !== "ready") throw new Error("Expected admitted session");
          await vi.waitFor(() =>
            expect(openingEvents).toEqual([{ type: "retired", reason: "identity" }]),
          );
          expect(
            await retired.session.set({
              hostId: "local",
              threadId: "stale-open",
              hasUnreadTurn: true,
            }),
          ).toEqual({ status: "retired" });
        } finally {
          service.dispose();
          transport.abort(new Error("test finished"));
          remote[Symbol.dispose]();
        }
      });
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This test is the scoped runtime entry point.
    }).pipe(Effect.scoped, Effect.provide(callbackLayer)),
);

it.effect("retires the trusted physical window identity when its service closes", () =>
  Effect.gen(function* () {
    const endpoint = yield* network;
    const window = yield* Effect.acquireRelease(
      Effect.sync(() => manager(endpoint)),
      (value) => Effect.sync(value.dispose),
    );
    yield* Effect.tryPromise(async () => {
      window.stream.setRole("thread", { role: "owner" });
      const id = await window.getClientId();
      expect(id).toBeTruthy();
      window.dispose();
      expect(await window.getClientId()).toBeNull();
    });
  }).pipe(Effect.scoped),
);

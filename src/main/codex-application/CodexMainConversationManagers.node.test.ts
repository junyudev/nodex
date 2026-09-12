import * as PubSub from "effect/PubSub";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { produce, produceWithPatches } from "immer";
import { conversationWindowPeer } from "./conversation-window-peer.test-support";
import {
  replaceCanonicalHistoryDraft,
  loadCanonicalHistoryBoundaryPage,
  type CanonicalHistoryClient,
} from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { createCodexHistoryBoundaryRef } from "../../shared/codex-conversation-state/codex-history-topology";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
/* oxlint-disable effecttsgo/strict-effect-provide -- Scoped test entry point composes the callback runtime. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ScopedCallbackRuntime, layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexConversationPeerRuntime } from "../platform/node/CodexConversationPeerRuntime";
import { acquireCodexPeerEndpointManager } from "../platform/node/CodexPeerEndpoint";
import { CodexThreadReadState } from "./CodexThreadReadState";
import { make } from "./CodexMainConversationManagers";
import { ConversationEntityMap, live as entityLayer } from "./internal/ConversationEntityMap";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";

const network = Effect.gen(function* () {
  const path = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "nodex-main-manager-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const endpoints = yield* acquireCodexPeerEndpointManager(path, () => {});
  return yield* Effect.tryPromise(() => endpoints.getOrStartRouterEndpoint());
});
const build = (endpoint: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const entities = Context.get(
      yield* Layer.buildWithScope(entityLayer, scope),
      ConversationEntityMap,
    );
    const callbacks = yield* ScopedCallbackRuntime;
    let accountId = "account-a";
    let generation = 1;
    const unsubscribed: string[] = [];
    const gatewayEvents = yield* PubSub.unbounded<CodexEndpointEvent>();
    const managers = yield* make.pipe(
      Effect.provideService(ConversationEntityMap, entities),
      Effect.provideService(ScopedCallbackRuntime, callbacks),
      Effect.provideService(CodexConversationPeerRuntime, {
        getEndpoint: () => Promise.resolve(endpoint),
        registerWindowPeer: () => () => {},
        resolvePeerClientId: () => Promise.resolve(null),
      }),
      Effect.provideService(CodexGateway, {
        localHostId: "local",
        events: Stream.fromPubSub(gatewayEvents),
        requestOnHost: (_host: string, method: string, params: { threadId: string }) =>
          Effect.sync(() => {
            assert.strictEqual(method, "thread/unsubscribe");
            unsubscribed.push(params.threadId);
            return {};
          }),
        connection: () => Effect.succeed({ kind: "ready", hostId: "local", generation }),
      } as unknown as CodexGateway["Service"]),
      Effect.provideService(CodexThreadReadState, {
        captureContext: () =>
          Effect.succeed({
            context: {
              identity: { kind: "chatgpt", accountId, userId: "user" },
              executionHostKey: "local-key",
            },
            isCurrent: Effect.succeed(true),
          }),
      } as unknown as CodexThreadReadState["Service"]),
    );
    return {
      entities,
      managers,
      unsubscribed,
      gatewayEvents,
      changeAccount: () => {
        accountId = "account-b";
      },
      reconnect: () => {
        generation += 1;
      },
    };
  });

it.effect("replicates an ordinary Main owner's canonical document into another manager", () =>
  Effect.gen(function* () {
    const endpoint = yield* network;
    const first = yield* build(endpoint);
    const second = yield* build(endpoint);
    const owner = yield* first.managers.get("local");
    const follower = yield* second.managers.get("local");
    owner.stream.setRole("thread", { role: "owner" });
    first.entities.entity("thread").acceptCanonicalState(conversationFixture("thread"));
    const ownerId = yield* Effect.tryPromise(() => follower.findOwner("thread"));
    if (!ownerId) throw new Error("Owner missing");
    follower.stream.setRole("thread", { role: "follower", ownerClientId: ownerId });
    follower.stream.setFollowing("thread", true);
    yield* Effect.tryPromise(() => follower.stream.waitForRevision("thread", ownerId, 1, 1000));
    assert.strictEqual(second.entities.current("thread")?.readCanonicalState()?.id, "thread");
    assert.strictEqual(follower.stream.getRole("thread")?.role, "follower");
    assert.strictEqual(owner.stream.getRevision("thread"), 1);
  }).pipe(Effect.scoped, Effect.provide(callbackLayer)),
);

it.effect(
  "replaces account identities while preserving the manager across physical reconnects",
  () =>
    Effect.gen(function* () {
      const runtime = yield* build(yield* network);
      const initial = yield* runtime.managers.get("local");
      runtime.entities.entity("thread").acceptCanonicalState(conversationFixture("thread"));
      runtime.changeAccount();
      const changed = yield* runtime.managers.get("local");
      assert.notStrictEqual(changed, initial);
      assert.throws(initial.assertCurrent);
      assert.strictEqual(runtime.entities.current("thread"), null);
      const unchanged = yield* runtime.managers.get("local");
      assert.strictEqual(unchanged, changed);
      unchanged.assertCurrent();
      const entity = runtime.entities.entity("retained");
      entity.acceptCanonicalState(conversationFixture("retained", [turnFixture("tail")]));
      unchanged.stream.setRole("retained", { role: "owner" });
      const canonical = entity.readCanonicalState()!;
      const disposed: string[] = [];
      const resetGenerations: number[] = [];
      unchanged.onDispose(() => {
        disposed.push("manager");
      });
      unchanged.onConnectionReset(() => {
        resetGenerations.push(unchanged.generation);
      });
      unchanged.assertCurrent(1);
      runtime.reconnect();
      const reconnected = yield* runtime.managers.get("local");
      assert.strictEqual(changed, reconnected);
      assert.deepEqual(disposed, []);
      assert.strictEqual(reconnected.generation, 2);
      assert.deepEqual(resetGenerations, [1]);
      assert.throws(() => reconnected.assertCurrent(1), "connection retired");
      reconnected.assertCurrent(2);
      assert.strictEqual(runtime.entities.current("retained"), entity);
      assert.strictEqual(entity.readResumeState(), "needs_resume");
      assert.strictEqual(reconnected.stream.getRole("retained"), null);
      assert.deepEqual(
        residentConversationTurns(entity.readCanonicalState()).map((turn) => turn.turnId),
        residentConversationTurns(canonical).map((turn) => turn.turnId),
      );
      reconnected.assertCurrent();
    }).pipe(Effect.scoped, Effect.provide(callbackLayer)),
);

it.effect(
  "replicates interleaved native history and live writes from Main to two window peers",
  () =>
    Effect.gen(function* () {
      const endpoint = yield* network;
      const runtime = yield* build(endpoint);
      const owner = yield* runtime.managers.get("local");
      const entity = runtime.entities.entity("thread");
      const initial = conversationFixture("thread", [turnFixture("tail")]);
      entity.acceptCanonicalState(
        produce(initial, (draft) =>
          replaceCanonicalHistoryDraft(draft, initial.turns, false, {
            cursor: "older",
            oldestLoadedTurnId: "tail",
          }),
        ),
      );
      owner.stream.setRole("thread", { role: "owner" });
      const acquireWindow = Effect.acquireRelease(
        Effect.sync(() => conversationWindowPeer(endpoint)),
        (window) => Effect.sync(window.dispose),
      );
      const first = yield* acquireWindow;
      const second = yield* acquireWindow;
      const ownerId = yield* Effect.tryPromise(() =>
        first.host.findThreadOwner({ hostId: "local", conversationId: "thread" }),
      );
      if (!ownerId) throw new Error("Main owner unavailable");
      for (const window of [first, second]) {
        window.stream.setRole("thread", { role: "follower", ownerClientId: ownerId });
        window.stream.setFollowing("thread", true);
        yield* Effect.tryPromise(() => window.stream.waitForRevision("thread", ownerId, 1, 1000));
      }
      let resolvePage!: (value: ClientRequestResponsesByMethod["thread/turns/list"]) => void;
      const page = new Promise<ClientRequestResponsesByMethod["thread/turns/list"]>((resolve) => {
        resolvePage = resolve;
      });
      const client: CanonicalHistoryClient = {
        hostId: "local",
        supportsPaginatedHistory: () => false,
        getConversation: () => entity.readCanonicalState(),
        sendRequest: <M extends "thread/turns/list" | "thread/items/list">() =>
          page as Promise<ClientRequestResponsesByMethod[M]>,
        updateConversation: (_id, recipe, broadcast = true) => {
          entity.mutateCanonicalState(recipe, 1, broadcast);
        },
        broadcastSnapshot: () => owner.stream.broadcastSnapshot("thread"),
        mapTurns: (_id, turns, pagination) =>
          conversationFixture("thread", [...turns]).turns.map((turn) => ({
            ...turn,
            ...(turn.turnId && pagination[turn.turnId]
              ? { itemsPagination: pagination[turn.turnId] }
              : {}),
          })),
      };
      const history = entity.readCanonicalState()!.turnHistory!.history;
      const island = history.islands[0]!;
      if (island.olderBoundary.status !== "available") throw new Error("Missing boundary");
      const reference = createCodexHistoryBoundaryRef(
        history.generation,
        island.id,
        "older",
        island.olderBoundary,
      );
      const loading = loadCanonicalHistoryBoundaryPage(client, "thread", reference, {});
      entity.mutateCanonicalState((draft) => {
        draft.turnHistory!.history.entitiesByKey["turn:tail"]!.items.push({
          type: "plan",
          id: "live",
          text: "arrived during history I/O",
        });
      }, 2);
      resolvePage({
        data: [{ id: "older", items: [], itemsView: "full", status: "completed" }],
        nextCursor: null,
        backwardsCursor: null,
      });
      assert.strictEqual(yield* Effect.tryPromise(() => loading), "applied");
      const revision = owner.stream.getRevision("thread");
      if (revision === null) throw new Error("Owner revision missing");
      for (const window of [first, second]) {
        yield* Effect.tryPromise(() =>
          window.stream.waitForRevision("thread", ownerId, revision, 1000),
        );
        assert.deepStrictEqual(
          window.documents.get("thread"),
          JSON.parse(JSON.stringify(entity.readCanonicalState())),
        );
        assert.deepStrictEqual(
          residentConversationTurns(window.documents.get("thread")).map((turn) => turn.turnId),
          ["older", "tail"],
        );
        assert.strictEqual(
          window.documents.get("thread")!.turnHistory!.history.entitiesByKey["turn:tail"]!.items[0]
            ?.id,
          "live",
        );
        assert.deepStrictEqual(window.failures, []);
      }
      const replacementId = yield* Effect.tryPromise(first.getClientId);
      if (!replacementId) throw new Error("Window peer missing");
      first.stream.setRole("thread", { role: "owner" });
      owner.stream.setRole("thread", { role: "follower", ownerClientId: replacementId });
      second.stream.setRole("thread", { role: "follower", ownerClientId: replacementId });
      owner.stream.setFollowing("thread", true);
      second.stream.setFollowing("thread", true);
      yield* Effect.tryPromise(() =>
        owner.stream.waitForRevision("thread", replacementId, 1, 1000),
      );
      yield* Effect.tryPromise(() =>
        second.stream.waitForRevision("thread", replacementId, 1, 1000),
      );
      const [updated, patches] = produceWithPatches(first.documents.get("thread")!, (draft) => {
        draft.title = "Window now owns the conversation";
      });
      first.documents.set("thread", updated);
      first.stream.broadcastPatches("thread", patches);
      const replacementRevision = first.stream.getRevision("thread");
      if (replacementRevision === null) throw new Error("Replacement revision missing");
      yield* Effect.tryPromise(() =>
        owner.stream.waitForRevision("thread", replacementId, replacementRevision, 1000),
      );
      yield* Effect.tryPromise(() =>
        second.stream.waitForRevision("thread", replacementId, replacementRevision, 1000),
      );
      assert.strictEqual(entity.readCanonicalState()?.title, updated.title);
      assert.strictEqual(second.documents.get("thread")?.title, updated.title);
      const unfinished = second.stream
        .waitForRevision("thread", replacementId, replacementRevision + 1, 1000)
        .then(
          () => false,
          () => true,
        );
      second.dispose();
      assert.isTrue(yield* Effect.tryPromise(() => unfinished));
    }).pipe(Effect.scoped, Effect.provide(callbackLayer)),
);

it.effect("Main retires excess inactive canonical owners without a UI snapshot", () =>
  Effect.gen(function* () {
    const endpoint = yield* network;
    const harness = yield* build(endpoint);
    const manager = yield* harness.managers.get("local");
    for (let index = 0; index < 11; index += 1) {
      const id = `inactive-${index}`;
      harness.entities.entity(id).acceptCanonicalState({
        ...conversationFixture(id, [turnFixture(`turn-${index}`)]),
        rolloutPath: `/rollouts/${id}`,
        resumeState: "resumed",
      });
      manager.stream.setRole(id, { role: "owner" });
    }
    yield* TestClock.adjust(1);
    yield* Effect.yieldNow;
    assert.deepEqual(harness.unsubscribed, ["inactive-0"]);
    assert.strictEqual(manager.stream.getRole("inactive-0"), null);
    assert.strictEqual(
      harness.entities.current("inactive-0")?.readCanonicalState()?.resumeState,
      "needs_resume",
    );
    assert.deepEqual(
      residentConversationTurns(harness.entities.current("inactive-0")!.readCanonicalState()!),
      [],
    );
    assert.strictEqual(manager.stream.getRole("inactive-1")?.role, "owner");
  }).pipe(Effect.scoped, Effect.provide(callbackLayer)),
);

it.effect("only current-generation retention notifications release passive canonical history", () =>
  Effect.gen(function* () {
    const endpoint = yield* network;
    const harness = yield* build(endpoint);
    yield* harness.managers.get("local");
    const id = "passive-notification";
    const entity = harness.entities.entity(id);
    entity.acceptCanonicalState({
      ...conversationFixture(id, [
        {
          ...turnFixture("turn"),
          items: [
            {
              type: "agentMessage",
              id: "answer",
              text: "kept",
              phase: null,
              memoryCitation: null,
              delivery: null,
              questions: null,
            },
          ],
        },
      ]),
      rolloutPath: "/rollout",
      resumeState: "resumed",
      threadRuntimeStatus: { type: "idle" },
    });
    yield* Effect.yieldNow;
    yield* PubSub.publish(harness.gatewayEvents, {
      kind: "notification",
      hostId: "local",
      generation: 1,
      value: {
        protocol: "generated",
        method: "thread/name/updated",
        params: { threadId: id, threadName: "Renamed" },
      },
    });
    yield* Effect.yieldNow;
    yield* Effect.promise(() => Promise.resolve());
    assert.strictEqual(residentConversationTurns(entity.readCanonicalState()).length, 1);
    yield* PubSub.publish(harness.gatewayEvents, {
      kind: "notification",
      hostId: "local",
      generation: 0,
      value: {
        protocol: "generated",
        method: "thread/status/changed",
        params: { threadId: id, status: { type: "idle" } },
      },
    });
    yield* Effect.yieldNow;
    yield* Effect.promise(() => Promise.resolve());
    assert.strictEqual(residentConversationTurns(entity.readCanonicalState()).length, 1);
    yield* PubSub.publish(harness.gatewayEvents, {
      kind: "notification",
      hostId: "local",
      generation: 1,
      value: {
        protocol: "generated",
        method: "thread/status/changed",
        params: { threadId: id, status: { type: "idle" } },
      },
    });
    yield* Effect.yieldNow;
    yield* Effect.promise(() => Promise.resolve());
    assert.strictEqual(residentConversationTurns(entity.readCanonicalState()).length, 0);
    assert.deepEqual(harness.unsubscribed, []);
  }).pipe(Effect.scoped, Effect.provide(callbackLayer)),
);

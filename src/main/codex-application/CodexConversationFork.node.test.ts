import { describe } from "vite-plus/test";
import { produce, produceWithPatches } from "immer";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import type {
  CodexCanonicalTurnHeader,
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
} from "../../shared/types";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { make } from "./CodexConversationFork";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import { CodexForkTitlePolicy } from "./CodexForkTitlePolicy";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import {
  ConversationEntityMap,
  live as entityLayer,
  live as conversationEntityMapLive,
} from "./internal/ConversationEntityMap";
import * as PubSub from "effect/PubSub";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { conversationWindowPeer } from "./conversation-window-peer.test-support";
import {
  replaceCanonicalHistoryDraft,
  loadCanonicalHistoryBoundaryPage,
  type CanonicalHistoryClient,
} from "../../shared/codex-conversation-state/codex-canonical-history-loader";
import { createCodexHistoryBoundaryRef } from "../../shared/codex-conversation-state/codex-history-topology";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ScopedCallbackRuntime, layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import { CodexConversationPeerRuntime } from "../platform/node/CodexConversationPeerRuntime";
import { acquireCodexPeerEndpointManager } from "../platform/node/CodexPeerEndpoint";
import { CodexThreadReadState } from "./CodexThreadReadState";
import { make as makeCodexMainConversationManagers } from "./CodexMainConversationManagers";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { make as makeConversationContext } from "./CodexConversationContext";
import type { ConversationEntityState } from "./internal/ConversationEntityState";

describe("CodexConversationFork", () => {
  const sourceThreadId = "thread-source";
  const childThreadId = "thread-child";

  const canonical = (threadId: string): CodexCanonicalConversationState =>
    ({
      turns: [
        {
          ...({ turnId: "turn-a", status: "completed" } satisfies Pick<
            CodexCanonicalTurnHeader,
            "turnId" | "status"
          >),
          items: [],
          params: undefined,
          hookRuns: [],
        },
      ],
      ...{ id: threadId },
    }) as unknown as CodexCanonicalConversationState;

  const snapshot = (threadId: string): CodexConversationSnapshot =>
    ({
      threadId,
      threadName: "Source title",
      turns: [
        {
          threadId,
          ...({ turnId: "turn-a", status: "completed" } satisfies Pick<
            CodexCanonicalTurnHeader,
            "turnId" | "status"
          >),
          itemIds: [],
        },
      ],
      turnPagination: {
        olderCursor: null,
        backwardsCursor: null,
        oldestLoadedTurnId: "turn-a",
        isLoadingOlder: false,
        hasLoadedOldest: true,
        loadedTurnCount: 1,
        itemsView: "full",
      },
    }) as unknown as CodexConversationSnapshot;

  interface HarnessOptions {
    readonly appServerVersion?: string;
    readonly capabilityIsCurrent?: boolean;
    readonly gatewayFailure?: ReturnType<typeof codexRuntimeError>;
    readonly localHostId?: string;
    readonly responseTurns?: readonly {
      readonly id: string;
      readonly status: "completed";
    }[];
    readonly sourceCanonicalLoaded?: boolean;
    readonly sourceHistoryMode?: "legacy" | "paginated";
    readonly currentExecutionHostId?: string;
  }

  const makeHarness = (options: HarnessOptions = {}) => {
    const order: string[] = [];
    const requests: Array<{
      readonly hostId: string;
      readonly method: string;
      readonly params: unknown;
      readonly scheduling: unknown;
    }> = [];
    const resolutions: Array<{
      readonly threadId: string;
      readonly fidelity: string;
    }> = [];
    const sourceCanonical = canonical(sourceThreadId);
    const sourceSnapshot = snapshot(sourceThreadId);
    const childSnapshot = snapshot(childThreadId);
    let projectedChild: CodexCanonicalConversationState | null = null;
    let projectedChildSnapshot: CodexConversationSnapshot | null = null;

    const core = CoreModules.of({
      workspace: {
        read: (input: Parameters<CoreModuleClients["workspace"]["read"]>[0]) => {
          if (input.kind === "task_window") {
            return Effect.succeed({
              value: {
                kind: "task_window",
                tasks: {
                  items: [
                    {
                      session: {},
                      thread: {
                        thread_id: sourceThreadId,
                        forked_from_id: null,
                        thread_name: "Source title",
                      },
                    },
                  ],
                  total_count: 1,
                  next_cursor: null,
                  authority: { projection_revision: 1 },
                },
              },
            } as unknown as ProjectWorkspaceReadSnapshot);
          }
          if (input.kind === "execution_context") {
            return Effect.succeed({
              value: {
                kind: "execution_context",
                context: { thread: { writable_roots: ["/workspace", "/shared"] } },
              },
            } as unknown as ProjectWorkspaceReadSnapshot);
          }
          if (input.kind === "thread") {
            return Effect.succeed({
              value: {
                kind: "thread",
                thread: {
                  thread_id: sourceThreadId,
                  execution_host_id: options.currentExecutionHostId ?? "host-a",
                },
              },
            } as unknown as ProjectWorkspaceReadSnapshot);
          }
          return Effect.die("unexpected Core read");
        },
      },
    } as unknown as CoreModuleClients);
    const gateway = CodexGateway.of({
      localHostId: options.localHostId ?? "local",
      events: Stream.empty,
      requestOnHost: ((hostId: string, method: string, params: unknown, scheduling: unknown) =>
        Effect.gen(function* () {
          order.push("gateway:fork");
          requests.push({ hostId, method, params, scheduling });
          if (options.gatewayFailure) return yield* options.gatewayFailure;
          return {
            thread: {
              id: childThreadId,
              forkedFromId: sourceThreadId,
              historyMode: "paginated",
              turns: [...(options.responseTurns ?? [])],
            },
            model: "gpt-test",
            modelProvider: "openai",
            serviceTier: null,
            cwd: "/workspace",
            runtimeWorkspaceRoots: ["/workspace", "/shared"],
            instructionSources: [],
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: { type: "workspaceWrite", writableRoots: ["/workspace", "/shared"] },
            activePermissionProfile: null,
            reasoningEffort: "high",
            multiAgentMode: "explicitRequestOnly",
          } as never;
        })) as CodexGateway["Service"]["requestOnHost"],
    } as unknown as CodexGateway["Service"]);
    const directory = CodexThreadDirectory.of({
      prepareResume: () => Effect.die("unused"),
      prepareHistoryHydration: () => Effect.die("unused"),
      acceptRendererResume: () => Effect.die("unused"),
      materializeInCurrentLane: () => Effect.die("unused"),
      refreshMetadataInCurrentLane: () => Effect.die("unused"),
      resolve: (input) =>
        Effect.sync(() => {
          resolutions.push({ threadId: input.threadId, fidelity: input.fidelity });
          return {
            fidelity: "durable",
            historyMode: options.sourceHistoryMode ?? "paginated",
            durable: {
              threadId: sourceThreadId,
              projectId: "project-a",
              executionHostId: "host-a",
              cwd: "/workspace",
              executionProfile: {
                modelId: "gpt-test",
                reasoningEffort: "high",
                serviceTier: null,
              },
            },
            summary: { ...sourceSnapshot, forkedFromId: null },
            canonical: options.sourceCanonicalLoaded === false ? null : sourceCanonical,
            snapshot: options.sourceCanonicalLoaded === false ? null : sourceSnapshot,
          } as never;
        }),
      acceptImportResult: () => Effect.die("unused"),
      acceptForkResult: ({ sourceThreadId: acceptedSource, response }) =>
        Effect.sync(() => {
          order.push("directory:accept");
          assert.strictEqual(acceptedSource, sourceThreadId);
          assert.strictEqual(response.thread.id, childThreadId);
          return {
            fidelity: "metadata",
            historyMode: "paginated",
            durable: { threadId: childThreadId },
            summary: { ...childSnapshot, threadId: childThreadId },
            canonical: canonical(childThreadId),
            snapshot: childSnapshot,
          } as never;
        }),
      observeMetadata: () => Effect.die("unused"),
      acceptStandaloneStart: () => Effect.die("unused"),
      acceptResumeResult: () => Effect.die("unused"),
      acceptSessionStart: () => Effect.die("unused"),
    });
    const capabilitySnapshot = createCodexAppServerCapabilitySnapshot({
      hostId: "host-a",
      generation: 7,
      userAgent: `Codex Desktop/${options.appServerVersion ?? "0.147.0"}`,
      nativeAppTools: (options.localHostId ?? "local") === "host-a",
    });
    const capability = make.pipe(
      Effect.provideService(CoreModules, core),
      Effect.provideService(
        CodexAppServerCapabilities,
        CodexAppServerCapabilities.of({
          forHost: () => Effect.succeed(capabilitySnapshot),
          forThread: () => Effect.succeed(capabilitySnapshot),
          isCurrent: () => Effect.succeed(options.capabilityIsCurrent ?? true),
        }),
      ),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(
        DesktopToolRuntime,
        DesktopToolRuntime.of({
          threadConfig: () =>
            Effect.succeed({ "mcp_servers.node_repl": { command: "/runtime/node" } }),
        } as unknown as DesktopToolRuntime["Service"]),
      ),
      Effect.provideService(
        CodexMainConversationResume,
        CodexMainConversationResume.of({
          resume: () =>
            Effect.sync(() => {
              order.push("manager:resume");
              projectedChild = canonical(childThreadId);
              projectedChildSnapshot = childSnapshot;
              return { status: "ready", snapshot: childSnapshot } as const;
            }),
        }),
      ),
      Effect.provideService(
        CodexForkTitlePolicy,
        CodexForkTitlePolicy.of({
          derive: () =>
            Effect.succeed({ sourceTitle: "Source title", childTitle: "Source title (3)" }),
        }),
      ),
      Effect.provideService(
        CodexForkSidePanelTransfer,
        CodexForkSidePanelTransfer.of({
          stageDirect: () => Effect.sync(() => order.push("side-panel:stage")).pipe(Effect.asVoid),
        } as never),
      ),
      Effect.provideService(
        CodexThreadCatalog,
        CodexThreadCatalog.of({
          ensureSession: () =>
            Effect.sync(() => {
              order.push("session:ensure");
              return {
                id: "session-child",
                thread: { threadId: childThreadId },
              } as never;
            }),
        } as never),
      ),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
      Effect.provideService(
        CodexThreadTitlePersistence,
        CodexThreadTitlePersistence.of({
          set: (input) =>
            Effect.sync(() => {
              if (!projectedChild) throw new Error("Fork title cannot project before child resume");
              order.push(`title:set:${input.name}`);
              return true;
            }),
          setRequired: () => Effect.die("unused"),
          syncCommittedTitle: () => Effect.die("unused"),
        }),
      ),
      Effect.provideService(
        ConversationEntityMap,
        ConversationEntityMap.of({
          entity: () => ({
            mutateCanonicalState: (
              recipe: (draft: import("immer").Draft<CodexCanonicalConversationState>) => void,
            ) => {
              if (!projectedChild) throw new Error("Main conversation has not resumed");
              projectedChild = produce(projectedChild, recipe);
              return true;
            },
            readSnapshot: () => projectedChildSnapshot,
          }),
          registerThreadMetadata: () => {},
          readThreadMetadata: () => null,
          runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) =>
            Effect.sync(() => order.push("lane:open")).pipe(Effect.andThen(operation)),
        } as never),
      ),
    );
    return { capability, order, projectedChild: () => projectedChild, requests, resolutions };
  };

  it.effect("commits an exact persistent fork through canonical Session ownership", () =>
    Effect.gen(function* () {
      const { capability, order, projectedChild, requests, resolutions } = makeHarness();
      const forks = yield* capability;
      const result = yield* forks.fork({
        sourceThreadId,
        lastTurnId: "turn-a",
        threadSource: "user",
      });

      assert.strictEqual(result.threadId, childThreadId);
      assert.strictEqual(result.session.id, "session-child");
      assert.strictEqual(result.composerIntent.prompt, "");
      assert.deepEqual(requests, [
        {
          hostId: "host-a",
          method: "thread/fork",
          params: {
            threadId: sourceThreadId,
            lastTurnId: "turn-a",
            path: null,
            cwd: "/workspace",
            runtimeWorkspaceRoots: ["/workspace", "/shared"],
            threadSource: "user",
            excludeTurns: true,
          },
          scheduling: {
            conversationId: sourceThreadId,
            priority: "interactive",
            source: "thread_fork",
            expectedHostId: "host-a",
            expectedGeneration: 7,
          },
        },
      ]);
      assert.deepEqual(resolutions, [{ threadId: sourceThreadId, fidelity: "metadata" }]);
      assert.deepEqual(
        requests.map((request) => request.method),
        ["thread/fork"],
      );
      const projected = projectedChild();
      assert.ok(projected);
      assert.strictEqual(projected.turns.at(-1)?.items.at(-1)?.type, "forkedFromConversation");
      assert.deepEqual(result.conversation.turnPagination, snapshot(childThreadId).turnPagination);
      assert.deepEqual(order, [
        "lane:open",
        "gateway:fork",
        "directory:accept",
        "session:ensure",
        "manager:resume",
        "title:set:Source title (3)",
        "side-panel:stage",
      ]);
    }),
  );

  it.effect("does not attach local desktop runtime config to a remote persistent fork", () =>
    Effect.gen(function* () {
      const { capability, requests } = makeHarness({ localHostId: "local" });
      const forks = yield* capability;
      const result = yield* forks.fork({
        sourceThreadId,
        lastTurnId: "turn-a",
        threadSource: "user",
      });

      assert.strictEqual(result.threadId, childThreadId);
      assert.lengthOf(requests, 1);
      assert.strictEqual(requests[0]?.method, "thread/fork");
      assert.notProperty(requests[0]?.params as Record<string, unknown>, "config");
    }),
  );

  it.effect("forks through an unloaded stable Turn identity without reading source history", () =>
    Effect.gen(function* () {
      const { capability, order, requests, resolutions } = makeHarness({
        sourceCanonicalLoaded: false,
      });
      const forks = yield* capability;
      const result = yield* forks.fork({
        sourceThreadId,
        lastTurnId: "turn-not-resident",
        threadSource: "user",
      });

      assert.strictEqual(result.threadId, childThreadId);
      assert.strictEqual(
        (
          requests[0]?.params as {
            readonly lastTurnId?: string;
          }
        ).lastTurnId,
        "turn-not-resident",
      );
      assert.deepEqual(
        requests.map((request) => request.method),
        ["thread/fork"],
      );
      assert.deepEqual(resolutions, [{ threadId: sourceThreadId, fidelity: "metadata" }]);
      assert.ok(!order.some((entry) => entry.startsWith("title:set:")));
    }),
  );

  it.effect("accepts returned inline history and resumes the child at the ordinary manager", () =>
    Effect.gen(function* () {
      const { capability, order, projectedChild, requests } = makeHarness({
        responseTurns: [{ id: "turn-inline", status: "completed" }],
      });
      const forks = yield* capability;
      const result = yield* Effect.exit(
        forks.fork({
          sourceThreadId,
          lastTurnId: "turn-a",
          threadSource: "user",
        }),
      );

      assert.isTrue(Exit.isSuccess(result));
      assert.deepEqual(
        requests.map((request) => request.method),
        ["thread/fork"],
      );
      assert.ok(projectedChild());
      assert.ok(order.includes("manager:resume"));
    }),
  );

  it.effect("fails closed before dispatch when bounded fork capabilities are unavailable", () =>
    Effect.gen(function* () {
      const { capability, order, requests, resolutions } = makeHarness({
        appServerVersion: "0.143.0-alpha.32",
      });
      const forks = yield* capability;
      const exit = yield* Effect.exit(
        forks.fork({
          sourceThreadId,
          lastTurnId: "turn-a",
          threadSource: "user",
        }),
      );

      assert.strictEqual(exit._tag, "Failure");
      assert.deepEqual(requests, []);
      assert.deepEqual(resolutions, [{ threadId: sourceThreadId, fidelity: "metadata" }]);
      assert.deepEqual(order, ["lane:open"]);
    }),
  );

  it.effect("forks a legacy Thread on an older host using the native identity", () =>
    Effect.gen(function* () {
      const { capability, order, requests, resolutions } = makeHarness({
        sourceHistoryMode: "legacy",
        appServerVersion: "0.143.0-alpha.32",
      });
      const forks = yield* capability;
      const exit = yield* Effect.exit(
        forks.fork({
          sourceThreadId,
          lastTurnId: "turn-a",
          threadSource: "user",
        }),
      );

      assert.strictEqual(exit._tag, "Success");
      assert.strictEqual(requests[0]?.method, "thread/fork");
      assert.deepEqual(resolutions, [{ threadId: sourceThreadId, fidelity: "metadata" }]);
      assert.ok(order.includes("manager:resume"));
    }),
  );

  it.effect("fences a stale app-server generation before the fork mutation", () =>
    Effect.gen(function* () {
      const { capability, order, requests } = makeHarness({ capabilityIsCurrent: false });
      const forks = yield* capability;
      const exit = yield* Effect.exit(
        forks.fork({ sourceThreadId, lastTurnId: "turn-a", threadSource: "user" }),
      );

      assert.strictEqual(exit._tag, "Failure");
      assert.deepEqual(requests, []);
      assert.deepEqual(order, ["lane:open"]);
    }),
  );

  it.effect("fails closed when handoff changes the durable host before fork dispatch", () =>
    Effect.gen(function* () {
      const { capability, order, requests } = makeHarness({
        currentExecutionHostId: "host-b",
      });
      const forks = yield* capability;

      const exit = yield* Effect.exit(
        forks.fork({ sourceThreadId, lastTurnId: "turn-a", threadSource: "user" }),
      );

      assert.strictEqual(exit._tag, "Failure");
      assert.deepEqual(requests, []);
      assert.deepEqual(order, ["lane:open"]);
    }),
  );

  it.effect("preserves mutation outcome-unknown failures without retrying the fork", () =>
    Effect.gen(function* () {
      const unknown = codexRuntimeError({
        operation: "scheduler.execution",
        reason: "outcome-unknown",
        retryable: false,
        hostId: "host-a",
        generation: 7,
        method: "thread/fork",
      });
      const { capability, requests } = makeHarness({ gatewayFailure: unknown });
      const forks = yield* capability;
      const failure = yield* Effect.flip(
        forks.fork({ sourceThreadId, lastTurnId: "turn-a", threadSource: "user" }),
      );

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(failure.operation, "fork");
      assert.strictEqual(failure.cause, unknown);
    }),
  );

  it.effect("rejects an explicitly blank stable Turn identity instead of widening the fork", () =>
    Effect.gen(function* () {
      const { capability, requests } = makeHarness();
      const forks = yield* capability;
      const exit = yield* Effect.exit(
        forks.fork({ sourceThreadId, lastTurnId: "   ", threadSource: "user" }),
      );

      assert.strictEqual(exit._tag, "Failure");
      assert.deepEqual(requests, []);
    }),
  );

  it.effect(
    "renderer fork admission returns raw response and accepts durable identity without a Main document",
    () =>
      Effect.gen(function* () {
        const { capability, order, requests } = makeHarness();
        const forks = yield* capability;
        const prepared = yield* forks.prepareRenderer({
          sourceThreadId,
          lastTurnId: "turn-a",
          threadSource: "user",
        });
        assert.strictEqual(requests.length, 0);
        const response = yield* forks.executeRenderer(prepared.receiptId);
        assert.strictEqual(response.thread.id, childThreadId);
        assert.strictEqual(order.includes("manager:resume"), false);
        const accepted = yield* forks.acceptRenderer(prepared.receiptId);
        assert.strictEqual(accepted.threadId, childThreadId);
        assert.strictEqual(order.includes("manager:resume"), false);
        assert.strictEqual(
          order.some((entry) => entry.startsWith("projection:")),
          false,
        );
        const duplicate = yield* forks.executeRenderer(prepared.receiptId).pipe(Effect.exit);
        assert.strictEqual(duplicate._tag, "Failure");
        yield* forks.releaseRenderer(prepared.receiptId);
        const late = yield* forks.acceptRenderer(prepared.receiptId).pipe(Effect.exit);
        assert.strictEqual(late._tag, "Failure");
      }),
  );

  it.effect("requires an actual remote native owner before direct or renderer fork dispatch", () =>
    Effect.gen(function* () {
      const fixture = makeHarness({ localHostId: "host-a" });
      const forks = yield* fixture.capability;
      const input = { sourceThreadId, threadSource: "user" as const };
      const direct = yield* forks.fork(input).pipe(Effect.flip);
      const prepared = yield* forks.prepareRenderer(input).pipe(Effect.flip);
      assert.equal(direct.operation, "admit");
      assert.equal(prepared.operation, "admit");
      assert.deepEqual(fixture.requests, []);
    }),
  );
});

describe("CodexMainConversationManagers", () => {
  const make = makeCodexMainConversationManagers;
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

  it.effect(
    "shares resident history without native resume and respects an existing peer owner",
    () =>
      Effect.gen(function* () {
        const endpoint = yield* network;
        const first = yield* build(endpoint);
        const second = yield* build(endpoint);
        const owner = yield* first.managers.get("local");
        const follower = yield* second.managers.get("local");
        first.entities.entity("thread").acceptCanonicalState(conversationFixture("thread"));
        yield* first.managers.shareResident("local", "thread");
        const ownerId = yield* Effect.tryPromise(() => follower.findOwner("thread"));
        if (!ownerId) throw new Error("Owner missing");
        second.entities.entity("thread").acceptCanonicalState(conversationFixture("thread"));
        yield* second.managers.shareResident("local", "thread");
        yield* Effect.tryPromise(() => follower.stream.waitForRevision("thread", ownerId, 1, 1000));
        assert.strictEqual(second.entities.current("thread")?.readCanonicalState()?.id, "thread");
        assert.strictEqual(follower.stream.getRole("thread")?.role, "follower");
        assert.strictEqual(owner.stream.getRevision("thread"), 1);
        assert.strictEqual(owner.stream.getRole("thread")?.role, "owner");
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
          data: [
            { rootTurnId: null, id: "older", items: [], itemsView: "full", status: "completed" },
          ],
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
            window.documents.get("thread")!.turnHistory!.history.entitiesByKey["turn:tail"]!
              .items[0]?.id,
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

  it.effect(
    "only current-generation retention notifications release passive canonical history",
    () =>
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
                  moderation: null,
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
});

describe("CodexConversationContext", () => {
  const canonicalDocument = (
    id: string,
    overrides: Partial<CodexCanonicalConversationState> = {},
  ): CodexCanonicalConversationState => ({
    id,
    hostId: "local",
    sessionId: `session-${id}`,
    ephemeral: true,
    forkedFromId: null,
    parentThreadId: null,
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    title: null,
    latestModel: "gpt-context",
    latestReasoningEffort: null,
    latestCollaborationMode: {
      mode: "default",
      settings: { model: "gpt-context", reasoning_effort: null, developer_instructions: null },
    },
    threadRuntimeStatus: { type: "idle" },
    rolloutPath: "",
    cwd: "/repo/canonical",
    gitInfo: null,
    resumeState: "resumed",
    hasUnreadTurn: false,
    hydrationContext: null,
    turns: [],
    requests: [],
    ...overrides,
  });

  interface DurableContextFixture {
    readonly project_id: string | null;
    readonly parent_thread_id: string | null;
    readonly cwd: string | null;
  }

  const makeContextHarness = (
    durable: Readonly<Record<string, DurableContextFixture>> = {},
    beforeRead: (threadId: string) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(conversationEntityMapLive);
      const conversations = Context.get(services, ConversationEntityMap);
      const workspace: CoreModuleClients["workspace"] = {
        admitToolOperation: () => Effect.die("Unexpected application tool admission"),
        recordAgentRun: () => Effect.die("Unexpected Agent attribution"),
        read: (query) => {
          if (query.kind !== "thread") return Effect.fail(notFound(query.kind));
          return beforeRead(query.thread_id).pipe(
            Effect.andThen(
              durable[query.thread_id]
                ? Effect.succeed({
                    value: {
                      kind: "thread",
                      thread: { thread_id: query.thread_id, ...durable[query.thread_id] },
                    },
                  } as never)
                : Effect.fail(notFound(query.kind)),
            ),
          );
        },
        apply: () => Effect.die("unused"),
      };
      const context = yield* makeConversationContext.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, CoreModules.of({ workspace } as CoreModuleClients)),
      );
      return { context, conversations };
    });

  const notFound = (kind: string) =>
    new CoreRuntimeError({
      message: `Missing ${kind}`,
      operation: `workspace:${kind}`,
      reason: "operation",
      retryable: false,
      cause: new CoreModuleResponseError({
        code: "not_found",
        message: `Missing ${kind}`,
        retryable: false,
        recovery: { kind: "none" },
      }),
    });

  it.effect(
    "inherits ephemeral Side Chat lineage and execution context from the live aggregate",
    () =>
      Effect.gen(function* () {
        const childSnapshot = {
          threadId: "side-chat",
          ephemeral: true,
          projectId: "project-a",
          cwd: "/repo/side-chat",
          source: { parentThreadId: "parent-thread" },
        } as unknown as CodexConversationSnapshot;
        const childCanonical = {
          hydrationContext: {
            cwd: "/repo/side-chat",
          },
          currentPermissions: { runtimeWorkspaceRoots: ["/repo/side-chat"] },
        } as unknown as CodexCanonicalConversationState;
        const aggregate = (
          snapshot: CodexConversationSnapshot,
          canonical: CodexCanonicalConversationState,
        ) =>
          ({
            readSnapshot: () => snapshot,
            readCanonicalState: () => canonical,
          }) as unknown as ConversationEntityState;
        const conversations = ConversationEntityMap.of({
          registerThreadMetadata: () => {},
          readThreadMetadata: () => null,
          current: (threadId: string) =>
            threadId === "side-chat"
              ? aggregate(childSnapshot, childCanonical)
              : threadId === "parent-thread"
                ? aggregate(
                    {
                      threadId,
                      ephemeral: false,
                      projectId: "project-a",
                      source: { parentThreadId: null },
                    } as unknown as CodexConversationSnapshot,
                    {} as CodexCanonicalConversationState,
                  )
                : null,
        } as unknown as ConversationEntityMap["Service"]);
        const workspace: CoreModuleClients["workspace"] = {
          admitToolOperation: () => Effect.die("Unexpected application tool admission"),
          recordAgentRun: () => Effect.die("Unexpected Agent attribution"),
          read: (read) => {
            if (read.kind === "thread" && read.thread_id === "parent-thread") {
              return Effect.succeed({
                value: {
                  kind: "thread",
                  thread: {
                    thread_id: "parent-thread",
                    project_id: "project-a",
                    parent_thread_id: null,
                    cwd: "/repo/parent",
                  },
                },
              } as never);
            }
            return Effect.fail(notFound(read.kind));
          },
          apply: () => Effect.die("unused"),
        };
        const context = yield* makeConversationContext.pipe(
          Effect.provideService(ConversationEntityMap, conversations),
          Effect.provideService(
            CoreModules,
            CoreModules.of({ workspace } as unknown as CoreModuleClients),
          ),
        );

        assert.deepEqual(yield* context.read("side-chat"), {
          threadId: "side-chat",
          parentThreadId: "parent-thread",
          rootThreadId: "parent-thread",
          projectId: "project-a",
          cwd: "/repo/side-chat",
          writableRoots: ["/repo/side-chat"],
        });
      }),
  );

  it.effect("resolves canonical-only side-chat lineage without materializing a presentation", () =>
    Effect.gen(function* () {
      const { context, conversations } = yield* makeContextHarness({
        root: { project_id: "root-project", parent_thread_id: null, cwd: "/repo/root" },
      });
      const side = conversations.entity("side");
      side.installFollowerCanonicalState(
        canonicalDocument("side", { sideConversation: true, forkedFromId: "middle" }),
      );
      conversations.entity("middle").installFollowerCanonicalState(
        canonicalDocument("middle", {
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "root",
                depth: 1,
                agent_path: null,
                agent_nickname: null,
                agent_role: null,
              },
            },
          },
        }),
      );

      assert.deepEqual(yield* context.read("side"), {
        threadId: "side",
        parentThreadId: "middle",
        rootThreadId: "root",
        projectId: "root-project",
        cwd: "/repo/canonical",
        writableRoots: ["/repo/canonical"],
      });
      assert.isNull(side.readSnapshot());
      assert.isNull(conversations.current("middle")?.readSnapshot());
    }),
  );

  it.effect.each(["canonical", "presentation", "durable"] as const)(
    "preserves an explicit projectless assignment from %s instead of inheriting an ancestor",
    (source) =>
      Effect.gen(function* () {
        const { context, conversations } = yield* makeContextHarness({
          root: { project_id: "root-project", parent_thread_id: null, cwd: "/repo/root" },
          ...(source === "durable"
            ? { child: { project_id: null, parent_thread_id: "root", cwd: "/repo/durable" } }
            : {}),
        });
        const child = conversations.entity("child");
        if (source === "presentation") {
          child.installSnapshot({
            threadId: "child",
            ephemeral: true,
            projectId: null,
            cwd: "/repo/child",
            source: { parentThreadId: "root" },
          } as CodexConversationSnapshot);
        } else {
          child.installFollowerCanonicalState(
            canonicalDocument("child", {
              ephemeral: source !== "durable",
              parentThreadId: "root",
              ...(source === "canonical" ? { workspaceKind: "projectless" } : {}),
            }),
          );
        }

        const result = yield* context.read("child");
        assert.strictEqual(result.parentThreadId, "root");
        assert.strictEqual(result.rootThreadId, "root");
        assert.isNull(result.projectId);
        assert.strictEqual(
          result.cwd,
          source === "durable"
            ? "/repo/durable"
            : source === "presentation"
              ? "/repo/child"
              : "/repo/canonical",
        );
      }),
  );

  it.effect.each([true, false])(
    "distinguishes a side-chat parent from native subagent ancestry (side: %s)",
    (sideConversation) =>
      Effect.gen(function* () {
        const { context, conversations } = yield* makeContextHarness({
          origin: { project_id: "origin-project", parent_thread_id: null, cwd: "/repo/origin" },
          ancestor: {
            project_id: "ancestor-project",
            parent_thread_id: null,
            cwd: "/repo/ancestor",
          },
        });
        conversations.entity("child").installFollowerCanonicalState(
          canonicalDocument("child", {
            sideConversation,
            forkedFromId: "origin",
            parentThreadId: "ancestor",
          }),
        );
        const result = yield* context.read("child");
        assert.strictEqual(result.parentThreadId, sideConversation ? "origin" : "ancestor");
        assert.strictEqual(result.rootThreadId, sideConversation ? "origin" : "ancestor");
        assert.strictEqual(
          result.projectId,
          sideConversation ? "origin-project" : "ancestor-project",
        );
        assert.strictEqual(
          conversations.current("child")?.readCanonicalState()?.parentThreadId,
          "ancestor",
        );
      }),
  );

  it.effect("keeps an explicit durable root separate from stale live lineage", () =>
    Effect.gen(function* () {
      const { context, conversations } = yield* makeContextHarness({
        child: { project_id: null, parent_thread_id: null, cwd: "/repo/durable" },
        stale: { project_id: "stale-project", parent_thread_id: null, cwd: "/repo/stale" },
      });
      conversations
        .entity("child")
        .installFollowerCanonicalState(
          canonicalDocument("child", { ephemeral: false, parentThreadId: "stale" }),
        );
      const result = yield* context.read("child");
      assert.isNull(result.parentThreadId);
      assert.strictEqual(result.rootThreadId, "child");
      assert.isNull(result.projectId);
      assert.strictEqual(result.cwd, "/repo/durable");
    }),
  );

  it.effect("rejects lineage read from a generation retired during an ancestor lookup", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { context, conversations } = yield* makeContextHarness(
        { root: { project_id: "root-project", parent_thread_id: null, cwd: "/repo/root" } },
        (threadId) =>
          threadId === "root"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
      );
      conversations
        .entity("child")
        .installFollowerCanonicalState(canonicalDocument("child", { parentThreadId: "root" }));
      const pending = yield* context.read("child").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* conversations.retire("child");
      conversations
        .entity("child")
        .installFollowerCanonicalState(canonicalDocument("child", { cwd: "/repo/successor" }));
      yield* Deferred.succeed(release, undefined);

      const failure = yield* Fiber.join(pending).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "CodexConversationContextError");
      assert.include(String(failure.cause), "generation");
      assert.strictEqual(
        conversations.current("child")?.readCanonicalState()?.cwd,
        "/repo/successor",
      );
    }),
  );
});

import type { Thread, Turn } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import {
  CodexConversationProjection,
  make as makeConversationProjection,
} from "./CodexConversationProjection";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";
import { makeCodexRendererConversationRegistryState } from "./CodexRendererConversationRegistry";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { make as makeDirectory } from "./CodexThreadDirectory";
import { CodexHistoryPageAdapter, make as makeHistoryPageAdapter } from "./CodexHistoryPageAdapter";

type CoreThread = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "thread" }
>["thread"];
type RequestOnHost = CodexGateway["Service"]["requestOnHost"];
type RequestForThread = CodexGateway["Service"]["requestForThread"];

const coreThread = (threadId: string, overrides: Partial<CoreThread> = {}): CoreThread =>
  ({
    thread_id: threadId,
    project_id: "project-a",
    session_id: null,
    forked_from_id: null,
    parent_thread_id: null,
    thread_source: null,
    service_name: null,
    agent_nickname: null,
    agent_role: null,
    agent_path: null,
    thread_name: threadId,
    thread_preview: "",
    backend_binding: { kind: "codex" },
    model_id: "gpt-test",
    reasoning_effort: "high",
    service_tier: null,
    execution_host_id: "remote-a",
    cwd: "/repo",
    writable_roots: ["/repo"],
    managed_worktree_path: null,
    projectless_output_directory: null,
    projectless_workspace_browser_root: null,
    status: { status_type: "idle", active_flags: [] },
    archived: false,
    pinned_order: null,
    has_unread_turn: false,
    dynamic_tool_catalogs: [],
    created_at: 100_000,
    updated_at: 100_000,
    recency_at: 100_000,
    linked_at: "2026-08-23T00:00:00.000Z",
    ...overrides,
  }) satisfies CoreThread;

const appThread = (threadId: string, turns: Thread["turns"] = []): Thread => ({
  id: threadId,
  extra: null,
  sessionId: `session-${threadId}`,
  forkedFromId: null,
  parentThreadId: null,
  preview: "Hydrated transcript",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 100,
  updatedAt: 120,
  recencyAt: 120,
  status: { type: "idle" },
  path: null,
  cwd: "/repo",
  cliVersion: "test",
  source: "unknown",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Hydrated Thread",
  turns: [...turns],
});

const notFound = (threadId: string) =>
  new CoreRuntimeError({
    message: `Missing ${threadId}`,
    operation: "workspace.read",
    reason: "operation",
    retryable: false,
    cause: new CoreModuleResponseError({
      code: "not_found",
      message: `Missing ${threadId}`,
      retryable: false,
      recovery: { kind: "none" },
    }),
  });

const makeCore = (threads: Map<string, CoreThread>): CoreModules["Service"] => {
  const read: CoreModuleClients["workspace"]["read"] = (input) => {
    if (input.kind === "execution_context") {
      const thread = threads.get(input.thread_id);
      return thread
        ? Effect.succeed({
            value: { kind: "execution_context", context: { thread, project: null } },
          } as ProjectWorkspaceReadSnapshot)
        : Effect.fail(notFound(input.thread_id));
    }
    if (input.kind !== "thread") return Effect.die(new Error("Unexpected Core read"));
    const threadId = input.thread_id;
    const thread = threads.get(threadId);
    return thread
      ? Effect.succeed({ value: { kind: "thread", thread } } as ProjectWorkspaceReadSnapshot)
      : Effect.fail(notFound(threadId));
  };
  const apply: CoreModuleClients["workspace"]["apply"] = (input) =>
    Effect.sync(() => {
      const intent = input.intent;
      const existing =
        "thread_id" in intent
          ? (threads.get(intent.thread_id) ?? coreThread(intent.thread_id))
          : null;
      if (intent.kind === "upsert_thread") {
        threads.set(intent.thread_id, {
          ...existing,
          ...intent.patch,
          thread_id: intent.thread_id,
        } as CoreThread);
      } else if (intent.kind === "replace_thread_dynamic_tool_catalogs" && existing) {
        threads.set(intent.thread_id, { ...existing, dynamic_tool_catalogs: intent.catalogs });
      } else if (intent.kind === "replace_thread_writable_roots" && existing) {
        threads.set(intent.thread_id, { ...existing, writable_roots: intent.roots });
      } else {
        throw new Error("Unexpected Core intent");
      }
      return {} as never;
    });
  return CoreModules.of({ workspace: { read, apply } } as unknown as CoreModuleClients);
};

const makeGateway = (
  requestOnHost: RequestOnHost,
  requestForThread?: RequestForThread,
): CodexGateway["Service"] => {
  const unsupported = () => Effect.die(new Error("Unsupported Gateway operation"));
  return CodexGateway.of({
    localHostId: "local",
    requestRawOnHost: unsupported,
    requestRawForThread: unsupported,
    events: Stream.empty,
    requestLocal: unsupported,
    requestOnHost,
    requestForThread: requestForThread ?? unsupported,
    notifyLocal: unsupported,
    connection: unsupported,
    connectionChanges: () => Stream.empty,
    awaitReady: () => Effect.void,
    reconcileHost: unsupported,
    removeHost: unsupported,
    restartHost: unsupported,
  });
};

const makeConversations = () => {
  const aggregates = makeConversationEntityStateRegistry();
  const runCommand: ConversationEntityMap["Service"]["runCommand"] = (_threadId, operation) =>
    operation;
  return ConversationEntityMap.of({
    entity: aggregates.acquire,
    current: aggregates.current,
    runCommand,
  } as unknown as ConversationEntityMap["Service"]);
};

const capabilitySnapshot = createCodexAppServerCapabilitySnapshot({
  hostId: "remote-a",
  generation: 1,
  userAgent: "codex-app-server/0.147.0",
});

const directoryFoundations = makeDirectory.pipe(
  Effect.provideService(
    CodexHistoryPageAdapter,
    CodexHistoryPageAdapter.of({
      loadTurnPage: () => Effect.die("unused"),
      loadTurnItemsPage: () => Effect.die("unused"),
    }),
  ),
  Effect.provideService(
    CodexAppServerCapabilities,
    CodexAppServerCapabilities.of({
      forHost: () => Effect.succeed(capabilitySnapshot),
      forThread: () => Effect.succeed(capabilitySnapshot),
      isCurrent: () => Effect.succeed(true),
    }),
  ),
);

it.effect("accepts rollback as one durable and canonical replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([["thread-a", coreThread("thread-a", { has_unread_turn: true })]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      conversations.entity("thread-a").seedHasUnreadTurn(true);
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(
          CodexGateway,
          makeGateway((() => Effect.die("unused")) as RequestOnHost),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const accepted = yield* directory.acceptRollbackResult({
        expectedThreadId: "thread-a",
        thread: appThread("thread-a"),
        fallbackCwd: "/repo",
        pagination: {
          olderCursor: null,
          backwardsCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: true,
          loadedTurnCount: 0,
          itemsView: "full",
        },
      });

      assert.isFalse(accepted.durable.hasUnreadTurn);
      assert.isFalse(accepted.canonical?.sidecar.hasUnreadTurn ?? true);
      assert.deepEqual(accepted.canonical?.requests, []);
      assert.deepEqual(conversations.current("thread-a")?.readSnapshot(), accepted.snapshot);
    }),
  ),
);

it.effect("rejects inline history from a standalone start before it mutates durable state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map<string, CoreThread>();
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(
          CodexGateway,
          makeGateway((() => Effect.die("unused")) as RequestOnHost),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );
      const poisonTurn: Turn = {
        id: "turn-poison",
        items: Array.from({ length: 1_000 }, (_, index) => ({
          type: "agentMessage",
          id: `poison-${index}`,
          text: "must not become resident",
          phase: null,
          memoryCitation: null,
          delivery: null,
        })),
        status: "completed",
        error: null,
        itemsView: "full",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1_000,
      };

      const accepted = yield* Effect.exit(
        directory.acceptStandaloneStart({
          response: {
            cwd: "/repo",
            thread: appThread("thread-started", [poisonTurn]),
            model: "gpt-test",
            modelProvider: "openai",
            serviceTier: null,
            runtimeWorkspaceRoots: ["/repo"],
            instructionSources: [],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: { type: "readOnly", networkAccess: false },
            activePermissionProfile: null,
            reasoningEffort: "high",
            multiAgentMode: "explicitRequestOnly",
          } as never,
          projectId: "project-a",
          executionProfile: null,
          runtimeWorkspaceRoots: ["/repo"],
          fallbackCwd: "/fallback",
        }),
      );

      assert.isTrue(Exit.isFailure(accepted));
      assert.deepEqual([...threads.keys()], []);
      assert.isNull(conversations.current("thread-started"));
    }),
  ),
);

it.effect("rejects inline history from metadata observations before durable persistence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map<string, CoreThread>();
      const conversations = makeConversations();
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(
          CodexApplicationEventHub,
          CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
        ),
        Effect.provideService(
          CodexConversationProjection,
          CodexConversationProjection.of({ hydrate: () => Effect.die("unused") } as never),
        ),
        Effect.provideService(
          CodexGateway,
          makeGateway((() => Effect.die("unused")) as RequestOnHost),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, makeCore(threads)),
      );
      const poisonTurn: Turn = {
        id: "turn-inline",
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };

      const observed = yield* Effect.exit(
        directory.observeMetadata({
          thread: appThread("thread-inline", [poisonTurn]),
          inferredInitialProjectId: "project-a",
          executionHostId: "remote-a",
        }),
      );

      assert.isTrue(Exit.isFailure(observed));
      assert.deepEqual([...threads.keys()], []);
      assert.isNull(conversations.current("thread-inline"));
    }),
  ),
);

it.effect("accepts a metadata-only import shell and hydrates only a bounded tail", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map<string, CoreThread>();
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const physicalRequests: Array<{ readonly method: string; readonly params: unknown }> = [];
      const tailTurn: Turn = {
        id: "turn-tail",
        items: [],
        itemsView: "notLoaded",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };
      const gateway = makeGateway(
        (() => Effect.die("unused")) as RequestOnHost,
        ((_threadId, method, params) =>
          Effect.sync(() => {
            physicalRequests.push({ method, params });
            if (method === "thread/turns/list") {
              return {
                data: [tailTurn],
                nextCursor: "turns:older",
                backwardsCursor: "turns:newer",
              };
            }
            return {
              data: [
                {
                  turnId: "turn-tail",
                  item: {
                    type: "agentMessage",
                    id: "item-tail",
                    text: "bounded tail",
                    phase: null,
                    memoryCitation: null,
                    delivery: null,
                  },
                },
              ],
              nextCursor: null,
              backwardsCursor: null,
            };
          })) as RequestForThread,
      );
      const historyPages = yield* makeHistoryPageAdapter.pipe(
        Effect.provideService(CodexGateway, gateway),
      );
      const localCapability = createCodexAppServerCapabilitySnapshot({
        hostId: "local",
        generation: 1,
        userAgent: "codex-app-server/0.147.0",
      });
      const directory = yield* makeDirectory.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(
          CodexAppServerCapabilities,
          CodexAppServerCapabilities.of({
            forHost: () => Effect.succeed(localCapability),
            forThread: () => Effect.succeed(localCapability),
            isCurrent: () => Effect.succeed(true),
          }),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );
      const thread = appThread("thread-imported");

      const accepted = yield* directory.acceptImportResult({
        response: { cwd: "/repo", thread } as never,
        capability: localCapability,
        executionHostId: "local",
        fallbackCwd: "/fallback",
      });

      assert.strictEqual(accepted.fidelity, "tail");
      assert.strictEqual(accepted.durable.projectId, null);
      assert.strictEqual(accepted.durable.executionHostId, "local");
      assert.strictEqual(accepted.durable.managedWorktreePath, null);
      assert.strictEqual(accepted.durable.cwd, "/repo");
      assert.strictEqual(accepted.canonical?.protocol.id, "thread-imported");
      assert.deepEqual(
        accepted.canonical?.turns.map((turn) => turn.protocol.id),
        ["turn-tail"],
      );
      assert.deepEqual(physicalRequests, [
        {
          method: "thread/turns/list",
          params: {
            threadId: "thread-imported",
            cursor: null,
            limit: 5,
            itemsView: "notLoaded",
            sortDirection: "desc",
          },
        },
        {
          method: "thread/items/list",
          params: {
            threadId: "thread-imported",
            turnId: "turn-tail",
            cursor: null,
            limit: 1,
            sortDirection: "desc",
          },
        },
      ]);
      assert.deepEqual(accepted.snapshot?.turnPagination, {
        olderCursor: "turns:older",
        backwardsCursor: "turns:newer",
        oldestLoadedTurnId: "turn-tail",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 1,
        itemsView: "full",
      });
      assert.deepEqual(conversations.current("thread-imported")?.readSnapshot(), accepted.snapshot);
    }),
  ),
);

it.effect("rejects inline history from an import before it persists or pages", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map<string, CoreThread>();
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(
          CodexGateway,
          makeGateway((() => Effect.die("import must not page")) as RequestOnHost),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );
      const inlineTurn: Turn = {
        id: "turn-inline",
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };

      const result = yield* Effect.exit(
        directory.acceptImportResult({
          response: { cwd: "/repo", thread: appThread("thread-imported", [inlineTurn]) } as never,
          capability: capabilitySnapshot,
          executionHostId: "remote-a",
          fallbackCwd: "/repo",
        }),
      );

      assert.isTrue(Exit.isFailure(result));
      assert.deepEqual([...threads.keys()], []);
      assert.isNull(conversations.current("thread-imported"));
    }),
  ),
);

it.effect("accepts a metadata-only fork shell with inherited durable authority", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = coreThread("thread-source", {
        project_id: "project-fork",
        execution_host_id: "remote-fork",
        managed_worktree_path: "/repo",
        dynamic_tool_catalogs: [{ namespace: "nodex", toolset_revision: 7 }],
        writable_roots: ["/repo", "/shared"],
      });
      const threads = new Map([["thread-source", source]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const historyPages = CodexHistoryPageAdapter.of({
        loadTurnPage: () => Effect.die("fork shell must not read child history"),
        loadTurnItemsPage: () => Effect.die("unused"),
      });
      const directory = yield* makeDirectory.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(
          CodexGateway,
          makeGateway((() => Effect.die("unused")) as RequestOnHost),
        ),
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(
          CodexAppServerCapabilities,
          CodexAppServerCapabilities.of({
            forHost: () => Effect.succeed(capabilitySnapshot),
            forThread: () => Effect.succeed(capabilitySnapshot),
            isCurrent: () => Effect.succeed(true),
          }),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const accepted = yield* directory.acceptForkResult({
        sourceThreadId: "thread-source",
        response: {
          thread: {
            ...appThread("thread-child"),
            forkedFromId: "thread-source",
          },
          model: "gpt-fork",
          modelProvider: "openai",
          serviceTier: "default",
          cwd: "/repo",
          runtimeWorkspaceRoots: ["/repo", "/shared"],
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: {
            type: "workspaceWrite",
            writableRoots: ["/repo", "/shared"],
            networkAccess: false,
          },
          activePermissionProfile: null,
          reasoningEffort: "high",
          multiAgentMode: "explicitRequestOnly",
        } as never,
      });

      const persisted = threads.get("thread-child");
      assert.strictEqual(accepted.durable.projectId, "project-fork");
      assert.strictEqual(accepted.durable.forkedFromId, "thread-source");
      assert.strictEqual(accepted.durable.executionHostId, "remote-fork");
      assert.strictEqual(accepted.durable.managedWorktreePath, "/repo");
      assert.strictEqual(accepted.durable.executionProfile?.modelId, "gpt-fork");
      assert.strictEqual(accepted.durable.executionProfile?.serviceTier, null);
      assert.strictEqual(
        accepted.canonical?.sidecar.hydrationContext?.latestThreadSettings?.serviceTier,
        null,
      );
      assert.deepEqual(persisted?.dynamic_tool_catalogs, [
        { namespace: "nodex", toolset_revision: 7 },
      ]);
      assert.deepEqual(persisted?.writable_roots, ["/repo", "/shared"]);
      assert.deepEqual(accepted.canonical?.turns, []);
      assert.strictEqual(accepted.snapshot?.resumeState, "needs_resume");
    }),
  ),
);

it.effect("keeps an excluded paginated fork lazy until the child is opened", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = coreThread("thread-source", {
        execution_host_id: "remote-a",
        writable_roots: ["/repo"],
      });
      const threads = new Map([["thread-source", source]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const pageInputs: unknown[] = [];
      const historyPages = CodexHistoryPageAdapter.of({
        loadTurnPage: (input) =>
          Effect.sync(() => {
            pageInputs.push(input);
            throw new Error("fork shell must not read child history");
          }),
        loadTurnItemsPage: () => Effect.die("unused"),
      });
      const directory = yield* makeDirectory.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(
          CodexGateway,
          makeGateway((() => Effect.die("unused")) as RequestOnHost),
        ),
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(
          CodexAppServerCapabilities,
          CodexAppServerCapabilities.of({
            forHost: () => Effect.succeed(capabilitySnapshot),
            forThread: () => Effect.succeed(capabilitySnapshot),
            isCurrent: () => Effect.succeed(true),
          }),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const accepted = yield* directory.acceptForkResult({
        sourceThreadId: "thread-source",
        response: {
          thread: {
            ...appThread("thread-child"),
            forkedFromId: "thread-source",
            turns: [],
          },
          model: "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/repo",
          runtimeWorkspaceRoots: ["/repo"],
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
          reasoningEffort: "high",
          multiAgentMode: "explicitRequestOnly",
        },
      });

      assert.deepEqual(pageInputs, []);
      assert.deepEqual(accepted.canonical?.turns, []);
      assert.deepEqual(accepted.snapshot?.turnPagination, {
        olderCursor: null,
        backwardsCursor: null,
        oldestLoadedTurnId: null,
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 0,
        itemsView: "notLoaded",
      });
      assert.strictEqual(accepted.snapshot?.resumeState, "needs_resume");
    }),
  ),
);

it.effect("resolves remote metadata without reading or materializing the transcript", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([["thread-a", coreThread("thread-a")]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const events: unknown[] = [];
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: (event) => events.push(event),
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const gateway = makeGateway(((hostId, method, params) => {
        assert.strictEqual(hostId, "remote-a");
        assert.strictEqual(method, "thread/read");
        assert.deepEqual(params as unknown, { threadId: "thread-a", includeTurns: false });
        return Effect.succeed({ thread: appThread("thread-a") });
      }) as RequestOnHost);
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const resolved = yield* directory.resolve({ threadId: "thread-a", fidelity: "metadata" });

      assert.strictEqual(resolved?.fidelity, "metadata");
      assert.strictEqual(resolved?.durable.threadName, "Hydrated Thread");
      assert.isNull(resolved?.canonical ?? null);
      assert.isNull(resolved?.snapshot ?? null);
      assert.isTrue(events.length > 0);
    }),
  ),
);

it.effect("never admits an ACP Thread to any Codex directory fidelity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([
        [
          "thread-acp",
          coreThread("thread-acp", {
            backend_binding: {
              kind: "acp",
              agent_definition_id: "claude-code",
              instance_config_id: null,
            },
          }),
        ],
      ]);
      const conversations = makeConversations();
      let gatewayRequests = 0;
      const gateway = makeGateway((() =>
        Effect.sync(() => {
          gatewayRequests += 1;
          return { thread: appThread("thread-acp") };
        })) as RequestOnHost);
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(
          CodexApplicationEventHub,
          CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
        ),
        Effect.provideService(
          CodexConversationProjection,
          CodexConversationProjection.of({ hydrate: () => Effect.die("unused") } as never),
        ),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, makeCore(threads)),
      );

      const results = yield* Effect.forEach(
        ["durable", "metadata", "tail", "live"] as const,
        (fidelity) =>
          directory.resolve({
            threadId: "thread-acp",
            fidelity,
            hostId: "local",
          }),
      );

      assert.deepEqual(results, [null, null, null, null]);
      assert.strictEqual(gatewayRequests, 0);
    }),
  ),
);

it.effect("hydrates an inactive paginated Thread from a bounded tail without resuming it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([["thread-a", coreThread("thread-a")]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const gatewayRequests: Array<{
        readonly method: string;
        readonly params: unknown;
        readonly scheduling: unknown;
      }> = [];
      const gateway = makeGateway(((hostId, method, params, scheduling) => {
        assert.strictEqual(hostId, "remote-a");
        gatewayRequests.push({ method, params, scheduling });
        return Effect.succeed({ thread: appThread("thread-a") });
      }) as RequestOnHost);
      const tailTurn: Turn = {
        id: "turn-tail",
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };
      const pageInputs: unknown[] = [];
      const historyPages = CodexHistoryPageAdapter.of({
        loadTurnPage: (input) => {
          pageInputs.push(input);
          return Effect.succeed({
            turns: [tailTurn],
            nextCursor: "turns:older",
            backwardsCursor: null,
            loadedItemCount: 0,
            itemSegmentsByTurnId: { [tailTurn.id]: [] },
            itemsPaginationByTurnId: {
              [tailTurn.id]: {
                olderCursor: null,
                isLoadingOlder: false,
                hasLoadedOldest: true,
                oldestUserInput: null,
                openingUserMessageId: null,
                itemsView: "full",
              },
            },
          });
        },
        loadTurnItemsPage: () => Effect.die("unused"),
      });
      const directory = yield* makeDirectory.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(
          CodexAppServerCapabilities,
          CodexAppServerCapabilities.of({
            forHost: () => Effect.succeed(capabilitySnapshot),
            forThread: () => Effect.succeed(capabilitySnapshot),
            isCurrent: () => Effect.succeed(true),
          }),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const resolved = yield* directory.resolve({ threadId: "thread-a", fidelity: "tail" });

      assert.strictEqual(resolved?.fidelity, "tail");
      assert.deepEqual(gatewayRequests, [
        {
          method: "thread/read",
          params: { threadId: "thread-a", includeTurns: false },
          scheduling: { expectedHostId: "remote-a", expectedGeneration: 1 },
        },
      ]);
      assert.deepEqual(pageInputs, [
        {
          capability: capabilitySnapshot,
          threadId: "thread-a",
          cursor: null,
          initialItemsCursor: null,
          purpose: "initial",
        },
      ]);
      assert.deepEqual(
        resolved?.canonical?.turns.map((turn) => turn.protocol.id),
        ["turn-tail"],
      );
      assert.strictEqual(resolved?.snapshot?.turnPagination?.olderCursor, "turns:older");
    }),
  ),
);

it.effect("keeps legacy tail reads metadata-only instead of loading unbounded history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([["thread-a", coreThread("thread-a")]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const requests: unknown[] = [];
      const gateway = makeGateway(((hostId, method, params) => {
        assert.strictEqual(hostId, "remote-a");
        assert.strictEqual(method, "thread/read");
        requests.push(params);
        return Effect.succeed({
          thread: { ...appThread("thread-a"), historyMode: "legacy", turns: [] },
        });
      }) as RequestOnHost);
      const legacyCapability = createCodexAppServerCapabilitySnapshot({
        hostId: "remote-a",
        generation: 1,
        userAgent: "codex-app-server/0.144.0",
      });
      const directory = yield* makeDirectory.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(
          CodexHistoryPageAdapter,
          CodexHistoryPageAdapter.of({
            loadTurnPage: () => Effect.die("legacy tail must not page"),
            loadTurnItemsPage: () => Effect.die("legacy tail must not page"),
          }),
        ),
        Effect.provideService(
          CodexAppServerCapabilities,
          CodexAppServerCapabilities.of({
            forHost: () => Effect.succeed(legacyCapability),
            forThread: () => Effect.succeed(legacyCapability),
            isCurrent: () => Effect.succeed(true),
          }),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const resolved = yield* directory.resolve({ threadId: "thread-a", fidelity: "tail" });
      const live = yield* Effect.exit(
        directory.resolve({ threadId: "thread-a", fidelity: "live" }),
      );

      assert.deepEqual(requests, [{ threadId: "thread-a", includeTurns: false }]);
      assert.strictEqual(resolved?.historyMode, "legacy");
      assert.deepEqual(resolved?.canonical?.turns, []);
      assert.strictEqual(resolved?.snapshot?.resumeState, "needs_resume");
      assert.deepEqual(resolved?.snapshot?.turnPagination, {
        olderCursor: null,
        backwardsCursor: null,
        oldestLoadedTurnId: null,
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 0,
        itemsView: "notLoaded",
      });
      assert.isTrue(Exit.isFailure(live));
    }),
  ),
);

it.effect("resumes paginated Threads metadata-first and hydrates one bounded tail page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([["thread-a", coreThread("thread-a")]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(
          CodexRendererConversationRegistry,
          makeCodexRendererConversationRegistryState(),
        ),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const resumeRequests: Array<{ readonly params: unknown; readonly scheduling: unknown }> = [];
      const gateway = makeGateway(((hostId, method, params, scheduling) => {
        assert.strictEqual(hostId, "remote-a");
        assert.strictEqual(method, "thread/resume");
        resumeRequests.push({ params, scheduling });
        return Effect.succeed({
          thread: appThread("thread-a"),
          model: "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/repo",
          runtimeWorkspaceRoots: ["/repo"],
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
          reasoningEffort: "high",
          multiAgentMode: "explicitRequestOnly",
          turnsBackwardsCursor: "turns:tail",
          itemsBackwardsCursor: "items:tail",
        } as never);
      }) as RequestOnHost);
      const pageInputs: unknown[] = [];
      const tailTurn: Turn = {
        id: "turn-tail",
        items: [],
        itemsView: "summary",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };
      const historyPages = CodexHistoryPageAdapter.of({
        loadTurnPage: (input) => {
          pageInputs.push(input);
          return Effect.succeed({
            turns: [tailTurn],
            nextCursor: "turns:older",
            backwardsCursor: "turns:newer",
            loadedItemCount: 0,
            itemSegmentsByTurnId: { [tailTurn.id]: [] },
            itemsPaginationByTurnId: {
              [tailTurn.id]: {
                olderCursor: "items:older",
                isLoadingOlder: false,
                hasLoadedOldest: false,
                oldestUserInput: [{ type: "text", text: "opening prompt", text_elements: [] }],
                openingUserMessageId: "item-opening",
                itemsView: "summary",
              },
            },
          });
        },
        loadTurnItemsPage: () => Effect.die("unused"),
      });
      const directory = yield* makeDirectory.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(CodexHistoryPageAdapter, historyPages),
        Effect.provideService(
          CodexAppServerCapabilities,
          CodexAppServerCapabilities.of({
            forHost: () => Effect.succeed(capabilitySnapshot),
            forThread: () => Effect.succeed(capabilitySnapshot),
            isCurrent: () => Effect.succeed(true),
          }),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const resolved = yield* directory.resolve({ threadId: "thread-a", fidelity: "live" });

      assert.deepEqual(resumeRequests, [
        {
          params: { threadId: "thread-a", excludeTurns: true },
          scheduling: { expectedHostId: "remote-a", expectedGeneration: 1 },
        },
      ]);
      assert.deepEqual(pageInputs, [
        {
          capability: capabilitySnapshot,
          threadId: "thread-a",
          cursor: "turns:tail",
          initialItemsCursor: "items:tail",
          purpose: "initial",
        },
      ]);
      assert.deepEqual(resolved?.snapshot?.turnPagination, {
        olderCursor: "turns:older",
        backwardsCursor: "turns:newer",
        oldestLoadedTurnId: "turn-tail",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 1,
        itemsView: "summary",
      });
      assert.deepEqual(resolved?.canonical?.turns[0]?.sidecar.params.input, [
        { type: "text", text: "opening prompt", text_elements: [] },
      ]);
      assert.deepEqual(conversations.current("thread-a")?.readTurnItemsPagination("turn-tail"), {
        olderCursor: "items:older",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        oldestUserInput: [{ type: "text", text: "opening prompt", text_elements: [] }],
        openingUserMessageId: "item-opening",
        itemsView: "summary",
      });
    }),
  ),
);

it.effect("owner Scope close interrupts an in-flight remote hydration", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const core = makeCore(new Map([["thread-a", coreThread("thread-a")]]));
    const conversations = makeConversations();
    let interrupted = false;
    const gateway = makeGateway((() =>
      Effect.never.pipe(
        Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
      )) as RequestOnHost);
    const directory = yield* directoryFoundations.pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
      ),
      Effect.provideService(
        CodexConversationProjection,
        CodexConversationProjection.of({ hydrate: () => Effect.die("unused") } as never),
      ),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(ConversationEntityMap, conversations),
      Effect.provideService(CoreModules, core),
      Effect.provideService(Scope.Scope, ownerScope),
    );
    const resolve = yield* Effect.forkChild(
      directory.resolve({ threadId: "thread-a", fidelity: "live" }),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    yield* Scope.close(ownerScope, Exit.void);

    assert.strictEqual((yield* Fiber.await(resolve))._tag, "Failure");
    assert.isTrue(interrupted);
  }),
);

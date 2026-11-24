import { castDraft } from "immer";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  residentConversationTurns,
  residentConversationTurnEntries,
  conversationTurnDraft,
} from "../../shared/codex-conversation-state/codex-turn-mutation";
import {
  buildCodexDesktopThreadFeatureConfig,
  buildCodexThreadConfig,
} from "../codex/codex-thread-config";
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
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { makeTestApplicationSettings } from "../settings/ApplicationSettings.test-support";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import {
  CodexConversationProjection,
  make as makeConversationProjection,
} from "./CodexConversationProjection";
import { CodexGitProbe } from "./CodexGitProbe";
import { makeTestCodexGitProbe } from "./CodexGitProbe.test-support";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { make as makeDirectory } from "./CodexThreadDirectory";
import {
  projectCodexThreadDirectoryMaterialization,
  projectCoreWorkspaceThread,
} from "./CodexThreadDirectoryProjection";
import { CodexHistoryPageAdapter, make as makeHistoryPageAdapter } from "./CodexHistoryPageAdapter";

type CoreThread = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  {
    readonly kind: "thread";
  }
>["thread"];
type RequestOnHost = CodexGateway["Service"]["requestOnHost"];
type RequestForThread = CodexGateway["Service"]["requestForThread"];

// Native success fixtures obey the same UUID contract as the app-server.
const nativeThreadIds = {
  main: "00000000-0000-4000-8000-000000000001",
  started: "00000000-0000-4000-8000-000000000002",
  legacy: "00000000-0000-4000-8000-000000000003",
  unversioned: "00000000-0000-4000-8000-000000000004",
  inline: "00000000-0000-4000-8000-000000000005",
  imported: "00000000-0000-4000-8000-000000000006",
  source: "00000000-0000-4000-8000-000000000007",
  fork: "00000000-0000-4000-8000-000000000008",
  foreign: "00000000-0000-4000-8000-000000000009",
  projectless: "00000000-0000-4000-8000-000000000010",
  moving: "00000000-0000-4000-8000-000000000011",
  durable: "00000000-0000-4000-8000-000000000012",
  other: "00000000-0000-4000-8000-000000000013",
  child: "00000000-0000-4000-8000-000000000014",
  root: "00000000-0000-4000-8000-000000000015",
} as const;

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
    backend_binding: { driver: "codex", instanceId: "codex" },
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
    created_at: 100000,
    updated_at: 100000,
    recency_at: 100000,
    linked_at: "2026-08-23T00:00:00.000Z",
    ...overrides,
  }) satisfies CoreThread;

const appThread = (threadId: string, turns: Thread["turns"] = []): Thread => ({
  model: null,
  reasoningEffort: null,
  id: threadId,
  environments: null,
  extra: null,
  sessionId: `session-${threadId}`,
  forkedFromId: null,
  attachedToThreadId: null,
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
  originator: null,
  source: "unknown",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Hydrated Thread",
  daybreakEnabled: null,
  turns: [...turns],
});

it("preserves explicit settings and known settings when model metadata is unavailable", () => {
  const existing = projectCoreWorkspaceThread(
    coreThread(nativeThreadIds.main, { service_tier: "flex" }),
  );
  const input = {
    thread: appThread(nativeThreadIds.main),
    existing,
    parent: null,
    nowMs: 120000,
  };
  const unavailable = projectCodexThreadDirectoryMaterialization(input);
  assert.strictEqual(unavailable?.patch.model_id, "gpt-test");
  assert.strictEqual(unavailable?.patch.reasoning_effort, "high");
  assert.strictEqual(unavailable?.patch.service_tier, "flex");

  const explicit = projectCodexThreadDirectoryMaterialization({
    ...input,
    thread: { ...input.thread, model: "gpt-observed", reasoningEffort: "low" },
    executionProfile: { modelId: "gpt-explicit", reasoningEffort: "max", serviceTier: null },
  });
  assert.strictEqual(explicit?.patch.model_id, "gpt-explicit");
  assert.strictEqual(explicit?.patch.reasoning_effort, "max");
  assert.isNull(explicit?.patch.service_tier);
});

it("uses configured model metadata and treats null effort as unset without changing service tier", () => {
  const materialized = projectCodexThreadDirectoryMaterialization({
    thread: { ...appThread(nativeThreadIds.main), model: "gpt-observed", reasoningEffort: null },
    existing: projectCoreWorkspaceThread(
      coreThread(nativeThreadIds.main, { service_tier: "flex" }),
    ),
    parent: null,
    nowMs: 120000,
  });
  assert.strictEqual(materialized?.patch.model_id, "gpt-observed");
  assert.isNull(materialized?.patch.reasoning_effort);
  assert.strictEqual(materialized?.patch.service_tier, "flex");
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

const makeCore = (
  threads: Map<string, CoreThread>,
  workspaceStates = new Map<string, unknown>(),
): CoreModules["Service"] => {
  const read: CoreModuleClients["workspace"]["read"] = (input) => {
    if (input.kind === "execution_context") {
      const thread = threads.get(input.thread_id);
      return thread
        ? Effect.succeed({
            value: {
              kind: "execution_context",
              context: {
                thread,
                project: null,
                ...(workspaceStates.has(input.thread_id)
                  ? { workspace_state: workspaceStates.get(input.thread_id) }
                  : {}),
              },
            },
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
      } else if (intent.kind === "mutate_session" && intent.intent.kind === "link_thread") {
        const thread = threads.get(intent.intent.thread_id)!;
        assert.strictEqual(intent.intent.expected_project_id, thread.project_id);
        threads.set(intent.intent.thread_id, { ...thread, session_id: intent.session_id });
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
  localHostId = "local",
  options?: { readonly passthroughRequestSettings?: boolean },
): CodexGateway["Service"] => {
  const unsupported = () => Effect.die(new Error("Unsupported Gateway operation"));
  return CodexGateway.of({
    promoteQueuedCatalogPage: Effect.succeed(false),
    localHostId,
    requestRawOnHost: unsupported,
    requestRawForThread: unsupported,
    events: Stream.empty,
    requestLocal: unsupported,
    requestOnHost: (hostId, method, params, scheduling) => {
      if (!options?.passthroughRequestSettings && method === "config/read") {
        return Effect.succeed({ config: {}, origins: {}, layers: null }) as never;
      }
      if (!options?.passthroughRequestSettings && method === "experimentalFeature/list") {
        return Effect.succeed({ data: [], nextCursor: null }) as never;
      }
      return requestOnHost(hostId, method, params, scheduling);
    },
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
    registerThreadMetadata: aggregates.registerThreadMetadata,
    readThreadMetadata: aggregates.readThreadMetadata,
    entity: aggregates.acquire,
    current: aggregates.current,
    runCommand,
  } as unknown as ConversationEntityMap["Service"]);
};

const capabilitySnapshot = createCodexAppServerCapabilitySnapshot({
  hostId: "remote-a",
  generation: 1,
  userAgent: "nodex/0.147.0 (Mac OS 26.6.1; arm64) unknown (nodex; 0.5.0)",
});

const localCapabilitySnapshot = createCodexAppServerCapabilitySnapshot({
  hostId: "local",
  generation: 1,
  userAgent: "codex-app-server/0.147.0",
  nativeAppTools: true,
});

const directoryWithRequestSettings = makeDirectory.pipe(
  Effect.provideService(ApplicationSettings, makeTestApplicationSettings()),
  Effect.provideService(CodexGitProbe, makeTestCodexGitProbe()),
);

const directoryFoundations = directoryWithRequestSettings.pipe(
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

const boundaryDirectory = Effect.fn("CodexThreadDirectory.testBoundary")(function* (
  threads = new Map<string, CoreThread>(),
) {
  const conversations = makeConversations();
  const requests: string[] = [];
  const directory = yield* directoryFoundations.pipe(
    Effect.provideService(
      CodexApplicationEventHub,
      CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
    ),
    Effect.provideService(
      CodexConversationProjection,
      CodexConversationProjection.of({
        hydrate: () => Effect.die("Unexpected hydration"),
      } as never),
    ),
    Effect.provideService(
      CodexGateway,
      makeGateway(((hostId, method) => {
        requests.push(`${hostId}:${method}`);
        return Effect.die("A foreign identity reached the native Codex gateway");
      }) as RequestOnHost),
    ),
    Effect.provideService(ConversationEntityMap, conversations),
    Effect.provideService(CoreModules, makeCore(threads)),
  );
  return { directory, conversations, requests, threads };
});

const nonNativeThreadIds = [
  { label: "Runtime root", threadId: "nodex:thread:root" },
  { label: "delegated task", threadId: "thread:task:abcdefghijklmnopqrstuv" },
  {
    label: "Codex provider child",
    threadId: `thread:provider:codex:native-thread:${nativeThreadIds.child}`,
  },
  {
    label: "Claude provider child",
    threadId: "thread:provider:claudeAgent:native-thread:parent%3Atask-1",
  },
  {
    label: "ACP provider child",
    threadId: "thread:provider:acpRegistry:provider-instance:kimi:native-thread:session%3Atask-1",
  },
  { label: "unknown identity", threadId: "thread:missing" },
  { label: "Session identity", threadId: "session:chat" },
  { label: "ProviderThread identity", threadId: "provider-thread:provider:codex:native-thread:id" },
  { label: "blank identity", threadId: " " },
];

it.effect.each(nonNativeThreadIds)(
  "keeps $label out of every native read path when Core has no Thread",
  ({ threadId }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { directory, requests, threads } = yield* boundaryDirectory();
        const results = yield* Effect.forEach(
          ["durable", "metadata", "tail", "live"] as const,
          (fidelity) => directory.resolve({ threadId, fidelity, hostId: "local" }),
        );
        assert.deepEqual(results, [null, null, null, null]);
        assert.isNull(yield* directory.materializeInCurrentLane({ threadId, hostId: "local" }));
        assert.isNull(yield* directory.refreshMetadataInCurrentLane({ threadId, hostId: "local" }));
        assert.strictEqual((yield* Effect.exit(directory.prepareResume(threadId)))._tag, "Failure");
        assert.strictEqual(
          (yield* Effect.exit(directory.prepareHistoryHydration(threadId)))._tag,
          "Failure",
        );
        assert.deepEqual(requests, []);
        assert.strictEqual(threads.size, 0);
      }),
    ),
);

it.effect(
  "rejects a Runtime identity in accepted native results before persistence or history reads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { directory, conversations, requests, threads } = yield* boundaryDirectory();
        const threadId = "thread:task:abcdefghijklmnopqrstuv";
        const thread = appThread(threadId);
        const response = { thread, cwd: "/repo" };
        const starts = {
          response: response as never,
          capability: localCapabilitySnapshot,
          projectId: null,
          executionProfile: null,
          runtimeWorkspaceRoots: ["/repo"],
          fallbackCwd: "/repo",
          managedWorktreePath: null,
        };
        const operations = [
          directory.observeMetadata({ thread, inferredInitialProjectId: null }),
          directory.acceptSessionStart({ ...starts, sessionId: "session-chat" }),
          directory.acceptStandaloneStart(starts),
          directory.acceptImportResult({
            response: response as never,
            capability: localCapabilitySnapshot,
            fallbackCwd: "/repo",
          }),
          directory.acceptForkResult({
            sourceThreadId: nativeThreadIds.source,
            response: response as never,
          }),
          directory.acceptResumeResult({
            response: response as never,
            requestedCwd: "/repo",
            capability: localCapabilitySnapshot,
            executionHostId: "local",
            fallbackCwd: "/repo",
          }),
          directory.acceptRendererResume({
            threadId,
            response: response as never,
            capability: localCapabilitySnapshot,
            requestedCwd: "/repo",
          }),
        ];
        for (const operation of operations)
          assert.strictEqual((yield* Effect.exit(operation))._tag, "Failure");
        assert.deepEqual(requests, []);
        assert.strictEqual(threads.size, 0);
        assert.isNull(conversations.current(threadId));
      }),
    ),
);

it.effect.each([
  {
    label: "obsolete cwd",
    workspaceBrowserRoot: null,
    expectedCwd: "/projectless-old",
    expectedWorkspaceRoots: ["/projectless-old"],
  },
  {
    label: "workspace browser root",
    workspaceBrowserRoot: "/workspace/browser",
    expectedCwd: "/workspace/browser",
    expectedWorkspaceRoots: ["/workspace/browser"],
  },
])("prepareResume captures the physical projectless workspace for $label", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = nativeThreadIds.projectless;
      const threads = new Map([
        [
          threadId,
          coreThread(threadId, {
            project_id: null,
            cwd: "/projectless-old",
            writable_roots: [],
            projectless_workspace_browser_root: scenario.workspaceBrowserRoot,
          }),
        ],
      ]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const metadata = { ...appThread(threadId), cwd: "/projectless-old" };
      conversations.entity(threadId).acceptCanonicalState(
        createCodexCanonicalHydratedConversationState(metadata, {
          hostId: "remote-a",
          model: "gpt-test",
          reasoningEffort: "high",
          cwd: "/projectless-old",
          workspaceKind: "projectless",
          workspaceBrowserRoot: scenario.workspaceBrowserRoot,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          activePermissionProfile: null,
          runtimeWorkspaceRoots: [],
        }),
      );
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const configCwds: string[] = [];
      const gateway = makeGateway(
        ((_hostId, method, params) =>
          Effect.sync(() => {
            if (method === "config/read") {
              configCwds.push((params as { cwd: string }).cwd);
              return { config: {} };
            }
            if (method === "experimentalFeature/list") return { data: [], nextCursor: null };
            throw new Error(`Unexpected request: ${method}`);
          })) as RequestOnHost,
        undefined,
        "local",
        { passthroughRequestSettings: true },
      );
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const prepared = yield* directory.prepareResume(threadId, metadata);
      assert.strictEqual(prepared.params.cwd, scenario.expectedCwd);
      assert.deepEqual(
        prepared.permissionContext.runtimeWorkspaceRootCandidates,
        scenario.expectedWorkspaceRoots,
      );
      assert.deepEqual(prepared.params.runtimeWorkspaceRoots, scenario.expectedWorkspaceRoots);
      assert.strictEqual(prepared.params.permissions, ":danger-full-access");
      assert.strictEqual(prepared.params.approvalPolicy, "never");
      assert.deepEqual(configCwds, [scenario.expectedCwd]);
    }),
  ),
);

it.effect("prepareResume keeps the applied workspace until the pending move is accepted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = nativeThreadIds.moving;
      const threads = new Map([
        [
          threadId,
          coreThread(threadId, {
            project_id: null,
            cwd: "/new-projectless",
            writable_roots: ["/old-project"],
            projectless_workspace_browser_root: "/new-projectless",
          }),
        ],
      ]);
      const workspaceStates = new Map<string, unknown>([
        [
          threadId,
          {
            revision: "workspace-revision",
            applied: {
              project_sources: ["/old-project"],
              cwd: "/old-project",
              runtime_workspace_roots: ["/old-project"],
            },
            pending: {
              project_sources: [],
              cwd: "/new-projectless",
              runtime_workspace_roots: ["/new-projectless"],
            },
          },
        ],
      ]);
      const core = makeCore(threads, workspaceStates);
      const conversations = makeConversations();
      const metadata = { ...appThread(threadId), cwd: "/new-projectless" };
      conversations.entity(threadId).acceptCanonicalState(
        createCodexCanonicalHydratedConversationState(metadata, {
          hostId: "remote-a",
          model: "gpt-test",
          reasoningEffort: "high",
          cwd: "/new-projectless",
          workspaceKind: "projectless",
          workspaceBrowserRoot: "/new-projectless",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/old-project"],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          activePermissionProfile: null,
          runtimeWorkspaceRoots: ["/old-project"],
        }),
      );
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const configCwds: string[] = [];
      const gateway = makeGateway(
        ((_hostId, method, params) =>
          Effect.sync(() => {
            if (method === "config/read") {
              configCwds.push((params as { cwd: string }).cwd);
              return { config: {} };
            }
            if (method === "experimentalFeature/list") return { data: [], nextCursor: null };
            throw new Error(`Unexpected request: ${method}`);
          })) as RequestOnHost,
        undefined,
        "local",
        { passthroughRequestSettings: true },
      );
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const prepared = yield* directory.prepareResume(threadId, metadata);
      assert.strictEqual(prepared.params.cwd, "/old-project");
      assert.deepEqual(prepared.permissionContext.runtimeWorkspaceRootCandidates, ["/old-project"]);
      assert.deepEqual(configCwds, ["/old-project"]);
    }),
  ),
);

it.effect("accepts a concrete paginated start contract without trusting the version label", () =>
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
        rootTurnId: null,
        id: "turn-poison",
        items: Array.from({ length: 1000 }, (_, index) => ({
          questions: null,
          type: "agentMessage",
          moderation: null,
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
        durationMs: 1000,
      };

      const accepted = yield* Effect.exit(
        directory.acceptStandaloneStart({
          response: {
            cwd: "/repo",
            thread: appThread(nativeThreadIds.started, [poisonTurn]),
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
          capability: localCapabilitySnapshot,
        }),
      );

      const legacy = yield* Effect.exit(
        directory.acceptStandaloneStart({
          response: {
            cwd: "/repo",
            thread: { ...appThread(nativeThreadIds.legacy), historyMode: "legacy", turns: [] },
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
          capability: localCapabilitySnapshot,
        }),
      );

      const unversioned = yield* directory.acceptStandaloneStart({
        response: {
          cwd: "/repo",
          thread: appThread(nativeThreadIds.unversioned),
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
        capability: createCodexAppServerCapabilitySnapshot({
          hostId: "local",
          generation: 1,
          userAgent: "codex-app-server/0.0.0",
        }),
      });

      assert.isTrue(Exit.isFailure(accepted));
      assert.isTrue(Exit.isFailure(legacy));
      assert.strictEqual(unversioned.historyMode, "paginated");
      assert.deepEqual([...threads.keys()], [nativeThreadIds.unversioned]);
      assert.isNull(conversations.current(nativeThreadIds.started));
      assert.isNull(conversations.current(nativeThreadIds.legacy));
      assert.isNotNull(conversations.current(nativeThreadIds.unversioned));
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
        rootTurnId: null,
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
          thread: appThread(nativeThreadIds.inline, [poisonTurn]),
          inferredInitialProjectId: "project-a",
          executionHostId: "remote-a",
        }),
      );

      assert.isTrue(Exit.isFailure(observed));
      assert.deepEqual([...threads.keys()], []);
      assert.isNull(conversations.current(nativeThreadIds.inline));
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
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const physicalRequests: Array<{
        readonly method: string;
        readonly params: unknown;
      }> = [];
      const tailTurn: Turn = {
        rootTurnId: null,
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
                    questions: null,
                    type: "agentMessage",
                    moderation: null,
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
      const directory = yield* directoryWithRequestSettings.pipe(
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
      const thread = appThread(nativeThreadIds.imported);

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
      assert.strictEqual(accepted.canonical?.id, nativeThreadIds.imported);
      assert.deepEqual(
        accepted.canonical?.turns.map((turn) => turn.turnId),
        ["turn-tail"],
      );
      assert.deepEqual(physicalRequests, [
        {
          method: "thread/turns/list",
          params: {
            threadId: nativeThreadIds.imported,
            cursor: null,
            limit: 5,
            itemsView: "notLoaded",
            sortDirection: "desc",
          },
        },
        {
          method: "thread/items/list",
          params: {
            threadId: nativeThreadIds.imported,
            turnId: "turn-tail",
            cursor: null,
            limit: 100,
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
      assert.deepEqual(
        conversations.current(nativeThreadIds.imported)?.readSnapshot(),
        accepted.snapshot,
      );
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
        rootTurnId: null,
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
          response: {
            cwd: "/repo",
            thread: appThread(nativeThreadIds.imported, [inlineTurn]),
          } as never,
          capability: capabilitySnapshot,
          executionHostId: "remote-a",
          fallbackCwd: "/repo",
        }),
      );

      assert.isTrue(Exit.isFailure(result));
      assert.deepEqual([...threads.keys()], []);
      assert.isNull(conversations.current(nativeThreadIds.imported));
    }),
  ),
);

it.effect("accepts a metadata-only fork shell with inherited durable authority", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = coreThread(nativeThreadIds.source, {
        project_id: "project-fork",
        execution_host_id: "remote-fork",
        managed_worktree_path: "/repo",
        dynamic_tool_catalogs: [{ namespace: "nodex", toolset_revision: 7 }],
        writable_roots: ["/repo", "/shared"],
      });
      const threads = new Map([[nativeThreadIds.source, source]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const historyPages = CodexHistoryPageAdapter.of({
        loadTurnPage: () => Effect.die("fork shell must not read child history"),
        loadTurnItemsPage: () => Effect.die("unused"),
      });
      const directory = yield* directoryWithRequestSettings.pipe(
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
        sourceThreadId: nativeThreadIds.source,
        destinationSessionId: "reserved-fork",
        response: {
          thread: {
            ...appThread(nativeThreadIds.fork),
            forkedFromId: nativeThreadIds.source,
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

      const persisted = threads.get(nativeThreadIds.fork);
      assert.strictEqual(accepted.durable.sessionId, "reserved-fork");
      assert.strictEqual(accepted.durable.projectId, "project-fork");
      assert.strictEqual(accepted.durable.forkedFromId, nativeThreadIds.source);
      assert.strictEqual(accepted.durable.executionHostId, "remote-fork");
      assert.strictEqual(accepted.durable.managedWorktreePath, "/repo");
      assert.strictEqual(accepted.durable.executionProfile?.modelId, "gpt-fork");
      assert.strictEqual(accepted.durable.executionProfile?.serviceTier, null);
      assert.strictEqual(
        accepted.canonical?.hydrationContext?.latestThreadSettings?.serviceTier,
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
      const source = coreThread(nativeThreadIds.source, {
        execution_host_id: "remote-a",
        writable_roots: ["/repo"],
      });
      const threads = new Map([[nativeThreadIds.source, source]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
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
      const directory = yield* directoryWithRequestSettings.pipe(
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
        sourceThreadId: nativeThreadIds.source,
        response: {
          thread: {
            ...appThread(nativeThreadIds.fork),
            forkedFromId: nativeThreadIds.source,
            turns: [],
          },
          model: "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          disabledPluginIds: [],
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

it.effect("discovers a native UUID on its selected host without a durable Core row", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map<string, CoreThread>();
      const requests: Array<{ hostId: string; method: string; params: unknown }> = [];
      const gateway = makeGateway(((hostId, method, params) => {
        requests.push({ hostId, method, params });
        return Effect.succeed({ thread: appThread(nativeThreadIds.main) });
      }) as RequestOnHost);
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(
          CodexApplicationEventHub,
          CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
        ),
        Effect.provideService(
          CodexConversationProjection,
          CodexConversationProjection.of({
            hydrate: () => Effect.die("Unexpected hydration"),
          } as never),
        ),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(ConversationEntityMap, makeConversations()),
        Effect.provideService(CoreModules, makeCore(threads)),
      );

      assert.isNull(
        yield* directory.resolve({ threadId: nativeThreadIds.main, fidelity: "durable" }),
      );
      const discovered = yield* directory.resolve({
        threadId: nativeThreadIds.main,
        fidelity: "durable",
        hostId: "remote-a",
      });
      assert.strictEqual(discovered?.summary.threadId, nativeThreadIds.main);
      assert.strictEqual(discovered?.durable.executionHostId, "remote-a");
      assert.deepEqual(requests, [
        {
          hostId: "remote-a",
          method: "thread/read",
          params: { threadId: nativeThreadIds.main, includeTurns: false },
        },
      ]);
      const retained = yield* directory.resolve({
        threadId: nativeThreadIds.main,
        fidelity: "durable",
        hostId: "local",
      });
      assert.strictEqual(retained?.durable.executionHostId, "remote-a");
      assert.strictEqual(requests.length, 1);
    }),
  ),
);

it.effect("resolves remote metadata without reading or materializing the transcript", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([[nativeThreadIds.main, coreThread(nativeThreadIds.main)]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const events: unknown[] = [];
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: (event) => events.push(event),
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const gateway = makeGateway(((hostId, method, params) => {
        assert.strictEqual(hostId, "remote-a");
        assert.strictEqual(method, "thread/read");
        assert.deepEqual(params as unknown, {
          threadId: nativeThreadIds.main,
          includeTurns: false,
        });
        return Effect.succeed({
          thread: {
            ...appThread(nativeThreadIds.main),
            model: "gpt-observed",
            reasoningEffort: "medium",
          },
        });
      }) as RequestOnHost);
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const resolved = yield* directory.resolve({
        threadId: nativeThreadIds.main,
        fidelity: "metadata",
      });

      assert.strictEqual(resolved?.fidelity, "metadata");
      assert.strictEqual(resolved?.durable.threadName, "Hydrated Thread");
      assert.strictEqual(resolved?.durable.executionProfile?.modelId, "gpt-observed");
      assert.strictEqual(resolved?.durable.executionProfile?.reasoningEffort, "medium");
      assert.isNull(resolved?.canonical ?? null);
      assert.isNull(resolved?.snapshot ?? null);
      assert.isTrue(events.length > 0);
    }),
  ),
);

it.effect("refreshes an unarchived Thread into a resumed metadata-only canonical shell", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([
        [nativeThreadIds.main, coreThread(nativeThreadIds.main, { archived: false })],
      ]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const gateway = makeGateway(((hostId, method, params) => {
        assert.strictEqual(hostId, "remote-a");
        assert.strictEqual(method, "thread/read");
        assert.deepEqual(params as unknown, {
          threadId: nativeThreadIds.main,
          includeTurns: false,
        });
        return Effect.succeed({ thread: appThread(nativeThreadIds.main) });
      }) as RequestOnHost);
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );

      const refreshed = yield* directory.refreshMetadataInCurrentLane({
        threadId: nativeThreadIds.main,
      });

      assert.strictEqual(refreshed?.fidelity, "materialized");
      assert.deepEqual(refreshed?.canonical?.turns, []);
      assert.strictEqual(refreshed?.snapshot?.resumeState, "resumed");
      assert.deepEqual(refreshed?.snapshot?.turnPagination, {
        olderCursor: null,
        backwardsCursor: null,
        oldestLoadedTurnId: null,
        isLoadingOlder: false,
        hasLoadedOldest: true,
        loadedTurnCount: 0,
        itemsView: "full",
      });
    }),
  ),
);

it.effect.each([
  { label: "ACP", binding: { driver: "acpRegistry", instanceId: "claude-code" } },
  { label: "Claude", binding: { driver: "claudeAgent", instanceId: "claude" } },
  { label: "another Codex instance", binding: { driver: "codex", instanceId: "another-account" } },
])("keeps a UUID owned by $label out of native Codex reads and acceptance", ({ binding }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = nativeThreadIds.foreign;
      const original = coreThread(threadId, { backend_binding: binding });
      const { directory, requests, threads, conversations } = yield* boundaryDirectory(
        new Map([[threadId, original]]),
      );
      const results = yield* Effect.forEach(
        ["durable", "metadata", "tail", "live"] as const,
        (fidelity) => directory.resolve({ threadId, fidelity, hostId: "local" }),
      );
      assert.deepEqual(results, [null, null, null, null]);
      assert.isNull(yield* directory.materializeInCurrentLane({ threadId, hostId: "local" }));
      assert.isNull(yield* directory.refreshMetadataInCurrentLane({ threadId, hostId: "local" }));
      assert.strictEqual((yield* Effect.exit(directory.prepareResume(threadId)))._tag, "Failure");
      assert.strictEqual(
        (yield* Effect.exit(directory.prepareHistoryHydration(threadId)))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Effect.exit(
          directory.observeMetadata({
            thread: appThread(threadId),
            inferredInitialProjectId: null,
          }),
        ))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Effect.exit(
          directory.acceptSessionStart({
            response: {
              thread: appThread(threadId),
              cwd: "/repo",
              model: "gpt-test",
              reasoningEffort: "high",
              serviceTier: null,
            } as never,
            sessionId: "session-native",
            projectId: original.project_id,
            durableOnly: true,
            capability: localCapabilitySnapshot,
            executionProfile: null,
            runtimeWorkspaceRoots: ["/repo"],
            fallbackCwd: "/repo",
            managedWorktreePath: null,
          }),
        ))._tag,
        "Failure",
      );
      assert.deepEqual(requests, []);
      assert.strictEqual(threads.get(threadId), original);
      assert.isNull(conversations.readThreadMetadata(threadId));
    }),
  ),
);

it.effect("hydrates an inactive paginated Thread from a bounded tail without resuming it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([[nativeThreadIds.main, coreThread(nativeThreadIds.main)]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
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
        return Effect.succeed({ thread: appThread(nativeThreadIds.main) });
      }) as RequestOnHost);
      const tailTurn: Turn = {
        rootTurnId: null,
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
          const { readResidentHistory, ...pageInput } = input;
          assert.isFunction(readResidentHistory);
          pageInputs.push(pageInput);
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
      const directory = yield* directoryWithRequestSettings.pipe(
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

      const resolved = yield* directory.resolve({
        threadId: nativeThreadIds.main,
        fidelity: "tail",
      });

      assert.strictEqual(resolved?.fidelity, "tail");
      assert.deepEqual(gatewayRequests, [
        {
          method: "thread/read",
          params: { threadId: nativeThreadIds.main, includeTurns: false },
          scheduling: { expectedHostId: "remote-a", expectedGeneration: 1 },
        },
      ]);
      assert.deepEqual(pageInputs, [
        {
          capability: capabilitySnapshot,
          threadId: nativeThreadIds.main,
          cursor: null,
          initialItemsCursor: null,
          purpose: "initial",
        },
      ]);
      assert.deepEqual(
        resolved?.canonical?.turns.map((turn) => turn.turnId),
        ["turn-tail"],
      );
      assert.strictEqual(resolved?.snapshot?.turnPagination?.olderCursor, "turns:older");
    }),
  ),
);

it.effect("keeps legacy tail reads metadata-only instead of loading unbounded history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([[nativeThreadIds.main, coreThread(nativeThreadIds.main)]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const requests: unknown[] = [];
      const gateway = makeGateway(((hostId, method, params) => {
        assert.strictEqual(hostId, "remote-a");
        assert.strictEqual(method, "thread/read");
        requests.push(params);
        return Effect.succeed({
          thread: { ...appThread(nativeThreadIds.main), historyMode: "legacy", turns: [] },
        });
      }) as RequestOnHost);
      const legacyCapability = createCodexAppServerCapabilitySnapshot({
        hostId: "remote-a",
        generation: 1,
        userAgent: "codex-app-server/0.144.0",
      });
      const directory = yield* directoryWithRequestSettings.pipe(
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

      const resolved = yield* directory.resolve({
        threadId: nativeThreadIds.main,
        fidelity: "tail",
      });
      assert.deepEqual(requests, [{ threadId: nativeThreadIds.main, includeTurns: false }]);
      const live = yield* Effect.exit(
        directory.resolve({ threadId: nativeThreadIds.main, fidelity: "live" }),
      );

      assert.deepEqual(requests, [
        { threadId: nativeThreadIds.main, includeTurns: false },
        { threadId: nativeThreadIds.main, includeTurns: false },
      ]);
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

it.effect.each([
  {
    label: "native bridge",
    nativeMcp: true,
    selectedCwd: "/repo",
    metadataCwd: "/repo",
    responseCwd: "/repo",
    requestCwd: "/repo",
    finalCwd: "/repo",
  },
  {
    label: "remote bridge",
    nativeMcp: false,
    selectedCwd: "/repo",
    metadataCwd: "/repo",
    responseCwd: "/repo",
    requestCwd: "/repo",
    finalCwd: "/repo",
  },
  {
    label: "selected subdirectory",
    nativeMcp: false,
    selectedCwd: "/repo/packages/tool",
    metadataCwd: "/repo",
    responseCwd: "/repo",
    requestCwd: "/repo/packages/tool",
    finalCwd: "/repo/packages/tool",
  },
  {
    label: "Windows subdirectory",
    nativeMcp: false,
    selectedCwd: "C:\\Repo\\Packages\\Tool",
    metadataCwd: "c:/repo",
    responseCwd: "c:/repo",
    requestCwd: "C:\\Repo\\Packages\\Tool",
    finalCwd: "C:\\Repo\\Packages\\Tool",
  },
  {
    label: "different root",
    nativeMcp: false,
    selectedCwd: "/repo-other",
    metadataCwd: "/repo",
    responseCwd: "/repo",
    requestCwd: "/repo",
    finalCwd: "/repo",
  },
  {
    label: "root changed during resume",
    nativeMcp: false,
    selectedCwd: "/repo/packages",
    metadataCwd: "/repo",
    responseCwd: "/new-root",
    requestCwd: "/repo/packages",
    finalCwd: "/new-root",
  },
])(
  "resumes metadata-first and hydrates one bounded tail page: $label",
  ({ nativeMcp, selectedCwd, metadataCwd, responseCwd, requestCwd, finalCwd }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const threads = new Map([
          [nativeThreadIds.main, coreThread(nativeThreadIds.main, { cwd: selectedCwd })],
        ]);
        const core = makeCore(threads);
        const conversations = makeConversations();
        const eventHub = CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: () => undefined,
        });
        const projection = yield* makeConversationProjection.pipe(
          Effect.provideService(ConversationEntityMap, conversations),
          Effect.provideService(CodexApplicationEventHub, eventHub),
          Effect.provideService(CoreModules, core),
        );
        const resumeRequests: Array<{
          readonly params: unknown;
          readonly scheduling: unknown;
        }> = [];
        const gateway = makeGateway(
          ((hostId, method, params, scheduling) => {
            assert.strictEqual(hostId, "remote-a");
            if (method === "thread/read") {
              assert.deepEqual(params as unknown, {
                threadId: nativeThreadIds.main,
                includeTurns: false,
              });
              return Effect.succeed({
                thread: { ...appThread(nativeThreadIds.main), cwd: metadataCwd },
              });
            }
            assert.strictEqual(method, "thread/resume");
            resumeRequests.push({ params, scheduling });
            return Effect.succeed({
              thread: appThread(nativeThreadIds.main),
              model: "gpt-test",
              modelProvider: "openai",
              serviceTier: null,
              cwd: responseCwd,
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
          }) as RequestOnHost,
          undefined,
          nativeMcp ? "remote-a" : "local",
        );
        const pageInputs: unknown[] = [];
        const tailTurn: Turn = {
          rootTurnId: null,
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
            const { readResidentHistory, ...pageInput } = input;
            assert.isFunction(readResidentHistory);
            pageInputs.push(pageInput);
            return Effect.succeed({
              turns: [tailTurn],
              nextCursor: "turns:older",
              backwardsCursor: "turns:newer",
              loadedItemCount: 0,
              itemSegmentsByTurnId: { [tailTurn.id]: [] },
              itemsPaginationByTurnId: {
                [tailTurn.id]: {
                  ...(tailTurn.items.length > 0
                    ? { newestSnapshotItemId: tailTurn.items.at(-1)!.id }
                    : {}),
                  olderCursor: pageInputs.length === 1 ? "items:older" : "items:snapshot",
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
        const scenarioCapability = createCodexAppServerCapabilitySnapshot({
          hostId: "remote-a",
          generation: 1,
          userAgent: capabilitySnapshot.userAgent,
          nativeAppTools: nativeMcp,
        });
        const directory = yield* directoryWithRequestSettings.pipe(
          Effect.provideService(CodexApplicationEventHub, eventHub),
          Effect.provideService(CodexConversationProjection, projection),
          Effect.provideService(CodexGateway, gateway),
          Effect.provideService(CodexHistoryPageAdapter, historyPages),
          Effect.provideService(
            CodexAppServerCapabilities,
            CodexAppServerCapabilities.of({
              forHost: () => Effect.succeed(scenarioCapability),
              forThread: () => Effect.succeed(scenarioCapability),
              isCurrent: () => Effect.succeed(true),
            }),
          ),
          Effect.provideService(ConversationEntityMap, conversations),
          Effect.provideService(CoreModules, core),
        );

        const resolved = yield* directory.resolve({
          threadId: nativeThreadIds.main,
          fidelity: "live",
        });

        assert.lengthOf(resumeRequests, 1);
        const resumeRequest = resumeRequests[0]!;
        assert.deepInclude(resumeRequest.params as Record<string, unknown>, {
          threadId: nativeThreadIds.main,
          excludeTurns: true,
          history: null,
          path: null,
          model: null,
          cwd: requestCwd,
          personality: "friendly",
        });
        assert.deepEqual(resumeRequest.scheduling, {
          expectedHostId: "remote-a",
          expectedGeneration: 1,
          timeoutMs: 120_000,
        });
        assert.deepEqual(
          (resumeRequest.params as { config?: unknown }).config,
          buildCodexThreadConfig({
            nativeAppTools: nativeMcp,
            overrides: buildCodexDesktopThreadFeatureConfig(capabilitySnapshot.version),
          }),
        );
        assert.include(
          String(
            (resumeRequest.params as { developerInstructions?: string }).developerInstructions,
          ),
          "<app-context>",
        );
        assert.strictEqual(resolved?.canonical?.cwd, finalCwd);
        assert.strictEqual(resolved?.canonical?.hydrationContext?.cwd, finalCwd);
        assert.strictEqual(
          resolved?.canonical?.hydrationContext?.latestThreadSettings?.cwd,
          finalCwd,
        );
        assert.strictEqual(residentConversationTurns(resolved?.canonical)[0]?.params.cwd, finalCwd);
        assert.strictEqual(threads.get(nativeThreadIds.main)?.cwd, finalCwd);
        assert.deepEqual(pageInputs, [
          {
            capability: scenarioCapability,
            threadId: nativeThreadIds.main,
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
        assert.deepEqual(resolved?.canonical?.turns[0]?.params.input, [
          { type: "text", text: "opening prompt", text_elements: [] },
        ]);
        assert.deepEqual(
          conversations.current(nativeThreadIds.main)?.readTurnItemsPagination("turn-tail"),
          {
            olderCursor: "items:older",
            isLoadingOlder: false,
            hasLoadedOldest: false,
            oldestUserInput: [{ type: "text", text: "opening prompt", text_elements: [] }],
            openingUserMessageId: "item-opening",
            itemsView: "summary",
          },
        );
        const aggregate = conversations.entity(nativeThreadIds.main);
        const residentItem = { type: "plan" as const, id: "resident-item", text: "local work" };
        aggregate.mutateCanonicalState((draft) => {
          const entry = residentConversationTurnEntries(draft)[0];
          if (!entry) throw new Error("Expected the hydrated tail");
          conversationTurnDraft(draft, entry.address)!.items = [residentItem];
        }, Date.now());
        aggregate.initializeHistory(aggregate.readTurnPagination(), 1, {
          [tailTurn.id]: {
            ...aggregate.readTurnItemsPagination(tailTurn.id)!,
            newestSnapshotItemId: residentItem.id,
          },
        });
        tailTurn.items = [{ type: "plan", id: "snapshot-item", text: "new work" }];
        tailTurn.status = "inProgress";
        const resumed = yield* directory.resolve({
          threadId: nativeThreadIds.main,
          fidelity: "live",
        });
        assert.deepEqual(
          resumed?.canonical?.turns[0]?.items.map((item) => item.id),
          ["resident-item", "snapshot-item"],
        );
        assert.strictEqual(resumed?.canonical?.turns[0]?.status, "completed");
        assert.deepEqual(resumed?.snapshot?.turnItemsPaginationById?.[tailTurn.id]?.reconnect, {
          beforeItemId: "snapshot-item",
          stopItemId: "resident-item",
          olderCursorAfterReconnect: "items:older",
        });
      }),
    ),
);

it.effect("reads authoritative history when an unversioned resume omits its page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threads = new Map([[nativeThreadIds.main, coreThread(nativeThreadIds.main)]]);
      const core = makeCore(threads);
      const conversations = makeConversations();
      const eventHub = CodexApplicationEventHub.of({
        events: Stream.empty,
        publish: () => undefined,
      });
      const projection = yield* makeConversationProjection.pipe(
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CoreModules, core),
      );
      const unversionedCapability = createCodexAppServerCapabilitySnapshot({
        hostId: "remote-a",
        generation: 2,
        userAgent: "codex-app-server/0.0.0",
      });
      const resumeRequests: Array<{
        readonly params: unknown;
        readonly scheduling: unknown;
      }> = [];
      const gateway = makeGateway(((hostId, method, params, scheduling) => {
        assert.strictEqual(hostId, "remote-a");
        if (method === "thread/read") {
          assert.deepEqual(scheduling, { expectedHostId: "remote-a", expectedGeneration: 2 });
          if (!(params as { includeTurns?: boolean }).includeTurns) {
            assert.deepEqual(params as unknown, {
              threadId: nativeThreadIds.main,
              includeTurns: false,
            });
            return Effect.succeed({ thread: appThread(nativeThreadIds.main) });
          }
          assert.deepEqual(params as unknown, {
            threadId: nativeThreadIds.main,
            includeTurns: true,
          });
          return Effect.succeed({ thread: appThread(nativeThreadIds.main, [residentTurn]) });
        }
        assert.strictEqual(method, "thread/resume");
        resumeRequests.push({ params, scheduling });
        return Effect.succeed({
          thread: appThread(nativeThreadIds.main),
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
          turnsBackwardsCursor: "must-not-page",
          itemsBackwardsCursor: "must-not-page",
        } as never);
      }) as RequestOnHost);
      const directory = yield* directoryWithRequestSettings.pipe(
        Effect.provideService(CodexApplicationEventHub, eventHub),
        Effect.provideService(CodexConversationProjection, projection),
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(
          CodexHistoryPageAdapter,
          CodexHistoryPageAdapter.of({
            loadTurnPage: () => Effect.die("unversioned resume must not use paginated RPCs"),
            loadTurnItemsPage: () => Effect.die("unused"),
          }),
        ),
        Effect.provideService(
          CodexAppServerCapabilities,
          CodexAppServerCapabilities.of({
            forHost: () => Effect.succeed(unversionedCapability),
            forThread: () => Effect.succeed(unversionedCapability),
            isCurrent: () => Effect.succeed(true),
          }),
        ),
        Effect.provideService(ConversationEntityMap, conversations),
        Effect.provideService(CoreModules, core),
      );
      const residentTurn: Turn = {
        rootTurnId: null,
        id: "turn-resident",
        items: [
          {
            type: "userMessage",
            id: "item-resident",
            clientId: null,
            content: [{ type: "text", text: "Keep me resident", text_elements: [] }],
          },
        ],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      };
      const resident = conversations.entity(nativeThreadIds.main);
      resident.acceptCanonicalState(
        createCodexCanonicalHydratedConversationState(
          appThread(nativeThreadIds.main, [residentTurn]),
          {
            hostId: "remote-a",
            model: "gpt-test",
            reasoningEffort: "high",
            cwd: "/repo",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            activePermissionProfile: null,
            runtimeWorkspaceRoots: ["/repo"],
          },
        ),
      );
      resident.initializeHistory(
        {
          olderCursor: "cursor:resident-older",
          backwardsCursor: "cursor:resident-newer",
          oldestLoadedTurnId: residentTurn.id,
          isLoadingOlder: false,
          hasLoadedOldest: false,
          loadedTurnCount: 1,
          itemsView: "full",
        },
        120_000,
      );

      const resolved = yield* directory.resolve({
        threadId: nativeThreadIds.main,
        fidelity: "live",
      });

      assert.lengthOf(resumeRequests, 1);
      const resumeRequest = resumeRequests[0]!;
      assert.deepInclude(resumeRequest.params as Record<string, unknown>, {
        threadId: nativeThreadIds.main,
        excludeTurns: true,
        initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" },
        history: null,
        path: null,
        model: null,
        cwd: "/repo",
        personality: null,
        config: buildCodexDesktopThreadFeatureConfig(unversionedCapability.version),
      });
      assert.deepEqual(resumeRequest.scheduling, {
        expectedHostId: "remote-a",
        expectedGeneration: 2,
        timeoutMs: 120_000,
      });
      assert.include(
        String((resumeRequest.params as { developerInstructions?: string }).developerInstructions),
        "<app-context>",
      );
      assert.deepEqual(
        resolved?.canonical?.turns.map((turn) => turn.turnId),
        ["turn-resident"],
      );
      assert.deepEqual(resolved?.snapshot?.turnPagination, {
        olderCursor: null,
        backwardsCursor: null,
        oldestLoadedTurnId: "turn-resident",
        isLoadingOlder: false,
        hasLoadedOldest: true,
        loadedTurnCount: 1,
        itemsView: "full",
      });
    }),
  ),
);

it.effect.each([false, true])(
  "durable resume accepts inline history and hydrates its separate full page: %s",
  (supportsPagination) =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = nativeThreadIds.durable;
        const core = makeCore(
          new Map([[threadId, coreThread(threadId, { execution_host_id: "durable" })]]),
        );
        const conversations = makeConversations();
        const eventHub = CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: () => undefined,
        });
        const projection = yield* makeConversationProjection.pipe(
          Effect.provideService(ConversationEntityMap, conversations),
          Effect.provideService(CodexApplicationEventHub, eventHub),
          Effect.provideService(CoreModules, core),
        );
        const capability = createCodexAppServerCapabilitySnapshot({
          hostId: "durable",
          generation: 2,
          userAgent: supportsPagination ? "nodex/0.148.0" : "nodex/0.144.0",
        });
        const item = (id: string) => ({
          type: "agentMessage" as const,
          moderation: null,
          id,
          text: id,
          phase: null,
          memoryCitation: null,
          delivery: null,
          questions: null,
        });
        const turn = (id: string): Turn => ({
          rootTurnId: null,
          id,
          items: [item(id)],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        });
        const completed = turn("page-turn");
        const inline = turn("inline-turn");
        const calls: { method: string; params: unknown }[] = [];
        let emptyPage = false;
        const gateway = makeGateway(
          () => Effect.die("durable resume must not issue a fallback thread/read"),
          ((_id, method, params, options) =>
            Effect.sync(() => {
              calls.push({ method, params });
              assert.strictEqual(options?.expectedHostId, "durable");
              assert.strictEqual(options?.expectedGeneration, 2);
              assert.strictEqual(options?.priority, "critical");
              assert.strictEqual(options?.timeoutMs, 30_000);
              if (method === "thread/turns/list")
                return emptyPage
                  ? { data: [], nextCursor: "empty-prefix", backwardsCursor: null }
                  : {
                      data: [{ ...completed, items: [], itemsView: "notLoaded" }],
                      nextCursor: "older-durable",
                      backwardsCursor: null,
                    };
              assert.strictEqual(method, "thread/items/list");
              return {
                data: completed.items.map((value) => ({ turnId: completed.id, item: value })),
                nextCursor: null,
                backwardsCursor: null,
              };
            })) as RequestForThread,
        );
        const history = yield* makeHistoryPageAdapter.pipe(
          Effect.provideService(CodexGateway, gateway),
        );
        const directory = yield* directoryWithRequestSettings.pipe(
          Effect.provideService(CodexApplicationEventHub, eventHub),
          Effect.provideService(CodexConversationProjection, projection),
          Effect.provideService(CodexGateway, gateway),
          Effect.provideService(CodexHistoryPageAdapter, history),
          Effect.provideService(
            CodexAppServerCapabilities,
            CodexAppServerCapabilities.of({
              forHost: () => Effect.succeed(capability),
              forThread: () => Effect.succeed(capability),
              isCurrent: () => Effect.succeed(true),
            }),
          ),
          Effect.provideService(ConversationEntityMap, conversations),
          Effect.provideService(CoreModules, core),
        );
        const metadata = appThread(threadId);
        const prepared = yield* directory.prepareResume(threadId, metadata);
        assert.strictEqual(prepared.params.excludeTurns, false);
        assert.isUndefined(prepared.params.initialTurnsPage);
        const response = {
          thread: {
            ...metadata,
            turns: [
              { ...completed, status: "inProgress" as const, items: [item("stale")] },
              inline,
            ],
          },
          model: "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          disabledPluginIds: [],
          cwd: "/repo",
          runtimeWorkspaceRoots: ["/repo"],
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
          reasoningEffort: "high",
          collaborationMode: null,
          multiAgentMode: "explicitRequestOnly",
          initialTurnsPage: null,
          turnsBackwardsCursor: null,
          itemsBackwardsCursor: null,
        } satisfies import("@nodex/codex-app-server-protocol/v2").ThreadResumeResponse;
        const accepted = yield* directory.acceptResumeResult({
          response,
          requestedCwd: "/repo",
          requestOptions: { priority: "critical", source: "thread_hydration" },
          capability,
          executionHostId: "durable",
          fallbackCwd: "/repo",
        });
        assert.deepEqual(calls, [
          {
            method: "thread/turns/list",
            params: {
              threadId,
              cursor: null,
              limit: 5,
              itemsView: "notLoaded",
              sortDirection: "desc",
            },
          },
          {
            method: "thread/items/list",
            params: {
              threadId,
              turnId: completed.id,
              cursor: null,
              limit: 500,
              sortDirection: "asc",
            },
          },
        ]);
        const turns = residentConversationTurns(accepted.canonical);
        assert.deepEqual(
          turns.map((value) => [value.turnId, value.status, value.items.map((entry) => entry.id)]),
          [
            [completed.id, "completed", [completed.id]],
            [inline.id, "completed", [inline.id]],
          ],
        );
        assert.strictEqual(accepted.canonical?.turnsPagination?.olderCursor, "older-durable");
        assert.strictEqual(accepted.canonical?.turnsPagination?.hasLoadedOldest, false);
        assert.isUndefined(accepted.canonical?.paginatedHistory);
        assert.strictEqual(accepted.durable.executionHostId, "durable");
        const inlineOnly = turn("new-inline-only");
        emptyPage = true;
        const empty = yield* directory.acceptResumeResult({
          response: { ...response, thread: { ...metadata, turns: [inlineOnly] } },
          requestedCwd: "/repo",
          requestOptions: { priority: "critical", source: "thread_hydration" },
          capability,
          executionHostId: "durable",
          fallbackCwd: "/repo",
        });
        assert.strictEqual(empty.canonical?.turnsPagination?.oldestLoadedTurnId, inlineOnly.id);
        assert.strictEqual(empty.canonical?.turnsPagination?.olderCursor, "empty-prefix");
        assert.strictEqual(empty.canonical?.turnsPagination?.hasLoadedOldest, false);
        assert.deepEqual(
          residentConversationTurns(empty.canonical).map((value) => value.turnId),
          [completed.id, inline.id, inlineOnly.id],
        );
      }),
    ),
);

it.effect.each([false, true])(
  "resume history accepts legacy pages with pagination support %s",
  (supportsPagination) =>
    Effect.scoped(
      Effect.gen(function* () {
        let capabilityCurrent = true;
        let invalidateAfterPersistence = false;
        const storage = makeCore(
          new Map([[nativeThreadIds.main, coreThread(nativeThreadIds.main)]]),
        );
        const core = CoreModules.of({
          ...storage,
          workspace: {
            ...storage.workspace,
            apply: (input) =>
              storage.workspace.apply(input).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (invalidateAfterPersistence) capabilityCurrent = false;
                  }),
                ),
              ),
          },
        });
        const conversations = makeConversations();
        const eventHub = CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: () => undefined,
        });
        const projection = yield* makeConversationProjection.pipe(
          Effect.provideService(ConversationEntityMap, conversations),
          Effect.provideService(CodexApplicationEventHub, eventHub),
          Effect.provideService(CoreModules, core),
        );
        const capability = createCodexAppServerCapabilitySnapshot({
          hostId: "remote-a",
          generation: 2,
          userAgent: supportsPagination ? "nodex/0.148.0" : "nodex/0.144.0",
        });
        const historyReads: unknown[] = [];
        let readMode: "success" | "wrong-thread" | "stale" | "failure" = "success";
        const gateway = makeGateway(((hostId, method, params, scheduling) => {
          if (method !== "thread/read") return Effect.die("Unexpected history RPC");
          assert.strictEqual(scheduling?.priority, "critical");
          assert.strictEqual(scheduling?.source, "thread_hydration");
          assert.strictEqual(scheduling?.expectedGeneration, 2);
          historyReads.push({ hostId, params });
          if (readMode === "failure")
            return Effect.fail(
              codexRuntimeError({ operation: "read", reason: "request", retryable: false }),
            );
          if (readMode === "stale") capabilityCurrent = false;
          return Effect.succeed({
            thread: appThread(
              readMode === "wrong-thread" ? nativeThreadIds.other : nativeThreadIds.main,
            ),
          });
        }) as RequestOnHost);
        const history = yield* makeHistoryPageAdapter.pipe(
          Effect.provideService(CodexGateway, gateway),
        );
        const directory = yield* directoryWithRequestSettings.pipe(
          Effect.provideService(CodexApplicationEventHub, eventHub),
          Effect.provideService(CodexConversationProjection, projection),
          Effect.provideService(CodexGateway, gateway),
          Effect.provideService(CodexHistoryPageAdapter, history),
          Effect.provideService(
            CodexAppServerCapabilities,
            CodexAppServerCapabilities.of({
              forHost: () => Effect.succeed(capability),
              forThread: () => Effect.succeed(capability),
              isCurrent: () => Effect.succeed(capabilityCurrent),
            }),
          ),
          Effect.provideService(ConversationEntityMap, conversations),
          Effect.provideService(CoreModules, core),
        );
        const response = {
          thread: { ...appThread(nativeThreadIds.main), historyMode: "legacy" as const },
          model: "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          disabledPluginIds: [],
          cwd: "/repo",
          runtimeWorkspaceRoots: ["/repo"],
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
          reasoningEffort: "high",
          collaborationMode: null,
          multiAgentMode: "explicitRequestOnly",
          initialTurnsPage: null,
          turnsBackwardsCursor: null,
          itemsBackwardsCursor: null,
        } satisfies import("@nodex/codex-app-server-protocol/v2").ThreadResumeResponse;
        const input = {
          response,
          requestedCwd: "/repo",
          requestOptions: { priority: "critical" as const, source: "thread_hydration" as const },
          capability,
          executionHostId: "remote-a",
          fallbackCwd: "/repo",
          historyMode: "legacy" as const,
        };
        const fallback = yield* directory.acceptResumeResult(input);
        assert.deepEqual(historyReads, [
          { hostId: "remote-a", params: { threadId: nativeThreadIds.main, includeTurns: true } },
        ]);
        assert.deepEqual(fallback.snapshot?.turns, []);
        assert.strictEqual(fallback.snapshot?.turnPagination?.hasLoadedOldest, true);

        const turn = (id: string): Turn => ({
          rootTurnId: null,
          id,
          items: [
            {
              type: "userMessage",
              id: `user-${id}`,
              clientId: null,
              content: [{ type: "text", text: id, text_elements: [] }],
            },
          ],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        });
        const page = {
          data: [turn("newest"), turn("oldest")],
          nextCursor: "older-unavailable",
          backwardsCursor: "newer-unavailable",
        };
        const restored = yield* directory.acceptResumeResult({
          ...input,
          response: { ...response, initialTurnsPage: page },
        });
        assert.deepEqual(
          restored.canonical?.turns.map((value) => value.turnId),
          ["oldest", "newest"],
        );
        assert.strictEqual(restored.snapshot?.resumeState, "resumed");
        assert.strictEqual(restored.snapshot?.turnPagination?.hasLoadedOldest, false);
        assert.strictEqual(restored.snapshot?.turnPagination?.olderCursor, page.nextCursor);
        assert.strictEqual(
          conversations.current(nativeThreadIds.main)?.readCanonicalState()?.turnsPagination
            ?.olderCursor,
          page.nextCursor,
        );

        const resident = conversations.entity(nativeThreadIds.main).readCanonicalState()!;
        const oldest = residentConversationTurns(resident)[0]!;
        const correlatedParams = { ...oldest.params, clientUserMessageId: "opening-client" };
        conversations.entity(nativeThreadIds.main).mutateCanonicalState((draft) => {
          const entry = residentConversationTurnEntries(draft)[0];
          if (!entry) throw new Error("Expected a resident turn");
          conversationTurnDraft(draft, entry.address)!.params = castDraft(correlatedParams);
        }, Date.now());
        const overlapping = yield* directory.acceptResumeResult({
          ...input,
          response: {
            ...response,
            thread: appThread(nativeThreadIds.main),
            initialTurnsPage: { ...page, data: [{ ...turn("oldest"), items: [] }] },
          },
        });
        assert.deepEqual(overlapping.canonical?.turns[0]?.params, {
          ...correlatedParams,
          approvalPolicy: response.approvalPolicy,
          approvalsReviewer: response.approvalsReviewer,
          sandboxPolicy: response.sandbox,
          model: response.model,
          effort: response.reasoningEffort,
        });
        assert.deepEqual(overlapping.canonical?.turns[0]?.items, oldest.items);
        assert.deepEqual(
          overlapping.snapshot?.turns.map((value) => value.turnId),
          ["oldest", "newest"],
        );

        const acceptedPages: Array<typeof page> = [
          { ...page, data: [{ ...turn("missing-items"), items: [], itemsView: "notLoaded" }] },
          { ...page, data: Array.from({ length: 6 }, (_, index) => turn(`turn-${index}`)) },
          {
            ...page,
            data: [
              {
                ...turn("too-many-items"),
                items: Array.from({ length: 501 }, (_, index) => turn(`item-${index}`).items[0]!),
              },
            ],
          },
          { ...page, data: [] },
        ];
        const expectedTurns = page.data.slice().reverse();
        for (const initialTurnsPage of acceptedPages) {
          expectedTurns.push(...initialTurnsPage.data.slice().reverse());
          const accepted = yield* directory.acceptResumeResult({
            ...input,
            response: { ...response, initialTurnsPage },
          });
          assert.deepEqual<unknown>(
            accepted.canonical?.turns.map((value) => ({
              rootTurnId: null,
              id: value.turnId,
              itemsView: value.itemsView,
              items: value.items,
            })),
            expectedTurns.map(({ id, itemsView, items }) => ({
              rootTurnId: null,
              id,
              itemsView,
              items,
            })),
          );
          assert.strictEqual(accepted.snapshot?.turnPagination?.hasLoadedOldest, false);
          assert.strictEqual(
            accepted.snapshot?.turnPagination?.olderCursor,
            initialTurnsPage.nextCursor,
          );
        }
        const empty = yield* directory.acceptResumeResult({
          ...input,
          response: {
            ...response,
            initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
          },
        });
        assert.strictEqual(historyReads.length, 1);
        assert.deepEqual(
          empty.canonical?.turns.map((value) => value.turnId),
          expectedTurns.map((value) => value.id),
        );
        assert.strictEqual(empty.snapshot?.turnPagination?.hasLoadedOldest, true);
        const queuedInput = [
          { type: "text" as const, text: "captured queue input", text_elements: [] },
        ];
        const queueReceipt = {
          id: "native-row",
          clientUserMessageId: "queued-client",
          responsesapiClientMetadata: null,
          input: queuedInput,
        };
        conversations.entity(nativeThreadIds.main).mutateCanonicalState((draft) => {
          const entry = residentConversationTurnEntries(draft)[0];
          if (!entry) throw new Error("Expected a resident turn");
          conversationTurnDraft(draft, entry.address)!.items.push({
            type: "steeringUserMessage",
            id: "pending-native-row",
            targetTurnId: "oldest",
            targetTurnStartedAtMs: null,
            status: "pending",
            clientUserMessageId: "queued-client",
            input: queuedInput,
            attachments: [],
            serverQueuedSubmission: queueReceipt,
            restoreMessage: { context: { commentAttachments: [] } },
            compareKey: { rawText: "captured queue input", imageCount: 0 },
          });
        }, Date.now());
        const queueEchoPage = {
          ...page,
          data: [
            {
              ...turn("oldest"),
              items: [
                {
                  type: "userMessage" as const,
                  id: "queue-echo",
                  clientId: "queued-client",
                  content: queuedInput,
                },
              ],
            },
          ],
        };
        const readOnlyQueue = yield* directory.acceptResumeResult({
          ...input,
          response: { ...response, initialTurnsPage: queueEchoPage },
        });
        assert.isUndefined(readOnlyQueue.canonical?.unconfirmedServerQueueMessages);
        const ownedQueue = yield* directory.acceptResumeResult({
          ...input,
          canRecordQueueAcceptance: () => true,
          response: { ...response, initialTurnsPage: queueEchoPage },
        });
        assert.deepEqual(ownedQueue.canonical?.unconfirmedServerQueueMessages, [queueReceipt]);
        const ackInput = [{ type: "text" as const, text: "ack captured input", text_elements: [] }];
        const ackReceipt = {
          id: "native-ack-row",
          clientUserMessageId: "ack-client",
          responsesapiClientMetadata: null,
          input: ackInput,
        };
        conversations.entity(nativeThreadIds.main).mutateCanonicalState((draft) => {
          const entry = residentConversationTurnEntries(draft)[0];
          if (!entry) throw new Error("Expected a resident turn");
          conversationTurnDraft(draft, entry.address)!.items.push({
            type: "steeringUserMessage",
            id: "pending-ack-row",
            targetTurnId: "oldest",
            targetTurnStartedAtMs: null,
            status: "accepted",
            clientUserMessageId: "ack-client",
            input: ackInput,
            attachments: [],
            serverQueuedSubmission: ackReceipt,
            restoreMessage: { context: { commentAttachments: [] } },
            compareKey: { rawText: "ack captured input", imageCount: 0 },
          });
        }, Date.now());
        const ownedAck = yield* directory.acceptResumeResult({
          ...input,
          canRecordQueueAcceptance: () => true,
          response: {
            ...response,
            initialTurnsPage: {
              ...page,
              data: [
                {
                  ...turn("oldest"),
                  items: [
                    {
                      type: "userMessage",
                      id: "ack-echo",
                      clientId: "ack-client",
                      content: ackInput,
                    },
                  ],
                },
              ],
            },
          },
        });
        assert.deepEqual(ownedAck.canonical?.unconfirmedServerQueueMessages, [
          queueReceipt,
          ackReceipt,
        ]);
        const installedAck = residentConversationTurns(
          conversations.current(nativeThreadIds.main)!.readCanonicalState(),
        )[0]?.items.find((item) => item.id === "pending-ack-row");
        assert.ok(installedAck?.type === "steeringUserMessage");
        assert.strictEqual(installedAck.serverUserMessageId, "ack-echo");
        assert.deepEqual(installedAck.acceptedInput, ackInput);
        const baseline = yield* directory.resolve({
          threadId: nativeThreadIds.main,
          fidelity: "durable",
        });
        for (const mode of ["wrong-thread", "stale", "failure"] as const) {
          readMode = mode;
          capabilityCurrent = true;
          const failed = yield* directory.acceptResumeResult(input).pipe(Effect.flip);
          assert.strictEqual(failed.operation, "read");
          const retained = yield* directory.resolve({
            threadId: nativeThreadIds.main,
            fidelity: "durable",
          });
          assert.strictEqual(retained?.canonical, baseline?.canonical);
        }
        capabilityCurrent = true;
        invalidateAfterPersistence = true;
        const staleAcceptance = yield* directory
          .acceptResumeResult({
            ...input,
            response: { ...response, initialTurnsPage: page },
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(staleAcceptance));
        assert.strictEqual(
          conversations.current(nativeThreadIds.main)?.readCanonicalState(),
          baseline?.canonical,
        );
      }),
    ),
);

it.effect("owner Scope close interrupts an in-flight remote hydration", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const core = makeCore(new Map([[nativeThreadIds.main, coreThread(nativeThreadIds.main)]]));
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
      directory.resolve({ threadId: nativeThreadIds.main, fidelity: "live" }),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    yield* Scope.close(ownerScope, Exit.void);

    assert.strictEqual((yield* Fiber.await(resolve))._tag, "Failure");
    assert.isTrue(interrupted);
  }),
);

it.effect("strict selected target rejects a foreign durable host before any native hydration", () =>
  Effect.gen(function* () {
    const core = makeCore(
      new Map([
        [
          nativeThreadIds.child,
          coreThread(nativeThreadIds.child, { execution_host_id: "foreign" }),
        ],
      ]),
    );
    let requests = 0;
    const directory = yield* directoryFoundations.pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
      ),
      Effect.provideService(
        CodexConversationProjection,
        CodexConversationProjection.of({
          hydrate: () => Effect.die("No selected history may be installed"),
        } as never),
      ),
      Effect.provideService(
        CodexGateway,
        makeGateway((() => {
          requests++;
          return Effect.die("No foreign native request");
        }) as RequestOnHost),
      ),
      Effect.provideService(ConversationEntityMap, makeConversations()),
      Effect.provideService(CoreModules, core),
    );
    assert.isTrue(
      Exit.isFailure(
        yield* directory
          .resolve({
            threadId: nativeThreadIds.child,
            fidelity: "tail",
            expectedHostId: "remote-a",
          })
          .pipe(Effect.exit),
      ),
    );
    assert.strictEqual(requests, 0);
  }),
);

for (const race of ["host", "link", "parent"] as const)
  it.effect(`strict hydration sends its pre-request binding to Core after a ${race} race`, () =>
    Effect.gen(function* () {
      const original = coreThread(nativeThreadIds.child, {
        parent_thread_id: nativeThreadIds.root,
        session_id: "original-session",
      });
      const threads = new Map([
        [nativeThreadIds.child, original],
        [nativeThreadIds.root, coreThread(nativeThreadIds.root)],
      ]);
      const base = makeCore(threads);
      let writes = 0;
      const core = CoreModules.of({
        ...base,
        workspace: {
          ...base.workspace,
          apply: (input) => {
            writes++;
            assert.strictEqual(input.intent.kind, "observe_codex_thread_metadata");
            if (input.intent.kind !== "observe_codex_thread_metadata")
              return Effect.die("Wrong metadata admission");
            assert.strictEqual(input.intent.expected_execution_host_id, "remote-a");
            assert.deepStrictEqual(input.intent.expected_binding, {
              kind: "existing",
              project_id: "project-a",
              session_id: "original-session",
            });
            assert.strictEqual(input.intent.expected_parent_thread_id, nativeThreadIds.root);
            return Effect.fail(
              new CoreRuntimeError({
                message: "Binding changed",
                operation: "workspace.apply",
                reason: "operation",
                retryable: false,
                cause: new CoreModuleResponseError({
                  code: "conflict",
                  message: "Binding changed",
                  retryable: false,
                  recovery: { kind: "none" },
                }),
              }),
            );
          },
        },
      });
      const request = ((_host: string, method: string) =>
        Effect.sync(() => {
          assert.strictEqual(method, "thread/read");
          threads.set(nativeThreadIds.child, {
            ...original,
            ...(race === "host"
              ? { execution_host_id: "foreign" }
              : race === "link"
                ? { session_id: "new-session" }
                : { parent_thread_id: "new-parent" }),
          });
          return {
            thread: { ...appThread(nativeThreadIds.child), parentThreadId: nativeThreadIds.root },
          };
        })) as RequestOnHost;
      const directory = yield* directoryFoundations.pipe(
        Effect.provideService(
          CodexApplicationEventHub,
          CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
        ),
        Effect.provideService(
          CodexConversationProjection,
          CodexConversationProjection.of({
            hydrate: () => Effect.die("Rejected metadata cannot install history"),
          } as never),
        ),
        Effect.provideService(CodexGateway, makeGateway(request)),
        Effect.provideService(ConversationEntityMap, makeConversations()),
        Effect.provideService(CoreModules, core),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* directory
            .resolve({
              threadId: nativeThreadIds.child,
              fidelity: "tail",
              expectedHostId: "remote-a",
            })
            .pipe(Effect.exit),
        ),
      );
      assert.strictEqual(writes, 1);
      assert.notStrictEqual(threads.get(nativeThreadIds.child), original);
      assert.notStrictEqual(threads.get(nativeThreadIds.child)?.thread_name, "Hydrated Thread");
    }),
  );

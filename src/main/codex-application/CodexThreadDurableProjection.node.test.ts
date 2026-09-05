import type { Thread, Turn } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexConversationProjection } from "./CodexConversationProjection";
import {
  CodexSidebarSyncRuntime,
  type CodexSidebarSyncNotification,
} from "./CodexSidebarSyncRuntime";
import { make } from "./CodexThreadDurableProjection";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

type CoreThread = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "thread" }
>["thread"];

const coreThread = (overrides: Partial<CoreThread> = {}): CoreThread =>
  ({
    thread_id: "thread-a",
    project_id: "project-a",
    session_id: null,
    forked_from_id: null,
    parent_thread_id: null,
    thread_source: null,
    service_name: null,
    agent_nickname: null,
    agent_role: null,
    agent_path: null,
    thread_name: "Thread A",
    thread_preview: "",
    backend_binding: { kind: "codex" },
    model_id: "gpt-test",
    reasoning_effort: "high",
    service_tier: null,
    execution_host_id: "local",
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
    created_at: 1,
    updated_at: 1,
    recency_at: 1,
    linked_at: "2026-08-24T00:00:00.000Z",
    ...overrides,
  }) satisfies CoreThread;

const appThread = (turns: readonly Turn[]): Thread => ({
  model: null,
  reasoningEffort: null,
  id: "thread-a",
  extra: null,
  sessionId: "session-a",
  forkedFromId: null,
  parentThreadId: null,
  preview: "notification preview",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 2,
  recencyAt: 2,
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
  name: "Thread A",
  turns: [...turns],
});

const missingThread = (threadId: string) =>
  new CoreRuntimeError({
    message: "Native Core workspace.read failed",
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

it.effect(
  "accepts status that arrives before Thread identity without issuing a partial update",
  () =>
    Effect.gen(function* () {
      let applyCount = 0;
      let sidebarCount = 0;
      const workspace: CoreModuleClients["workspace"] = {
        read: (input) =>
          input.kind === "thread"
            ? Effect.fail(missingThread(input.thread_id) as never)
            : Effect.die(`Unexpected read ${input.kind}`),
        apply: () =>
          Effect.sync(() => {
            applyCount += 1;
            return {} as never;
          }),
      };
      const service = yield* make.pipe(
        Effect.provideService(
          CodexApplicationEventHub,
          CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
        ),
        Effect.provideService(
          CodexConversationProjection,
          CodexConversationProjection.of({} as CodexConversationProjection["Service"]),
        ),
        Effect.provideService(
          CodexSidebarSyncRuntime,
          CodexSidebarSyncRuntime.of({
            scheduleNotification: () => {
              sidebarCount += 1;
            },
          } as unknown as CodexSidebarSyncRuntime["Service"]),
        ),
        Effect.provideService(
          ConversationEntityMap,
          ConversationEntityMap.of({
            current: () => null,
          } as unknown as ConversationEntityMap["Service"]),
        ),
        Effect.provideService(
          CoreModules,
          CoreModules.of({ workspace } as unknown as CoreModuleClients),
        ),
      );

      yield* service.observe({
        hostId: "local",
        generation: 1,
        occurrenceId: "local:1:inbox-a:40",
        occurrenceToken: 40,
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "child-before-identity",
            status: { type: "active", activeFlags: [] },
          },
        },
      });

      assert.strictEqual(applyCount, 0);
      assert.strictEqual(sidebarCount, 0);
    }),
);

it.effect("serially commits archive and delete observations before scheduling sidebar repair", () =>
  Effect.gen(function* () {
    let stored: CoreThread | null = coreThread();
    const operations: string[] = [];
    const sidebar: string[] = [];
    const events: unknown[] = [];
    const workspace: CoreModuleClients["workspace"] = {
      read: () =>
        Effect.sync(() => {
          if (!stored) return { value: { kind: "thread", thread: coreThread() } } as never;
          return { value: { kind: "thread", thread: stored } } as never;
        }),
      apply: (input) =>
        Effect.sync(() => {
          operations.push(input.operationId);
          if (input.intent.kind === "set_thread_archived" && stored) {
            stored = { ...stored, archived: input.intent.archived };
          }
          if (input.intent.kind === "delete_thread") stored = null;
          return {} as never;
        }),
    };
    const service = yield* make.pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: (event) => events.push(event),
        }),
      ),
      Effect.provideService(
        CodexConversationProjection,
        CodexConversationProjection.of({} as CodexConversationProjection["Service"]),
      ),
      Effect.provideService(
        CodexSidebarSyncRuntime,
        CodexSidebarSyncRuntime.of({
          scheduleNotification: ({ notificationMethod }: CodexSidebarSyncNotification) => {
            sidebar.push(notificationMethod);
          },
        } as unknown as CodexSidebarSyncRuntime["Service"]),
      ),
      Effect.provideService(
        ConversationEntityMap,
        ConversationEntityMap.of({
          current: () => null,
        } as unknown as ConversationEntityMap["Service"]),
      ),
      Effect.provideService(
        CoreModules,
        CoreModules.of({ workspace } as unknown as CoreModuleClients),
      ),
    );

    yield* service.observe({
      hostId: "local",
      generation: 1,
      occurrenceId: "local:1:inbox-a:41",
      occurrenceToken: 41,
      notification: { method: "thread/archived", params: { threadId: "thread-a" } },
    });
    yield* service.observe({
      hostId: "local",
      generation: 1,
      occurrenceId: "local:1:inbox-a:42",
      occurrenceToken: 42,
      notification: { method: "thread/deleted", params: { threadId: "thread-a" } },
    });

    assert.deepEqual(operations, [
      "codex:notification:thread/archived:thread-a:local:1:inbox-a:41",
      "codex:notification:thread/deleted:thread-a:local:1:inbox-a:42",
    ]);
    assert.deepEqual(sidebar, ["thread/archived", "thread/deleted"]);
    assert.isNull(stored);
    assert.deepEqual(events.slice(-2), [
      {
        kind: "codex",
        value: { type: "threadArchivedState", threadId: "thread-a", archived: true },
      },
      { kind: "codex", value: { type: "threadDeleted", threadId: "thread-a" } },
    ]);
  }),
);

it.effect("invalidates the durable root after deleting a nested Subagent", () =>
  Effect.gen(function* () {
    const threads = new Map<string, CoreThread>([
      ["root-a", coreThread({ thread_id: "root-a", thread_name: "Root" })],
      [
        "child-a",
        coreThread({
          thread_id: "child-a",
          parent_thread_id: "root-a",
          thread_source: "subAgentThreadSpawn",
        }),
      ],
      [
        "grandchild-a",
        coreThread({
          thread_id: "grandchild-a",
          parent_thread_id: "child-a",
          thread_source: "subAgentThreadSpawn",
        }),
      ],
    ]);
    const events: unknown[] = [];
    const workspace: CoreModuleClients["workspace"] = {
      read: (input) =>
        Effect.sync(() => {
          if (input.kind !== "thread") throw new Error(`Unexpected read ${input.kind}`);
          const thread = threads.get(input.thread_id);
          if (!thread) throw new Error(`Missing fixture Thread ${input.thread_id}`);
          return { value: { kind: "thread", thread } } as never;
        }),
      apply: (input) =>
        Effect.sync(() => {
          if (input.intent.kind === "delete_thread") threads.delete(input.intent.thread_id);
          return {} as never;
        }),
    };
    const service = yield* make.pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: (event) => events.push(event),
        }),
      ),
      Effect.provideService(
        CodexConversationProjection,
        CodexConversationProjection.of({} as CodexConversationProjection["Service"]),
      ),
      Effect.provideService(
        CodexSidebarSyncRuntime,
        CodexSidebarSyncRuntime.of({
          scheduleNotification: () => undefined,
        } as unknown as CodexSidebarSyncRuntime["Service"]),
      ),
      Effect.provideService(
        ConversationEntityMap,
        ConversationEntityMap.of({
          current: () => null,
        } as unknown as ConversationEntityMap["Service"]),
      ),
      Effect.provideService(
        CoreModules,
        CoreModules.of({ workspace } as unknown as CoreModuleClients),
      ),
    );

    yield* service.observe({
      hostId: "local",
      generation: 1,
      occurrenceId: "local:1:inbox-a:43",
      occurrenceToken: 43,
      notification: { method: "thread/deleted", params: { threadId: "grandchild-a" } },
    });

    assert.isFalse(threads.has("grandchild-a"));
    assert.deepEqual(
      events.filter((event) => (event as { kind?: unknown }).kind === "codex").slice(-2),
      [
        { kind: "codex", value: { type: "threadDeleted", threadId: "grandchild-a" } },
        {
          kind: "codex",
          value: { type: "subagentOverviewInvalidated", rootThreadId: "root-a" },
        },
      ],
    );
  }),
);

it.effect("never treats thread/started as a history transport", () =>
  Effect.gen(function* () {
    const stored = coreThread();
    const hydrated: Array<Parameters<CodexConversationProjection["Service"]["hydrate"]>[0]> = [];
    const workspace: CoreModuleClients["workspace"] = {
      read: () => Effect.succeed({ value: { kind: "thread", thread: stored } } as never),
      apply: () => Effect.succeed({} as never),
    };
    const service = yield* make.pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
      ),
      Effect.provideService(
        CodexConversationProjection,
        CodexConversationProjection.of({
          hydrate: (input: Parameters<CodexConversationProjection["Service"]["hydrate"]>[0]) =>
            Effect.sync(() => {
              hydrated.push(input);
            }),
        } as unknown as CodexConversationProjection["Service"]),
      ),
      Effect.provideService(
        CodexSidebarSyncRuntime,
        CodexSidebarSyncRuntime.of({
          scheduleNotification: () => undefined,
        } as unknown as CodexSidebarSyncRuntime["Service"]),
      ),
      Effect.provideService(
        ConversationEntityMap,
        ConversationEntityMap.of({
          current: () => null,
        } as unknown as ConversationEntityMap["Service"]),
      ),
      Effect.provideService(
        CoreModules,
        CoreModules.of({ workspace } as unknown as CoreModuleClients),
      ),
    );
    const poisonTurn: Turn = {
      id: "turn-poison",
      items: Array.from({ length: 1_000 }, (_, index) => ({
        questions: null,
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

    yield* service.observe({
      hostId: "local",
      generation: 1,
      occurrenceId: "local:1:inbox-a:43",
      occurrenceToken: 43,
      notification: {
        method: "thread/started",
        params: { thread: appThread([poisonTurn]) },
      },
    });

    assert.lengthOf(hydrated, 1);
    assert.deepEqual(hydrated[0]?.canonical.turns, []);
    assert.strictEqual(hydrated[0]?.pagination.loadedTurnCount, 0);
    assert.isFalse(hydrated[0]?.pagination.hasLoadedOldest);
    assert.strictEqual(hydrated[0]?.pagination.itemsView, "notLoaded");
  }),
);

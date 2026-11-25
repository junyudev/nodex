import { describe } from "vite-plus/test";
import type { Thread, Turn } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CoreModuleResponseError } from "../core-client/core-client";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CoreRuntimeError, coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { CodexCanonicalConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { CodexAutoThreadTitle } from "./CodexAutoThreadTitle";
import {
  CodexConversationProjection,
  type CodexConversationProjectionService,
} from "./CodexConversationProjection";
import {
  CodexSidebarSyncRuntime,
  type CodexSidebarSyncNotification,
} from "./CodexSidebarSyncRuntime";
import { make, resolveCodexThreadAddedTitlePrompt } from "./CodexThreadDurableProjection";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { make as makeCodexSidebarSectionSync } from "./CodexSidebarSectionSync";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import { codexHostMessageParts } from "../../shared/codex-host-chunked-message";
import type { CodexConversationSnapshot } from "../../shared/types";
import { make as makeCodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";

describe("CodexThreadDurableProjection", () => {
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
      backend_binding: { driver: "codex", instanceId: "codex" },
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

  const appThread = (turns: readonly Turn[], overrides: Partial<Thread> = {}): Thread => ({
    model: null,
    reasoningEffort: null,
    id: "thread-a",
    environments: null,
    extra: null,
    sessionId: "session-a",
    forkedFromId: null,
    attachedToThreadId: null,
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
    originator: null,
    source: "unknown",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Thread A",
    daybreakEnabled: null,
    ...overrides,
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

  const noOpAutoTitle = CodexAutoThreadTitle.of({
    schedule: () => Effect.void,
  });

  it("uses a child spawn prompt and never guesses from an unavailable parent", () => {
    const child = appThread([], {
      id: "child-thread",
      parentThreadId: "parent-thread",
      preview: "child preview",
    });
    const parentCanonical = {
      turns: [
        {
          items: [
            {
              type: "collabAgentToolCall",
              receiverThreadIds: ["child-thread"],
              prompt: "Investigate the parser regression",
            },
          ],
        },
      ],
    } as unknown as CodexCanonicalConversationState;

    assert.strictEqual(
      resolveCodexThreadAddedTitlePrompt(child, parentCanonical),
      "Investigate the parser regression",
    );
    assert.strictEqual(resolveCodexThreadAddedTitlePrompt(child, null), "");
  });

  it.effect(
    "accepts status that arrives before Thread identity without issuing a partial update",
    () =>
      Effect.gen(function* () {
        let applyCount = 0;
        let sidebarCount = 0;
        const workspace: CoreModuleClients["workspace"] = {
          admitToolOperation: () => Effect.die("Unexpected application tool admission"),
          recordAgentRun: () => Effect.die("Unexpected Agent attribution"),
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
          Effect.provideService(CodexAutoThreadTitle, noOpAutoTitle),
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
              registerThreadMetadata: () => {},
              readThreadMetadata: () => null,
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

  it.effect(
    "serially commits archive and delete observations before scheduling sidebar repair",
    () =>
      Effect.gen(function* () {
        let stored: CoreThread | null = coreThread();
        const operations: string[] = [];
        const sidebar: string[] = [];
        const events: unknown[] = [];
        const workspace: CoreModuleClients["workspace"] = {
          admitToolOperation: () => Effect.die("Unexpected application tool admission"),
          recordAgentRun: () => Effect.die("Unexpected Agent attribution"),
          read: () =>
            Effect.suspend(() =>
              stored
                ? Effect.succeed({ value: { kind: "thread", thread: stored } } as never)
                : Effect.fail(missingThread("thread-a") as never),
            ),
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
          Effect.provideService(CodexAutoThreadTitle, noOpAutoTitle),
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
              registerThreadMetadata: () => {},
              readThreadMetadata: () => null,
              current: () => null,
            } as unknown as ConversationEntityMap["Service"]),
          ),
          Effect.provideService(
            CoreModules,
            CoreModules.of({ workspace } as unknown as CoreModuleClients),
          ),
        );

        // A terminal notification from another execution host cannot mutate this durable Thread.
        const foreignBefore = stored;
        assert.isFalse(
          yield* service.acceptsTerminalObservation({ hostId: "remote", threadId: "thread-a" }),
        );
        assert.isTrue(
          yield* service.acceptsTerminalObservation({ hostId: "local", threadId: "thread-a" }),
        );
        for (const method of ["thread/archived", "thread/deleted"] as const) {
          yield* service.observe({
            hostId: "remote",
            generation: 1,
            occurrenceId: `remote:1:${method}`,
            occurrenceToken: 40,
            notification: { method, params: { threadId: "thread-a" } },
          });
        }
        assert.strictEqual(stored, foreignBefore);
        assert.deepEqual(operations, []);
        assert.deepEqual(sidebar, []);
        assert.deepEqual(events, []);

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
          {
            kind: "codex",
            value: { type: "threadDeleted", hostId: "local", threadId: "thread-a" },
          },
        ]);
        assert.isTrue(
          yield* service.acceptsTerminalObservation({ hostId: "local", threadId: "thread-a" }),
        );
        stored = coreThread({ backend_binding: { driver: "claudeAgent", instanceId: "claude-a" } });
        const otherBackend = stored;
        assert.isFalse(
          yield* service.acceptsTerminalObservation({ hostId: "local", threadId: "thread-a" }),
        );
        yield* service.observe({
          hostId: "local",
          generation: 1,
          occurrenceId: "local:1:other-backend:43",
          occurrenceToken: 43,
          notification: { method: "thread/deleted", params: { threadId: "thread-a" } },
        });
        assert.strictEqual(stored, otherBackend);
        assert.strictEqual(operations.length, 2);
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
        admitToolOperation: () => Effect.die("Unexpected application tool admission"),
        recordAgentRun: () => Effect.die("Unexpected Agent attribution"),
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
        Effect.provideService(CodexAutoThreadTitle, noOpAutoTitle),
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
            registerThreadMetadata: () => {},
            readThreadMetadata: () => null,
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
          {
            kind: "codex",
            value: { type: "threadDeleted", hostId: "local", threadId: "grandchild-a" },
          },
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
      const addedTitleInputs: Array<Parameters<CodexAutoThreadTitle["Service"]["schedule"]>[0]> =
        [];
      const workspace: CoreModuleClients["workspace"] = {
        admitToolOperation: () => Effect.die("Unexpected application tool admission"),
        recordAgentRun: () => Effect.die("Unexpected Agent attribution"),
        read: () => Effect.succeed({ value: { kind: "thread", thread: stored } } as never),
        apply: () => Effect.succeed({} as never),
      };
      const service = yield* make.pipe(
        Effect.provideService(
          CodexApplicationEventHub,
          CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
        ),
        Effect.provideService(
          CodexAutoThreadTitle,
          CodexAutoThreadTitle.of({
            schedule: (input) => Effect.sync(() => addedTitleInputs.push(input)),
          }),
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
            registerThreadMetadata: () => {},
            readThreadMetadata: () => null,
            current: () => null,
          } as unknown as ConversationEntityMap["Service"]),
        ),
        Effect.provideService(
          CoreModules,
          CoreModules.of({ workspace } as unknown as CoreModuleClients),
        ),
      );
      const poisonTurn: Turn = {
        rootTurnId: null,
        id: "turn-poison",
        items: Array.from({ length: 1_000 }, (_, index) => ({
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
      assert.deepEqual(addedTitleInputs, [
        { threadId: "thread-a", prompt: "notification preview" },
      ]);
    }),
  );
});

describe("CodexSidebarSectionSync", () => {
  const make = makeCodexSidebarSectionSync;
  const section = {
    section_id: "section:work",
    kind: "custom" as const,
    name: "Work",
    rank_key: 1_000_000_000_000,
    revision: 1,
    lifecycle: "active" as const,
    direct_item_count: 1,
    effective_session_count: 1,
    has_waiting: false,
    has_running: false,
    has_unread: false,
  };

  const sectionWindow = (current = section) => ({
    value: {
      kind: "sidebar_section_window" as const,
      sections: {
        items: [current],
        next_cursor: null,
        authority: { projection_revision: 1 },
      },
    },
  });

  const projectWindow = () => ({
    value: {
      kind: "project_window" as const,
      projects: {
        items: [],
        next_cursor: null,
        authority: { projection_revision: 1 },
      },
    },
  });

  const task = {
    threadId: "thread:work",
    sessionId: "session:work",
    projectId: null,
    projectName: null,
    title: "Work task",
    preview: "",
    cwd: "/workspace",
    gitBranch: null,
    projectless: true,
    pinned: false,
    pinnedOrder: null,
    statusType: "idle" as const,
    statusActiveFlags: [],
    createdAt: 1,
    updatedAt: 2,
  };

  const harness = (
    mode: "unsupported" | "supported" | "persistent-failure" | "concurrent-revision",
    backendKind: "codex" | "acp" = "codex",
  ) => {
    let links: Array<{
      section_id: string;
      host_id: string;
      remote_section_id?: string | null;
      sync_state: "pending" | "ready" | "delete_pending" | "conflict" | "unsupported";
      observed_generation: number;
      last_error?: string | null;
      updated_at: string;
    }> =
      mode === "concurrent-revision"
        ? [
            {
              section_id: section.section_id,
              host_id: "local",
              remote_section_id: "remote:work",
              sync_state: "ready",
              observed_generation: 7,
              last_error: null,
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ]
        : [];
    const applied: unknown[] = [];
    const requests: Array<{ method: string; params: unknown }> = [];
    let currentSection = section;
    let sectionReads = 0;
    let revisionConflictPending = mode === "concurrent-revision";
    let remoteCreated = mode === "concurrent-revision";
    let persistentFailure = mode === "persistent-failure";
    const workspace = {
      read: (request: { readonly kind: string }) =>
        Effect.sync(() => {
          if (request.kind === "sidebar_section_window") {
            sectionReads += 1;
            return sectionWindow(currentSection) as never;
          }
          if (request.kind === "sidebar_section_host_link_window") {
            return {
              value: {
                kind: "sidebar_section_host_link_window",
                links: {
                  items: links,
                  next_cursor: null,
                  authority: { projection_revision: 1 },
                },
              },
            } as never;
          }
          if (request.kind === "sidebar_section_item_window") {
            return {
              value: {
                kind: "sidebar_section_item_window",
                items: {
                  items:
                    mode === "supported"
                      ? [
                          {
                            placement_id: "session:session:work",
                            rank_key: 0,
                            revision: 1,
                            value: {
                              kind: "session",
                              task: {
                                session: {
                                  id: "session:work",
                                  project_id: null,
                                  display_title: "Work task",
                                  no_thread_fallback_title: "Work task",
                                  pinned: false,
                                  pinned_order: null,
                                  archived: false,
                                  archived_at: null,
                                  unread: false,
                                  thread_id: "thread:work",
                                  order: 0,
                                  created_at: "2026-01-01T00:00:00.000Z",
                                  updated_at: "2026-01-01T00:00:01.000Z",
                                },
                                thread: null,
                              },
                            },
                          },
                        ]
                      : [],
                  next_cursor: null,
                  authority: { projection_revision: 1 },
                },
              },
            } as never;
          }
          if (request.kind === "session_window")
            return {
              value: {
                kind: "session_window",
                sessions: {
                  items:
                    mode === "supported"
                      ? [
                          {
                            task: {
                              session: {
                                id: task.sessionId,
                                project_id: task.projectId,
                                pinned: task.pinned,
                              },
                              thread: {
                                thread_id: task.threadId,
                                execution_host_id: "local",
                                backend_binding: {
                                  driver: backendKind === "acp" ? "acpRegistry" : backendKind,
                                  instanceId: backendKind,
                                },
                              },
                            },
                          },
                        ]
                      : [],
                  next_cursor: null,
                },
              },
            } as never;
          if (request.kind === "project_window") return projectWindow() as never;
          throw new Error(`Unexpected Core read: ${request.kind}`);
        }),
      apply: (request: {
        readonly intent: {
          readonly kind: string;
          readonly link?: (typeof links)[number];
          readonly section_id?: string;
          readonly host_id?: string;
        };
      }) =>
        Effect.suspend(() => {
          applied.push(request);
          if (
            request.intent.kind === "rename_sidebar_section" &&
            mode === "concurrent-revision" &&
            revisionConflictPending
          ) {
            revisionConflictPending = false;
            currentSection = { ...currentSection, name: "Concurrent Work", revision: 2 };
            return Effect.fail(
              coreRuntimeError({
                operation: "workspace.apply",
                reason: "operation",
                retryable: false,
                cause: new CoreModuleResponseError({
                  code: "revision_conflict",
                  message: "Sidebar Section revision changed",
                  retryable: true,
                } as never),
              }),
            );
          }
          if (request.intent.kind === "upsert_sidebar_section_host_link" && request.intent.link) {
            links = [
              ...links.filter(
                (link) =>
                  link.section_id !== request.intent.link?.section_id ||
                  link.host_id !== request.intent.link?.host_id,
              ),
              request.intent.link,
            ];
          }
          if (request.intent.kind === "delete_sidebar_section_host_link") {
            links = links.filter(
              (link) =>
                link.section_id !== request.intent.section_id ||
                link.host_id !== request.intent.host_id,
            );
          }
          return Effect.succeed({
            status: "committed",
            commit: { commit_seq: applied.length, store_epoch: "epoch:test" },
            outcome: { affected_project_ids: [], affected_thread_ids: [] },
          } as never);
        }),
    };
    const gateway = CodexGateway.of({
      localHostId: "local",
      events: Stream.empty,
      connection: () => Effect.succeed({ kind: "ready" as const, hostId: "local", generation: 7 }),
      requestOnHost: (_hostId: string, method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "threadSection/list") {
          if (mode === "unsupported") {
            return Effect.fail(
              codexRuntimeError({
                operation: "gateway.request",
                reason: "request",
                retryable: false,
                hostId: "local",
                generation: 7,
                method,
              }),
            );
          }
          return Effect.succeed({
            data: remoteCreated
              ? [
                  {
                    id: "remote:work",
                    name: mode === "concurrent-revision" ? "Remote Work" : "Work",
                    appearance: null,
                  },
                ]
              : [],
            nextCursor: null,
          });
        }
        if (method === "threadSection/create") {
          remoteCreated = true;
          return Effect.succeed({
            section: { id: "remote:work", name: "Work", appearance: null },
          });
        }
        if (method === "thread/list") {
          const listParams = params as {
            sectionId?: string | null;
            sortKey?: string | null;
          };
          if (
            listParams.sortKey === "section_position" &&
            typeof listParams.sectionId !== "string"
          ) {
            return Effect.fail(
              codexRuntimeError({
                operation: "gateway.request",
                reason: "request",
                retryable: false,
                hostId: "local",
                generation: 7,
                method,
                cause: new Error("section-position sorting requires a section filter"),
              }),
            );
          }
          if (persistentFailure) {
            return Effect.fail(
              codexRuntimeError({
                operation: "gateway.request",
                reason: "request",
                retryable: false,
                hostId: "local",
                generation: 7,
                method,
                cause: new Error("persistent test failure"),
              }),
            );
          }
          const sectionId = listParams.sectionId;
          return Effect.succeed({
            data: sectionId === null ? [{ id: "thread:work" }] : [],
            nextCursor: null,
          });
        }
        if (method === "thread/section/move") return Effect.succeed({});
        throw new Error(`Unexpected gateway request: ${method}`);
      },
    } as unknown as CodexGateway["Service"]);
    const directory = CodexThreadDirectory.of({
      resolve: () =>
        Effect.succeed({
          durable: {
            executionHostId: "local",
            backendBinding:
              backendKind === "codex"
                ? { driver: "codex", instanceId: "codex" }
                : { driver: "acpRegistry", instanceId: "claude-main" },
          },
        } as never),
    } as unknown as CodexThreadDirectory["Service"]);
    const catalog = CodexThreadCatalog.of({
      ensureSession: () => Effect.succeed(null),
    } as unknown as CodexThreadCatalog["Service"]);
    const hosts = ExecutionHostRuntime.of({
      hosts: () => Effect.succeed(mode === "persistent-failure" ? [{ hostId: "local" }] : []),
    } as unknown as ExecutionHostRuntime["Service"]);
    const runtime = make.pipe(
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(CodexThreadCatalog, catalog),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(
        CoreModules,
        CoreModules.of({ workspace } as unknown as CoreModules["Service"]),
      ),
      Effect.provideService(ExecutionHostRuntime, hosts),
    );
    return {
      applied,
      requests,
      runtime,
      readLinks: () => links,
      readSectionReads: () => sectionReads,
      setPersistentFailure: (value: boolean) => {
        persistentFailure = value;
      },
    };
  };

  it.effect("restarts reconciliation from fresh Core state after a Section revision conflict", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = harness("concurrent-revision");
        const service = yield* test.runtime;

        const result = yield* service.syncHost("local", "local-mutation");

        assert.strictEqual(result.capability, "supported");
        assert.isAtLeast(test.readSectionReads(), 2);
        const renameIntents = test.applied.flatMap((entry) => {
          const intent = (entry as { intent?: Record<string, unknown> }).intent;
          return intent?.kind === "rename_sidebar_section" ? [intent] : [];
        });
        assert.deepEqual(
          renameIntents.map((intent) => intent.expected_revision),
          [1, 2],
        );
      }),
    ),
  );

  it.effect("never projects an ACP Thread into Codex-owned remote Sections", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = harness("supported", "acp");
        const service = yield* test.runtime;

        yield* service.syncHost("local", "manual");

        assert.isFalse(test.requests.some(({ method }) => method === "thread/section/move"));
      }),
    ),
  );
});

describe("CodexThreadTitlePersistence", () => {
  const make = makeCodexThreadTitlePersistence;
  type CoreThread = Extract<
    ProjectWorkspaceReadSnapshot["value"],
    { readonly kind: "thread" }
  >["thread"];

  const coreThread = (
    threadId: string,
    name: string,
    backendKind: "codex" | "acp" = "codex",
    executionHostId = "local",
  ): CoreThread =>
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
      thread_name: name,
      thread_preview: "",
      backend_binding:
        backendKind === "codex"
          ? { driver: "codex", instanceId: "codex" }
          : { driver: "acpRegistry", instanceId: "claude-local" },
      model_id: "gpt-test",
      reasoning_effort: "high",
      service_tier: null,
      execution_host_id: executionHostId,
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
    }) satisfies CoreThread;

  const gateway = (
    request: CodexGateway["Service"]["requestForThread"],
  ): CodexGateway["Service"] => {
    const unsupported = () => Effect.die(new Error("Unsupported test operation"));
    return CodexGateway.of({
      promoteQueuedCatalogPage: Effect.succeed(false),
      localHostId: "local",
      requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
      requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
      events: Stream.empty,
      requestLocal: unsupported as CodexGateway["Service"]["requestLocal"],
      requestOnHost: unsupported as CodexGateway["Service"]["requestOnHost"],
      requestForThread: request,
      notifyLocal: unsupported,
      connection: unsupported,
      connectionChanges: () => Stream.empty,
      awaitReady: unsupported,
      reconcileHost: unsupported,
      removeHost: unsupported,
      restartHost: unsupported,
    });
  };

  const harness = (input: {
    readonly request: CodexGateway["Service"]["requestForThread"];
    readonly onProject?: (threadId: string, name: string) => void;
    readonly onCoreApply?: (threadId: string, name: string) => void;
    readonly backendKind?: "codex" | "acp";
    readonly executionHostId?: string;
    readonly committedTitle?: string;
    readonly publish?: (event: CodexApplicationEvent) => void;
  }) => {
    const names = new Map<string, string>();
    const projection = CodexConversationProjection.of({
      renameThread: ({ threadId, name }: { readonly threadId: string; readonly name: string }) =>
        Effect.sync(() => {
          names.set(threadId, name);
          input.onProject?.(threadId, name);
        }),
      read: (threadId: string) =>
        Effect.succeed({
          canonical: {} as never,
          snapshot: {
            threadId,
            threadName: names.get(threadId) ?? null,
            ephemeral: false,
            canonicalState: { turns: [{ params: undefined }] },
          } as unknown as CodexConversationSnapshot,
        }),
    } as unknown as CodexConversationProjectionService);
    const workspace: CoreModuleClients["workspace"] = {
      admitToolOperation: () => Effect.die("Unexpected application tool admission"),
      recordAgentRun: () => Effect.die("Unexpected Agent attribution"),
      apply: (operation) =>
        Effect.sync(() => {
          if (operation.intent.kind !== "update_thread") return {} as never;
          const name = operation.intent.patch.thread_name ?? "";
          names.set(operation.intent.thread_id, name);
          input.onCoreApply?.(operation.intent.thread_id, name);
          return {} as never;
        }),
      read: (read) => {
        const id = read.kind === "thread" ? read.thread_id : "unexpected";
        return Effect.succeed({
          value: {
            kind: "thread",
            thread: coreThread(
              id,
              input.committedTitle ?? names.get(id) ?? "",
              input.backendKind,
              input.executionHostId,
            ),
          },
        } as ProjectWorkspaceReadSnapshot);
      },
    };
    return make.pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: input.publish ?? (() => undefined),
        }),
      ),
      Effect.provideService(CodexConversationProjection, projection),
      Effect.provideService(CodexGateway, gateway(input.request)),
      Effect.provideService(
        CodexSidebarSyncRuntime,
        CodexSidebarSyncRuntime.of({
          scheduleNotification: (_notification: CodexSidebarSyncNotification) => undefined,
        } as unknown as CodexSidebarSyncRuntime["Service"]),
      ),
      Effect.provideService(
        CoreModules,
        CoreModules.of({ workspace } as unknown as CoreModuleClients),
      ),
    );
  };

  it.effect("rejects ACP titles before mutating projection, app-server, or Core", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const persistence = yield* harness({
        backendKind: "acp",
        onProject: () => calls.push("project"),
        onCoreApply: () => calls.push("workspace"),
        request: (() => Effect.sync(() => calls.push("remote"))) as never,
      });

      yield* persistence
        .setRequired({ threadId: "thread-acp", name: "ACP", normalization: "trim" })
        .pipe(Effect.flip);
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("serializes the complete title transaction per Thread", () =>
    Effect.gen(function* () {
      const firstRemote = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const calls: string[] = [];
      const persistence = yield* harness({
        request: ((_threadId, _method, params) => {
          const name = (params as { name: string }).name;
          return Effect.sync(() => void calls.push(`remote:${name}`)).pipe(
            Effect.andThen(
              name === "first"
                ? Deferred.succeed(firstRemote, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirst)),
                    Effect.as({}),
                  )
                : Effect.succeed({}),
            ),
          );
        }) as CodexGateway["Service"]["requestForThread"],
        onCoreApply: (_threadId, name) => calls.push(`workspace:${name}`),
      });

      const first = yield* Effect.forkChild(
        persistence.setRequired({ threadId: "thread-1", name: "first", normalization: "trim" }),
      );
      yield* Deferred.await(firstRemote);
      const second = yield* Effect.forkChild(
        persistence.setRequired({ threadId: "thread-1", name: "second", normalization: "trim" }),
      );
      yield* Effect.yieldNow;
      assert.deepEqual(calls, ["remote:first"]);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepEqual(calls, [
        "remote:first",
        "workspace:first",
        "remote:second",
        "workspace:second",
      ]);
    }),
  );

  it.effect("an automatic title names only an untitled Thread", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const request = ((_threadId, _method, params) =>
        Effect.sync(() =>
          calls.push(`remote:${(params as { name: string }).name}`),
        )) as CodexGateway["Service"]["requestForThread"];
      const automatic = {
        threadId: "thread-1",
        name: "Prompt preview",
        normalization: "trim",
        onlyIfUntitled: true,
      } as const;

      const untitled = yield* harness({ committedTitle: "", request });
      assert.isTrue(yield* untitled.set(automatic));
      assert.deepEqual(calls, ["remote:Prompt preview"]);

      const named = yield* harness({ committedTitle: "Manual title", request });
      assert.isFalse(yield* named.set(automatic));
      assert.deepEqual(calls, ["remote:Prompt preview"]);
    }),
  );

  it.effect("delivers titles and durable summaries without exporting conversation internals", () =>
    Effect.gen(function* () {
      const delivered: CodexApplicationEvent[] = [];
      const persistence = yield* harness({
        request: (() => Effect.succeed({})) as CodexGateway["Service"]["requestForThread"],
        publish: (event) => {
          Array.from(codexHostMessageParts(event, { transferId: `title-${delivered.length}` }));
          delivered.push(event);
        },
      });
      yield* persistence.setRequired({
        threadId: "fork-child",
        name: "Research (2)",
        normalization: "manual",
      });
      assert.deepInclude(delivered, {
        kind: "hostMessage",
        value: {
          type: "threadTitleUpdated",
          hostId: DEFAULT_CODEX_HOST_ID,
          conversationId: "fork-child",
          title: "Research (2)",
        },
      });
      const summary = delivered.find(
        (event) => event.kind === "codex" && event.value.type === "threadSummary",
      );
      assert.isDefined(summary);
      if (summary?.kind !== "codex" || summary.value.type !== "threadSummary") return;
      assert.strictEqual(summary.value.thread.threadName, "Research (2)");
      assert.notProperty(summary.value.thread, "canonicalState");
    }),
  );

  it.effect("routes remote title updates to the Thread execution host", () =>
    Effect.gen(function* () {
      const delivered: CodexApplicationEvent[] = [];
      const persistence = yield* harness({
        executionHostId: "ssh:builder",
        request: (() => Effect.succeed({})) as CodexGateway["Service"]["requestForThread"],
        publish: (event) => delivered.push(event),
      });

      yield* persistence.setRequired({
        threadId: "remote-thread",
        name: "Remote title",
        normalization: "manual",
      });

      assert.deepInclude(delivered, {
        kind: "hostMessage",
        value: {
          type: "threadTitleUpdated",
          hostId: "ssh:builder",
          conversationId: "remote-thread",
          title: "Remote title",
        },
      });
    }),
  );
});

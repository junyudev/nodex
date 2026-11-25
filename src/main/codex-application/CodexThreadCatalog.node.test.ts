import { describe } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import {
  CodexInternalThreadRegistry,
  make as makeInternalThreadRegistry,
} from "./CodexInternalThreadRegistry";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { make, make as makeThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import type { CodexSidebarSnapshot } from "../../shared/types";
import { DEFAULT_PROJECT_APPEARANCE } from "../../shared/project-appearance";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { projectCoreWorkspaceTask } from "./CodexThreadCatalogProjection";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type {
  ThreadReadStateEvent,
  ThreadReadStateIdentity,
} from "../../shared/codex-thread-read-state";
import { makeIdentityReadState } from "./CodexIdentityReadState";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexPeerClient } from "../platform/node/CodexPeerClient";
import { acquireCodexPeerEndpointManager } from "../platform/node/CodexPeerEndpoint";
import { CodexConversationPeerRuntime } from "../platform/node/CodexConversationPeerRuntime";
import { ScopedCallbackRuntime, layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { threadReadStateHostKeys } from "../codex/thread-read-state-identity";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  ProjectWorkspace,
  type DesktopProjectWorkspaceThread,
  type ProjectWorkspaceService,
} from "../project-application/ProjectWorkspace";
import { CodexApplicationEventHub, make as makeEventHub } from "./CodexApplicationEventHub";
import { make as makeCodexThreadReadState } from "./CodexThreadReadState";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import { CoreModuleResponseError } from "../core-client/core-client";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { makeTargetFixture, targetThread } from "./CodexThreadTargets.test-support";

describe("CodexThreadCatalog", () => {
  const coreProject = (id: string, root: string) => ({
    id,
    library_id: `library-${id}`,
    database_id: `database-${id}`,
    default_database_view_id: null,
    lifecycle: "active",
    binding_revision: 1,
    name: id,
    description: "",
    appearance: null,
    sources: [{ kind: "directory" as const, path: root, order: 0 }],
    primary_workspace_root: root,
    pinned: false,
    pinned_order: null,
    created_at: "2026-09-02T00:00:00.000Z",
    updated_at: "2026-09-02T00:00:00.000Z",
  });

  const emptyCoreWindow = (kind: "project_window" | "sidebar_overview" | "task_window") =>
    kind === "project_window"
      ? ({
          value: {
            kind,
            projects: { items: [], next_cursor: null, authority: { projection_revision: 1 } },
          },
        } as never)
      : kind === "sidebar_overview"
        ? ({
            value: {
              kind,
              pinned_tasks: {
                items: [],
                total_count: 0,
                next_cursor: null,
                authority: { projection_revision: 1 },
              },
            },
          } as never)
        : ({
            value: {
              kind,
              tasks: {
                items: [],
                total_count: 0,
                next_cursor: null,
                authority: { projection_revision: 1 },
              },
            },
          } as never);

  const coreTask = (
    threadId: string,
    backendBinding: { readonly driver: string; readonly instanceId: string },
  ) => ({
    session: {
      id: `session-${threadId}`,
      project_id: "project-a",
      no_thread_fallback_title: threadId,
      display_title: threadId,
      activityAt: 0,
      pinned: true,
      pinned_order: 0,
      archived: false,
      archived_at: null,
      unread: false,
      thread_id: threadId,
      created_at: "2026-09-02T00:00:00.000Z",
      updated_at: "2026-09-02T00:00:00.000Z",
    },
    thread: {
      thread_id: threadId,
      session_id: `session-${threadId}`,
      project_id: "project-a",
      forked_from_id: null,
      parent_thread_id: null,
      thread_source: null,
      service_name: null,
      agent_nickname: null,
      agent_role: null,
      agent_path: null,
      thread_name: threadId,
      thread_preview: `${threadId} preview`,
      backend_binding: backendBinding,
      model_id: "gpt-test",
      reasoning_effort: "high",
      service_tier: null,
      execution_host_id: "local",
      cwd: "/repo",
      managed_worktree_path: null,
      projectless_output_directory: null,
      projectless_workspace_browser_root: null,
      status: { status_type: "idle", active_flags: [] },
      archived: false,
      created_at: 100,
      updated_at: 200,
      recency_at: 200,
      linked_at: "2026-09-02T00:00:00.000Z",
    },
  });

  const runtimeTask = (sessionId: string) => {
    const task = coreTask(`unused-${sessionId}`, { driver: "codex", instanceId: "codex" });
    return {
      session: {
        ...task.session,
        id: sessionId,
        display_title: "Runtime chat",
        thread_id: null,
        execution_ref: { runtime_id: "runtime-1", thread_id: `root-${sessionId}` },
      },
      thread: null,
    };
  };

  const mixedBackendWindow = (kind: "sidebar_overview" | "task_window") => {
    const tasks = {
      items: [
        coreTask("thread-codex", { driver: "codex", instanceId: "codex" }),
        coreTask("thread-acp", { driver: "acpRegistry", instanceId: "claude-code" }),
        ...(kind === "task_window" ? [runtimeTask("session-runtime")] : []),
      ],
      total_count: kind === "task_window" ? 3 : 2,
      next_cursor: null,
      authority: { projection_revision: 1 },
    };
    return {
      value: kind === "sidebar_overview" ? { kind, pinned_tasks: tasks } : { kind, tasks },
    } as never;
  };

  const catalog = (input: {
    readonly read: (request: { readonly kind: string }) => Effect.Effect<unknown>;
    readonly apply?: (request: unknown) => Effect.Effect<unknown>;
    readonly sidebar?: Partial<CodexSidebarSyncRuntime["Service"]>;
    readonly awaitReady?: Effect.Effect<void>;
    readonly requestLocal?: (
      method: string,
      params: Record<string, unknown>,
      scheduling?: unknown,
    ) => Effect.Effect<unknown>;
  }) =>
    make().pipe(
      Effect.provideService(
        CodexGateway,
        CodexGateway.of({
          localHostId: "local",
          events: Stream.empty,
          awaitReady: () => input.awaitReady ?? Effect.void,
          connection: () => Effect.succeed({ kind: "ready", hostId: "local", generation: 1 }),
          requestLocal: (method: string, params: Record<string, unknown>, scheduling?: unknown) =>
            input.requestLocal?.(method, params, scheduling) ??
            Effect.die(`Unexpected gateway request: ${method}`),
        } as never),
      ),
      Effect.provideService(
        CodexInternalThreadRegistry,
        CodexInternalThreadRegistry.of({
          shouldSuppress: () => false,
          classification: () => null,
        } as never),
      ),
      Effect.provideService(
        CodexSidebarSyncRuntime,
        CodexSidebarSyncRuntime.of((input.sidebar ?? {}) as CodexSidebarSyncRuntime["Service"]),
      ),
      Effect.provideService(
        CodexThreadDirectory,
        CodexThreadDirectory.of({} as CodexThreadDirectory["Service"]),
      ),
      Effect.provideService(
        CoreModules,
        CoreModules.of({
          workspace: { read: input.read, apply: input.apply },
        } as unknown as CoreModuleClients),
      ),
    );

  it.effect("moves a Thread across Projects while preserving its physical workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const applied: Array<{ intent: Record<string, unknown> }> = [];
        let moved = false;
        const sourceThread = {
          ...coreTask("thread-move", { driver: "codex", instanceId: "codex" }).thread,
          project_id: "project-a",
          cwd: "/workspace/a",
          pinned_order: null,
          has_unread_turn: false,
        };
        const targetThread = { ...sourceThread, project_id: "project-b" };
        const service = yield* catalog({
          read: ({ kind }) => {
            if (kind === "thread") {
              return Effect.succeed({
                value: { kind: "thread", thread: moved ? targetThread : sourceThread },
              });
            }
            if (kind === "project_window") {
              return Effect.succeed({
                value: {
                  kind: "project_window",
                  projects: {
                    items: [
                      coreProject("project-a", "/workspace/a"),
                      coreProject("project-b", "/workspace"),
                    ],
                    next_cursor: null,
                    authority: { projection_revision: 1 },
                  },
                },
              });
            }
            return Effect.succeed(emptyCoreWindow(kind as never));
          },
          apply: (request) =>
            Effect.sync(() => {
              const value = request as { intent: Record<string, unknown> };
              applied.push(value);
              if (value.intent.kind === "move_thread") moved = true;
              return {
                status: "committed",
                commit: { commit_seq: 19, store_epoch: "epoch:test" },
                outcome: { affected_project_ids: [], affected_thread_ids: [] },
              } as never;
            }),
          sidebar: {
            ensureSession: () => Effect.succeed({ id: "session-thread-move" } as never),
            changed: () => Effect.succeed({ snapshot: {} } as never),
          },
        });

        const result = yield* service.move({
          hostId: "local",
          threadId: "thread-move",
          sourceContainerId: "project:project-a",
          targetContainerId: "project:project-b",
          beforeThreadId: null,
        });

        assert.strictEqual(result.status, "moved");
        const moveIntent = applied[0]?.intent;
        assert.isDefined(moveIntent);
        assert.deepEqual(moveIntent.metadata, {});
        assert.deepEqual(moveIntent.placement, { kind: "default" });
        assert.isUndefined(moveIntent.runtime_workspace_roots);
        assert.isUndefined(moveIntent.workspace_transition);
        assert.strictEqual(sourceThread.cwd, "/workspace/a");
        assert.strictEqual(targetThread.project_id, "project-b");
      }),
    ),
  );

  it.effect("unpins a moved chat before applying its manual destination placement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let pinned = true;
        let projectId = "project-a";
        const intents: Array<Record<string, unknown>> = [];
        const service = yield* catalog({
          read: ({ kind }) => {
            if (kind === "thread")
              return Effect.succeed({
                value: {
                  kind,
                  thread: {
                    ...coreTask("thread-move", { driver: "codex", instanceId: "codex" }).thread,
                    project_id: projectId,
                    pinned_order: pinned ? 0 : null,
                    has_unread_turn: false,
                  },
                },
              });
            if (kind === "project_window")
              return Effect.succeed({
                value: {
                  kind,
                  projects: {
                    items: [coreProject("project-a", "/a"), coreProject("project-b", "/b")],
                    next_cursor: null,
                    authority: { projection_revision: 1 },
                  },
                },
              });
            return Effect.succeed(emptyCoreWindow(kind as never));
          },
          apply: (request) =>
            Effect.sync(() => {
              const { intent } = request as { intent: Record<string, unknown> };
              intents.push(intent);
              if (intent.kind === "set_thread_pinned") pinned = false;
              if (intent.kind === "move_thread") {
                assert.isFalse(pinned);
                projectId = "project-b";
              }
              return {
                status: "committed",
                commit: { commit_seq: intents.length, store_epoch: "epoch:test" },
                outcome: { affected_project_ids: [], affected_thread_ids: [] },
              } as never;
            }),
          sidebar: {
            ensureSession: () => Effect.succeed({ id: "session-thread-move" } as never),
            changed: () => Effect.succeed({ snapshot: {} } as never),
          },
        });
        const moved = yield* service.move({
          hostId: "local",
          threadId: "thread-move",
          sourceContainerId: "project-pinned:project-a",
          targetContainerId: "project:project-b",
          beforeThreadId: null,
          afterThreadId: "thread:anchor",
        });
        assert.deepEqual(
          intents.map((intent) => intent.kind),
          ["set_thread_pinned", "move_thread"],
        );
        assert.deepEqual(intents[1]?.placement, { kind: "after", thread_id: "thread:anchor" });
        assert.equal(moved.projectionRevision, 2);
      }),
    ),
  );

  it.effect("materializes the Session before pinning a discovered Thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const applied: unknown[] = [];
        const service = yield* catalog({
          read: () =>
            Effect.succeed({
              value: {
                kind: "thread",
                thread: { thread_id: "thread-discovered", project_id: null },
              },
            }),
          apply: (request) =>
            Effect.sync(() => {
              events.push("pin:applied");
              applied.push(request);
            }),
          sidebar: {
            ensureSession: (threadId) =>
              Effect.sync(() => {
                assert.strictEqual(threadId, "thread-discovered");
                events.push("session:ensured");
                return { id: "session-discovered" } as never;
              }),
            changed: () =>
              Effect.sync(() => {
                events.push("sidebar:published");
                return { snapshot: {} } as never;
              }),
          },
        });

        yield* service.setPinned(" thread-discovered ", true);

        assert.deepEqual(events, ["session:ensured", "pin:applied", "sidebar:published"]);
        assert.deepEqual((applied[0] as { intent: unknown }).intent, {
          kind: "set_thread_pinned",
          thread_id: "thread-discovered",
          pinned: true,
        });
      }),
    ),
  );

  it.effect("keeps every Codex-only catalog list free of durable ACP Threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* catalog({
          read: ({ kind }) => {
            if (kind === "sidebar_overview" || kind === "task_window") {
              return Effect.succeed(mixedBackendWindow(kind));
            }
            return Effect.succeed(emptyCoreWindow(kind as never));
          },
        });

        const project = yield* service.listProject("project-a");

        assert.deepEqual(
          project.items.map((thread) => thread.threadId),
          ["thread-codex"],
        );
      }),
    ),
  );

  it.effect("resolves a mentioned Agent chat to its Session without the native directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads: string[] = [];
        const runtimeThread = "nodex:thread:agent-chat";
        const service = yield* catalog({
          read: (request) =>
            Effect.sync(() => {
              reads.push(request.kind);
              if (request.kind === "agent_runtime_session_binding_by_thread") {
                return {
                  value: {
                    kind: "agent_runtime_session_binding",
                    binding: {
                      session_id: "session-agent",
                      project_id: "project-a",
                      runtime_id: "runtime-1",
                      runtime_thread_id: runtimeThread,
                      launch_request_id: "launch",
                      bound_at: "2026-10-17T00:00:00.000Z",
                    },
                  },
                };
              }
              if (request.kind === "session") {
                return {
                  value: {
                    kind: "session",
                    session: { ...runtimeTask("session-agent").session, display_title: "Plan it" },
                  },
                };
              }
              throw new Error(`Unexpected read: ${request.kind}`);
            }),
        });

        const summary = yield* service.resolve(runtimeThread);

        assert.deepInclude(summary, {
          threadId: runtimeThread,
          sessionId: "session-agent",
          projectId: "project-a",
          threadName: "Plan it",
        });
        assert.deepEqual(reads, ["agent_runtime_session_binding_by_thread", "session"]);
      }),
    ),
  );
});

describe("CodexSidebarCapabilities", () => {
  type CoreThread = Extract<
    ProjectWorkspaceReadSnapshot["value"],
    { readonly kind: "thread" }
  >["thread"];

  const emptySnapshot: CodexSidebarSnapshot = {
    items: [],
    pinnedThreadIds: [],
    projectAssignments: {},
    projectlessThreadIds: [],
    revision: 0,
    generatedAt: 0,
  };

  const project = (input: {
    readonly id: string;
    readonly bindingRevision: number;
    readonly roots: readonly string[];
  }) => ({
    id: input.id,
    library_id: "library:test",
    database_id: `database:${input.id}`,
    default_database_view_id: null,
    lifecycle: "active" as const,
    binding_revision: input.bindingRevision,
    name: input.id,
    description: "",
    appearance: DEFAULT_PROJECT_APPEARANCE,
    sources: input.roots.map((root, order) => ({ kind: "directory" as const, path: root, order })),
    primary_workspace_root: input.roots[0] ?? null,
    pinned: false,
    pinned_order: null,
    created_at: "2026-08-24T00:00:00.000Z",
    updated_at: "2026-08-24T00:00:00.000Z",
  });

  const thread = (projectId: string): CoreThread => ({
    thread_id: "thread:move",
    project_id: projectId,
    session_id: "session:move",
    forked_from_id: null,
    parent_thread_id: null,
    thread_name: "Move me",
    thread_source: null,
    service_name: null,
    agent_nickname: null,
    agent_role: null,
    agent_path: null,
    thread_preview: "Move me",
    backend_binding: { driver: "codex", instanceId: "codex" },
    model_id: "gpt-test",
    reasoning_effort: "high",
    service_tier: "flex",
    execution_host_id: "local",
    writable_roots: ["/workspace/source"],
    cwd: "/workspace/source",
    managed_worktree_path: null,
    projectless_output_directory: null,
    projectless_workspace_browser_root: null,
    status: { status_type: "idle" as const, active_flags: [] },
    archived: false,
    pinned_order: null,
    has_unread_turn: false,
    dynamic_tool_catalogs: [],
    created_at: 1,
    updated_at: 2,
    recency_at: 2,
    linked_at: "2026-08-24T00:00:00.000Z",
  });

  const catalogHarness = (input: {
    readonly sourceRoot: string;
    readonly targetRoot: string;
    readonly targetBindingRevision: number;
  }) => {
    let current = thread("project:source");
    const applied: unknown[] = [];
    const source = project({ id: "project:source", bindingRevision: 1, roots: [input.sourceRoot] });
    const target = project({
      id: "project:target",
      bindingRevision: input.targetBindingRevision,
      roots: [input.targetRoot],
    });
    const workspace = {
      read: (request: { readonly kind: string }) =>
        Effect.sync(() => {
          if (request.kind === "project_window") {
            return {
              value: {
                kind: "project_window",
                projects: {
                  items: [source, target],
                  next_cursor: null,
                  authority: { projection_revision: 1 },
                },
              },
            } as never;
          }
          if (request.kind === "thread") {
            return { value: { kind: "thread", thread: current } } as never;
          }
          throw new Error(`Unexpected Core read: ${request.kind}`);
        }),
      apply: (request: { readonly intent: { readonly kind: string; readonly target?: unknown } }) =>
        Effect.sync(() => {
          applied.push(request);
          if (request.intent.kind === "move_thread") {
            current = {
              ...current,
              project_id: "project:target",
            };
          }
          return {
            status: "committed",
            commit: { commit_seq: 17, store_epoch: "epoch:test" },
            outcome: { affected_project_ids: [], affected_thread_ids: [] },
          } as never;
        }),
    };
    const sidebar = CodexSidebarSyncRuntime.of({
      sync: () => Effect.succeed({ snapshot: emptySnapshot } as never),
      changed: () => Effect.succeed({ snapshot: emptySnapshot } as never),
      ensureSession: () => Effect.succeed(null),
      invalidate: () => undefined,
      scheduleNotification: () => undefined,
    });
    return {
      applied,
      get current() {
        return current;
      },
      runtime: makeThreadCatalog().pipe(
        Effect.provideService(
          CodexGateway,
          CodexGateway.of({
            localHostId: "local",
            events: Stream.empty,
          } as unknown as CodexGateway["Service"]),
        ),
        Effect.provideService(
          CodexInternalThreadRegistry,
          CodexInternalThreadRegistry.of({
            shouldSuppress: () => false,
          } as unknown as CodexInternalThreadRegistry["Service"]),
        ),
        Effect.provideService(CodexSidebarSyncRuntime, sidebar),
        Effect.provideService(
          CodexThreadDirectory,
          CodexThreadDirectory.of({} as CodexThreadDirectory["Service"]),
        ),
        Effect.provideService(
          CoreModules,
          CoreModules.of({ workspace } as unknown as CoreModules["Service"]),
        ),
      ),
    };
  };

  it.effect(
    "moves a native conversation between Projects while preserving its execution workspace",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = catalogHarness({
            sourceRoot: "/workspace/source",
            targetRoot: "/unrelated/target",
            targetBindingRevision: 3,
          });
          const catalog = yield* harness.runtime;
          const result = yield* catalog.move({
            hostId: "local",
            threadId: "thread:move",
            sourceContainerId: "project:project:source",
            targetContainerId: "project:project:target",
            beforeThreadId: null,
            useDefaultOrder: true,
          });

          assert.strictEqual(result.status, "moved");
          assert.strictEqual(harness.applied.length, 1);
          const move = harness.applied[0] as {
            readonly intent: {
              readonly kind: string;
              readonly metadata: unknown;
              readonly target: unknown;
            };
          };
          assert.strictEqual(move.intent.kind, "move_thread");
          assert.deepStrictEqual(move.intent.metadata, {});
          assert.deepStrictEqual(move.intent.target, {
            kind: "project",
            project_id: "project:target",
          });
          assert.strictEqual(harness.current.cwd, "/workspace/source");
          assert.deepStrictEqual(harness.current.writable_roots, ["/workspace/source"]);
        }),
      ),
  );

  it.effect("classifies only protocol-authoritative internal roots, never child Threads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeInternalThreadRegistry;
        assert.strictEqual(
          registry.observeStarted({
            id: "thread:system",
            ephemeral: true,
            threadSource: "system",
          } as never),
          "structured-title",
        );
        assert.strictEqual(
          registry.observeStarted({
            id: "thread:internal",
            ephemeral: false,
            threadSource: "subagent",
          } as never),
          "non-sidebar",
        );
        assert.strictEqual(
          registry.observeStarted({
            id: "thread:child",
            ephemeral: false,
            threadSource: "subagent",
            parentThreadId: "thread:root",
          } as never),
          null,
        );
        assert.isTrue(registry.shouldSuppress("thread:system"));
        assert.isTrue(registry.shouldSuppress("thread:internal"));
        assert.isFalse(registry.shouldSuppress("thread:child"));
      }),
    ),
  );

  it("projects execution authority from the Core task window without follow-up reads", () => {
    const projected = projectCoreWorkspaceTask({
      session: {
        id: "session:authority",
        project_id: null,
        no_thread_fallback_title: "Authority",
        display_title: "Authority",
        activityAt: 0,
        pinned: true,
        pinned_order: 0,
        archived: false,
        archived_at: null,
        unread: false,
        created_at: "2026-08-24T00:00:00.000Z",
        updated_at: "2026-08-24T00:00:00.000Z",
      },
      thread: {
        ...thread("project:source"),
        project_id: null,
        projectless_output_directory: "/workspace/output",
        projectless_workspace_browser_root: "/workspace/browser",
      },
    } as never);

    assert.deepStrictEqual(projected.thread?.executionProfile, {
      modelId: "gpt-test",
      reasoningEffort: "high",
      serviceTier: "flex",
    });
    assert.strictEqual(projected.thread?.projectlessOutputDirectory, "/workspace/output");
    assert.strictEqual(projected.thread?.projectlessWorkspaceBrowserRoot, "/workspace/browser");
  });
});

describe("CodexIdentityReadState", () => {
  const setup = Effect.gen(function* () {
    let identity: ThreadReadStateIdentity = { kind: "chatgpt", accountId: "a", userId: "u" };
    let hosts = { local: "endpoint-a" };
    let pending: Effect.Effect<ThreadReadStateIdentity | null> | undefined;
    const outbound: unknown[] = [];
    const storage: Record<string, Record<string, string[]>> = {};
    const owner = yield* makeIdentityReadState({
      readIdentity: Effect.suspend(() => pending ?? Effect.succeed(identity)),
      hostKeys: Effect.sync(() => hosts),
      read: (key) => Effect.sync(() => storage[key] ?? {}),
      write: (key, host, thread, unread) =>
        Effect.sync(() => {
          const values = (storage[key] ??= {});
          values[host] = unread
            ? [...(values[host] ?? []), thread]
            : (values[host] ?? []).filter((id) => id !== thread);
        }),
      clear: (key) =>
        Effect.sync(() => {
          delete storage[key];
        }),
      select: () => Effect.void,
      project: () => Effect.void,
      accepted: (change) =>
        Effect.sync(() => {
          outbound.push(change);
        }),
    });
    const open = Effect.gen(function* () {
      const events: ThreadReadStateEvent[] = [];
      const result = yield* owner.open((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      );
      assert.strictEqual(result.status, "ready");
      if (result.status !== "ready") throw new Error("Unavailable");
      return { ...result.session, events };
    });
    return {
      owner,
      open,
      outbound,
      setReader: (reader: typeof pending) => {
        pending = reader;
      },
      setIdentity: (value: ThreadReadStateIdentity) => {
        identity = value;
      },
      setHosts: (value: typeof hosts) => {
        hosts = value;
      },
    };
  });

  it.effect(
    "unread delivery forwards every change without retiring the session before an identity change",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* setup;
          const slow = yield* runtime.open;
          const captured = yield* runtime.owner.captureContext("local");
          if (!captured) throw new Error("Missing authenticated context");
          const threadIds = Array.from({ length: 1025 }, (_, index) => `thread-${index}`);
          for (const threadId of threadIds) {
            yield* runtime.owner.acceptBroadcast({
              hostId: "local",
              threadId,
              hasUnreadTurn: true,
              context: { identity: slow.identity, executionHostKey: "endpoint-a" },
            });
            assert.strictEqual(slow.events.at(-1)?.type, "changed");
          }
          assert.deepEqual(
            yield* slow.set({ hostId: "local", threadId: "late", hasUnreadTurn: true }),
            { status: "ok" },
          );
          assert.isTrue(yield* captured.isCurrent);
          runtime.setIdentity({ kind: "chatgpt", accountId: "other", userId: "u" });
          yield* runtime.owner.refresh;
          assert.deepEqual(slow.events, [
            ...threadIds.map((threadId) => ({
              type: "changed",
              origin: "external",
              hostId: "local",
              threadId,
              hasUnreadTurn: true,
            })),
            {
              type: "changed",
              origin: "self",
              hostId: "local",
              threadId: "late",
              hasUnreadTurn: true,
            },
            { type: "retired", reason: "identity" },
          ]);
          assert.isFalse(yield* captured.isCurrent);
          assert.deepEqual(
            yield* slow.set({ hostId: "local", threadId: "stale", hasUnreadTurn: true }),
            {
              status: "retired",
            },
          );
          assert.deepEqual((yield* runtime.open).unreadThreadIdsByHostId.local, []);
          runtime.setIdentity(slow.identity);
          yield* runtime.owner.refresh;
          const reopened = yield* runtime.open;
          assert.deepEqual(reopened.unreadThreadIdsByHostId.local, [...threadIds, "late"]);
          yield* slow.unsubscribe;
          assert.deepEqual(
            yield* reopened.set({ hostId: "local", threadId: "new", hasUnreadTurn: true }),
            { status: "ok" },
          );
        }),
      ),
  );

  it.effect("isolates accounts and retires sessions when identity changes", () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      const first = yield* runtime.open;
      yield* first.set({ hostId: "local", threadId: "thread", hasUnreadTurn: true });
      runtime.setIdentity({ kind: "chatgpt", accountId: "b", userId: "u" });
      yield* runtime.owner.refresh;
      assert.deepEqual(
        yield* first.set({ hostId: "local", threadId: "late", hasUnreadTurn: true }),
        {
          status: "retired",
        },
      );
      const second = yield* runtime.open;
      assert.deepEqual(second.unreadThreadIdsByHostId.local, []);
      runtime.setIdentity({ kind: "chatgpt", accountId: "a", userId: "u" });
      yield* runtime.owner.refresh;
      assert.deepEqual((yield* runtime.open).unreadThreadIdsByHostId.local, ["thread"]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a changed execution endpoint and does not reuse its unread list", () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      const first = yield* runtime.open;
      yield* first.set({ hostId: "local", threadId: "thread", hasUnreadTurn: true });
      runtime.setHosts({ local: "endpoint-b" });
      assert.deepEqual(
        yield* first.set({ hostId: "local", threadId: "late", hasUnreadTurn: true }),
        {
          status: "retired",
        },
      );
      assert.deepEqual((yield* runtime.open).unreadThreadIdsByHostId.local, []);
    }).pipe(Effect.scoped),
  );

  it.effect("delivers self and external changes and rejects updates after unsubscribe", () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      const first = yield* runtime.open;
      const second = yield* runtime.open;
      yield* first.set({ hostId: "local", threadId: "thread", hasUnreadTurn: true });
      assert.deepEqual(first.events, [
        {
          type: "changed",
          origin: "self",
          hostId: "local",
          threadId: "thread",
          hasUnreadTurn: true,
        },
      ]);
      assert.deepEqual(second.events, [
        {
          type: "changed",
          origin: "external",
          hostId: "local",
          threadId: "thread",
          hasUnreadTurn: true,
        },
      ]);
      yield* first.unsubscribe;
      assert.deepEqual(
        yield* first.set({ hostId: "local", threadId: "late", hasUnreadTurn: true }),
        {
          status: "retired",
        },
      );
    }).pipe(Effect.scoped),
  );

  it.effect("waits for identity refresh before admitting an old session write", () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      const first = yield* runtime.open;
      const identity = yield* Deferred.make<ThreadReadStateIdentity>();
      runtime.setReader(Deferred.await(identity));
      const refresh = yield* runtime.owner.refresh.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const write = yield* first
        .set({ hostId: "local", threadId: "late", hasUnreadTurn: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.deepEqual(runtime.outbound, []);
      yield* Deferred.succeed(identity, { kind: "chatgpt", accountId: "b", userId: "u" });
      yield* Fiber.join(refresh);
      assert.deepEqual(yield* Fiber.join(write), { status: "retired" });
      assert.deepEqual(runtime.outbound, []);
    }).pipe(Effect.scoped),
  );

  it.effect("accepts matching broadcasts without echo and fences captured context", () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      const first = yield* runtime.open;
      const captured = yield* runtime.owner.captureContext("local");
      assert.isNotNull(captured);
      if (!captured) return;
      const change = {
        hostId: "local",
        threadId: "remote",
        hasUnreadTurn: true,
        context: captured.context,
      };
      assert.deepEqual(yield* runtime.owner.acceptBroadcast(change), { status: "ok" });
      assert.deepEqual((yield* runtime.open).unreadThreadIdsByHostId.local, ["remote"]);
      assert.deepEqual(runtime.outbound, []);
      runtime.setIdentity({ kind: "chatgpt", accountId: "other", userId: "u" });
      yield* runtime.owner.refresh;
      assert.isFalse(yield* captured.isCurrent);
      assert.deepEqual(yield* runtime.owner.acceptBroadcast(change), { status: "retired" });
      yield* first.unsubscribe;
    }).pipe(Effect.scoped),
  );

  it.effect("preserves sessions after a same-identity refresh and waits for its result", () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      const first = yield* runtime.open;
      const identity = yield* Deferred.make<ThreadReadStateIdentity>();
      runtime.setReader(Deferred.await(identity));
      const refresh = yield* runtime.owner.refresh.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const write = yield* first
        .set({ hostId: "local", threadId: "same", hasUnreadTurn: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.deepEqual(runtime.outbound, []);
      yield* Deferred.succeed(identity, { kind: "chatgpt", accountId: "a", userId: "u" });
      yield* Fiber.join(refresh);
      assert.deepEqual(yield* Fiber.join(write), { status: "ok" });
      assert.strictEqual(runtime.outbound.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects both in-flight and queued broadcasts captured before retirement", () =>
    Effect.gen(function* () {
      const runtime = yield* setup;
      yield* runtime.open;
      const captured = yield* runtime.owner.captureContext("local");
      if (!captured) throw new Error("Missing context");
      const identity = yield* Deferred.make<ThreadReadStateIdentity>();
      runtime.setReader(Deferred.await(identity));
      const change = {
        hostId: "local",
        threadId: "one",
        hasUnreadTurn: true,
        context: captured.context,
      };
      const first = yield* runtime.owner
        .acceptBroadcast(change)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* runtime.owner
        .acceptBroadcast({ ...change, threadId: "two" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* runtime.owner.retire("hosts");
      yield* Deferred.succeed(identity, captured.context.identity);
      assert.deepEqual(yield* Fiber.join(first), { status: "retired" });
      assert.deepEqual(yield* Fiber.join(second), { status: "retired" });
      assert.deepEqual((yield* runtime.open).unreadThreadIdsByHostId.local, []);
    }).pipe(Effect.scoped),
  );
});

describe("CodexThreadReadState", () => {
  const make = makeCodexThreadReadState;
  const buildRuntime = Effect.fn("CodexThreadReadStateTest.buildRuntime")(function* (
    workspace: ProjectWorkspaceService,
    initiallyUnread = false,
    endpoint?: string,
    hostId = "local",
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
      Effect.provideService(CodexThreadHostResolver, { resolve: () => Effect.succeed(hostId) }),
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
      // oxlint-disable-next-line nodex/no-polling-loop-in-tests -- Yield to the Core read-state observer before checking its final durable write.
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

  it.effect("read-state writes fail when the selected execution identity is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* buildRuntime(
          {} as ProjectWorkspaceService,
          false,
          undefined,
          "missing-host",
        );
        yield* Effect.addFinalizer(() => Scope.close(runtime.scope, Exit.void));
        assert.isTrue(
          yield* runtime.readState
            .set({ threadId: "thread-a", hasUnreadTurn: true })
            .pipe(Effect.isFailure),
        );
        assert.isEmpty(runtime.persistedWrites);
      }),
    ),
  );
});

describe("CodexThreadTargets", () => {
  const missing = () =>
    coreRuntimeError({
      operation: "workspace.read",
      reason: "operation",
      retryable: false,
      cause: new CoreModuleResponseError({
        code: "not_found",
        message: "Missing Thread",
        retryable: false,
        recovery: { kind: "none" },
      }),
    });
  const emptyCore = CoreModules.of({
    workspace: {
      read: () => Effect.fail(missing()),
      apply: () => Effect.die("Readonly summary cannot write Core"),
    },
  } as unknown as CoreModules["Service"]);
  const item = (
    text: string,
    phase: "commentary" | "final_answer",
    delivery: "async" | null = null,
  ): ThreadItemEntry => ({
    turnId: "turn",
    startedAtMs: 1,
    completedAtMs: 2,
    item: {
      type: "agentMessage",
      moderation: null,
      id: text,
      text,
      phase,
      delivery,
      memoryCitation: null,
      questions: null,
    },
  });

  it.effect(
    "reads exactly one metadata header and one bounded descending item page without installing history",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeTargetFixture({
          core: emptyCore,
          request: (_host, method) =>
            Effect.succeed(
              method === "thread/read"
                ? { thread: targetThread("child") }
                : {
                    data: [
                      item("commentary", "commentary"),
                      item("**hel**lo [a](https://x)bc", "final_answer"),
                    ],
                    nextCursor: "must-not-follow",
                  },
            ) as never,
        });
        const result = yield* fixture.service.readSummary({
          hostId: "ssh:owner",
          threadId: "child",
        });
        assert.deepStrictEqual(result, {
          hostId: "ssh:owner",
          threadId: "child",
          title: "Created chat",
          status: { type: "idle" },
          latestReply: "hello abc",
        });
        assert.deepStrictEqual(
          fixture.requests.map((request) => [request.method, request.params]),
          [
            ["thread/read", { threadId: "child", includeTurns: false }],
            ["thread/items/list", { threadId: "child", limit: 100, sortDirection: "desc" }],
          ],
        );
        assert.strictEqual(fixture.listeners(), 0);
      }),
  );

  for (const retire of ["reset", "dispose"] as const)
    it.effect(
      `cancels an in-flight header when its physical source ${retire}s and releases observers`,
      () =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          let interrupted = false;
          const fixture = yield* makeTargetFixture({
            core: emptyCore,
            request: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ) as never,
          });
          const fiber = yield* fixture.service
            .readSummary({ hostId: "ssh:owner", threadId: "child" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          fixture[retire]();
          assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
          assert.isTrue(interrupted);
          assert.strictEqual(fixture.listeners(), 0);
          assert.strictEqual(fixture.requests.length, 1);
        }),
    );

  it.effect(
    "caller cancellation releases the read and late retirement cannot cancel a new attempt",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let interrupted = false;
        let suspended = true;
        const fixture = yield* makeTargetFixture({
          core: emptyCore,
          request: (_host, method) => {
            if (!suspended)
              return Effect.succeed(
                method === "thread/read"
                  ? { thread: targetThread("child") }
                  : { data: [], nextCursor: null },
              ) as never;
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ) as never;
          },
        });
        const fiber = yield* fixture.service
          .readSummary({ hostId: "ssh:owner", threadId: "child" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const lateCallbacks = fixture.retirementCallbacks();
        assert.strictEqual(lateCallbacks.length, 2);
        yield* Fiber.interrupt(fiber);
        assert.isTrue(interrupted);
        assert.strictEqual(fixture.listeners(), 0);
        suspended = false;
        for (const callback of lateCallbacks) callback();
        const result = yield* fixture.service.readSummary({
          hostId: "ssh:owner",
          threadId: "child",
        });
        assert.strictEqual(result.threadId, "child");
        assert.strictEqual(fixture.listeners(), 0);
        assert.strictEqual(fixture.requests.length, 3);
      }),
  );

  it.effect(
    "rejects an unavailable explicit host without creating a manager or issuing native reads",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeTargetFixture({ core: emptyCore });
        assert.isTrue(
          Exit.isFailure(
            yield* fixture.service
              .readSummary({ hostId: "foreign", threadId: "child" })
              .pipe(Effect.exit),
          ),
        );
        assert.strictEqual(fixture.requests.length, 0);
      }),
  );

  it.effect("rejects a non-metadata header before requesting items", () =>
    Effect.gen(function* () {
      const fixture = yield* makeTargetFixture({
        core: emptyCore,
        request: () =>
          Effect.succeed({ thread: { ...targetThread("wrong-child"), turns: [] } }) as never,
      });
      assert.isTrue(
        Exit.isFailure(
          yield* fixture.service
            .readSummary({ hostId: "ssh:owner", threadId: "child" })
            .pipe(Effect.exit),
        ),
      );
      assert.strictEqual(fixture.requests.length, 1);
    }),
  );
});

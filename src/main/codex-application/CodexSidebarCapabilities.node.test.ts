import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { CodexSidebarSnapshot } from "../../shared/types";
import { DEFAULT_PROJECT_APPEARANCE } from "../../shared/project-appearance";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import {
  CodexInternalThreadRegistry,
  make as makeInternalThreadRegistry,
} from "./CodexInternalThreadRegistry";
import {
  CodexSidebarSyncError,
  CodexSidebarSyncRuntime,
  make as makeSidebarSync,
} from "./CodexSidebarSyncRuntime";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadExecution } from "./CodexThreadExecution";
import { make as makeThreadCatalog } from "./CodexThreadCatalog";
import { projectCoreWorkspaceTask } from "./CodexThreadCatalogProjection";

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
  sources: input.roots.map((root, order) => ({ root, order })),
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
  backend_binding: { kind: "codex" as const },
  model_id: "gpt-test",
  reasoning_effort: "high",
  service_tier: "priority",
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
  const relocations: unknown[] = [];
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
            cwd: input.targetRoot,
            writable_roots: [input.targetRoot],
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
  const execution = CodexThreadExecution.of({
    relocate: (relocation: Parameters<CodexThreadExecution["Service"]["relocate"]>[0]) =>
      Effect.sync(() => {
        relocations.push(relocation);
      }),
  } as unknown as CodexThreadExecution["Service"]);

  return {
    applied,
    relocations,
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
      Effect.provideService(CodexThreadExecution, execution),
      Effect.provideService(
        CoreModules,
        CoreModules.of({ workspace } as unknown as CoreModules["Service"]),
      ),
    ),
  };
};

const sidebarHarness = (input: {
  readonly requestList: (params: {
    readonly archived: boolean;
    readonly cursor?: string | null;
  }) => Effect.Effect<unknown, CodexSidebarSyncError>;
  readonly directory?: CodexThreadDirectory["Service"];
  readonly runtimeOptions?: Parameters<typeof makeSidebarSync>[0];
}) => {
  const applied: Array<{ readonly intent: { readonly kind: string } }> = [];
  let snapshotReads = 0;
  const workspace = {
    read: (request: { readonly kind: string }) =>
      Effect.sync(() => {
        if (request.kind === "project_window") {
          return {
            value: {
              kind: "project_window",
              projects: {
                items: [],
                next_cursor: null,
                authority: { projection_revision: 1 },
              },
            },
          } as never;
        }
        if (request.kind === "sidebar_overview") {
          snapshotReads += 1;
          return {
            value: {
              kind: "sidebar_overview",
              pinned_tasks: {
                items: [],
                next_cursor: null,
                authority: { projection_revision: snapshotReads },
              },
            },
          } as never;
        }
        throw new Error(`Unexpected Core read: ${request.kind}`);
      }),
    apply: (request: { readonly intent: { readonly kind: string } }) =>
      Effect.sync(() => {
        applied.push(request);
        return {
          status: "committed",
          commit: { commit_seq: applied.length, store_epoch: "epoch:test" },
          outcome: { affected_project_ids: [], affected_thread_ids: [] },
        } as never;
      }),
  };
  const gateway = CodexGateway.of({
    localHostId: "local",
    events: Stream.empty,
    requestLocal: (method: string, params: { readonly archived: boolean }) => {
      if (method !== "thread/list") return Effect.die(`Unexpected gateway request: ${method}`);
      return input.requestList(params);
    },
  } as unknown as CodexGateway["Service"]);

  return {
    applied,
    snapshotReads: () => snapshotReads,
    runtime: makeSidebarSync(input.runtimeOptions).pipe(
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
      ),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(
        CodexThreadDirectory,
        input.directory ??
          CodexThreadDirectory.of({
            resolve: () => Effect.succeed(null),
            observeMetadata: () => Effect.die("unused"),
          } as unknown as CodexThreadDirectory["Service"]),
      ),
      Effect.provideService(
        CoreModules,
        CoreModules.of({ workspace } as unknown as CoreModules["Service"]),
      ),
      Effect.provideService(
        DatabaseNotifierRuntime,
        DatabaseNotifierRuntime.of({
          projectSessionInvalidations: Stream.never,
        } as unknown as DatabaseNotifierRuntime["Service"]),
      ),
      Effect.provideService(
        ExecutionHostRuntime,
        ExecutionHostRuntime.of({
          hosts: () => Effect.succeed([]),
        } as unknown as ExecutionHostRuntime["Service"]),
      ),
    ),
  };
};

it.effect("coalesces physical refreshes and crosses the Core invalidation fence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let activeRequests = 0;
      const harness = sidebarHarness({
        requestList: ({ archived }) => {
          if (archived) return Effect.succeed({ data: [], nextCursor: null });
          activeRequests += 1;
          return Deferred.await(release).pipe(Effect.as({ data: [], nextCursor: null }));
        },
      });
      const internalThreads = yield* makeInternalThreadRegistry;
      const runtime = yield* harness.runtime.pipe(
        Effect.provideService(CodexInternalThreadRegistry, internalThreads),
      );
      const first = yield* Effect.forkChild(runtime.sync({ policy: "force" }), {
        startImmediately: true,
      });
      const second = yield* Effect.forkChild(runtime.sync({ policy: "force" }), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      assert.strictEqual(activeRequests, 1);
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(first), yield* Fiber.join(second));

      yield* runtime.sync({ policy: "stale" });
      assert.strictEqual(activeRequests, 1);
      runtime.invalidate();
      yield* runtime.sync({ policy: "stale" });
      assert.strictEqual(activeRequests, 2);
      assert.isAtLeast(harness.snapshotReads(), 2);
    }),
  ),
);

it.effect("stops a capped background sweep before it can reconcile unseen Threads", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: Array<{ readonly archived: boolean; readonly cursor: string | null }> = [];
      const harness = sidebarHarness({
        runtimeOptions: { sweepMaxPages: 1 },
        requestList: ({ archived, cursor = null }) =>
          Effect.sync(() => {
            requests.push({ archived, cursor });
            return { data: [], nextCursor: "unseen-page" };
          }),
      });
      const internalThreads = yield* makeInternalThreadRegistry;
      const runtime = yield* harness.runtime.pipe(
        Effect.provideService(CodexInternalThreadRegistry, internalThreads),
      );

      yield* runtime.sync({ policy: "force" });
      for (let attempt = 0; attempt < 8; attempt += 1) yield* Effect.yieldNow;

      assert.deepEqual(requests, [{ archived: false, cursor: null }]);
      assert.strictEqual(
        harness.applied.filter(
          (request) => request.intent.kind === "reconcile_app_server_thread_sweep",
        ).length,
        0,
      );
    }),
  ),
);

it.effect("serves the Core snapshot without retrying during Effect-clock backoff", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let requests = 0;
      const harness = sidebarHarness({
        requestList: () => {
          requests += 1;
          return Effect.fail(new CodexSidebarSyncError({ cause: new Error("busy") }));
        },
      });
      const internalThreads = yield* makeInternalThreadRegistry;
      const runtime = yield* harness.runtime.pipe(
        Effect.provideService(CodexInternalThreadRegistry, internalThreads),
      );
      yield* runtime.sync({ policy: "read" });
      assert.strictEqual((yield* runtime.sync({ policy: "force" })).source, "stale-last-known");
      assert.strictEqual((yield* runtime.sync({ policy: "stale" })).source, "stale-last-known");
      assert.strictEqual(requests, 1);
      yield* TestClock.adjust("2 seconds");
      yield* runtime.sync({ policy: "stale" });
      assert.strictEqual(requests, 2);
    }),
  ),
);

it.effect("interrupts an admitted refresh when its Main Scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ownerScope = yield* Scope.make();
      let interrupted = false;
      const harness = sidebarHarness({
        requestList: () =>
          Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
      });
      const internalThreads = yield* makeInternalThreadRegistry;
      const runtime = yield* harness.runtime.pipe(
        Effect.provideService(CodexInternalThreadRegistry, internalThreads),
        Effect.provideService(Scope.Scope, ownerScope),
      );
      const pending = yield* Effect.forkChild(runtime.sync({ policy: "force" }), {
        startImmediately: true,
      });
      yield* Effect.yieldNow;
      yield* Scope.close(ownerScope, Exit.void);

      assert.isTrue(interrupted);
      assert.strictEqual((yield* Fiber.await(pending))._tag, "Failure");
    }),
  ),
);

it.effect(
  "archives protocol-internal and ephemeral roots while keeping child Threads sessionless",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const durable = (threadId: string) =>
          ({
            fidelity: "durable",
            durable: {
              ...thread("project:source"),
              threadId,
              projectId: "project:source",
              sessionId: null,
            },
            summary: {
              threadId,
              projectId: "project:source",
              threadPreview: threadId,
              modelProvider: "openai",
              statusType: "idle",
              statusActiveFlags: [],
              archived: false,
              pinned: false,
              createdAt: 1,
              updatedAt: 1,
            },
          }) as never;
        const existing = new Map([
          ["thread:ephemeral", durable("thread:ephemeral")],
          ["thread:internal", durable("thread:internal")],
        ]);
        let observedChild = false;
        const directory = CodexThreadDirectory.of({
          resolve: ({ threadId }: { readonly threadId: string }) =>
            Effect.succeed(existing.get(threadId) ?? null),
          observeMetadata: ({ thread: observed }: { readonly thread: { readonly id: string } }) =>
            Effect.sync(() => {
              observedChild = observed.id === "thread:child";
              return durable(observed.id);
            }),
        } as unknown as CodexThreadDirectory["Service"]);
        const harness = sidebarHarness({
          directory,
          requestList: ({ archived }) =>
            Effect.succeed({
              data: archived
                ? []
                : [
                    { id: "thread:ephemeral", ephemeral: true, threadSource: "system" },
                    { id: "thread:internal", ephemeral: false, threadSource: "subagent" },
                    {
                      id: "thread:child",
                      ephemeral: false,
                      threadSource: "subagent",
                      parentThreadId: "thread:root",
                      cwd: "/workspace/source",
                    },
                  ],
              nextCursor: null,
            }),
        });
        const internalThreads = yield* makeInternalThreadRegistry;
        const runtime = yield* harness.runtime.pipe(
          Effect.provideService(CodexInternalThreadRegistry, internalThreads),
        );
        yield* runtime.sync({ policy: "force" });

        assert.isTrue(observedChild);
        assert.strictEqual(
          harness.applied.filter((request) => request.intent.kind === "set_thread_archived").length,
          2,
        );
        assert.strictEqual(
          harness.applied.filter((request) => request.intent.kind === "create_session").length,
          0,
        );
        assert.strictEqual(
          harness.applied.filter(
            (request) => request.intent.kind === "observe_app_server_thread_window",
          ).length,
          0,
        );
      }),
    ),
);

it.effect("requires a grant fenced by the target Project binding revision", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = catalogHarness({
        sourceRoot: "/workspace/source",
        targetRoot: "/workspace/target",
        targetBindingRevision: 8,
      });
      const catalog = yield* harness.runtime;
      const result = yield* catalog.move({
        hostId: "local",
        threadId: "thread:move",
        sourceContainerId: "project:project:source",
        targetContainerId: "project:project:target",
        projectAccessGrant: {
          targetProjectId: "project:target",
          expectedBindingRevision: 7,
          missingProjectSources: ["/workspace/source"],
        },
        beforeThreadId: null,
        useDefaultOrder: true,
      });

      assert.deepStrictEqual(result, {
        status: "confirmation-required",
        reason: "target-project-needs-source-access",
        threadId: "thread:move",
        targetProjectId: "project:target",
        targetBindingRevision: 8,
        missingProjectSources: ["/workspace/source"],
        targetProjectName: "project:target",
      });
      assert.strictEqual(harness.applied.length, 0);
      assert.strictEqual(harness.relocations.length, 0);
    }),
  ),
);

it.effect(
  "relocates a loaded Thread through the final execution capability after Core commits",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = catalogHarness({
          sourceRoot: "/workspace/source",
          targetRoot: "/workspace",
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
        assert.deepStrictEqual(harness.relocations, [
          {
            threadId: "thread:move",
            loaded: true,
            location: {
              hostId: "local",
              cwd: "/workspace",
              workspaceRoots: ["/workspace"],
              managedWorktreePath: null,
              projectId: "project:target",
              projectlessOutputDirectory: null,
              projectlessWorkspaceBrowserRoot: null,
            },
          },
        ]);
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
      order: 0,
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
    serviceTier: "priority",
  });
  assert.strictEqual(projected.thread?.projectlessOutputDirectory, "/workspace/output");
  assert.strictEqual(projected.thread?.projectlessWorkspaceBrowserRoot, "/workspace/browser");
});

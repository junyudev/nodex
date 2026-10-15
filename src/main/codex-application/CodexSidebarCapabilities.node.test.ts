import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { CodexSidebarSnapshot } from "../../shared/types";
import { DEFAULT_PROJECT_APPEARANCE } from "../../shared/project-appearance";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import {
  CodexInternalThreadRegistry,
  make as makeInternalThreadRegistry,
} from "./CodexInternalThreadRegistry";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
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

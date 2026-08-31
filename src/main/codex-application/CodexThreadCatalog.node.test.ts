import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CodexInternalThreadRegistry } from "./CodexInternalThreadRegistry";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import {
  CODEX_PINNED_THREAD_LIST_MAX_PAGES,
  CODEX_THREAD_PALETTE_SEARCH_MAX_PAGES,
  make,
} from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadExecution } from "./CodexThreadExecution";

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
            pinned_tasks: { items: [], next_cursor: null, authority: { projection_revision: 1 } },
          },
        } as never)
      : ({
          value: {
            kind,
            tasks: { items: [], next_cursor: null, authority: { projection_revision: 1 } },
          },
        } as never);

const coreTask = (
  threadId: string,
  backendBinding:
    | { readonly kind: "codex" }
    | {
        readonly kind: "acp";
        readonly agent_definition_id: string;
        readonly instance_config_id: string | null;
      },
) =>
  ({
    session: {
      id: `session-${threadId}`,
      project_id: "project-a",
      no_thread_fallback_title: threadId,
      display_title: threadId,
      order: 0,
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
  }) as never;

const mixedBackendWindow = (kind: "sidebar_overview" | "task_window") => {
  const tasks = {
    items: [
      coreTask("thread-codex", { kind: "codex" }),
      coreTask("thread-acp", {
        kind: "acp",
        agent_definition_id: "claude-code",
        instance_config_id: null,
      }),
    ],
    next_cursor: null,
    authority: { projection_revision: 1 },
  };
  return {
    value: kind === "sidebar_overview" ? { kind, pinned_tasks: tasks } : { kind, tasks },
  } as never;
};

const catalog = (input: {
  readonly read: (request: { readonly kind: string }) => Effect.Effect<unknown>;
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
        connection: () => Effect.succeed({ kind: "ready", hostId: "local", generation: 1 }),
        requestLocal: (method: string, params: Record<string, unknown>, scheduling?: unknown) =>
          input.requestLocal?.(method, params, scheduling) ??
          Effect.die(`Unexpected gateway request: ${method}`),
      } as never),
    ),
    Effect.provideService(
      CodexInternalThreadRegistry,
      CodexInternalThreadRegistry.of({ shouldSuppress: () => false } as never),
    ),
    Effect.provideService(
      CodexSidebarSyncRuntime,
      CodexSidebarSyncRuntime.of({} as CodexSidebarSyncRuntime["Service"]),
    ),
    Effect.provideService(
      CodexThreadDirectory,
      CodexThreadDirectory.of({} as CodexThreadDirectory["Service"]),
    ),
    Effect.provideService(
      CodexThreadExecution,
      CodexThreadExecution.of({} as CodexThreadExecution["Service"]),
    ),
    Effect.provideService(
      CoreModules,
      CoreModules.of({ workspace: { read: input.read } } as unknown as CoreModuleClients),
    ),
  );

it.effect("fails closed instead of draining unbounded pinned Thread pages", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      const service = yield* catalog({
        read: ({ kind }) => {
          if (kind !== "sidebar_overview") return Effect.succeed(emptyCoreWindow(kind as never));
          return Effect.sync(() => {
            reads += 1;
            return {
              value: {
                kind: "sidebar_overview",
                pinned_tasks: {
                  items: [],
                  next_cursor: `cursor-${reads}`,
                  authority: { projection_revision: 1 },
                },
              },
            } as never;
          });
        },
      });
      const error = yield* service.listPinned.pipe(Effect.flip);

      assert.strictEqual(error.operation, "list-pinned");
      assert.strictEqual(reads, CODEX_PINNED_THREAD_LIST_MAX_PAGES);
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

      const [pinned, project, palette] = yield* Effect.all([
        service.listPinned,
        service.listProject("project-a"),
        service.listPalette({ scope: "sidebar" }),
      ] as const);

      assert.deepEqual(pinned, ["thread-codex"]);
      assert.deepEqual(
        project.items.map((thread) => thread.threadId),
        ["thread-codex"],
      );
      assert.deepEqual(
        palette.map((thread) => ({
          threadId: thread.threadId,
          backendBinding: thread.backendBinding,
        })),
        [{ threadId: "thread-codex", backendBinding: { kind: "codex" } }],
      );
    }),
  ),
);

it.effect("stops a unique-cursor empty Thread search at its page budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let searches = 0;
      const scheduling: unknown[] = [];
      const service = yield* catalog({
        read: ({ kind }) => Effect.succeed(emptyCoreWindow(kind as never)),
        requestLocal: (method, _params, options) => {
          if (method !== "thread/search")
            return Effect.die(`Unexpected gateway request: ${method}`);
          return Effect.sync(() => {
            searches += 1;
            scheduling.push(options);
            return { data: [], nextCursor: `cursor-${searches}` };
          });
        },
      });
      const error = yield* service.searchPalette({ query: "needle", limit: 1 }).pipe(Effect.flip);

      assert.strictEqual(error.operation, "search-palette");
      assert.strictEqual(searches, CODEX_THREAD_PALETTE_SEARCH_MAX_PAGES);
      assert.deepEqual(
        scheduling,
        Array.from({ length: CODEX_THREAD_PALETTE_SEARCH_MAX_PAGES }, () => ({
          expectedHostId: "local",
          expectedGeneration: 1,
          priority: "interactive",
          source: "thread_catalog",
          timeoutMs: 3_000,
        })),
      );
    }),
  ),
);

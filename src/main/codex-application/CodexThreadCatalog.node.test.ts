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

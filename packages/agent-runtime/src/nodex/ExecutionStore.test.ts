import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeOperations } from "./Interface.ts";
import * as ExecutionRoots from "./ExecutionRoots.ts";
import * as StoreCoordinate from "./StoreCoordinate.ts";

type Roots = AgentRuntimeOperations["execution.roots"]["output"];

it.live(
  "persists the Store coordinate across Runtime restarts and serves reconciliation roots",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-store-coordinate-" });
      const configuration = { home, cwd: home, providers: {} };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          const request = (method: string, input: unknown = {}) =>
            runtime.handle({ id: method, method, input });
          expect(yield* request("store.coordinate.read")).toEqual({ coordinate: null });
          expect(
            yield* request("store.coordinate.record", { coordinate: "profile:epoch:1" }),
          ).toEqual({ recorded: true });
          yield* request("command.dispatch", {
            command: {
              type: "thread.create",
              commandId: "create:root",
              threadId: "root",
              projectId: "project",
              title: "Root",
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: home,
              createdBy: "user",
              creationSource: "web",
            },
          });
          const page = (yield* request("execution.roots")) as Roots;
          expect(page.items).toEqual([
            {
              rootThreadId: "root",
              projectId: "project",
              title: "Root",
              createdAt: expect.any(String),
              deleted: false,
            },
          ]);
          yield* request("command.dispatch", {
            command: { type: "thread.delete", commandId: "delete:root", threadId: "root" },
          });
          expect(((yield* request("execution.roots")) as Roots).items[0]?.deleted).toBe(true);
          for (const limit of [0, 501, 1.5])
            expect(yield* request("execution.roots", { limit }).pipe(Effect.isFailure)).toBe(true);
          expect(
            yield* request("execution.roots", { cursor: "broken" }).pipe(Effect.isFailure),
          ).toBe(true);
        }).pipe(Effect.provide(Application.layer(configuration, () => Effect.void))),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          expect(
            yield* runtime.handle({ id: "read", method: "store.coordinate.read", input: {} }),
          ).toEqual({ coordinate: "profile:epoch:1" });
        }).pipe(Effect.provide(Application.layer(configuration, () => Effect.void))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "pages stable Session root identities including tombstones, excluding children and side chats",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A pressure fixture isolates bounded metadata paging from native execution and history bodies.
      yield* sql`WITH RECURSIVE roots(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM roots WHERE i < 503)
      INSERT INTO orchestration_v2_projection_threads(thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, payload_json)
      SELECT printf('root:%04d', i), CASE WHEN i = 1 THEN 'nodex:projectless:profile' ELSE 'project' END, 'Title', 'codex', 'full-access', 'default', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z',
        CASE WHEN i = 2 THEN '2026-11-01T00:00:01Z' ELSE NULL END,
        CASE WHEN i = 502 THEN '{"lineage":{"relationshipToParent":"subagent"}}'
          WHEN i = 503 THEN '{"sideChat":{"sourceThreadId":"root:0001"}}'
          WHEN i = 3 THEN '{"lineage":{"relationshipToParent":"fork"}}' ELSE '{}' END FROM roots`;
      const first = yield* ExecutionRoots.read({});
      expect(first.items).toHaveLength(200);
      expect(first.items[0]?.projectId).toBeNull();
      expect(first.items[1]?.deleted).toBe(true);
      expect(first.items[2]?.rootThreadId).toBe("root:0003");
      yield* sql`UPDATE orchestration_v2_projection_threads SET title = 'Renamed', deleted_at = '2026-11-01T01:00:00Z' WHERE thread_id = 'root:0201'`;
      const second = yield* ExecutionRoots.read({ cursor: first.nextCursor!, limit: 500 });
      expect(second.items).toHaveLength(301);
      expect(second.items[0]).toMatchObject({
        rootThreadId: "root:0201",
        title: "Renamed",
        deleted: true,
      });
      expect(new Set([...first.items, ...second.items].map((item) => item.rootThreadId)).size).toBe(
        501,
      );
      expect(second.nextCursor).toBeNull();
      expect((yield* StoreCoordinate.read).coordinate).toBeNull();
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.live.each([
  { version: 2, sourceProfileHome: "/source", importedAt: "2026-11-01T00:00:00Z" },
  { version: 1, sourceProfileHome: "relative", importedAt: "2026-11-01T00:00:00Z" },
  { version: 1, sourceProfileHome: "/source", importedAt: "yesterday" },
  { version: 1, sourceProfileHome: "/source", importedAt: "2026-02-31T00:00:00Z" },
  {
    version: 1,
    sourceProfileHome: "/source",
    importedAt: "2026-11-01T00:00:00Z",
    unexpected: true,
  },
])("refuses startup with an invalid import marker: %j", (marker) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-invalid-execution-import-" });
    const markerPath = path.join(home, "imported-execution.json");
    yield* fs.writeFileString(markerPath, JSON.stringify(marker));
    const result = yield* Effect.scoped(
      AgentRuntime.pipe(
        Effect.provide(Application.layer({ home, cwd: home, providers: {} }, () => Effect.void)),
        Effect.result,
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(String(result.failure)).toContain("Invalid imported-execution.json");
    expect(yield* fs.exists(markerPath)).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

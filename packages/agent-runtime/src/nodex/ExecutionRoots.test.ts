import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { workspaceInUse } from "./ExecutionRoots.ts";

it.effect(
  "forks and side chats keep their shared execution folder in use after the source is deleted",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, deleted_at TEXT, payload_json TEXT
    )`;
      const dir = "/workspace/chat";
      const insert = (id: string, deletedAt: string | null, payload: object) =>
        sql`INSERT INTO orchestration_v2_projection_threads VALUES (${id}, ${deletedAt}, ${JSON.stringify(payload)})`;
      yield* insert("source", "today", { worktreePath: dir });
      yield* insert("neighbour", null, { worktreePath: "/workspace/chat-neighbour" });
      assert.isFalse((yield* workspaceInUse({ path: dir })).inUse);
      yield* insert("fork", null, { worktreePath: dir, forkedFrom: { threadId: "source" } });
      assert.isTrue((yield* workspaceInUse({ path: dir })).inUse);
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = 'today' WHERE thread_id = 'fork'`;
      yield* insert("side", null, {
        executionLocation: { cwd: `${dir}/work` },
        sideChat: { sourceThreadId: "source" },
      });
      assert.isTrue((yield* workspaceInUse({ path: dir })).inUse);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

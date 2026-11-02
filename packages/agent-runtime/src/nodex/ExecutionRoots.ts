import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { AgentRuntimeOperations } from "./Interface.ts";

export const Input = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
const Cursor = Schema.Struct({ version: Schema.Literal(1), threadId: Schema.NonEmptyString });
const decodeCursor = Schema.decodeEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Cursor));
export class ExecutionRootsError extends Schema.TaggedError<ExecutionRootsError>()(
  "ExecutionRootsError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** Immutable Thread identities keep pagination stable across rename, archive and deletion. */
export const read = Effect.fn("ExecutionRoots.read")(function* (input: typeof Input.Type) {
  const sql = yield* SqlClient.SqlClient;
  const cursor =
    input.cursor === undefined
      ? null
      : yield* decodeCursor(input.cursor).pipe(
          Effect.mapError(
            (cause) =>
              new ExecutionRootsError({ message: "Invalid execution roots cursor.", cause }),
          ),
        );
  const limit = input.limit ?? 200;
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly project_id: string | null;
    readonly title: string;
    readonly created_at: string;
    readonly deleted_at: string | null;
  }>`SELECT thread_id, project_id, title, created_at, deleted_at
    FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.sideChat') IS NULL
      AND COALESCE(json_extract(payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
      AND thread_id > ${cursor?.threadId ?? ""}
    ORDER BY thread_id LIMIT ${limit + 1}`;
  return {
    items: rows.slice(0, limit).map((row) => ({
      rootThreadId: row.thread_id,
      projectId: row.project_id?.startsWith("nodex:projectless:") ? null : row.project_id,
      title: row.title,
      createdAt: row.created_at,
      deleted: row.deleted_at !== null,
    })),
    nextCursor:
      rows.length > limit
        ? encodeCursor({ version: 1, threadId: rows[limit - 1]!.thread_id })
        : null,
  } satisfies AgentRuntimeOperations["execution.roots"]["output"];
}, NodeSqliteClient.readOnly);

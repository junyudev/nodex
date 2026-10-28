import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  readSessionMetadata,
  type SessionExecutionMetadata,
  type SessionMetadataOptions,
} from "./SessionMetadata.ts";

export const SESSION_CATALOG_MAX_LIMIT = 100;

export interface SessionCatalogInput {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly includeSubagents?: boolean | undefined;
  /** Case-insensitive substring of title or bounded first user prompt. */
  readonly query?: string | undefined;
}

export interface SessionCatalogItem extends SessionExecutionMetadata {
  readonly threadId: string;
  readonly title: string;
  readonly preview: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly recencyAt: string | null;
  readonly createdAt: string;
  readonly status: "active" | "idle" | "systemError";
  readonly activeFlags: readonly ("waitingOnUserInput" | "waitingOnApproval")[];
  /** Resume strictly after this entry, including when a caller returns a smaller page. */
  readonly cursor: string;
}

export interface SessionCatalogPage {
  readonly items: readonly SessionCatalogItem[];
  readonly nextCursor: string | null;
}

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  query: Schema.String,
  includeSubagents: Schema.Boolean,
  at: Schema.String,
  threadId: Schema.String,
});
class SessionCatalogError extends Schema.TaggedError<SessionCatalogError>()("SessionCatalogError", {
  reason: Schema.Literal("invalid_cursor"),
  cause: Schema.Defect(),
}) {}
const decodeCursor = Schema.decodeEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Cursor));

/** Ordered metadata only: no history payload or Thread shell is hydrated for discovery. */
export const readSessionCatalog = Effect.fn("SessionCatalog.read")(function* (
  input: SessionCatalogInput,
  metadataOptions: SessionMetadataOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const query = input.query?.trim() ?? "";
  const after =
    input.cursor === undefined
      ? null
      : yield* decodeCursor(input.cursor).pipe(
          Effect.mapError((cause) => new SessionCatalogError({ reason: "invalid_cursor", cause })),
        );
  if (
    after !== null &&
    (after.query !== query || after.includeSubagents !== (input.includeSubagents ?? false))
  )
    return yield* new SessionCatalogError({
      reason: "invalid_cursor",
      cause: new Error("Session catalog cursor belongs to another query"),
    });
  const limit = Math.max(1, Math.min(SESSION_CATALOG_MAX_LIMIT, input.limit ?? 30));
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly title: string;
    readonly preview: string;
    readonly provider_instance_id: string;
    readonly model: string;
    readonly recency_at: string | null;
    readonly created_at: string;
    readonly sort_at: string;
    readonly pending_kind: string | null;
  }>`
    SELECT thread.thread_id, thread.title, thread.conversation_preview AS preview,
      COALESCE(thread.provider_instance_id, '') AS provider_instance_id,
      COALESCE(json_extract(thread.payload_json, '$.modelSelection.model'), '') AS model,
      thread.conversation_recency_at AS recency_at, thread.created_at,
      COALESCE(thread.conversation_recency_at, thread.created_at) AS sort_at,
      (SELECT request.kind FROM orchestration_v2_projection_runtime_requests request
        WHERE request.thread_id = thread.thread_id AND request.status = 'pending'
          AND request.kind NOT IN ('dynamic_tool_call', 'auth_refresh')
        ORDER BY request.created_at DESC LIMIT 1) AS pending_kind
    FROM orchestration_v2_projection_threads thread INDEXED BY orchestration_v2_conversation_discovery_idx
    WHERE thread.deleted_at IS NULL AND json_extract(thread.payload_json, '$.sideChat') IS NULL
      AND (${input.includeSubagents ? 1 : 0} OR COALESCE(json_extract(thread.payload_json, '$.lineage.relationshipToParent'),'') <> 'subagent')
      AND (${query} = '' OR instr(lower(thread.title), lower(${query})) > 0
        OR instr(lower(thread.conversation_preview), lower(${query})) > 0)
      AND (${after?.at ?? null} IS NULL
        OR COALESCE(thread.conversation_recency_at, thread.created_at) < ${after?.at ?? null}
        OR (COALESCE(thread.conversation_recency_at, thread.created_at) = ${after?.at ?? null}
          AND thread.thread_id > ${after?.threadId ?? null}))
    ORDER BY COALESCE(thread.conversation_recency_at, thread.created_at) DESC, thread.thread_id
    LIMIT ${limit + 1}`;
  const metadata = new Map(
    (yield* readSessionMetadata(
      rows.slice(0, limit).map((row) => row.thread_id),
      metadataOptions,
    )).map((item) => [item.threadId, item]),
  );
  const items = rows.slice(0, limit).map((row): SessionCatalogItem => ({
    ...metadata.get(row.thread_id)!,
    threadId: row.thread_id,
    title: row.title,
    preview: row.preview,
    providerInstanceId: row.provider_instance_id,
    model: row.model,
    recencyAt: row.recency_at,
    createdAt: row.created_at,
    status: (() => {
      const state = metadata.get(row.thread_id)!;
      const status = state.activityRunStatus ?? state.runStatus;
      return status === "failed"
        ? "systemError"
        : status !== null && ["preparing", "starting", "running", "waiting"].includes(status)
          ? "active"
          : "idle";
    })(),
    activeFlags:
      row.pending_kind === null
        ? []
        : [row.pending_kind === "user_input" ? "waitingOnUserInput" : "waitingOnApproval"],
    cursor: encodeCursor({
      version: 1,
      query,
      includeSubagents: input.includeSubagents ?? false,
      at: row.sort_at,
      threadId: row.thread_id,
    }),
  }));
  return {
    items,
    nextCursor: rows.length > limit ? items.at(-1)!.cursor : null,
  } satisfies SessionCatalogPage;
}, NodeSqliteClient.readOnly);

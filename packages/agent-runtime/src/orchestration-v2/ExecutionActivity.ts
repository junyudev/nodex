import type { AgentRunReadback } from "../nodex/Interface.ts";
import type { ThreadActiveFlag } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  LIVE_PROVIDER_THREAD_PREDICATE,
  OPEN_DELIVERY_RUN_PREDICATE,
} from "./ProjectionRecoveryQueries.ts";
import {
  sessionAttentionFlags,
  OWN_ATTENTION_PREDICATE,
  CHILD_ATTENTION_PREDICATE,
  SIDE_CHAT_SOURCE_ROOT,
  ATTENTION_KINDS,
  ATTENTION_KIND_SQL_LIST,
  LIVE_RUN_PREDICATE,
  PENDING_ATTENTION_REQUEST_PREDICATE,
  REQUEST_ATTENTION_KIND_SQL,
  SECRET_CARD_ATTENTION_FACT_FROM_SQL,
} from "./SessionAttention.ts";

export const EXECUTION_ACTIVITY_PAGE_LIMIT = 200;
export const EXECUTION_ACTIVITY_MAX_PAGE_LIMIT = 500;
export const EXECUTION_ACTIVITY_MAX_POINT_READS = 64;

export const EXECUTION_ACTIVITY_BACKGROUND_TASK_LIMIT = 25;

const BackgroundTask = Schema.Struct({
  threadId: Schema.String,
  threadTitle: Schema.NullOr(Schema.String),
  taskId: Schema.String,
  kind: Schema.Literals(["command", "monitor", "background_task"]),
  description: Schema.NullOr(Schema.String),
  command: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  /** The Run whose work started the task, when its turn item says. */
  runId: Schema.NullOr(Schema.String),
});
export type RootActivityBackgroundTask = typeof BackgroundTask.Type;
const decodeBackgroundTasks = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(BackgroundTask)),
);

/** Live work for one non-idle root; only user attention rolls up from hidden side chats. */
export interface RootActivity {
  readonly rootThreadId: string;
  /** Temporary side chats surface user attention through their source Session. */
  readonly sideChatSourceThreadId?: string;
  readonly status: "running" | "waiting" | "background";
  readonly activeRunId: string | null;
  readonly readback?: AgentRunReadback | null;
  readonly pendingRequestCount: number;
  readonly activeFlags?: readonly ThreadActiveFlag[];
  readonly approvalPrompt?: string | null;
  readonly backgroundTasks: ReadonlyArray<RootActivityBackgroundTask>;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly updatedAt: string;
}

export interface RootActivityPage {
  readonly snapshotSequence: number;
  readonly items: ReadonlyArray<RootActivity>;
  readonly nextCursor: string | null;
}

/**
 * Live delegated tasks that wake their parent when they finish, whether or not the parent is
 * still running. Wait-mode tasks return through the blocking call and wake nothing.
 */
const WAKING_LIVE_TASK_PREDICATE = `status IN ('pending', 'running', 'waiting') AND origin = 'app_owned'
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.completionWake') = 'always' ELSE 0 END`;

/** Roots affected by a Thread change, including the visible sources of temporary side chats. */
export const readActivityRootIds = Effect.fn("ExecutionActivity.readActivityRootIds")(function* (
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly root_thread_id: string }>`
    WITH RECURSIVE roots(root_thread_id) AS (
      SELECT json_extract(payload_json, '$.lineage.rootThreadId')
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      UNION
      SELECT (${sql.literal(SIDE_CHAT_SOURCE_ROOT)})
      FROM roots CROSS JOIN orchestration_v2_projection_threads AS owner
        ON owner.thread_id = roots.root_thread_id
      WHERE json_extract(owner.payload_json, '$.sideChat.sourceThreadId') IS NOT NULL
    ) SELECT root_thread_id FROM roots WHERE root_thread_id IS NOT NULL`;
  return rows.map((row) => row.root_thread_id);
});

/**
 * Non-idle roots from indexed live work and pending attention. Root approvals, live input and
 * live secret cards wait immediately; asynchronous root questions wait after working Runs end.
 * Live, non-provider child approvals and questions handed to the person roll up. Side-chat attention also reaches its source.
 * No message or result body is read; cost follows live work, never retained history.
 */
export const readRootActivity = Effect.fn("ExecutionActivity.readRootActivity")(function* (input: {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly rootThreadIds?: ReadonlyArray<string> | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const limit = Math.max(
    1,
    Math.min(
      EXECUTION_ACTIVITY_MAX_PAGE_LIMIT,
      Math.trunc(input.limit ?? EXECUTION_ACTIVITY_PAGE_LIMIT),
    ),
  );
  const roots =
    input.rootThreadIds === undefined
      ? undefined
      : [...new Set(input.rootThreadIds)].slice(0, EXECUTION_ACTIVITY_MAX_POINT_READS);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const sequence = yield* sql<{ readonly sequence: number | null }>`
        SELECT MAX(sequence) AS sequence
        FROM orchestration_events INDEXED BY idx_orchestration_events_application_high_water
        WHERE aggregate_kind = 'project'
          OR (application_event_version = 2 AND aggregate_kind = 'thread')`;
      const snapshotSequence = sequence[0]?.sequence ?? 0;
      if (roots?.length === 0)
        return { snapshotSequence, items: [], nextCursor: null } satisfies RootActivityPage;
      const rows = yield* sql<{
        readonly root_thread_id: string;
        readonly active_runs: number;
        readonly pending_requests: number;
        readonly has_approval: number;
        readonly has_input: number;
        readonly approval_prompt: string | null;
        readonly active_tasks: number;
        readonly resumes: number;
        readonly fact_at: string | null;
        readonly background_tasks_json: string;
      }>`
        WITH RECURSIVE facts(thread_id, kind, at, amount, background_task, request_id) AS MATERIALIZED (
          SELECT thread_id, 'run', requested_at, 1, NULL, NULL FROM orchestration_v2_projection_runs
          WHERE ${sql.literal(LIVE_RUN_PREDICATE)}
          UNION ALL
          SELECT thread_id, ${sql.literal(REQUEST_ATTENTION_KIND_SQL)}, created_at, 1, NULL, runtime_request_id
          FROM orchestration_v2_projection_runtime_requests
          WHERE ${sql.literal(PENDING_ATTENTION_REQUEST_PREDICATE)}
          UNION ALL
          SELECT secret.thread_id, ${sql.literal(`'${ATTENTION_KINDS.input}'`)}, secret.updated_at, 1, NULL, secret.turn_item_id
          ${sql.literal(SECRET_CARD_ATTENTION_FACT_FROM_SQL)}
          UNION ALL
          SELECT thread_id, 'task', updated_at, 1, NULL, NULL FROM orchestration_v2_projection_subagents
          WHERE status IN ('pending', 'running', 'waiting')
          UNION ALL
          SELECT provider.thread_id, 'task', provider.updated_at, 1, task.value, NULL
          FROM orchestration_v2_projection_provider_threads AS provider
          CROSS JOIN json_each(
            CASE WHEN json_valid(provider.payload_json) THEN provider.payload_json ELSE '{}' END,
            '$.pendingBackgroundTasks'
          ) AS task
          WHERE provider.thread_id IS NOT NULL AND (${sql.literal(LIVE_PROVIDER_THREAD_PREDICATE)})
          UNION ALL
          SELECT thread_id, 'wake', NULL, 1, NULL, NULL FROM orchestration_v2_projection_runs
          WHERE ${sql.literal(OPEN_DELIVERY_RUN_PREDICATE)}
          UNION ALL
          SELECT thread_id, 'wake', updated_at, 1, NULL, NULL FROM orchestration_v2_projection_subagents
          WHERE ${sql.literal(WAKING_LIVE_TASK_PREDICATE)}
        ), rooted AS MATERIALIZED (
          SELECT json_extract(thread.payload_json, '$.lineage.rootThreadId') AS root_thread_id,
            facts.thread_id, facts.kind, facts.at, facts.amount, facts.background_task, facts.request_id,
            json_extract(thread.payload_json, '$.title') AS thread_title
          FROM facts
          -- Keep the live fact set outermost; discovery indexes must never turn this into
          -- a scan of retained Threads before their live facts are looked up.
          CROSS JOIN orchestration_v2_projection_threads AS thread
            ON thread.thread_id = facts.thread_id
          WHERE thread.deleted_at IS NULL
            AND (facts.kind NOT IN (${sql.literal(ATTENTION_KIND_SQL_LIST)})
              OR (${sql.literal(OWN_ATTENTION_PREDICATE)})
              OR (${sql.literal(CHILD_ATTENTION_PREDICATE)}))
        ), attention(root_thread_id, thread_id, kind, at, amount, request_id) AS (
          SELECT root_thread_id, thread_id, kind, at, amount, request_id
          FROM rooted WHERE kind IN (${sql.literal(ATTENTION_KIND_SQL_LIST)})
          UNION
          SELECT (${sql.literal(SIDE_CHAT_SOURCE_ROOT)}), attention.thread_id,
            attention.kind, attention.at, attention.amount, attention.request_id
          FROM attention CROSS JOIN orchestration_v2_projection_threads AS owner
            ON owner.thread_id = attention.root_thread_id
          WHERE json_extract(owner.payload_json, '$.sideChat.sourceThreadId') IS NOT NULL
        ), activity_facts AS MATERIALIZED (
          SELECT root_thread_id, thread_id, kind, at, amount FROM rooted
          WHERE kind NOT IN (${sql.literal(ATTENTION_KIND_SQL_LIST)})
          UNION ALL
          SELECT root_thread_id, thread_id, kind, at, amount FROM attention
        ), activity AS MATERIALIZED (
        SELECT root_thread_id,
          SUM(kind = 'run') AS active_runs,
          SUM(CASE WHEN kind IN (${sql.literal(ATTENTION_KIND_SQL_LIST)}) THEN amount ELSE 0 END) AS pending_requests,
          MAX(kind = ${ATTENTION_KINDS.approval}) AS has_approval,
          MAX(kind IN (${ATTENTION_KINDS.input}, ${ATTENTION_KINDS.question})) AS has_input,
          SUM(CASE WHEN kind = 'task' THEN amount ELSE 0 END) AS active_tasks,
          MAX(kind = 'wake' AND thread_id = root_thread_id) AS resumes,
          MAX(at) AS fact_at
        FROM activity_facts
        WHERE root_thread_id IS NOT NULL
          AND (${input.cursor ?? null} IS NULL OR root_thread_id > ${input.cursor ?? null})
          ${roots === undefined ? sql`` : sql`AND root_thread_id IN ${sql.in(roots)}`}
        GROUP BY root_thread_id
        HAVING active_runs > 0 OR pending_requests > 0 OR active_tasks > 0 OR resumes > 0
        ORDER BY root_thread_id
        LIMIT ${roots === undefined ? limit + 1 : roots.length}
        ), roster_tasks AS MATERIALIZED (
          SELECT rooted.root_thread_id, rooted.thread_id,
            CASE WHEN rooted.thread_id = rooted.root_thread_id THEN NULL ELSE rooted.thread_title END AS thread_title,
            json_extract(background_task, '$.taskId') AS task_id,
            CASE json_extract(background_task, '$.kind') WHEN 'command' THEN 'command' WHEN 'monitor' THEN 'monitor' ELSE 'background_task' END AS task_kind,
            json_extract(background_task, '$.description') AS description,
            json_extract(background_task, '$.command') AS command,
            json_extract(background_task, '$.startedAt') AS started_at,
            (SELECT item.run_id FROM orchestration_v2_projection_turn_items AS item
              WHERE item.turn_item_id = json_extract(background_task, '$.turnItemId')) AS run_id,
            ROW_NUMBER() OVER (PARTITION BY rooted.thread_id, json_extract(background_task, '$.taskId')
              ORDER BY json_extract(background_task, '$.startedAt'), rooted.at DESC, background_task) AS duplicate_position
          FROM rooted
          INNER JOIN activity ON activity.root_thread_id = rooted.root_thread_id
          WHERE background_task IS NOT NULL AND json_extract(background_task, '$.kind') IS NOT 'subagent'
        ), ranked_tasks AS MATERIALIZED (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY root_thread_id
            ORDER BY started_at, task_id, thread_id) AS position
          FROM roster_tasks WHERE duplicate_position = 1
        ), background_tasks AS MATERIALIZED (
          SELECT root_thread_id,
            json_group_array(json_object('threadId', thread_id, 'threadTitle', thread_title,
              'taskId', task_id, 'kind', task_kind, 'description', description,
              'command', command, 'startedAt', started_at, 'runId', run_id)) AS background_tasks_json
          FROM (SELECT * FROM ranked_tasks WHERE position <= ${EXECUTION_ACTIVITY_BACKGROUND_TASK_LIMIT}
            ORDER BY root_thread_id, position)
          GROUP BY root_thread_id
        )
        SELECT activity.*, COALESCE(background_tasks.background_tasks_json, '[]') AS background_tasks_json,
          (SELECT json_extract(item.payload_json, '$.prompt') FROM attention
            CROSS JOIN orchestration_v2_projection_runtime_requests AS request
              ON request.thread_id = attention.thread_id AND request.runtime_request_id = attention.request_id
            CROSS JOIN orchestration_v2_projection_turn_items AS item
              INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
              ON item.node_id = request.node_id AND item.thread_id = request.thread_id AND item.type = 'approval_request'
            WHERE attention.root_thread_id = activity.root_thread_id AND attention.kind = ${ATTENTION_KINDS.approval}
              AND json_extract(request.payload_json, '$.responseCapability.type') IN ('live', 'runtime')
              AND TRIM(COALESCE(json_extract(item.payload_json, '$.prompt'), '')) <> ''
            ORDER BY attention.at, attention.thread_id, attention.request_id, item.ordinal DESC LIMIT 1) AS approval_prompt
        FROM activity LEFT JOIN background_tasks ON background_tasks.root_thread_id = activity.root_thread_id
        ORDER BY activity.root_thread_id`;

      const page = roots === undefined ? rows.slice(0, limit) : rows;
      const heads =
        page.length === 0
          ? []
          : yield* sql<{
              readonly thread_id: string;
              readonly provider_instance_id: string | null;
              readonly model: string | null;
              readonly updated_at: string;
              readonly active_run_id: string | null;
              readonly side_chat_source_thread_id: string | null;
            }>`
              SELECT thread.thread_id, thread.provider_instance_id,
                json_extract(thread.payload_json, '$.modelSelection.model') AS model,
                thread.updated_at,
                json_extract(thread.payload_json, '$.sideChat.sourceThreadId') AS side_chat_source_thread_id,
                (SELECT run.run_id FROM orchestration_v2_projection_runs AS run
                  INDEXED BY orchestration_v2_projection_runs_thread_status_idx
                  WHERE run.thread_id = thread.thread_id
                    AND ${sql.literal(LIVE_RUN_PREDICATE)}
                  ORDER BY run.ordinal DESC LIMIT 1) AS active_run_id
              FROM orchestration_v2_projection_threads AS thread
              WHERE thread.thread_id IN ${sql.in(page.map((row) => row.root_thread_id))}`;
      const readbacks = heads.flatMap((head) =>
        head.active_run_id === null ? [] : [head.active_run_id],
      );
      const readbackRows =
        readbacks.length === 0
          ? []
          : yield* sql<{
              readonly run_id: string;
              readonly item_id: string;
              readonly text: string;
              readonly started_by_person: number;
            }>`SELECT run_id, json_extract(payload_json, '$.readback.itemId') AS item_id,
          json_extract(payload_json, '$.readback.text') AS text,
          COALESCE(json_extract(payload_json, '$.startedByPerson'), 0) AS started_by_person
        FROM orchestration_v2_projection_runs WHERE run_id IN ${sql.in(readbacks)}
          AND json_extract(payload_json, '$.readback') IS NOT NULL`;
      const readbackOf = new Map(
        readbackRows.map((row) => [
          row.run_id,
          {
            runId: row.run_id,
            itemId: row.item_id,
            text: row.text,
            startedByPerson: row.started_by_person === 1,
          },
        ]),
      );
      const headOf = new Map(heads.map((head) => [head.thread_id, head]));
      const items: Array<RootActivity> = [];
      for (const row of page) {
        const head = headOf.get(row.root_thread_id);
        if (head === undefined) continue;
        items.push({
          rootThreadId: row.root_thread_id,
          ...(head.side_chat_source_thread_id === null
            ? {}
            : { sideChatSourceThreadId: head.side_chat_source_thread_id }),
          status:
            row.pending_requests > 0 ? "waiting" : row.active_runs > 0 ? "running" : "background",
          activeRunId: head.active_run_id,
          readback:
            head.active_run_id === null ? null : (readbackOf.get(head.active_run_id) ?? null),
          pendingRequestCount: row.pending_requests,
          activeFlags: sessionAttentionFlags([
            { kind: ATTENTION_KINDS.approval, awaitsPerson: row.has_approval > 0 },
            { kind: ATTENTION_KINDS.input, awaitsPerson: row.has_input > 0 },
          ]),
          approvalPrompt: row.approval_prompt,
          backgroundTasks: yield* decodeBackgroundTasks(row.background_tasks_json),
          providerInstanceId: head.provider_instance_id ?? "",
          model: head.model ?? "",
          updatedAt:
            row.fact_at !== null && row.fact_at > head.updated_at ? row.fact_at : head.updated_at,
        });
      }
      return {
        snapshotSequence,
        items,
        nextCursor:
          roots === undefined && rows.length > limit ? page[page.length - 1]!.root_thread_id : null,
      } satisfies RootActivityPage;
    }),
  );
});

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  LIVE_PROVIDER_THREAD_PREDICATE,
  OPEN_DELIVERY_RUN_PREDICATE,
} from "./ProjectionRecoveryQueries.ts";

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
  readonly pendingRequestCount: number;
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
 * Same predicate as `orchestration_v2_projection_runs_active_provider_idx` (migration 063). A
 * `waiting` Run is still foreground work, for example a parent blocked on a delegated result.
 */
const LIVE_RUN_PREDICATE = `status IN ('preparing', 'starting', 'running', 'waiting')`;

/**
 * Live delegated tasks that wake their parent when they finish, whether or not the parent is
 * still running. Wait-mode tasks return through the blocking call and wake nothing.
 */
const WAKING_LIVE_TASK_PREDICATE = `status IN ('pending', 'running', 'waiting') AND origin = 'app_owned'
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.completionWake') = 'always' ELSE 0 END`;

/** A provider turn is working until it ends; a waiting Run only drains effects. */
const WORKING_RUN_PREDICATE = `status IN ('preparing', 'starting', 'running')`;

/** Message-capable questions await the user only after their own Thread stops working. */
const ASYNC_QUESTION_PREDICATE = `kind = 'user_input' AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.responseCapability.type') = 'message' ELSE 0 END`;

/** Own approvals and live input always wait; asynchronous questions wait between working Runs. */
const OWN_ATTENTION_PREDICATE = `facts.thread_id = json_extract(thread.payload_json, '$.lineage.rootThreadId')
      AND (facts.kind <> 'question' OR NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs AS working
        INDEXED BY orchestration_v2_projection_runs_thread_status_idx
        WHERE working.thread_id = facts.thread_id AND ${WORKING_RUN_PREDICATE}))`;

/** Coordinators answer child questions; only live delegated approvals need user attention. */
const CHILD_APPROVAL_PREDICATE = `facts.kind = 'approval'
      AND json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND json_extract(thread.payload_json, '$.creationSource') IS NOT 'provider'
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS live
        INDEXED BY orchestration_v2_projection_runs_thread_status_idx
        WHERE live.thread_id = facts.thread_id AND ${LIVE_RUN_PREDICATE})`;

/**
 * A side chat has its own execution root but no catalog row. Its user attention also reaches
 * the source's root; source lookups follow only exact Thread identities, never retained history.
 */
const SIDE_CHAT_SOURCE_ROOT = `SELECT json_extract(source.payload_json, '$.lineage.rootThreadId')
      FROM orchestration_v2_projection_threads AS source
      WHERE source.thread_id = json_extract(owner.payload_json, '$.sideChat.sourceThreadId')
        AND source.deleted_at IS NULL`;

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
 * Only live, non-provider child approvals roll up. Side-chat attention also reaches its source.
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
        readonly active_tasks: number;
        readonly resumes: number;
        readonly fact_at: string | null;
        readonly background_tasks_json: string;
      }>`
        WITH RECURSIVE facts(thread_id, kind, at, amount, background_task) AS MATERIALIZED (
          SELECT thread_id, 'run', requested_at, 1, NULL FROM orchestration_v2_projection_runs
          WHERE ${sql.literal(LIVE_RUN_PREDICATE)}
          UNION ALL
          SELECT thread_id,
            CASE WHEN kind <> 'user_input' THEN 'approval'
              WHEN ${sql.literal(ASYNC_QUESTION_PREDICATE)} THEN 'question' ELSE 'input' END,
            created_at, 1, NULL
          FROM orchestration_v2_projection_runtime_requests
          WHERE status = 'pending' AND kind NOT IN ('dynamic_tool_call', 'auth_refresh')
          UNION ALL
          SELECT secret.thread_id, 'input', secret.updated_at, 1, NULL
          FROM orchestration_v2_projection_turn_items AS secret
            INDEXED BY orchestration_v2_projection_turn_items_pending_secret_idx
          WHERE secret.type = 'secret_request' AND secret.status = 'waiting'
            AND json_extract(secret.payload_json, '$.nodeId') IS NOT NULL
            AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS live
              WHERE live.run_id = secret.run_id AND ${sql.literal(LIVE_RUN_PREDICATE)})
          UNION ALL
          SELECT thread_id, 'task', updated_at, 1, NULL FROM orchestration_v2_projection_subagents
          WHERE status IN ('pending', 'running', 'waiting')
          UNION ALL
          SELECT provider.thread_id, 'task', provider.updated_at, 1, task.value
          FROM orchestration_v2_projection_provider_threads AS provider
          CROSS JOIN json_each(
            CASE WHEN json_valid(provider.payload_json) THEN provider.payload_json ELSE '{}' END,
            '$.pendingBackgroundTasks'
          ) AS task
          WHERE provider.thread_id IS NOT NULL AND (${sql.literal(LIVE_PROVIDER_THREAD_PREDICATE)})
          UNION ALL
          SELECT thread_id, 'wake', NULL, 1, NULL FROM orchestration_v2_projection_runs
          WHERE ${sql.literal(OPEN_DELIVERY_RUN_PREDICATE)}
          UNION ALL
          SELECT thread_id, 'wake', updated_at, 1, NULL FROM orchestration_v2_projection_subagents
          WHERE ${sql.literal(WAKING_LIVE_TASK_PREDICATE)}
        ), rooted AS MATERIALIZED (
          SELECT json_extract(thread.payload_json, '$.lineage.rootThreadId') AS root_thread_id,
            facts.thread_id, facts.kind, facts.at, facts.amount, facts.background_task,
            json_extract(thread.payload_json, '$.title') AS thread_title
          FROM facts
          -- Keep the live fact set outermost; discovery indexes must never turn this into
          -- a scan of retained Threads before their live facts are looked up.
          CROSS JOIN orchestration_v2_projection_threads AS thread
            ON thread.thread_id = facts.thread_id
          WHERE thread.deleted_at IS NULL
            AND (facts.kind NOT IN ('approval', 'input', 'question')
              OR (${sql.literal(OWN_ATTENTION_PREDICATE)})
              OR (${sql.literal(CHILD_APPROVAL_PREDICATE)}))
        ), attention(root_thread_id, thread_id, at, amount) AS (
          SELECT root_thread_id, thread_id, MAX(at), SUM(amount)
          FROM rooted WHERE kind IN ('approval', 'input', 'question')
          GROUP BY root_thread_id, thread_id
          UNION
          SELECT (${sql.literal(SIDE_CHAT_SOURCE_ROOT)}), attention.thread_id,
            attention.at, attention.amount
          FROM attention CROSS JOIN orchestration_v2_projection_threads AS owner
            ON owner.thread_id = attention.root_thread_id
          WHERE json_extract(owner.payload_json, '$.sideChat.sourceThreadId') IS NOT NULL
        ), activity_facts AS MATERIALIZED (
          SELECT root_thread_id, thread_id, kind, at, amount FROM rooted
          WHERE kind NOT IN ('approval', 'input', 'question')
          UNION ALL
          SELECT root_thread_id, thread_id, 'request', at, amount FROM attention
        ), activity AS MATERIALIZED (
        SELECT root_thread_id,
          SUM(kind = 'run') AS active_runs,
          SUM(CASE WHEN kind = 'request' THEN amount ELSE 0 END) AS pending_requests,
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
              'command', command, 'startedAt', started_at)) AS background_tasks_json
          FROM (SELECT * FROM ranked_tasks WHERE position <= ${EXECUTION_ACTIVITY_BACKGROUND_TASK_LIMIT}
            ORDER BY root_thread_id, position)
          GROUP BY root_thread_id
        )
        SELECT activity.*, COALESCE(background_tasks.background_tasks_json, '[]') AS background_tasks_json
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
                    AND run.status IN ('preparing', 'starting', 'running', 'waiting')
                  ORDER BY run.ordinal DESC LIMIT 1) AS active_run_id
              FROM orchestration_v2_projection_threads AS thread
              WHERE thread.thread_id IN ${sql.in(page.map((row) => row.root_thread_id))}`;
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
          pendingRequestCount: row.pending_requests,
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

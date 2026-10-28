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

/** Live execution facts for one non-idle root Thread; descendants roll up to their root. */
export interface RootActivity {
  readonly rootThreadId: string;
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

/**
 * Non-idle roots from live-state indexes only: active Runs, pending information requests, live
 * delegated or native background tasks, results already queued for delivery, and live async
 * tasks whose completion will wake their parent.
 * No message, item or result body is read; cost follows live work, never retained history.
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
        WITH facts(thread_id, kind, at, amount, background_task) AS MATERIALIZED (
          SELECT thread_id, 'run', requested_at, 1, NULL FROM orchestration_v2_projection_runs
          WHERE ${sql.literal(LIVE_RUN_PREDICATE)}
          UNION ALL
          SELECT thread_id, 'request', created_at, 1, NULL
          FROM orchestration_v2_projection_runtime_requests
          WHERE status = 'pending' AND kind NOT IN ('dynamic_tool_call', 'auth_refresh')
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
        ), activity AS MATERIALIZED (
        SELECT root_thread_id,
          SUM(kind = 'run') AS active_runs,
          SUM(CASE WHEN kind = 'request' THEN amount ELSE 0 END) AS pending_requests,
          SUM(CASE WHEN kind = 'task' THEN amount ELSE 0 END) AS active_tasks,
          MAX(kind = 'wake' AND thread_id = root_thread_id) AS resumes,
          MAX(at) AS fact_at
        FROM rooted
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
            }>`
              SELECT thread.thread_id, thread.provider_instance_id,
                json_extract(thread.payload_json, '$.modelSelection.model') AS model,
                thread.updated_at,
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

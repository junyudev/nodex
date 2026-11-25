import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { AgentExecutionAgentSelection } from "../nodex/Interface.ts";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";

export const RECENT_ROOT_RUNS_PAGE_LIMIT = 100;

export interface RecentRootRunCursor {
  readonly completedAt: string;
  readonly runId: string;
}

export interface RecentRootRunsInput {
  readonly since: string;
  readonly before?: RecentRootRunCursor | undefined;
}

export interface RecentRootRun extends RecentRootRunCursor {
  readonly rootThreadId: string;
  readonly status: "completed" | "failed" | "cancelled" | "interrupted";
  readonly agentSelection: AgentExecutionAgentSelection;
}

export interface RecentRootRunsPage {
  readonly items: readonly RecentRootRun[];
  readonly nextCursor: RecentRootRunCursor | null;
}

/** Indexed terminal Run metadata, newest first, retaining only each root's latest Run. */
export const readRecentRootRuns = Effect.fn("RecentRootRuns.read")(function* ({
  since,
  before,
}: RecentRootRunsInput) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly runId: string;
    readonly rootThreadId: string;
    readonly completedAt: string;
    readonly status: RecentRootRun["status"];
    readonly driver: AgentExecutionAgentSelection["driver"];
    readonly providerInstanceId: string | null;
    readonly model: string | null;
    readonly options: string | null;
  }>`
    SELECT run.run_id AS runId, run.thread_id AS rootThreadId,
      run.completed_at AS completedAt, run.status, thread.provider_instance_id AS providerInstanceId,
      json_extract(thread.payload_json, '$.providerDriver') AS driver,
      json_extract(thread.payload_json, '$.modelSelection.model') AS model,
      json_extract(thread.payload_json, '$.modelSelection.options') AS options
    FROM orchestration_v2_projection_runs AS run
    CROSS JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = run.thread_id
    WHERE run.status IN ('completed', 'failed', 'cancelled', 'interrupted')
      AND run.completed_at IS NOT NULL AND run.completed_at >= ${since}
      ${before ? sql`AND (run.completed_at, run.run_id) < (${before.completedAt}, ${before.runId})` : sql``}
      AND thread.deleted_at IS NULL
      AND json_extract(thread.payload_json, '$.lineage.rootThreadId') = thread.thread_id
      AND run.ordinal = (SELECT latest.ordinal FROM orchestration_v2_projection_runs AS latest
        WHERE latest.thread_id = run.thread_id AND latest.status <> 'rolled_back'
        ORDER BY latest.ordinal DESC LIMIT 1)
    ORDER BY run.completed_at DESC, run.run_id DESC LIMIT ${RECENT_ROOT_RUNS_PAGE_LIMIT + 1}`;
  const items = rows
    .slice(0, RECENT_ROOT_RUNS_PAGE_LIMIT)
    .map(
      ({
        runId,
        rootThreadId,
        completedAt,
        status,
        driver,
        providerInstanceId,
        model,
        options,
      }): RecentRootRun => ({
        runId,
        rootThreadId,
        completedAt,
        status,
        agentSelection: {
          driver,
          providerInstanceId,
          model,
          options: options === null ? undefined : JSON.parse(options),
        },
      }),
    );
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      last && rows.length > items.length
        ? { completedAt: last.completedAt, runId: last.runId }
        : null,
  } satisfies RecentRootRunsPage;
}, NodeSqliteClient.readOnly);

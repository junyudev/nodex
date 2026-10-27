import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { ProjectionStoreV2Error } from "./ProjectionStore.ts";
import { isSnoozed } from "./threadSnoozePolicy.ts";
import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2AppThread,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** A bounded discovery view; full PR snapshots and transcript bodies stay with their owners. */
export const SessionPullRequest = Schema.Struct({
  host: Schema.NullOr(Schema.String),
  repository: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  source: Schema.String,
  state: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
});
export type SessionPullRequest = typeof SessionPullRequest.Type;
export interface SessionExecutionMetadata {
  readonly threadId: string;
  readonly createdBy: OrchestrationV2AppThread["createdBy"] | null;
  readonly creationSource: OrchestrationV2AppThread["creationSource"] | null;
  readonly runtimeMode: OrchestrationV2AppThread["runtimeMode"];
  readonly interactionMode: OrchestrationV2AppThread["interactionMode"];
  readonly createdAt: string;
  readonly preview: string;
  readonly recencyAt: string | null;
  readonly latestUserAuthoredMessageAt: string | null;
  readonly updatedAt: string;
  readonly activeRunId: string | null;
  readonly worktreePath: string | null;
  readonly titleRegeneration: { readonly requestId: string; readonly startedAt: string } | null;
  readonly latestRunId: string | null;
  readonly runStatus: OrchestrationV2Run["status"] | null;
  readonly activityRunStatus: Exclude<OrchestrationV2ThreadShell["activityRunStatus"], undefined>;
  readonly providerInstanceId: string;
  readonly providerDriver: string | null;
  readonly model: string;
  readonly parentThreadId: string | null;
  readonly relationshipToParent: "fork" | "subagent" | null;
  readonly rootThreadId: string;
  readonly branch: string | null;
  readonly settled: boolean;
  readonly settledAt: string | null;
  readonly snoozed: boolean;
  readonly snoozedUntil: string | null;
  readonly pullRequests: readonly SessionPullRequest[];
  readonly itemCount: number;
  readonly itemCountCoverage: "complete" | "local";
}
const decodeTitleRegeneration = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.NullOr(Schema.Struct({ requestId: Schema.String, startedAt: Schema.String })),
  ),
);
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodePullRequests = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(SessionPullRequest)),
);

/** Indexed point reads for caller-selected Threads; no message or tool body is selected. */
export interface SessionMetadataOptions {
  readonly providerDriver?: (instanceId: string) => Effect.Effect<string | null>;
  readonly shell?: (
    threadId: string,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, ProjectionStoreV2Error>;
}
export const readSessionMetadata = Effect.fn("SessionMetadata.read")(function* (
  threadIds: readonly string[],
  options: SessionMetadataOptions = {},
) {
  if (threadIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly created_by: SessionExecutionMetadata["createdBy"];
    readonly creation_source: SessionExecutionMetadata["creationSource"];
    readonly runtime_mode: SessionExecutionMetadata["runtimeMode"];
    readonly interaction_mode: SessionExecutionMetadata["interactionMode"];
    readonly created_at: string;
    readonly conversation_preview: string;
    readonly conversation_recency_at: string | null;
    readonly updated_at: string;
    readonly active_run_id: string | null;
    readonly worktree_path: string | null;
    readonly title_regeneration: string;
    readonly latest_run_id: string | null;
    readonly run_status: SessionExecutionMetadata["runStatus"];
    readonly completed_at: string | null;
    readonly provider_instance_id: string;
    readonly default_provider: string;
    readonly model: string;
    readonly parent_thread_id: string | null;
    readonly relationship: SessionExecutionMetadata["relationshipToParent"];
    readonly root_thread_id: string;
    readonly branch: string | null;
    readonly settled: number;
    readonly settled_at: string | null;
    readonly snoozed_at: string | null;
    readonly snoozed_until: string | null;
    readonly pending: number;
    readonly pull_requests: string;
    readonly item_count: number;
  }>`
    SELECT t.thread_id, json_extract(t.payload_json,'$.createdBy') AS created_by,
      json_extract(t.payload_json,'$.creationSource') AS creation_source,
      t.runtime_mode, t.interaction_mode,t.created_at,t.updated_at,t.conversation_preview,t.conversation_recency_at,
      (SELECT active.run_id FROM orchestration_v2_projection_runs active WHERE active.thread_id=t.thread_id
        AND active.status IN ('preparing','starting','running') ORDER BY active.ordinal DESC,active.run_id DESC LIMIT 1) AS active_run_id,
      json_extract(t.payload_json,'$.worktreePath') AS worktree_path,
      COALESCE(json_extract(t.payload_json,'$.titleRegeneration'),'null') AS title_regeneration,
      run.run_id AS latest_run_id, run.status AS run_status,
      run.completed_at,t.default_provider, COALESCE(t.provider_instance_id,'') AS provider_instance_id,
      COALESCE(json_extract(t.payload_json,'$.modelSelection.model'),'') AS model,
      json_extract(t.payload_json,'$.lineage.parentThreadId') AS parent_thread_id,
      json_extract(t.payload_json,'$.lineage.relationshipToParent') AS relationship,
      json_extract(t.payload_json,'$.lineage.rootThreadId') AS root_thread_id,
      json_extract(t.payload_json,'$.branch') AS branch,
      COALESCE(json_extract(t.payload_json,'$.settledOverride') = 'settled',0) AS settled,
      json_extract(t.payload_json,'$.settledAt') AS settled_at,
      json_extract(t.payload_json,'$.snoozedAt') AS snoozed_at,
      json_extract(t.payload_json,'$.snoozedUntil') AS snoozed_until,
      EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests request
        WHERE request.thread_id=t.thread_id AND request.status='pending'
          AND request.kind NOT IN ('dynamic_tool_call','auth_refresh')) AS pending,
      (SELECT json_group_array(json_object('host',json_extract(pr.value,'$.host'),
        'repository',json_extract(pr.value,'$.repository'),'number',json_extract(pr.value,'$.number'),
        'url',json_extract(pr.value,'$.url'),'source',json_extract(pr.value,'$.source'),
        'state',json_extract(pr.value,'$.snapshot.state'),'title',json_extract(pr.value,'$.snapshot.title')))
        FROM json_each(t.payload_json,'$.pullRequests') pr
        WHERE json_extract(pr.value,'$.source') <> 'stack-dismissed') AS pull_requests,
      (SELECT COUNT(*) FROM orchestration_v2_turn_item_positions position WHERE position.thread_id=t.thread_id) AS item_count
    FROM orchestration_v2_projection_threads t
    LEFT JOIN orchestration_v2_projection_runs run ON run.run_id=(
      SELECT r.run_id FROM orchestration_v2_projection_runs r WHERE r.thread_id=t.thread_id
        AND NOT (r.status='queued' AND json_extract(r.payload_json,'$.queueHeld') IS 1)
      ORDER BY r.ordinal DESC,r.run_id DESC LIMIT 1)
    WHERE t.thread_id IN (SELECT value FROM json_each(${encodeIds(threadIds.slice(0, 100))})) AND t.deleted_at IS NULL`;
  return yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const shell = options.shell ? yield* options.shell(row.thread_id) : null;
      const wokeOnFailure =
        row.run_status === "failed" &&
        (row.snoozed_at === null ||
          (row.completed_at !== null && row.completed_at > row.snoozed_at));
      const wokeOnCompletion =
        row.run_status === "completed" &&
        row.snoozed_at !== null &&
        row.completed_at !== null &&
        row.completed_at > row.snoozed_at;
      const snoozed =
        row.snoozed_until !== null &&
        Date.parse(row.snoozed_until) > now &&
        row.pending === 0 &&
        !wokeOnFailure &&
        !wokeOnCompletion;
      const effectiveSnoozed = shell ? isSnoozed(shell, now) : snoozed;
      return {
        threadId: row.thread_id,
        createdBy: row.created_by,
        creationSource: row.creation_source,
        runtimeMode: row.runtime_mode,
        interactionMode: row.interaction_mode,
        createdAt: row.created_at,
        preview: row.conversation_preview,
        recencyAt: row.conversation_recency_at,
        latestUserAuthoredMessageAt: shell?.latestUserAuthoredMessageAt
          ? DateTime.formatIso(shell.latestUserAuthoredMessageAt)
          : null,
        updatedAt: row.updated_at,
        activeRunId: shell ? shell.activeRunId : row.active_run_id,
        worktreePath: row.worktree_path,
        titleRegeneration: yield* decodeTitleRegeneration(row.title_regeneration),
        latestRunId: shell ? shell.latestRunId : row.latest_run_id,
        runStatus: shell ? (shell.status === "idle" ? null : shell.status) : row.run_status,
        activityRunStatus: shell?.activityRunStatus ?? null,
        providerInstanceId: row.provider_instance_id,
        providerDriver: options.providerDriver
          ? yield* options.providerDriver(row.provider_instance_id)
          : row.default_provider,
        model: row.model,
        parentThreadId: row.parent_thread_id,
        relationshipToParent: row.relationship,
        rootThreadId: row.root_thread_id,
        branch: row.branch,
        settled: row.settled === 1,
        settledAt: row.settled === 1 ? row.settled_at : null,
        snoozed: effectiveSnoozed,
        snoozedUntil: effectiveSnoozed ? row.snoozed_until : null,
        pullRequests: yield* decodePullRequests(row.pull_requests),
        itemCount: shell ? shell.visibleItemCount : row.item_count,
        itemCountCoverage: shell ? ("complete" as const) : ("local" as const),
      } satisfies SessionExecutionMetadata;
    }),
  );
}, NodeSqliteClient.readOnly);

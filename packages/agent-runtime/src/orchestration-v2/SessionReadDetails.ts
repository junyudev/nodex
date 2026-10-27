import type { OrchestrationV2Run } from "@t3tools/contracts";
import type { AgentWire } from "../nodex/Interface.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export type SessionRunSummary = Pick<
  AgentWire<OrchestrationV2Run>,
  "ordinal" | "status" | "providerInstanceId" | "requestedAt" | "startedAt" | "completedAt"
> & { readonly runId: string; readonly model: string };
export interface SessionReadDetails {
  readonly runCount: number;
  readonly pendingRequestCount: number;
  readonly recentRuns: readonly SessionRunSummary[];
  readonly nextOrdinal: number | null;
}

/** Runs are selected by the indexed ordinal before decoding or joining any history. */
export const readSessionDetails = Effect.fn("SessionReadDetails.read")(function* (
  threadId: string,
  limit: number,
  beforeOrdinal?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const recentRuns = yield* sql<SessionRunSummary>`
    SELECT run_id AS runId, ordinal, status,
      provider_instance_id AS providerInstanceId,
      COALESCE(json_extract(payload_json, '$.modelSelection.model'), '') AS model,
      requested_at AS requestedAt,
      json_extract(payload_json, '$.startedAt') AS startedAt,
      completed_at AS completedAt
    FROM orchestration_v2_projection_runs
    WHERE thread_id = ${threadId}
      AND (${beforeOrdinal ?? null} IS NULL OR ordinal < ${beforeOrdinal ?? null})
    ORDER BY ordinal DESC LIMIT ${limit + 1}`;
      const counts = yield* sql<{
        readonly runCount: number;
        readonly pendingRequestCount: number;
      }>`
    SELECT
      (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}) AS runCount,
      (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests
        WHERE thread_id = ${threadId} AND status = 'pending') AS pendingRequestCount`;
      return {
        runCount: counts[0]?.runCount ?? 0,
        pendingRequestCount: counts[0]?.pendingRequestCount ?? 0,
        recentRuns: recentRuns.slice(0, limit),
        nextOrdinal: recentRuns.length > limit ? recentRuns[limit - 1]!.ordinal : null,
      } satisfies SessionReadDetails;
    }),
  );
}, NodeSqliteClient.readOnly);

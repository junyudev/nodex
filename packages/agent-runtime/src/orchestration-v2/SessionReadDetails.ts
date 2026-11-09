import {
  OrchestrationV2UserInputQuestion,
  type OrchestrationV2Run,
} from "@nodex/runtime-contracts";
import type { AgentWire } from "../nodex/Interface.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readWaiting, type WaitingAdmission } from "./RunAdmission.ts";
import { readSessionAttention } from "./SessionAttention.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";

export type SessionRunSummary = Pick<
  AgentWire<OrchestrationV2Run>,
  "ordinal" | "status" | "providerInstanceId" | "requestedAt" | "startedAt" | "completedAt"
> & {
  readonly runId: string;
  readonly model: string;
  readonly interruptRequested: boolean;
  readonly failureMessage?: string | null;
};
export interface SessionReadDetails {
  readonly waitingAdmissions: readonly WaitingAdmission[];
  readonly runCount: number;
  readonly pendingRequestCount: number;
  readonly recentRuns: readonly SessionRunSummary[];
  readonly pendingRequests: readonly {
    readonly id: string;
    readonly kind: "question" | "approval";
    readonly questions: readonly (typeof OrchestrationV2UserInputQuestion.Type)[];
  }[];
  readonly nextOrdinal: number | null;
}

/** Runs are selected by the indexed ordinal before decoding or joining any history. */
export const readSessionDetails = Effect.fn("SessionReadDetails.read")(function* (
  threadId: string,
  limit: number,
  beforeOrdinal?: number,
  runId?: string,
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
      completed_at AS completedAt,
      CASE WHEN status = 'failed' THEN (SELECT json_extract(item.payload_json, '$.failure.message')
        FROM orchestration_v2_projection_turn_items item
        WHERE item.thread_id = runs.thread_id AND item.run_id = runs.run_id
          AND item.type = 'error' AND item.status = 'failed'
        ORDER BY item.ordinal DESC, item.turn_item_id DESC LIMIT 1) END AS failureMessage,
      EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items item
        WHERE item.thread_id = runs.thread_id AND item.run_id = runs.run_id
          AND item.type = 'run_interrupt_request') AS interruptRequested
    FROM orchestration_v2_projection_runs runs
    WHERE thread_id = ${threadId}
      ${runId === undefined ? sql`` : sql`AND run_id = ${runId}`}
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
      const attention = (yield* readSessionAttention([threadId])).get(threadId);
      const pendingRequests = yield* Effect.forEach(attention?.requests ?? [], (request) =>
        Effect.gen(function* () {
          // Select only the question envelope, never transcript or tool-result bodies.
          const rows =
            request.kind === "question"
              ? yield* sql<{ questions: string }>`
            SELECT COALESCE(json_extract(payload_json,'$.questions'),'[]') AS questions
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id=${threadId} AND type='user_input_request'
              AND node_id=(SELECT node_id FROM orchestration_v2_projection_runtime_requests
                WHERE thread_id=${threadId} AND runtime_request_id=${request.id})
              AND json_extract(payload_json,'$.requestId')=${request.id} LIMIT 1`
              : [];
          const questions = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Array(OrchestrationV2UserInputQuestion)),
          )(rows[0]?.questions ?? "[]");
          return { ...request, questions };
        }),
      );
      return {
        waitingAdmissions: yield* readWaiting(threadId),
        runCount: counts[0]?.runCount ?? 0,
        pendingRequestCount: counts[0]?.pendingRequestCount ?? 0,
        pendingRequests,
        recentRuns: recentRuns
          .slice(0, limit)
          .map((run) => ({ ...run, interruptRequested: Boolean(run.interruptRequested) })),
        nextOrdinal: recentRuns.length > limit ? recentRuns[limit - 1]!.ordinal : null,
      } satisfies SessionReadDetails;
    }),
  );
}, NodeSqliteClient.readOnly);

import type { OrchestrationV2UserInputQuestion } from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

type QuestionState = {
  readonly status: "pending" | "resolved" | "cancelled";
  readonly responseCapability: {
    readonly type: "live" | "message" | "not_resumable";
    readonly reason?: string;
  };
};

/** Seeds Runtime-owned metadata in the existing disposable Sqlite.layerMemory test database. */
export const makeSessionDetailsFixture = Effect.fn("SessionDetailsFixture.make")(function* (
  threadId: string,
  runId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-11-04T00:00:00Z";
  return {
    startRun: sql`INSERT INTO orchestration_v2_projection_runs
      (run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
      VALUES(${runId},${threadId},1,'codex','running',${at},
        '{"startedAt":"2026-11-04T00:00:01Z"}')`,
    completeRun: sql`UPDATE orchestration_v2_projection_runs SET status='completed'
      WHERE thread_id=${threadId} AND run_id=${runId}`,
    addQuestion: Effect.fn("SessionDetailsFixture.addQuestion")(function* (
      input: QuestionState & {
        readonly requestId: string;
        readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
      },
    ) {
      const nodeId = `${input.requestId}:node`;
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json)
        VALUES(${input.requestId},${threadId},${nodeId},'user_input',${input.status},${at},
          ${JSON.stringify({ responseCapability: input.responseCapability })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json)
        VALUES(${`${input.requestId}:item`},${threadId},${runId},${nodeId},1,
          'user_input_request','waiting',${at},
          ${JSON.stringify({ requestId: input.requestId, questions: input.questions })})`;
    }),
    updateQuestion: Effect.fn("SessionDetailsFixture.updateQuestion")(
      (requestId: string, input: QuestionState) =>
        sql`UPDATE orchestration_v2_projection_runtime_requests
          SET status=${input.status},
            payload_json=${JSON.stringify({ responseCapability: input.responseCapability })}
          WHERE thread_id=${threadId} AND runtime_request_id=${requestId}`,
    ),
  };
});

import type { ThreadActiveFlag } from "@nodex/codex-app-server-protocol/v2";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Shared attention policy for Session observations and execution activity. */
export const ATTENTION_KINDS = {
  approval: "approval",
  input: "input",
  question: "question",
} as const;
type AttentionKind = (typeof ATTENTION_KINDS)[keyof typeof ATTENTION_KINDS];
export const ATTENTION_KIND_SQL_LIST = Object.values(ATTENTION_KINDS)
  .map((kind) => `'${kind}'`)
  .join(", ");

const WORKING_RUN_STATUSES = "'preparing', 'starting', 'running'";
/** A waiting Run drains effects; its provider has stopped working. */
export const WORKING_RUN_PREDICATE = `status IN (${WORKING_RUN_STATUSES})`;
/** Matches the active-provider partial index; waiting Runs still own live work. */
export const LIVE_RUN_PREDICATE = `status IN (${WORKING_RUN_STATUSES}, 'waiting')`;

const USER_INPUT_REQUEST_KIND = "user_input";
export const ASYNC_QUESTION_PREDICATE = `kind = '${USER_INPUT_REQUEST_KIND}' AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.responseCapability.type') = 'message' ELSE 0 END`;
export const REQUEST_ATTENTION_KIND_SQL = `CASE WHEN kind <> '${USER_INPUT_REQUEST_KIND}' THEN '${ATTENTION_KINDS.approval}'
      WHEN ${ASYNC_QUESTION_PREDICATE} THEN '${ATTENTION_KINDS.question}' ELSE '${ATTENTION_KINDS.input}' END`;
/** Request status and response capability own answerability, independently of the Run. */
export const PENDING_ATTENTION_REQUEST_PREDICATE = `status = 'pending' AND kind NOT IN ('dynamic_tool_call', 'auth_refresh')
  AND CASE WHEN json_valid(payload_json)
    THEN json_extract(payload_json, '$.responseCapability.type') IN ('live', 'message') ELSE 0 END`;

/** Async questions await the person only after their own Thread stops working. */
export const AWAITS_PERSON_PREDICATE = `facts.kind <> '${ATTENTION_KINDS.question}' OR NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs AS working
      INDEXED BY orchestration_v2_projection_runs_thread_status_idx
      WHERE working.thread_id = facts.thread_id AND ${WORKING_RUN_PREDICATE})`;

/** FROM/WHERE fact fragment; callers select their columns and append scope filters on secret. */
export const SECRET_CARD_ATTENTION_FACT_FROM_SQL = `FROM orchestration_v2_projection_turn_items AS secret
      INDEXED BY orchestration_v2_projection_turn_items_pending_secret_idx
    WHERE secret.type = 'secret_request' AND secret.status = 'waiting'
      AND json_extract(secret.payload_json, '$.nodeId') IS NOT NULL
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS live
        WHERE live.run_id = secret.run_id AND ${LIVE_RUN_PREDICATE})`;

const attentionFlags = {
  [ATTENTION_KINDS.approval]: "waitingOnApproval",
  [ATTENTION_KINDS.input]: "waitingOnUserInput",
  [ATTENTION_KINDS.question]: "waitingOnUserInput",
} satisfies Record<AttentionKind, ThreadActiveFlag>;

interface AttentionFact {
  readonly kind: AttentionKind;
  readonly awaitsPerson: boolean;
}

/** SQL classifies eligibility once; observations expose only the native attention vocabulary. */
export function sessionAttentionFlags(
  facts: readonly AttentionFact[],
): readonly ThreadActiveFlag[] {
  const flags = new Set<ThreadActiveFlag>();
  for (const fact of facts) {
    if (!fact.awaitsPerson) continue;
    flags.add(attentionFlags[fact.kind]);
  }
  return [...flags].sort();
}

/** Compact attention facts for Thread observations, optionally restricted to one exact Run. */
export const readSessionAttention = Effect.fn("SessionAttention.read")(function* (
  threadIds: readonly string[],
  runId?: string,
) {
  const attention = new Map<
    string,
    {
      readonly activeFlags: readonly ThreadActiveFlag[];
      readonly requestIds: readonly string[];
      readonly requests: readonly { readonly id: string; readonly kind: "question" | "approval" }[];
    }
  >();
  if (threadIds.length === 0) return attention;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly thread_id: string;
    readonly id: string;
    readonly kind: AttentionKind;
    readonly awaits_person: number;
  }>`
    WITH facts(thread_id, id, kind) AS (
      SELECT request.thread_id, request.runtime_request_id, ${sql.literal(REQUEST_ATTENTION_KIND_SQL)}
      FROM orchestration_v2_projection_runtime_requests request
      WHERE request.thread_id IN ${sql.in(threadIds)} AND ${sql.literal(PENDING_ATTENTION_REQUEST_PREDICATE)}
        ${
          runId === undefined
            ? sql``
            : sql`AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_nodes node
          WHERE node.node_id = request.node_id AND node.run_id = ${runId})`
        }
      UNION ALL
      SELECT secret.thread_id, secret.turn_item_id, ${sql.literal(`'${ATTENTION_KINDS.input}'`)}
      ${sql.literal(SECRET_CARD_ATTENTION_FACT_FROM_SQL)}
        AND secret.thread_id IN ${sql.in(threadIds)}
        ${runId === undefined ? sql`` : sql`AND secret.run_id = ${runId}`}
    ) SELECT facts.*, (${sql.literal(AWAITS_PERSON_PREDICATE)}) AS awaits_person
    FROM facts ORDER BY thread_id, id, kind`;
  const byThread = Arr.groupBy(rows, (row) => row.thread_id);
  for (const [threadId, facts] of Object.entries(byThread)) {
    attention.set(threadId, {
      activeFlags: sessionAttentionFlags(
        facts.map((fact) => ({ kind: fact.kind, awaitsPerson: fact.awaits_person !== 0 })),
      ),
      requestIds: facts.map((fact) => fact.id),
      requests: facts.map((fact) => ({
        id: fact.id,
        kind:
          fact.kind === ATTENTION_KINDS.approval ? ("approval" as const) : ("question" as const),
      })),
    });
  }
  return attention;
});

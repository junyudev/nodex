import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";

export const HISTORICAL_RUN_COUNT = 10_000;

/**
 * Seeds settled history at storage scale. Every payload is valid JSON that no projection decoder
 * accepts, so a control path that decodes any historical Run, message, task, provider turn or
 * item fails instead of silently growing with history. Ordinals precede the live fixture.
 */
export const seedUndecodableHistory = Effect.fn("HistoryPressure.seed")(function* (input: {
  readonly threadId: ThreadId;
  readonly count?: number;
  readonly at: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const count = input.count ?? HISTORICAL_RUN_COUNT;
  const body = "history ".repeat(256);
  const series = sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})`;
  const prefix = `history:${input.threadId}`;
  yield* sql`${series}
    INSERT INTO orchestration_v2_projection_runs(run_id, thread_id, ordinal, provider,
      provider_instance_id, status, requested_at, completed_at, payload_json)
    SELECT ${prefix} || ':run:' || i, ${input.threadId}, i, 'codex', 'codex', 'completed',
      ${input.at}, ${input.at}, json_object('history', i)
    FROM n`;
  yield* sql`${series}
    INSERT INTO orchestration_v2_projection_messages(message_id, thread_id, run_id, node_id, role,
      streaming, created_at, updated_at, payload_json)
    SELECT ${prefix} || ':' || role.value || ':' || i, ${input.threadId}, ${prefix} || ':run:' || i,
      NULL, role.value, 0, ${input.at}, ${input.at}, json_object('history', i, 'text', ${body})
    FROM n, json_each('["user","assistant"]') AS role`;
  yield* sql`${series}
    INSERT INTO orchestration_v2_projection_provider_turns(provider_turn_id, thread_id,
      provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at,
      payload_json)
    SELECT ${prefix} || ':turn:' || i, ${input.threadId}, ${prefix} || ':provider-thread',
      ${prefix} || ':node:' || i, ${prefix} || ':attempt:' || i, i, 'completed', ${input.at},
      ${input.at}, json_object('history', i, 'text', ${body})
    FROM n`;
  yield* sql`${series}
    INSERT INTO orchestration_v2_projection_subagents(subagent_id, thread_id, run_id,
      parent_node_id, provider, driver, provider_instance_id, origin, status, started_at,
      completed_at, updated_at, payload_json)
    SELECT ${prefix} || ':task:' || i, ${input.threadId}, ${prefix} || ':run:' || i,
      ${prefix} || ':node:' || i, 'codex', 'codex', 'codex', 'app_owned', 'completed', ${input.at},
      ${input.at}, ${input.at}, json_object('history', i, 'result', ${body})
    FROM n`;
  yield* sql`${series}
    INSERT INTO orchestration_v2_projection_turn_items(turn_item_id, thread_id, run_id, ordinal,
      type, status, updated_at, payload_json)
    SELECT ${prefix} || ':item:' || i, ${input.threadId}, ${prefix} || ':run:' || i, i,
      'assistant_message', 'completed', ${input.at}, json_object('history', i, 'text', ${body})
    FROM n`;
});

/** Partial indexes whose predicates admit only live or unresolved control rows. */
const LIVE_STATE_INDEXES = [
  "orchestration_v2_runs_open_delivery_idx",
  "orchestration_v2_subagents_unresolved_child_idx",
  "orchestration_v2_provider_threads_live_idx",
  "orchestration_v2_provider_sessions_live_idx",
  "orchestration_v2_projection_runs_recovery_idx",
  "orchestration_v2_projection_requests_recovery_idx",
  "orchestration_v2_projection_turn_items_recovery_idx",
  "orchestration_v2_queued_run_window_idx",
  "orchestration_v2_execution_live_nodes_idx",
  "orchestration_v2_execution_live_tasks_idx",
  "orchestration_v2_execution_live_native_tasks_idx",
  "orchestration_v2_execution_live_items_idx",
];

/**
 * Plan rows that visit every row of a table or a history-wide index. Scans of the named
 * materialized CTEs read only rows their own indexed seeds produced.
 */
export const fullHistoryScans = (
  plan: ReadonlyArray<{ readonly detail: string }>,
  boundedSources: ReadonlyArray<string> = [],
) =>
  plan
    .map((row) => row.detail)
    .filter((detail) => {
      const scan = /^SCAN (\S+)(?: USING (?:COVERING )?INDEX (\S+))?/.exec(detail);
      if (scan === null) return false;
      const [, source, index] = scan;
      return index === undefined
        ? !boundedSources.includes(source!)
        : !LIVE_STATE_INDEXES.includes(index);
    });

/**
 * Runs an operation while recording every SQL statement it executes, then returns each
 * statement's query plan. Plans are prepared without bindings; they depend on indexes, not values.
 */
export const explainExecutedSql = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const base = yield* Effect.tracer;
    const statements = new Set<string>();
    const tracer = Tracer.make({
      span(options) {
        const span = base.span(options);
        const attribute = span.attribute.bind(span);
        span.attribute = (key, value) => {
          if (key === "db.query.text" && typeof value === "string") statements.add(value);
          attribute(key, value);
        };
        return span;
      },
      ...(base.context === undefined ? {} : { context: base.context }),
    });
    const result = yield* effect.pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));
    const plans = yield* Effect.forEach([...statements], (statement) =>
      sql
        .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`)
        .pipe(Effect.map((plan) => ({ statement, plan }))),
    );
    return { result, plans };
  });

const PROJECTION_TABLES =
  /^orchestration_v2_projection_(runs|run_attempts|nodes|messages|turn_items|subagents|provider_turns|provider_threads|runtime_requests|context_transfers|context_handoffs|plans|checkpoints)$/;

/**
 * Executed statements whose plans visit a Thread's whole history: full scans, or index ranges
 * constrained only by the Thread. A covering-index count reads index entries, never rows.
 */
export const historyWideReads = (
  executed: ReadonlyArray<{
    readonly statement: string;
    readonly plan: ReadonlyArray<{ readonly detail: string }>;
  }>,
) =>
  executed.flatMap(({ statement, plan }) => {
    const aliases = new Map<string, string>();
    for (const match of statement.matchAll(/\b(orchestration_v2_\w+)(?:\s+AS)?\s+(\w+)/gi))
      aliases.set(match[2]!, match[1]!);
    const table = (source: string) => aliases.get(source) ?? source;
    const wide = [
      ...fullHistoryScans(plan).filter((detail) =>
        PROJECTION_TABLES.test(table(detail.split(" ")[1]!)),
      ),
      ...plan
        .map((row) => row.detail)
        .filter((detail) => {
          const search = /^SEARCH (\S+) USING (COVERING )?INDEX (\S+) \(thread_id=\?\)$/.exec(
            detail,
          );
          return (
            search !== null &&
            PROJECTION_TABLES.test(table(search[1]!)) &&
            search[2] === undefined &&
            !LIVE_STATE_INDEXES.includes(search[3]!)
          );
        }),
    ];
    return wide.length === 0 ? [] : [{ statement: statement.replace(/\s+/g, " ").trim(), wide }];
  });

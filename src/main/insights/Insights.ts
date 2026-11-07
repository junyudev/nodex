import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  localCalendar,
  type InsightsContentSnapshot,
  type InsightsOrigin,
} from "../../shared/insights";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../core-runtime/CoreModules";

const CONTENT_DEADLINE_MS = 20_000;

/** Minutes survive any zone offset, including the ones a quarter hour off the hour. */
const PAGES_CREATED_SQL = `SELECT substr(created_at, 1, 16) AS minute, count(*) AS n FROM pages GROUP BY 1`;
const PAGE_TOTALS_SQL = `SELECT count(*) AS pages, coalesce(sum(block_count), 0) AS blocks FROM pages`;
// A Page's Status moves through `status`; its last change into Done is when the task finished.
const TASKS_DONE_SQL = `SELECT substr(value_updated_at, 1, 16) AS minute, count(*) AS n
  FROM property_values
  WHERE property_id = 'status' AND value_json = '"done"' AND value_updated_at IS NOT NULL
  GROUP BY 1`;
const TASK_TOTALS_SQL = `SELECT count(*) AS tasks,
    coalesce(sum(CASE WHEN value_json = '"done"' THEN 1 ELSE 0 END), 0) AS done
  FROM property_values WHERE property_id = 'status'`;

type Row = readonly unknown[];

function perDay(rows: readonly Row[], timeZone: string) {
  const calendar = localCalendar(timeZone);
  const days = new Map<string, number>();
  for (const [minute, count] of rows) {
    if (typeof minute !== "string" || typeof count !== "number") continue;
    const timestampMs = Date.parse(`${minute}:00.000Z`);
    if (!Number.isFinite(timestampMs)) continue;
    const day = calendar.dayOf(timestampMs);
    days.set(day, (days.get(day) ?? 0) + count);
  }
  return [...days]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => [day, count] as const);
}

const numberAt = (rows: readonly Row[], column: number) => {
  const value = rows[0]?.[column];
  return typeof value === "number" ? value : 0;
};

/** Insights joins two owners: the Agent Runtime's usage ledger and Core's public content relations. */
export class Insights extends Context.Service<
  Insights,
  {
    readonly readUsage: (input: {
      readonly timeZone: string;
      readonly origin: InsightsOrigin;
    }) => ReturnType<AgentRuntimeApplication["Service"]["insightsUsage"]>;
    readonly setAccess: (
      granted: boolean,
    ) => ReturnType<AgentRuntimeApplication["Service"]["insightsAccess"]>;
    /** Null when Core cannot answer in time; usage still shows without content numbers. */
    readonly readContent: (input: {
      readonly timeZone: string;
    }) => Effect.Effect<InsightsContentSnapshot | null>;
  }
>()("nodex/main/insights/Insights") {}

export const live = Layer.effect(
  Insights,
  Effect.gen(function* () {
    const runtime = yield* AgentRuntimeApplication;
    const core = yield* CoreModules;
    const select = (sql: string) =>
      core.query
        .read(
          {
            kind: "query",
            query: { scope: { database_id: null, bindings: [] }, sql, parameters: {} },
          },
          null,
          { deadlineMs: CONTENT_DEADLINE_MS },
        )
        .pipe(
          Effect.map((snapshot): readonly Row[] => {
            const value = snapshot.value;
            return value.kind === "query" ? value.value.rows : [];
          }),
        );
    return Insights.of({
      readUsage: (input) => runtime.insightsUsage(input),
      setAccess: (granted) => runtime.insightsAccess(granted),
      readContent: ({ timeZone }) =>
        Effect.all(
          [
            select(PAGES_CREATED_SQL),
            select(PAGE_TOTALS_SQL),
            select(TASKS_DONE_SQL),
            select(TASK_TOTALS_SQL),
          ],
          { concurrency: 1 },
        ).pipe(
          Effect.map(([pagesCreated, pageTotals, tasksDone, taskTotals]) => ({
            pageTotal: numberAt(pageTotals, 0),
            blockTotal: numberAt(pageTotals, 1),
            taskTotal: numberAt(taskTotals, 0),
            tasksDoneTotal: numberAt(taskTotals, 1),
            pagesCreated: perDay(pagesCreated, timeZone),
            tasksDone: perDay(tasksDone, timeZone),
          })),
          Effect.catchCause(() => Effect.succeed(null)),
        ),
    });
  }),
);

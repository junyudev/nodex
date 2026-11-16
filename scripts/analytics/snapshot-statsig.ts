import { z } from "zod";
import { DAY_MS, snapshotEventNames, type SnapshotEvent, utcDate } from "./snapshot-aggregation";
import { statsigConsole } from "./statsig-console";

export interface SourceStatus {
  readonly status: string;
  readonly truncated?: true;
}

// Logs Explorer limits: a query spans at most seven days, a page holds at most 1,000 rows and a
// cursor reaches at most 100,000 rows. The per-event endpoint returns only the latest 100 events,
// so it cannot serve history.
const PAGE_SIZE = 1_000;
const CURSOR_LIMIT = 100_000;
const MAX_WINDOW_MS = 7 * DAY_MS;

const metadata = ["page", "source", "target", "profile", "channel", "platform", "kind"] as const;
const tier = "user.statsigEnvironment.tier";
const columns = [
  ...metadata.map((key) => `metadata.${key}`),
  tier,
  "user.appVersion",
  "user.custom.os",
  "user.custom.channel",
];

const logsPage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      event_name: z.enum(snapshotEventNames),
      timestamp: z.iso.datetime(),
      user_id: z.string().nullable(),
      value: z.string().nullable(),
      fields: z.record(z.string(), z.string().nullable()),
    }),
  ),
  columns: z.array(z.string()),
  pagination: z.object({ has_more: z.boolean(), next_cursor: z.string().nullable() }),
});

type LogRow = z.infer<typeof logsPage>["data"][number];

const toEvent = (row: LogRow): SnapshotEvent | null => {
  if (row.fields[tier] !== "production") return null;
  const { event_name: name } = row;
  const distribution = name === "distribution_downloads" || name === "update_feed_requests";
  const anonymous =
    distribution || name === "landing_viewed" || name === "landing_download_clicked";
  const value = row.value ? Number(row.value) : null;
  if (distribution && (value === null || !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Statsig returned an invalid count for ${name}`);
  }
  if (!anonymous && !row.user_id)
    throw new Error(`Statsig omitted the installation ID for ${name}`);

  return {
    name,
    time: Date.parse(row.timestamp),
    installationId: anonymous ? null : row.user_id,
    value,
    fields: {
      ...Object.fromEntries(
        metadata.map((key) => [key, row.fields[`metadata.${key}`] || undefined]),
      ),
      appVersion: row.fields["user.appVersion"] || undefined,
      os: row.fields["user.custom.os"] || undefined,
      channel:
        (anonymous ? row.fields["metadata.channel"] : row.fields["user.custom.channel"]) ||
        undefined,
    },
  };
};

// Log windows overlap at the boundary. Event IDs also protect against repeated rows between pages.
export async function collectStatsigEvents(
  get: ReturnType<typeof statsigConsole>["get"],
  start: number,
  end: number,
  names: readonly SnapshotEvent["name"][],
) {
  const events = new Map<string, SnapshotEvent>();
  const errors: string[] = [];
  let collected = false;
  let truncated = false;
  for (let from = start; from < end; from += MAX_WINDOW_MS) {
    const to = Math.min(from + MAX_WINDOW_MS, end);
    const result = await readLogWindow(get, from, to, names, events);
    collected ||= result.collected;
    if (result.error) errors.push(`${utcDate(from)}: ${result.error}`);
    if (result.truncated) truncated = true;
    if (result.stop) break;
  }
  const status: SourceStatus = {
    status: errors.length > 0 ? errors.join("; ") : "ok",
    ...(truncated ? { truncated: true } : {}),
  };
  return { events: [...events.values()], status, collected };
}

async function readLogWindow(
  get: ReturnType<typeof statsigConsole>["get"],
  start: number,
  end: number,
  names: readonly SnapshotEvent["name"][],
  events: Map<string, SnapshotEvent>,
) {
  const params = new URLSearchParams({
    source: "events",
    // A leading # is rejected by the Console API even though it is valid inside a filter.
    query: `(${names.map((name) => `#custom_event:${name}`).join(" OR ")})`,
    columns: columns.join(","),
    start_ts: String(start),
    end_ts: String(end),
    limit: String(PAGE_SIZE),
  });
  const cursors = new Set<string>();
  let rows = 0;
  let collected = false;
  try {
    for (;;) {
      const response = await get(`/logs?${params}`, AbortSignal.timeout(45_000));
      if (response.status !== 200) {
        return {
          error: `Statsig Logs Explorer returned HTTP ${response.status}`,
          collected,
          stop: response.status === 401 || response.status === 403 || response.status === 429,
        };
      }
      const page = logsPage.safeParse(response.body);
      if (!page.success || columns.some((column) => !page.data.columns.includes(column))) {
        throw new Error("Statsig Logs Explorer returned an unexpected payload");
      }
      const batch = page.data.data.map((row) => ({ id: row.id, event: toEvent(row) }));
      for (const { id, event } of batch) {
        if (event) events.set(id, event);
      }
      collected = true;
      rows += batch.length;
      const { has_more, next_cursor } = page.data.pagination;
      if (rows >= CURSOR_LIMIT) {
        return {
          collected,
          truncated: true,
          error: "Statsig Logs Explorer reached its 100,000-row cursor limit",
        };
      }
      if (!has_more) return { collected };
      if (batch.length === 0 || !next_cursor || cursors.has(next_cursor)) {
        return {
          collected,
          truncated: true,
          error: "Statsig Logs Explorer pagination stopped before the final page",
        };
      }
      cursors.add(next_cursor);
      params.set("after", next_cursor);
    }
  } catch (error) {
    return {
      collected,
      error: error instanceof Error ? error.message : "Statsig Logs Explorer request failed",
    };
  }
}

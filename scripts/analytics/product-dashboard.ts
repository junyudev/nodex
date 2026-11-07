/**
 * The Statsig dashboard that answers Nodex's product questions, as reviewable data. Provisioning
 * replaces the live dashboard's widgets with exactly this list.
 */
export const DASHBOARD_NAME = "Nodex Product Health";
/** Statsig's names: a query with any other unit or column succeeds and silently returns nothing. */
const INSTALLATION_UNIT = "user_id";
const ANONYMOUS_UNIT = "stableID";
const EVENT_PROPERTIES = "company_metadata";
const USER_PROPERTIES = "user_object";

const series = (
  event: string,
  aggregation: string,
  options: {
    readonly groupBy?: string;
    readonly groupColumn?: string;
    readonly unit?: string;
    readonly alias?: string;
    readonly window?: "daily" | "weekly" | "monthly";
  } = {},
) => ({
  source: { type: "event", event_name: event },
  definition: {
    events: [{ event_name: event, filters: [] }],
    aggregation: { type: aggregation },
    ...(options.window ? { uniques_window: options.window } : {}),
  },
  unit_type: options.unit ?? INSTALLATION_UNIT,
  ...(options.alias ? { alias: options.alias } : {}),
  ...(options.groupBy
    ? { group_bys: [{ key: options.groupBy, column: options.groupColumn ?? EVENT_PROPERTIES }] }
    : {}),
});

const chart = (
  title: string,
  description: string,
  seriesList: readonly ReturnType<typeof series>[],
  chartType: "line" | "timeseries-bar" = "line",
) => ({
  type: "drilldown" as const,
  title,
  description,
  width: 6,
  height: 4,
  query: {
    series: seriesList,
    viz: { chart_type: chartType, granularity: "day" },
    // Early volumes are small enough that sampling would round real activity down to zero.
    options: { sampling_enabled: false },
  },
});

const header = (title: string) => ({ type: "header" as const, title, width: 12, height: 1 });

export const DASHBOARD_WIDGETS = [
  header("Adoption"),
  chart(
    "New installations",
    "First launch on a Profile. new is a fresh install; existing is a Profile that predates analytics.",
    [series("installation_created", "COUNT", { groupBy: "profile" })],
    "timeseries-bar",
  ),
  {
    type: "funnel",
    title: "Activation",
    description: "New installations that start a conversation and finish a turn within a day.",
    width: 6,
    height: 4,
    query: {
      steps: [
        { event_name: "installation_created" },
        { event_name: "thread_started" },
        { event_name: "turn_completed" },
      ],
      unit_type: INSTALLATION_UNIT,
      conversion_window: { value: 1, unit: "day" },
      chart_type: "conversions",
      is_sequential: true,
    },
  },
  chart("Website visits", "Page views, with no cookies or stored identity.", [
    series("landing_viewed", "COUNT", { unit: ANONYMOUS_UNIT }),
  ]),
  chart(
    "Download intent",
    "Website download clicks and copied Homebrew commands, by target.",
    [series("landing_download_clicked", "COUNT", { unit: ANONYMOUS_UNIT, groupBy: "target" })],
    "timeseries-bar",
  ),
  chart(
    "GitHub downloads",
    "Daily change in release asset downloads, by kind. Includes CI, so read it as an upper bound.",
    [series("distribution_downloads", "SUM", { unit: ANONYMOUS_UNIT, groupBy: "kind" })],
    "timeseries-bar",
  ),
  chart(
    "Update feed requests",
    "Daily appcast requests. Every launch checks once, so this counts launches including opted-out ones.",
    [series("update_feed_requests", "SUM", { unit: ANONYMOUS_UNIT, groupBy: "platform" })],
    "timeseries-bar",
  ),
  header("Engagement"),
  chart("Active installations", "Installations with a focused window: daily, weekly and monthly.", [
    series("app_active", "COUNT_DISTINCT", { alias: "Daily", window: "daily" }),
    series("app_active", "COUNT_DISTINCT", { alias: "Weekly", window: "weekly" }),
    series("app_active", "COUNT_DISTINCT", { alias: "Monthly", window: "monthly" }),
  ]),
  chart(
    "Conversations started",
    "New conversations per day by Agent. Subagents, forks, side chats and imports are not included.",
    [series("thread_started", "COUNT", { groupBy: "provider" })],
    "timeseries-bar",
  ),
  chart(
    "Conversations per active installation",
    "Mean new conversations per installation, per day.",
    [series("thread_started", "AVG_COUNT_PER_USER")],
  ),
  chart(
    "Branched threads",
    "Subagents, forks and side chats per day.",
    [series("thread_branched", "COUNT", { groupBy: "kind" })],
    "timeseries-bar",
  ),
  chart(
    "Turns",
    "Completed provider turns per day by outcome.",
    [series("turn_completed", "COUNT", { groupBy: "status" })],
    "timeseries-bar",
  ),
  chart(
    "Models",
    "Turns per day by public model name; private models report as other.",
    [series("turn_completed", "COUNT", { groupBy: "model" })],
    "timeseries-bar",
  ),
  chart(
    "Surface adoption",
    "Installations using each surface per day.",
    [series("feature_used", "COUNT_DISTINCT", { groupBy: "feature" })],
    "timeseries-bar",
  ),
  header("Releases"),
  chart("Launches by kind", "First launches, updates and returning launches.", [
    series("app_launched", "COUNT", { groupBy: "launch" }),
  ]),
  chart("Active installations by version", "Version adoption across daily active installations.", [
    series("app_active", "COUNT_DISTINCT", { groupBy: "appVersion", groupColumn: USER_PROPERTIES }),
  ]),
  header("Responsiveness"),
  chart("Turn duration, p50", "How long a provider turn takes on any Agent, ms.", [
    series("turn_completed", "P50"),
  ]),
  chart("Turn duration, p95", "How long a provider turn takes on any Agent, ms.", [
    series("turn_completed", "P95"),
  ]),
  chart("Remote hosts: time to first response, p50", "Only conversations on a remote host, ms.", [
    series("turn_first_response", "P50"),
  ]),
  chart("Remote hosts: opening a conversation, p50", "Only conversations on a remote host, ms.", [
    series("thread_opened", "P50"),
  ]),
] as const;

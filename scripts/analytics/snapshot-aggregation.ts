export const DAY_MS = 86_400_000;
export const utcDate = (time: number): string => new Date(time).toISOString().slice(0, 10);

export const snapshotWindow = (now: number, completedDays: number) => {
  const today = Date.parse(utcDate(now));
  const start = today - completedDays * DAY_MS;
  const days = Array.from({ length: completedDays + 1 }, (_, index) => ({
    date: utcDate(start + index * DAY_MS),
    partial: index === completedDays,
  }));
  return { start, now, days };
};

type Window = ReturnType<typeof snapshotWindow>;

export const snapshotEventNames = [
  "landing_viewed",
  "landing_download_clicked",
  "distribution_downloads",
  "update_feed_requests",
  "installation_created",
  "app_launched",
  "app_active",
  "thread_started",
  "turn_completed",
] as const;

export interface SnapshotEvent {
  readonly name: (typeof snapshotEventNames)[number];
  readonly time: number;
  readonly installationId: string | null;
  readonly value: number | null;
  readonly fields: Readonly<Record<string, string | undefined>>;
}

const compareText = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);
const sortedCounts = (counts: Map<string, number>) =>
  Object.fromEntries([...counts].sort(([a], [b]) => compareText(a, b)));

const label = (event: SnapshotEvent, key: string) => event.fields[key] || "unknown";
const increment = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

const websiteDay = (events: readonly SnapshotEvent[]) => {
  let landingViews = 0;
  let entrances = 0;
  const viewsByPage = new Map<string, number>();
  const viewsBySource = new Map<string, number>();
  const downloadClicksByTarget = new Map<string, number>();
  const downloadClicksBySource = new Map<string, number>();
  for (const event of events) {
    if (event.name === "landing_download_clicked") {
      increment(downloadClicksByTarget, label(event, "target"));
      increment(downloadClicksBySource, label(event, "source").toLowerCase());
    }
    if (event.name !== "landing_viewed") continue;
    const source = label(event, "source").toLowerCase();
    landingViews++;
    if (source !== "internal") entrances++;
    increment(viewsByPage, label(event, "page"));
    increment(viewsBySource, source);
  }
  return {
    landingViews,
    entrances,
    viewsByPage: sortedCounts(viewsByPage),
    viewsBySource: sortedCounts(viewsBySource),
    downloadClicksByTarget: sortedCounts(downloadClicksByTarget),
    downloadClicksBySource: sortedCounts(downloadClicksBySource),
  };
};

const sumByDimensions = <const Key extends string>(
  events: readonly SnapshotEvent[],
  name: SnapshotEvent["name"],
  dimensions: readonly Key[],
) => {
  const sums = new Map<string, { dimensions: Record<Key, string>; count: number }>();
  for (const event of events) {
    if (event.name !== name || event.value === null) continue;
    const labels = dimensions.map((dimension) => [dimension, label(event, dimension)] as const);
    const key = JSON.stringify(labels);
    const total = (sums.get(key)?.count ?? 0) + event.value;
    sums.set(key, { dimensions: Object.fromEntries(labels) as Record<Key, string>, count: total });
  }
  return [...sums.keys()].sort(compareText).map((key) => {
    const { dimensions, count } = sums.get(key)!;
    return { ...dimensions, count };
  });
};

const externalCounts = () => ({
  newInstalls: 0,
  activeInstalls: 0,
  activatedInstalls: 0,
  returningInstalls: 0,
});

const summarizeInstallation = (
  events: readonly SnapshotEvent[],
  window: Window,
  externalByDate: Map<string, ReturnType<typeof externalCounts>>,
  self: boolean,
) => {
  // Process oldest first so newer release fields replace earlier observations.
  const ordered = events.toSorted((a, b) => a.time - b.time);
  const created = ordered.find((event) => event.name === "installation_created");
  const profile = created?.fields.profile;
  const firstSeen = created
    ? {
        date: utcDate(created.time),
        profile: profile === "new" || profile === "existing" ? profile : null,
      }
    : null;
  const activeDays = new Set<string>();
  const turnDays = new Set<string>();
  let earliestActivity: string | undefined;
  let threadsStarted = 0;
  let turnsCompleted = 0;
  const latest = {
    appVersion: null as string | null,
    os: null as string | null,
    channel: null as string | null,
  };

  for (const event of ordered) {
    const date = utcDate(event.time);
    latest.appVersion = event.fields.appVersion || latest.appVersion;
    latest.os = event.fields.os || latest.os;
    latest.channel = event.fields.channel || latest.channel;
    if (event.name === "app_active") earliestActivity ??= date;
    if (event.time < window.start) continue;
    if (event.name === "app_active") activeDays.add(date);
    if (event.name === "thread_started") threadsStarted++;
    if (event.name === "turn_completed") {
      turnsCompleted++;
      turnDays.add(date);
    }
  }

  if (!self) {
    const firstDay = firstSeen?.date ?? earliestActivity;
    if (firstSeen?.profile === "new") {
      const counts = externalByDate.get(firstSeen.date);
      if (counts) counts.newInstalls++;
    }
    for (const date of activeDays) {
      const counts = externalByDate.get(date)!;
      counts.activeInstalls++;
      if (firstDay && date > firstDay) counts.returningInstalls++;
    }
    for (const date of turnDays) externalByDate.get(date)!.activatedInstalls++;
  }

  return { firstSeen, self, activeDays: [...activeDays], threadsStarted, turnsCompleted, latest };
};

export const aggregateStatsig = (
  events: readonly SnapshotEvent[],
  window: Window,
  selfIds: ReadonlySet<string>,
) => {
  const byDate = new Map<string, SnapshotEvent[]>();
  const byInstallation = new Map<string, SnapshotEvent[]>();
  const observed = new Set<string>();
  for (const event of events) {
    if (event.time > window.now) continue;
    if (event.time >= window.start) {
      const date = utcDate(event.time);
      const daily = byDate.get(date) ?? [];
      daily.push(event);
      byDate.set(date, daily);
      if (event.installationId) observed.add(event.installationId);
    }
    if (!event.installationId) continue;
    const installation = byInstallation.get(event.installationId) ?? [];
    installation.push(event);
    byInstallation.set(event.installationId, installation);
  }

  const daily = window.days.map(({ date }) => ({ date, events: byDate.get(date) ?? [] }));
  const externalByDate = new Map(window.days.map(({ date }) => [date, externalCounts()]));
  const installations = [...observed].sort(compareText).map((id) => ({
    id,
    ...summarizeInstallation(byInstallation.get(id)!, window, externalByDate, selfIds.has(id)),
  }));
  return {
    website: daily.map(({ date, events }) => ({ date, ...websiteDay(events) })),
    distribution: daily.map(({ date, events }) => ({
      date,
      downloads: sumByDimensions(events, "distribution_downloads", ["channel", "platform", "kind"]),
      updateFeedRequests: sumByDimensions(events, "update_feed_requests", ["channel", "platform"]),
    })),
    product: {
      installations,
      external: [...externalByDate].map(([date, counts]) => ({ date, ...counts })),
    },
  };
};

export interface Stargazer {
  readonly login: string;
  readonly starred_at: string;
}

export interface GitHubTrafficDay {
  readonly timestamp: string;
  readonly count: number;
  readonly uniques: number;
}

export const aggregateGitHubDays = (
  window: Window,
  stargazers: readonly Stargazer[] | null,
  views: readonly GitHubTrafficDay[],
  clones: readonly GitHubTrafficDay[],
) => {
  const newStargazers = (stargazers ?? [])
    .filter(
      ({ starred_at }) =>
        Date.parse(starred_at) >= window.start && Date.parse(starred_at) <= window.now,
    )
    .toSorted(
      (a, b) =>
        Date.parse(a.starred_at) - Date.parse(b.starred_at) || compareText(a.login, b.login),
    );
  const starsByDay = new Map<string, number>();
  for (const { starred_at } of newStargazers)
    increment(starsByDay, utcDate(Date.parse(starred_at)));
  const indexTraffic = (rows: readonly GitHubTrafficDay[]) =>
    new Map(
      rows.map(({ timestamp, count, uniques }) => [
        utcDate(Date.parse(timestamp)),
        { count, uniques },
      ]),
    );
  const viewsByDay = indexTraffic(views);
  const clonesByDay = indexTraffic(clones);

  return {
    newStargazers: stargazers === null ? null : newStargazers,
    daily: window.days.map(({ date }) => ({
      date,
      stars: stargazers === null ? null : (starsByDay.get(date) ?? 0),
      views: viewsByDay.get(date) ?? null,
      clones: clonesByDay.get(date) ?? null,
    })),
  };
};

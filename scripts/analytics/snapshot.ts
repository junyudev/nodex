import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import {
  aggregateGitHubDays,
  aggregateStatsig,
  DAY_MS,
  parseSelfIds,
  snapshotEventNames,
  snapshotWindow,
  utcDate,
} from "./snapshot-aggregation";
import { collectStatsigEvents, type SourceStatus } from "./snapshot-statsig";
import { statsigConsole } from "./statsig-console";

const REPOSITORY = "junyudev/nodex";
const GITHUB_TRAFFIC_DAYS = 14;
const GITHUB_POPULAR_LIMIT = 10;
const STATSIG_INSTALLATION_LOOKBACK_DAYS = 30;

const count = z.number().int().nonnegative();
const isoTimestamp = z.iso.datetime();
const trafficPoint = z.object({ count, uniques: count });
const trafficDays = z.array(trafficPoint.extend({ timestamp: isoTimestamp }));
const starPages = z.array(
  z.array(
    z.object({
      starred_at: isoTimestamp,
      user: z.object({ login: z.string() }),
    }),
  ),
);
const referrers = z.array(trafficPoint.extend({ referrer: z.string() }));
const paths = z.array(trafficPoint.extend({ path: z.string(), title: z.string() }));

function githubError(error: unknown): SourceStatus {
  const failure = error as NodeJS.ErrnoException & { stderr?: string; signal?: string };
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { status: "GitHub response exceeded the local size limit", truncated: true };
  }
  if (failure.code === "ENOENT") return { status: "gh is unavailable" };
  if (failure.signal) return { status: "gh api timed out" };
  const http = failure.stderr?.match(/\bHTTP \d{3}\b/)?.[0];
  if (http) return { status: http };
  return { status: "gh api failed. Check gh auth status." };
}

const run = promisify(execFile);
async function github<Output>(endpoint: string, schema: z.ZodType<Output>, ...args: string[]) {
  let stdout: string;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1" };
    delete env.STATSIG_CONSOLE_API_KEY;
    ({ stdout } = await run("gh", ["api", `repos/${REPOSITORY}${endpoint}`, ...args], {
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env,
    }));
  } catch (error) {
    return { data: null, source: githubError(error) };
  }
  try {
    const data = schema.safeParse(JSON.parse(stdout));
    if (data.success) return { data: data.data, source: { status: "ok" } as SourceStatus };
  } catch {
    // An invalid JSON body also means the response shape is unusable.
  }
  return {
    data: null,
    source: { status: "GitHub returned an unexpected payload" } as SourceStatus,
  };
}

async function collectGitHub(window: ReturnType<typeof snapshotWindow>) {
  const [repo, stars, views, clones, popularReferrers, popularPaths] = await Promise.all([
    github("", z.object({ stargazers_count: count })),
    github(
      "/stargazers?per_page=100",
      starPages,
      "-H",
      "Accept: application/vnd.github.star+json",
      "--paginate",
      "--slurp",
    ),
    github("/traffic/views?per=day", z.object({ views: trafficDays })),
    github("/traffic/clones?per=day", z.object({ clones: trafficDays })),
    github("/traffic/popular/referrers", referrers),
    github("/traffic/popular/paths", paths),
  ]);
  const stargazers = stars.data && [
    ...new Map(
      stars.data
        .flat()
        .map(({ user, starred_at }) => [user.login, { login: user.login, starred_at }]),
    ).values(),
  ];
  const stargazerTotal = repo.data?.stargazers_count ?? null;
  const stats = aggregateGitHubDays(
    window,
    stargazers,
    views.data?.views ?? [],
    clones.data?.clones ?? [],
  );

  const trafficStatus = (
    source: SourceStatus,
    rows: readonly { timestamp: string }[] | undefined,
  ): SourceStatus => {
    if (!rows) return source;
    const earliest = rows.map(({ timestamp }) => utcDate(Date.parse(timestamp))).sort()[0];
    const start = utcDate(window.start);
    return window.days.length > GITHUB_TRAFFIC_DAYS + 1 || (earliest && start < earliest)
      ? { ...source, truncated: true }
      : source;
  };
  const popularStatus = (source: SourceStatus, length: number | undefined): SourceStatus =>
    length === GITHUB_POPULAR_LIMIT ? { ...source, truncated: true } : source;
  const starStatus =
    stargazers && stargazerTotal !== null && stargazers.length < stargazerTotal
      ? ({
          status: "Stargazer listing was smaller than the repository total",
          truncated: true,
        } as const)
      : stars.source;

  return {
    data: {
      repository: REPOSITORY,
      stargazerTotal,
      ...stats,
      popular: {
        rollingDays: GITHUB_TRAFFIC_DAYS,
        referrers: popularReferrers.data,
        paths: popularPaths.data,
      },
    },
    sources: {
      "github.repository": repo.source,
      "github.stargazers": starStatus,
      "github.views": trafficStatus(views.source, views.data?.views),
      "github.clones": trafficStatus(clones.source, clones.data?.clones),
      "github.referrers": popularStatus(popularReferrers.source, popularReferrers.data?.length),
      "github.paths": popularStatus(popularPaths.source, popularPaths.data?.length),
    },
    collected: [repo, stars, views, clones, popularReferrers, popularPaths].some(
      ({ data }) => data !== null,
    ),
  };
}

async function collectStatsig(
  window: ReturnType<typeof snapshotWindow>,
  selfIds: ReadonlySet<string>,
) {
  const key = process.env.STATSIG_CONSOLE_API_KEY;
  if (!key) {
    const status = { status: "STATSIG_CONSOLE_API_KEY is required" };
    return {
      data: null,
      sources: { "statsig.events": status, "statsig.installationHistory": status },
      collected: false,
    };
  }

  const { get } = statsigConsole(key);
  const [current, history] = await Promise.all([
    collectStatsigEvents(get, window.start, window.now, snapshotEventNames),
    collectStatsigEvents(
      get,
      Math.max(0, window.start - STATSIG_INSTALLATION_LOOKBACK_DAYS * DAY_MS),
      window.start,
      ["installation_created", "app_active"],
    ),
  ]);
  return {
    data: current.collected
      ? aggregateStatsig(
          [...history.events.filter(({ time }) => time < window.start), ...current.events],
          window,
          selfIds,
        )
      : null,
    sources: { "statsig.events": current.status, "statsig.installationHistory": history.status },
    collected: current.collected,
  };
}

async function writeSnapshot(out: string, snapshot: unknown) {
  const parent = dirname(out);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".analytics-snapshot-"));
  try {
    const file = join(temporary, "snapshot.json");
    await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(file, out);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      self: { type: "string", default: "" },
      days: { type: "string", default: "14" },
    },
  });
  if (!values.out) throw new Error("--out <file> is required");
  const now = Date.now();
  const days = Number(values.days);
  if (
    !/^\d+$/.test(values.days) ||
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > Math.floor(now / DAY_MS)
  ) {
    throw new Error("--days must be a positive integer within the supported UTC date range");
  }

  const window = snapshotWindow(now, days);
  const selfIds = parseSelfIds(values.self);
  const [statsig, github] = await Promise.all([
    collectStatsig(window, selfIds),
    collectGitHub(window),
  ]);
  await writeSnapshot(values.out, {
    schemaVersion: 1,
    asOf: new Date(now).toISOString(),
    days: window.days,
    website: statsig.data?.website ?? null,
    distribution: statsig.data?.distribution ?? null,
    product: statsig.data?.product ?? null,
    github: github.data,
    sources: { ...statsig.sources, ...github.sources },
  });
  if (!statsig.collected && !github.collected) {
    process.stderr.write("The snapshot contains source errors. No data was collected.\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

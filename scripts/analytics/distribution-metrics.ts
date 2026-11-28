import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  STATSIG_CLIENT_KEY,
  STATSIG_LOG_EVENT_URL,
} from "../../src/shared/product-analytics/statsig";
import {
  RELEASE_DOWNLOAD_ORIGIN,
  parseImmutableReleaseDownloadUrl,
  releaseTagChannel,
  type ReleaseChannel,
} from "../../src/shared/release-download";

/**
 * Records yesterday's distribution as product events so it can be read beside installations:
 * downloads served by GitHub Releases (the daily change in each asset's lifetime total, which
 * disappears with a retained Nightly) and by `dl.nodex.jyu.app` (whole-object responses from zone
 * analytics), plus update-feed requests. Downloads include CI and repeat fetches: they bound
 * installs from above, while `installation_created` is the install count.
 */
const REPOSITORY = "junyudev/nodex";
const JYU_APP_ZONE = "a33615070627c8e5977a12b591c231a5";
const WEBSITE_HOST = "nodex.jyu.app";
const DOWNLOAD_HOST = new URL(RELEASE_DOWNLOAD_ORIGIN).hostname;
/** The four feeds the website serves; any other path under `/updates/` is a 404. */
const FEED_PATH = /^\/updates\/(stable|nightly)\/(arm64|windows-x64)\/appcast\.xml$/;
const DAY_MS = 86_400_000;
const DOWNLOAD_PAGE_SIZE = 1_000;

interface ReleaseAsset {
  readonly name: string;
  readonly download_count: number;
}

interface Release {
  readonly tag_name: string;
  readonly assets: readonly ReleaseAsset[];
}

interface AssetKind {
  readonly platform: string;
  readonly kind: "installer" | "update";
}

interface Download extends AssetKind {
  readonly channel: ReleaseChannel;
  readonly tag: string;
  readonly source: "github" | "cloudflare";
  readonly downloads: number;
}

const ANDROID_INSTALLER = /-android\.apk$/;
const MAC_UPDATE_ARCHIVE = /-(arm64|x64)\.tar\.xz$/;

/** Classify distributed packages and archives, excluding release bookkeeping. */
function classifyAsset(name: string, source: Download["source"]): AssetKind | null {
  if (!name.startsWith("Nodex-")) return null;
  if (ANDROID_INSTALLER.test(name)) return { platform: "android", kind: "installer" };
  const windows = /-windows-(x64|arm64)\.exe$/.exec(name);
  if (windows) {
    // GitHub has a separate installer alias. The bucket serves one Windows installer for both uses.
    const installer = source === "cloudflare" || name.startsWith("Nodex-latest-");
    return { platform: `windows-${windows[1]}`, kind: installer ? "installer" : "update" };
  }
  const mac = /-(arm64|x64)\.(dmg|zip|delta|tar\.xz)$/.exec(name);
  if (!mac) return null;
  return { platform: `macos-${mac[1]}`, kind: mac[2] === "dmg" ? "installer" : "update" };
}

function groupDownloads(rows: readonly Download[]): readonly Download[] {
  const groups = new Map<string, Download>();
  for (const row of rows) {
    const key = `${row.source}/${row.tag}/${row.platform}/${row.kind}`;
    groups.set(key, { ...row, downloads: (groups.get(key)?.downloads ?? 0) + row.downloads });
  }
  return [...groups.values()];
}

type Snapshot = Readonly<Record<string, number>>;

interface State {
  readonly version: 0 | 1;
  readonly github: Snapshot;
  readonly feedWindowEnd?: number;
  readonly downloadWindowEnd?: number;
}

function githubDownloads(
  releases: readonly Release[],
  previous: State | null,
): { readonly snapshot: Snapshot; readonly deltas: readonly Download[] } {
  const counters = new Map<string, number>();
  const changes = releases.flatMap(({ tag_name: tag, assets }) => {
    const channel = releaseTagChannel(tag);
    if (!channel) return [];
    return assets.flatMap(({ name, download_count: count }) => {
      const dimensions = classifyAsset(name, "github");
      if (!dimensions) return [];
      const key = `${tag}/${name}`;
      counters.set(key, count);
      if (previous === null) return [];
      // An old snapshot never tracked APKs or .tar.xz files. Baseline them on first observation.
      const firstTracked =
        previous.version === 0 && (ANDROID_INSTALLER.test(name) || MAC_UPDATE_ARCHIVE.test(name));
      const downloads = count - (previous.github[key] ?? (firstTracked ? count : 0));
      return downloads > 0
        ? [{ ...dimensions, channel, tag, source: "github" as const, downloads }]
        : [];
    });
  });
  return { snapshot: Object.fromEntries(counters), deltas: groupDownloads(changes) };
}

interface FeedRequests {
  readonly channel: string;
  readonly platform: string;
  readonly requests: number;
}

interface RequestCount {
  readonly count: number;
  readonly dimensions: { readonly clientRequestPath: string };
}

const feedRequestsFromPaths = (groups: readonly RequestCount[]): readonly FeedRequests[] =>
  groups.flatMap(({ count, dimensions }) => {
    const match = FEED_PATH.exec(dimensions.clientRequestPath);
    return match ? [{ channel: match[1]!, platform: match[2]!, requests: count }] : [];
  });

function bucketDownloadsFromPaths(groups: readonly RequestCount[]): readonly Download[] {
  return groups.flatMap(({ count, dimensions: { clientRequestPath: path } }) => {
    const asset = parseImmutableReleaseDownloadUrl(`${RELEASE_DOWNLOAD_ORIGIN}${path}`);
    if (asset?.host !== "release-bucket") return [];
    const dimensions = classifyAsset(asset.assetName, "cloudflare");
    if (!dimensions || count <= 0) return [];
    return [
      {
        ...dimensions,
        channel: asset.channel,
        tag: asset.tag,
        source: "cloudflare",
        downloads: count,
      },
    ];
  });
}

/**
 * GitHub deltas measure the change up to this run. Zone analytics measure the previous UTC day, so
 * their events carry a time inside that day and group with the installs they sit beside.
 */
const statsigDistributionBody = (input: {
  readonly downloads: readonly Download[];
  readonly feed: readonly FeedRequests[];
  readonly time: number;
  readonly windowTime: number;
}) => ({
  // A stable ID rather than a user ID: distribution rows are not an active installation.
  user: {
    customIDs: { stableID: "nodex-distribution" },
    statsigEnvironment: { tier: "production" },
  },
  events: [
    ...input.downloads.map(({ downloads, ...metadata }) => ({
      eventName: "distribution_downloads",
      time: metadata.source === "cloudflare" ? input.windowTime : input.time,
      value: downloads,
      metadata,
    })),
    ...input.feed.map(({ requests, channel, platform }) => ({
      eventName: "update_feed_requests",
      time: input.windowTime,
      value: requests,
      metadata: { channel, platform },
    })),
  ],
  statsigMetadata: { sdkType: "nodex-distribution", sdkVersion: "1" },
});

const readReleases = async (
  token: string | undefined,
  request: typeof fetch,
): Promise<readonly Release[]> => {
  const releases: Release[] = [];
  for (let page = 1; ; page += 1) {
    const response = await request(
      `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
    );
    if (!response.ok) throw new Error(`GitHub releases returned ${response.status}`);
    const batch = (await response.json()) as readonly Release[];
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
};

const utcDayFilter = (windowEnd: number) => ({
  datetime_geq: new Date(windowEnd - DAY_MS).toISOString(),
  datetime_lt: new Date(windowEnd).toISOString(),
});

async function readZoneAnalytics<Zone>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  request: typeof fetch,
): Promise<Zone> {
  const response = await request("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { zone: JYU_APP_ZONE, ...variables } }),
  });
  if (!response.ok) throw new Error(`Cloudflare returned HTTP ${response.status}`);
  const result = (await response.json()) as {
    readonly data?: { readonly viewer?: { readonly zones?: readonly Zone[] } };
    readonly errors?: readonly { readonly message: string }[] | null;
  };
  const error = result.errors?.[0];
  if (error) throw new Error(error.message);
  const zone = result.data?.viewer?.zones?.[0];
  if (!zone) throw new Error("Cloudflare returned no analytics dataset for the jyu.app zone");
  return zone;
}

/** Query the host total alongside appcasts to distinguish missing traffic from zero matches. */
async function readFeedRequests(token: string, windowEnd: number, request: typeof fetch) {
  const hostFilter = { ...utcDayFilter(windowEnd), clientRequestHTTPHost: WEBSITE_HOST };
  const zone = await readZoneAnalytics<{
    readonly appcasts?: readonly RequestCount[];
    readonly hostTraffic?: readonly { readonly count: number }[];
  }>(
    token,
    `query AppcastRequests(
      $zone: String!,
      $appcastFilter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!,
      $hostFilter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!
    ) {
      viewer {
        zones(filter: {zoneTag: $zone}) {
          appcasts: httpRequestsAdaptiveGroups(limit: 50, filter: $appcastFilter) {
            count dimensions { clientRequestPath }
          }
          hostTraffic: httpRequestsAdaptiveGroups(limit: 1, filter: $hostFilter) { count }
        }
      }
    }`,
    { hostFilter, appcastFilter: { ...hostFilter, clientRequestPath_like: "/updates/%" } },
    request,
  );
  if (!zone.appcasts || !zone.hostTraffic) {
    throw new Error("Cloudflare did not return appcast and host traffic analytics");
  }
  const feed = feedRequestsFromPaths(zone.appcasts);
  if (feed.length === 0 && !zone.hostTraffic.some(({ count }) => count > 0)) {
    throw new Error(`Cloudflare returned no ${WEBSITE_HOST} traffic for the previous UTC day`);
  }
  return feed;
}

/** Count whole-object responses. A range can be one of many requests for the same transfer. */
async function readBucketDownloads(token: string, windowEnd: number, request: typeof fetch) {
  const rows: Download[] = [];
  let after = "";
  for (;;) {
    const { downloads } = await readZoneAnalytics<{ readonly downloads?: readonly RequestCount[] }>(
      token,
      `query ReleaseDownloads($zone: String!, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!) {
        viewer {
          zones(filter: {zoneTag: $zone}) {
            downloads: httpRequestsAdaptiveGroups(
              limit: ${DOWNLOAD_PAGE_SIZE}, orderBy: [clientRequestPath_ASC], filter: $filter
            ) { count dimensions { clientRequestPath } }
          }
        }
      }`,
      {
        filter: {
          ...utcDayFilter(windowEnd),
          clientRequestHTTPHost: DOWNLOAD_HOST,
          clientRequestHTTPMethodName: "GET",
          edgeResponseStatus: 200,
          requestSource: "eyeball",
          clientRequestPath_gt: after,
          OR: [{ clientRequestPath_like: "/releases/%" }, { clientRequestPath_like: "/nightly/%" }],
        },
      },
      request,
    );
    if (!downloads) throw new Error("Cloudflare did not return release download analytics");
    rows.push(...bucketDownloadsFromPaths(downloads));
    if (downloads.length < DOWNLOAD_PAGE_SIZE) return groupDownloads(rows);
    const lastPath = downloads.at(-1)!.dimensions.clientRequestPath;
    if (lastPath <= after) throw new Error("Cloudflare download analytics did not advance");
    after = lastPath;
  }
}

type CloudflareReport<Row> =
  | { readonly rows: readonly Row[]; readonly status: "reported" | "zero" | "already-reported" }
  | { readonly rows: readonly []; readonly status: "unavailable"; readonly reason: string };

async function collectCloudflare<Row>(
  token: string | undefined,
  alreadyReported: boolean,
  read: (token: string) => Promise<readonly Row[]>,
): Promise<CloudflareReport<Row>> {
  if (alreadyReported) return { rows: [], status: "already-reported" };
  if (!token)
    return { rows: [], status: "unavailable", reason: "CLOUDFLARE_ANALYTICS_TOKEN is not set" };
  try {
    const rows = await read(token);
    return { rows, status: rows.length > 0 ? "reported" : "zero" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { rows: [], status: "unavailable", reason };
  }
}

const isSnapshot = (value: unknown): value is Snapshot =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
  );

const isWindowEnd = (value: unknown): value is number | undefined =>
  value === undefined ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value % DAY_MS === 0);

const readState = (path: string): State | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const state = value as Partial<State> | null;
    if (state?.version === undefined && isSnapshot(value)) {
      return { version: 0, github: value };
    }
    if (
      state?.version === 1 &&
      isSnapshot(state.github) &&
      isWindowEnd(state.feedWindowEnd) &&
      isWindowEnd(state.downloadWindowEnd)
    ) {
      return { ...state, version: 1, github: state.github };
    }
    throw new Error("Invalid distribution snapshot");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export async function reportDistribution(
  input: {
    readonly state: string;
    readonly dryRun: boolean;
    readonly githubToken?: string;
    readonly cloudflareToken?: string;
  },
  request = fetch,
) {
  const previous = readState(input.state);
  const now = Date.now();
  const windowEnd = Math.floor(now / DAY_MS) * DAY_MS;
  const releases = await readReleases(input.githubToken, request);
  const { deltas, snapshot } = githubDownloads(releases, previous);
  // A failure on either host must leave the other metric available.
  const [feed, downloads] = await Promise.all([
    collectCloudflare(input.cloudflareToken, previous?.feedWindowEnd === windowEnd, (token) =>
      readFeedRequests(token, windowEnd, request),
    ),
    collectCloudflare(input.cloudflareToken, previous?.downloadWindowEnd === windowEnd, (token) =>
      readBucketDownloads(token, windowEnd, request),
    ),
  ]);
  const body = statsigDistributionBody({
    downloads: [...deltas, ...downloads.rows],
    feed: feed.rows,
    time: now,
    windowTime: windowEnd - 1,
  });
  const summary = {
    baseline: previous === null,
    deltas,
    cloudflareDownloads: downloads.rows,
    cloudflareDownloadsStatus: downloads.status,
    ...(downloads.status === "unavailable" ? { cloudflareDownloadsSkipped: downloads.reason } : {}),
    feed: feed.rows,
    feedStatus: feed.status,
    ...(feed.status === "unavailable" ? { feedSkipped: feed.reason } : {}),
    sent: !input.dryRun && body.events.length > 0,
  };
  if (summary.sent) {
    const response = await request(STATSIG_LOG_EVENT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "statsig-api-key": STATSIG_CLIENT_KEY,
        "statsig-client-time": String(now),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Statsig returned ${response.status}`);
  }
  // Advance counters and windows only after delivery, and retry unavailable windows on same-day runs.
  if (!input.dryRun) {
    const state: State = {
      version: 1,
      github: snapshot,
      feedWindowEnd: feed.status === "unavailable" ? previous?.feedWindowEnd : windowEnd,
      downloadWindowEnd:
        downloads.status === "unavailable" ? previous?.downloadWindowEnd : windowEnd,
    };
    writeFileSync(input.state, JSON.stringify(state));
  }
  return summary;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      state: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.state) throw new Error("--state <path> is required.");
  const summary = await reportDistribution({
    state: values.state,
    dryRun: values["dry-run"],
    githubToken: process.env.GITHUB_TOKEN,
    cloudflareToken: process.env.CLOUDFLARE_ANALYTICS_TOKEN,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("distribution-metrics.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

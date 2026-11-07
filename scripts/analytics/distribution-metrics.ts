import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  STATSIG_CLIENT_KEY,
  STATSIG_LOG_EVENT_URL,
} from "../../src/shared/product-analytics/statsig";

/**
 * GitHub keeps only a lifetime download total per asset, and that total disappears with a retained
 * Nightly. This job records the daily change, and yesterday's update-feed requests, as product
 * events so distribution can be read beside installations. Downloads include CI and repeat
 * fetches: they bound installs from above, while `installation_created` is the install count.
 */
const REPOSITORY = "junyudev/nodex";
const JYU_APP_ZONE = "a33615070627c8e5977a12b591c231a5";
const FEED_PATH = /^\/updates\/(stable|nightly)\/([a-z0-9-]+)\/appcast\.xml$/;

export interface ReleaseAsset {
  readonly name: string;
  readonly download_count: number;
}
export interface Release {
  readonly tag_name: string;
  readonly prerelease: boolean;
  readonly assets: readonly ReleaseAsset[];
}
export interface AssetKind {
  readonly channel: "stable" | "nightly";
  readonly platform: string;
  readonly kind: "installer" | "update";
}

/** Only files a person or the updater fetches; release bookkeeping assets never count. */
export const classifyAsset = (release: Release, name: string): AssetKind | null => {
  if (!/^v\d/.test(release.tag_name)) return null;
  const channel = release.prerelease ? "nightly" : "stable";
  const windows = /-windows-(x64|arm64)\.exe$/.exec(name);
  if (windows)
    return {
      channel,
      platform: `windows-${windows[1]}`,
      kind: name.startsWith("Nodex-latest-") ? "installer" : "update",
    };
  const mac = /-(arm64|x64)\.(dmg|zip)$/.exec(name);
  if (mac)
    return {
      channel,
      platform: `macos-${mac[1]}`,
      kind: mac[2] === "dmg" ? "installer" : "update",
    };
  const delta = /-(arm64|x64)\.delta$/.exec(name);
  return delta ? { channel, platform: `macos-${delta[1]}`, kind: "update" } : null;
};

export type Snapshot = Readonly<Record<string, number>>;

export const snapshotOf = (releases: readonly Release[]): Snapshot =>
  Object.fromEntries(
    releases.flatMap((release) =>
      release.assets.flatMap((asset) =>
        classifyAsset(release, asset.name)
          ? [[`${release.tag_name}/${asset.name}`, asset.download_count] as const]
          : [],
      ),
    ),
  );

export interface DownloadDelta extends AssetKind {
  readonly downloads: number;
}

/**
 * The change since the last snapshot, grouped for reporting. A first run has nothing to compare
 * with, so its lifetime totals are a baseline rather than one enormous day.
 */
export const downloadDeltas = (
  releases: readonly Release[],
  previous: Snapshot | null,
): readonly DownloadDelta[] => {
  if (previous === null) return [];
  const groups = new Map<string, DownloadDelta>();
  for (const release of releases) {
    for (const asset of release.assets) {
      const kind = classifyAsset(release, asset.name);
      if (kind === null) continue;
      const before = previous[`${release.tag_name}/${asset.name}`] ?? 0;
      const downloads = asset.download_count - before;
      if (downloads <= 0) continue;
      const key = `${kind.channel}/${kind.platform}/${kind.kind}`;
      groups.set(key, { ...kind, downloads: (groups.get(key)?.downloads ?? 0) + downloads });
    }
  }
  return [...groups.values()];
};

export interface FeedRequests {
  readonly channel: string;
  readonly platform: string;
  readonly requests: number;
}

export const feedRequestsFromPaths = (
  groups: readonly {
    readonly count: number;
    readonly dimensions: { readonly clientRequestPath: string };
  }[],
): readonly FeedRequests[] =>
  groups.flatMap(({ count, dimensions }) => {
    const match = FEED_PATH.exec(dimensions.clientRequestPath);
    return match ? [{ channel: match[1]!, platform: match[2]!, requests: count }] : [];
  });

export const statsigDistributionBody = (input: {
  readonly deltas: readonly DownloadDelta[];
  readonly feed: readonly FeedRequests[];
  readonly time: number;
}) => ({
  // A stable ID rather than a user ID: distribution rows are not an active installation.
  user: {
    customIDs: { stableID: "nodex-distribution" },
    statsigEnvironment: { tier: "production" },
  },
  events: [
    ...input.deltas.map(({ downloads, ...kind }) => ({
      eventName: "distribution_downloads",
      time: input.time,
      value: downloads,
      metadata: { ...kind },
    })),
    ...input.feed.map(({ requests, channel, platform }) => ({
      eventName: "update_feed_requests",
      time: input.time,
      value: requests,
      metadata: { channel, platform },
    })),
  ],
  statsigMetadata: { sdkType: "nodex-distribution", sdkVersion: "1" },
});

const readReleases = async (token: string | undefined): Promise<readonly Release[]> => {
  const releases: Release[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetch(
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

/** A missing or under-privileged token only skips this one signal. */
const readFeedRequests = async (
  token: string | undefined,
  now: number,
): Promise<{ readonly feed: readonly FeedRequests[]; readonly note: string | null }> => {
  if (!token) return { feed: [], note: "CLOUDFLARE_ANALYTICS_TOKEN is not set" };
  const dayMs = 86_400_000;
  const end = Math.floor(now / dayMs) * dayMs;
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: `query($zone:String!,$start:Time!,$end:Time!){viewer{zones(filter:{zoneTag:$zone}){httpRequestsAdaptiveGroups(limit:50,filter:{datetime_geq:$start,datetime_lt:$end,clientRequestHTTPHost:"nodex.jyu.app",clientRequestPath_like:"/updates/%"}){count dimensions{clientRequestPath}}}}}`,
      variables: {
        zone: JYU_APP_ZONE,
        start: new Date(end - dayMs).toISOString(),
        end: new Date(end).toISOString(),
      },
    }),
  });
  const result = (await response.json()) as {
    readonly data?: {
      readonly viewer?: {
        readonly zones?: readonly {
          readonly httpRequestsAdaptiveGroups?: Parameters<typeof feedRequestsFromPaths>[0];
        }[];
      };
    };
    readonly errors?: readonly { readonly message: string }[] | null;
  };
  if (result.errors?.length) return { feed: [], note: result.errors[0]!.message };
  return {
    feed: feedRequestsFromPaths(result.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? []),
    note: null,
  };
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      state: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.state) throw new Error("--state <path> is required.");
  const previous = (() => {
    try {
      return JSON.parse(readFileSync(values.state, "utf8")) as Snapshot;
    } catch {
      return null;
    }
  })();
  const now = Date.now();
  const releases = await readReleases(process.env.GITHUB_TOKEN);
  const deltas = downloadDeltas(releases, previous);
  const { feed, note } = await readFeedRequests(process.env.CLOUDFLARE_ANALYTICS_TOKEN, now);
  const body = statsigDistributionBody({ deltas, feed, time: now });
  const summary = {
    baseline: previous === null,
    deltas,
    feed,
    ...(note ? { feedSkipped: note } : {}),
    sent: !values["dry-run"] && body.events.length > 0,
  };
  if (summary.sent) {
    const response = await fetch(STATSIG_LOG_EVENT_URL, {
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
  // The new snapshot is saved only after delivery, so a failed run is counted by the next one.
  if (!values["dry-run"]) writeFileSync(values.state, JSON.stringify(snapshotOf(releases)));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("distribution-metrics.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

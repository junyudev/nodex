import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { STATSIG_LOG_EVENT_URL } from "../../src/shared/product-analytics/statsig";
import { RELEASE_DOWNLOAD_ORIGIN } from "../../src/shared/release-download";
import { reportDistribution } from "./distribution-metrics";

const STABLE = "v1.2.3";
const NIGHTLY = "v1.2.4-nightly.20261126.12";
const MAC_INSTALLER = "Nodex-1.2.3-arm64.dmg";
const MAC_UPDATE = "Nodex-1.2.3-arm64.tar.xz";
const ANDROID_INSTALLER = "Nodex-1.2.3-android.apk";
const APPCAST = "/updates/stable/arm64/appcast.xml";
const NOW = Date.parse("2026-11-28T23:30:00Z");

const pathCount = (clientRequestPath: string, count: number) => ({
  count,
  dimensions: { clientRequestPath },
});

const zone = (data: unknown) => Response.json({ data: { viewer: { zones: [data] } } });

function distributionApi() {
  const api = {
    assets: {} as Record<string, number>,
    feed: () => zone({ appcasts: [pathCount(APPCAST, 7)], hostTraffic: [{ count: 10 }] }),
    downloads: (_filter: Record<string, unknown>) => zone({ downloads: [] }),
    statsigStatus: 200,
    batches: [] as unknown[],
    queries: [] as Record<string, unknown>[],
  };
  const request: typeof fetch = (url, options) => {
    if (String(url).startsWith("https://api.github.com/")) {
      return Promise.resolve(
        Response.json([
          {
            tag_name: STABLE,
            assets: Object.entries(api.assets).map(([name, download_count]) => ({
              name,
              download_count,
            })),
          },
        ]),
      );
    }
    if (String(url) === "https://api.cloudflare.com/client/v4/graphql") {
      const { variables } = JSON.parse(String(options?.body)) as {
        variables: { filter?: Record<string, unknown> };
      };
      api.queries.push(variables);
      return Promise.resolve(variables.filter ? api.downloads(variables.filter) : api.feed());
    }
    expect(url).toBe(STATSIG_LOG_EVENT_URL);
    api.batches.push(JSON.parse(String(options?.body)));
    return Promise.resolve(new Response(null, { status: api.statsigStatus }));
  };
  return { api, request };
}

let directory: string;
let state: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nodex-distribution-"));
  state = join(directory, "snapshot.json");
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

test("attributes package downloads by host and release while preserving appcast events", async () => {
  const { api, request } = distributionApi();
  api.assets = { [MAC_INSTALLER]: 12, [MAC_UPDATE]: 200, [ANDROID_INSTALLER]: 100 };
  writeFileSync(state, JSON.stringify({ [`${STABLE}/${MAC_INSTALLER}`]: 10 }));
  api.downloads = () =>
    zone({
      downloads: [
        pathCount(`/releases/${STABLE}/${MAC_INSTALLER}`, 4),
        pathCount(`/releases/${STABLE}/${MAC_UPDATE}`, 3),
        pathCount(`/releases/${STABLE}/Nodex-1.2.2-to-1.2.3-arm64.delta`, 2),
        pathCount(`/releases/${STABLE}/${ANDROID_INSTALLER}`, 6),
        pathCount(`/nightly/${NIGHTLY}/Nodex-1.2.4-windows-x64.exe`, 5),
        pathCount(`/releases/${STABLE}/release-bundle.json`, 40),
        pathCount(`/releases/${NIGHTLY}/${MAC_INSTALLER}`, 50),
        pathCount(`/releases/other/../${STABLE}/${MAC_INSTALLER}`, 70),
        pathCount("/dl/macos", 100),
      ],
    });

  await expect(
    reportDistribution({ state, dryRun: false, cloudflareToken: "example" }, request),
  ).resolves.toMatchObject({
    baseline: false,
    cloudflareDownloadsStatus: "reported",
    feedStatus: "reported",
    sent: true,
  });

  const download = (
    value: number,
    source: string,
    tag: string,
    channel: string,
    platform: string,
    kind: string,
  ) => ({
    eventName: "distribution_downloads",
    // Zone analytics rows land inside the UTC day they measure.
    time: source === "github" ? NOW : Date.parse("2026-11-28T00:00:00.000Z") - 1,
    value,
    metadata: { source, tag, channel, platform, kind },
  });
  expect(api.batches).toMatchObject([
    {
      user: { customIDs: { stableID: "nodex-distribution" } },
      events: [
        download(2, "github", STABLE, "stable", "macos-arm64", "installer"),
        download(4, "cloudflare", STABLE, "stable", "macos-arm64", "installer"),
        download(5, "cloudflare", STABLE, "stable", "macos-arm64", "update"),
        download(6, "cloudflare", STABLE, "stable", "android", "installer"),
        download(5, "cloudflare", NIGHTLY, "nightly", "windows-x64", "installer"),
        {
          eventName: "update_feed_requests",
          time: Date.parse("2026-11-28T00:00:00.000Z") - 1,
          value: 7,
          metadata: { channel: "stable", platform: "arm64" },
        },
      ],
    },
  ]);
  expect(api.batches[0]).not.toHaveProperty("user.userID");

  const utcWindow = {
    datetime_geq: "2026-11-27T00:00:00.000Z",
    datetime_lt: "2026-11-28T00:00:00.000Z",
  };
  expect(api.queries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        appcastFilter: {
          ...utcWindow,
          clientRequestHTTPHost: "nodex.jyu.app",
          clientRequestPath_like: "/updates/%",
        },
      }),
      expect.objectContaining({
        filter: expect.objectContaining({
          ...utcWindow,
          clientRequestHTTPHost: new URL(RELEASE_DOWNLOAD_ORIGIN).hostname,
          clientRequestHTTPMethodName: "GET",
          edgeResponseStatus: 200,
          requestSource: "eyeball",
        }),
      }),
    ]),
  );

  api.assets[MAC_UPDATE] = 202;
  api.assets[ANDROID_INSTALLER] = 103;
  await expect(
    reportDistribution({ state, dryRun: false, cloudflareToken: "example" }, request),
  ).resolves.toMatchObject({
    deltas: [
      { source: "github", kind: "update", downloads: 2 },
      { source: "github", platform: "android", downloads: 3 },
    ],
    cloudflareDownloadsStatus: "already-reported",
    feedStatus: "already-reported",
  });
  expect(api.queries).toHaveLength(2);
});

test("keeps completed windows independent and retries a failed download query", async () => {
  const { api, request } = distributionApi();
  api.downloads = () => Response.json({ errors: [{ message: "Zone Analytics Read is required" }] });
  const input = { state, dryRun: false, cloudflareToken: "example" };
  await expect(reportDistribution(input, request)).resolves.toMatchObject({
    baseline: true,
    cloudflareDownloadsStatus: "unavailable",
    cloudflareDownloadsSkipped: "Zone Analytics Read is required",
    feedStatus: "reported",
    sent: true,
  });

  api.downloads = () => zone({ downloads: [pathCount(`/releases/${STABLE}/${MAC_INSTALLER}`, 4)] });
  await expect(reportDistribution(input, request)).resolves.toMatchObject({
    cloudflareDownloadsStatus: "reported",
    feedStatus: "already-reported",
    sent: true,
  });

  vi.mocked(Date.now).mockReturnValue(NOW + 86_400_000);
  api.downloads = () => zone({ downloads: [] });
  api.feed = () => zone({ appcasts: [], hostTraffic: [{ count: 10 }] });
  await expect(reportDistribution(input, request)).resolves.toMatchObject({
    cloudflareDownloadsStatus: "zero",
    feedStatus: "zero",
    sent: false,
  });
});

test("keeps the snapshot and Cloudflare windows retryable after dry run or failed delivery", async () => {
  const { api, request } = distributionApi();
  const before = JSON.stringify({ [`${STABLE}/${MAC_INSTALLER}`]: 10 });
  writeFileSync(state, before);
  api.assets = { [MAC_INSTALLER]: 12 };
  const input = { state, dryRun: false, cloudflareToken: "example" };

  await expect(reportDistribution({ ...input, dryRun: true }, request)).resolves.toMatchObject({
    sent: false,
    feedStatus: "reported",
  });
  expect(api.batches).toHaveLength(0);
  expect(readFileSync(state, "utf8")).toBe(before);

  api.statsigStatus = 503;
  await expect(reportDistribution(input, request)).rejects.toThrow("Statsig returned 503");
  expect(readFileSync(state, "utf8")).toBe(before);

  api.statsigStatus = 200;
  await expect(reportDistribution(input, request)).resolves.toMatchObject({
    cloudflareDownloadsStatus: "zero",
    feedStatus: "reported",
    deltas: [{ downloads: 2 }],
    sent: true,
  });
  expect(readFileSync(state, "utf8")).not.toBe(before);
});

test("reads past a full Cloudflare result page to find later release objects", async () => {
  const { api, request } = distributionApi();
  const page = Array.from({ length: 1000 }, (_, index) =>
    pathCount(`/releases/${STABLE}/${String(index).padStart(4, "0")}.json`, 1),
  );
  api.downloads = ({ clientRequestPath_gt: after }) =>
    zone({
      downloads:
        after === page.at(-1)?.dimensions.clientRequestPath
          ? [pathCount(`/releases/${STABLE}/${MAC_INSTALLER}`, 1)]
          : page,
    });

  await expect(
    reportDistribution({ state, dryRun: true, cloudflareToken: "example" }, request),
  ).resolves.toMatchObject({
    cloudflareDownloads: [{ tag: STABLE, downloads: 1 }],
    cloudflareDownloadsStatus: "reported",
  });
});

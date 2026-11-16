import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  classifyAsset,
  downloadDeltas,
  feedRequestsFromPaths,
  readFeedRequests,
  reportDistribution,
  snapshotOf,
  statsigDistributionBody,
  type Release,
} from "./distribution-metrics";

const stable = (assets: Record<string, number>, tag = "v1.0.0"): Release => ({
  tag_name: tag,
  prerelease: false,
  assets: Object.entries(assets).map(([name, download_count]) => ({ name, download_count })),
});

describe("distribution metrics", () => {
  test("classifies install and update files and ignores release bookkeeping", () => {
    const release = stable({});
    expect(classifyAsset(release, "Nodex-latest-arm64.dmg")).toEqual({
      channel: "stable",
      platform: "macos-arm64",
      kind: "installer",
    });
    expect(classifyAsset(release, "Nodex-1.0.0-arm64.zip")?.kind).toBe("update");
    expect(classifyAsset(release, "Nodex-0.9.0-to-1.0.0-arm64.delta")?.kind).toBe("update");
    expect(classifyAsset(release, "Nodex-latest-windows-x64.exe")?.kind).toBe("installer");
    expect(classifyAsset(release, "Nodex-1.0.0-windows-x64.exe")?.kind).toBe("update");
    for (const name of ["release-bundle.json", "SHA256SUMS", "Nodex-1.0.0-appcast-arm64.xml"]) {
      expect(classifyAsset(release, name)).toBeNull();
    }
  });

  test("runtime releases are not product downloads, and a prerelease is Nightly", () => {
    expect(classifyAsset(stable({}, "browser-runtime-v1"), "Nodex-latest-arm64.dmg")).toBeNull();
    expect(
      classifyAsset({ ...stable({}), prerelease: true }, "Nodex-latest-arm64.dmg")?.channel,
    ).toBe("nightly");
  });

  test("a first run records a baseline instead of one enormous day", () => {
    expect(downloadDeltas([stable({ "Nodex-latest-arm64.dmg": 500 })], null)).toEqual([]);
  });

  test("reports grouped change, counts new assets in full, and skips unchanged ones", () => {
    const releases = [
      stable({ "Nodex-latest-arm64.dmg": 12, "Nodex-1.0.0-arm64.zip": 5 }),
      stable({ "Nodex-latest-arm64.dmg": 3 }, "v1.1.0"),
    ];
    expect(
      downloadDeltas(releases, {
        "v1.0.0/Nodex-latest-arm64.dmg": 10,
        "v1.0.0/Nodex-1.0.0-arm64.zip": 5,
      }),
    ).toEqual([{ channel: "stable", platform: "macos-arm64", kind: "installer", downloads: 5 }]);
  });

  test("retired Nightly assets and counters that reset do not subtract downloads", () => {
    const asset = "Nodex-1.0.0-arm64.zip";
    const nightly = (count: number, tag: string): Release => ({
      ...stable({ [asset]: count }, tag),
      prerelease: true,
    });
    const previous = snapshotOf([nightly(20, "v1.0.0-nightly.1"), nightly(10, "v1.0.0-nightly.2")]);

    expect(
      downloadDeltas([nightly(2, "v1.0.0-nightly.2"), nightly(3, "v1.0.0-nightly.3")], previous),
    ).toEqual([{ channel: "nightly", platform: "macos-arm64", kind: "update", downloads: 3 }]);
  });

  test("keeps the prior snapshot on delivery failure or dry run and advances it after delivery", async () => {
    const temp = mkdtempSync(join(tmpdir(), "nodex-distribution-"));
    const state = join(temp, "snapshot.json");
    const asset = "Nodex-latest-arm64.dmg";
    const before = snapshotOf([stable({ [asset]: 2 })]);
    const releases = [stable({ [asset]: 5 })];
    const report = vi.fn<typeof fetch>();
    const request: typeof fetch = (url, options) =>
      String(url).startsWith("https://api.github.com/")
        ? Promise.resolve(Response.json(releases))
        : report(url, options);
    try {
      writeFileSync(state, JSON.stringify(before));
      expect(await reportDistribution({ state, dryRun: true }, request)).toMatchObject({
        baseline: false,
        deltas: [{ downloads: 3 }],
        sent: false,
      });
      expect(report).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(state, "utf8"))).toEqual(before);

      report.mockResolvedValueOnce(new Response(null, { status: 503 }));
      await expect(reportDistribution({ state, dryRun: false }, request)).rejects.toThrow(
        "Statsig returned 503",
      );
      expect(JSON.parse(readFileSync(state, "utf8"))).toEqual(before);

      report.mockResolvedValueOnce(new Response(null, { status: 200 }));
      expect(await reportDistribution({ state, dryRun: false }, request)).toMatchObject({
        deltas: [{ downloads: 3 }],
        sent: true,
      });
      expect(JSON.parse(readFileSync(state, "utf8"))).toEqual(snapshotOf(releases));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("rejects an invalid restored snapshot before reporting", async () => {
    const temp = mkdtempSync(join(tmpdir(), "nodex-distribution-"));
    const state = join(temp, "snapshot.json");
    const request = vi.fn<typeof fetch>();
    try {
      const invalid = '{"v1.0.0/Nodex-latest-arm64.dmg":"2"}';
      writeFileSync(state, invalid);
      await expect(reportDistribution({ state, dryRun: false }, request)).rejects.toThrow(
        "Invalid distribution snapshot",
      );
      expect(request).not.toHaveBeenCalled();
      expect(readFileSync(state, "utf8")).toBe(invalid);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("snapshots only counted assets", () => {
    expect(snapshotOf([stable({ "Nodex-latest-arm64.dmg": 2, SHA256SUMS: 9 })])).toEqual({
      "v1.0.0/Nodex-latest-arm64.dmg": 2,
    });
  });

  test("reads update feed requests from their paths", () => {
    expect(
      feedRequestsFromPaths([
        { count: 40, dimensions: { clientRequestPath: "/updates/stable/arm64/appcast.xml" } },
        { count: 2, dimensions: { clientRequestPath: "/updates/other.txt" } },
      ]),
    ).toEqual([{ channel: "stable", platform: "arm64", requests: 40 }]);
  });

  test("checks yesterday in UTC and recognizes zero appcasts when host traffic is available", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: { viewer: { zones: [{ appcasts: [], hostTraffic: [{ count: 20 }] }] } },
      }),
    );
    const now = Date.parse("2026-11-16T23:30:00Z");
    expect(await readFeedRequests("example-token", now, request)).toEqual({
      feed: [],
      feedStatus: "zero",
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).variables).toMatchObject({
      start: "2026-11-15T00:00:00.000Z",
      end: "2026-11-16T00:00:00.000Z",
    });
  });

  test.each([
    ["no zone", Response.json({ data: { viewer: { zones: [] } } }), "no analytics dataset"],
    [
      "no host traffic",
      Response.json({ data: { viewer: { zones: [{ appcasts: [], hostTraffic: [] }] } } }),
      "no nodex.jyu.app traffic",
    ],
    [
      "Cloudflare authorization failure",
      Response.json({ errors: [{ message: "Zone Analytics Read is required" }] }),
      "Zone Analytics Read is required",
    ],
    ["HTTP failure", new Response("Service unavailable", { status: 503 }), "HTTP 503"],
  ])("shows feed data as unavailable for %s", async (_case, response, reason) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await readFeedRequests("example-token", Date.now(), request)).toMatchObject({
      feed: [],
      feedStatus: "unavailable",
      feedSkipped: expect.stringContaining(reason),
    });
  });

  test("reports matching appcasts returned by Cloudflare", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          viewer: {
            zones: [
              {
                appcasts: [
                  {
                    count: 4,
                    dimensions: { clientRequestPath: "/updates/nightly/windows-arm64/appcast.xml" },
                  },
                ],
                hostTraffic: [{ count: 20 }],
              },
            ],
          },
        },
      }),
    );
    expect(await readFeedRequests("example-token", Date.now(), request)).toEqual({
      feed: [{ channel: "nightly", platform: "windows-arm64", requests: 4 }],
      feedStatus: "reported",
    });
  });

  test("distribution events never count as an active installation", () => {
    const body = statsigDistributionBody({
      deltas: [{ channel: "stable", platform: "macos-arm64", kind: "update", downloads: 3 }],
      feed: [{ channel: "stable", platform: "arm64", requests: 7 }],
      time: 1,
    });
    expect(body.user).not.toHaveProperty("userID");
    expect(body.events.map((event) => [event.eventName, event.value])).toEqual([
      ["distribution_downloads", 3],
      ["update_feed_requests", 7],
    ]);
  });
});

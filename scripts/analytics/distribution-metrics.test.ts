import { describe, expect, test } from "vite-plus/test";
import {
  classifyAsset,
  downloadDeltas,
  feedRequestsFromPaths,
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

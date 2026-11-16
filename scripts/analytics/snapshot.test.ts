import { describe, expect, it } from "vitest";
import {
  aggregateGitHubDays,
  aggregateStatsig,
  DAY_MS,
  snapshotWindow,
  type SnapshotEvent,
} from "./snapshot-aggregation";
import { collectStatsigEvents } from "./snapshot-statsig";

const now = Date.parse("2026-11-17T06:30:00+08:00");
const window = snapshotWindow(now, 2);
const event = (
  name: SnapshotEvent["name"],
  at: string,
  fields: SnapshotEvent["fields"] = {},
  installationId: string | null = null,
  value: number | null = null,
): SnapshotEvent => ({ name, time: Date.parse(at), fields, installationId, value });

describe("daily snapshot", () => {
  it("uses completed UTC days and the current partial day across local midnight", () => {
    expect(window.days).toEqual([
      { date: "2026-11-14", partial: false },
      { date: "2026-11-15", partial: false },
      { date: "2026-11-16", partial: true },
    ]);
  });

  it("groups anonymous views and clicks, counting sources other than internal as entrances", () => {
    const { website, product } = aggregateStatsig(
      [
        event("landing_viewed", "2026-11-14T00:00:00Z", { page: "/", source: "GitHub" }),
        event("landing_viewed", "2026-11-14T01:00:00Z", { page: "/download/", source: "internal" }),
        event("landing_viewed", "2026-11-14T02:00:00Z", { page: "/" }),
        event("landing_viewed", "2026-11-13T23:59:59.999Z", { page: "/" }),
        event("landing_viewed", "2026-11-16T22:31:00Z", { page: "/" }),
        event("landing_download_clicked", "2026-11-14T02:03:00Z", {
          target: "mac-arm64",
          source: "github",
        }),
        event("landing_download_clicked", "2026-11-14T02:04:00Z", { target: "mac-arm64" }),
        event("landing_download_clicked", "2026-11-14T02:05:00Z", { target: "homebrew" }),
      ],
      window,
      new Set(),
    );

    expect(website[0]).toEqual({
      date: "2026-11-14",
      landingViews: 3,
      entrances: 2,
      viewsByPage: { "/": 2, "/download/": 1 },
      viewsBySource: { github: 1, internal: 1, unknown: 1 },
      downloadClicksByTarget: { "mac-arm64": 2, homebrew: 1 },
      downloadClicksBySource: { github: 1, unknown: 2 },
    });
    expect(website.map(({ landingViews }) => landingViews)).toEqual([3, 0, 0]);
    expect(product.installations).toEqual([]);
  });

  it("sums distribution values by dimension without counting rows as downloads", () => {
    const stableMac = { channel: "stable", platform: "mac-arm64", kind: "installer" };
    const { distribution } = aggregateStatsig(
      [
        event("distribution_downloads", "2026-11-14T02:00:00Z", stableMac, null, 6),
        event("distribution_downloads", "2026-11-14T02:00:01Z", stableMac, null, 4),
        event(
          "distribution_downloads",
          "2026-11-14T02:00:02Z",
          { ...stableMac, kind: "update" },
          null,
          2,
        ),
        event("update_feed_requests", "2026-11-14T02:00:00Z", { platform: "mac-arm64" }, null, 26),
      ],
      window,
      new Set(),
    );
    expect(distribution[0]).toEqual({
      date: "2026-11-14",
      downloads: [
        { ...stableMac, count: 10 },
        { ...stableMac, kind: "update", count: 2 },
      ],
      updateFeedRequests: [{ channel: "unknown", platform: "mac-arm64", count: 26 }],
    });
  });

  it("uses prior installation history for returns and excludes self from every external count", () => {
    const { product } = aggregateStatsig(
      [
        event("app_launched", "2026-11-16T11:00:00Z", { appVersion: "2" }, "external"),
        event("app_active", "2026-11-16T10:00:00Z", {}, "external"),
        event(
          "installation_created",
          "2026-11-14T01:00:00Z",
          { profile: "new", appVersion: "1", os: "win32", channel: "stable" },
          "external",
        ),
        event("app_active", "2026-11-14T02:00:00Z", {}, "external"),
        event("app_active", "2026-11-14T13:00:00Z", {}, "external"),
        event("thread_started", "2026-11-14T02:01:00Z", {}, "external"),
        event("turn_completed", "2026-11-14T02:03:00Z", {}, "external"),
        event("turn_completed", "2026-11-14T02:04:00Z", {}, "external"),
        event("installation_created", "2026-11-12T01:00:00Z", { profile: "existing" }, "older"),
        event("app_active", "2026-11-14T05:00:00Z", {}, "older"),
        event("turn_completed", "2026-11-12T04:00:00Z", {}, "older"),
        event("app_active", "2026-11-15T05:00:00Z", {}, "creation-unknown"),
        event("app_active", "2026-11-16T05:00:00Z", {}, "creation-unknown"),
        event("installation_created", "2026-11-14T00:10:00Z", { profile: "new" }, "self"),
        event("app_active", "2026-11-15T02:00:00Z", {}, "self"),
        event("turn_completed", "2026-11-15T02:03:00Z", {}, "self"),
        event("installation_created", "2026-11-12T00:00:00Z", { profile: "new" }, "history-only"),
      ],
      window,
      new Set(["self"]),
    );

    expect(product.installations.find(({ id }) => id === "external")).toEqual({
      id: "external",
      firstSeen: { date: "2026-11-14", profile: "new" },
      self: false,
      activeDays: ["2026-11-14", "2026-11-16"],
      threadsStarted: 1,
      turnsCompleted: 2,
      latest: { appVersion: "2", os: "win32", channel: "stable" },
    });
    expect(product.installations.find(({ id }) => id === "older")?.turnsCompleted).toBe(0);
    expect(product.installations.find(({ id }) => id === "creation-unknown")?.firstSeen).toBeNull();
    expect(product.installations.find(({ id }) => id === "self")?.self).toBe(true);
    expect(product.installations.map(({ id }) => id)).not.toContain("history-only");
    expect(product.external).toEqual([
      {
        date: "2026-11-14",
        newInstalls: 1,
        activeInstalls: 2,
        activatedInstalls: 1,
        returningInstalls: 1,
      },
      {
        date: "2026-11-15",
        newInstalls: 0,
        activeInstalls: 1,
        activatedInstalls: 0,
        returningInstalls: 0,
      },
      {
        date: "2026-11-16",
        newInstalls: 0,
        activeInstalls: 2,
        activatedInstalls: 0,
        returningInstalls: 2,
      },
    ]);
  });

  it("reports stars by UTC date and distinguishes absent GitHub traffic from measured zero", () => {
    const first = { login: "first", starred_at: "2026-11-14T00:00:00Z" };
    const second = { login: "second", starred_at: "2026-11-16T01:00:00Z" };
    const result = aggregateGitHubDays(
      window,
      [second, first, { login: "earlier", starred_at: "2026-11-13T23:59:59Z" }],
      [{ timestamp: "2026-11-14T00:00:00Z", count: 0, uniques: 0 }],
      [],
    );
    expect(result).toEqual({
      newStargazers: [first, second],
      daily: [
        { date: "2026-11-14", stars: 1, views: { count: 0, uniques: 0 }, clones: null },
        { date: "2026-11-15", stars: 0, views: null, clones: null },
        { date: "2026-11-16", stars: 1, views: null, clones: null },
      ],
    });
    expect(aggregateGitHubDays(window, null, [], []).daily[0]?.stars).toBeNull();
  });
});

const logRow = (id: string, name: SnapshotEvent["name"], fields: Record<string, string> = {}) => ({
  id,
  event_name: name,
  timestamp: "2026-11-14T01:00:00Z",
  user_id: "some-statsig-id",
  value: "",
  fields: { "user.statsigEnvironment.tier": "production", ...fields },
});

const logPage = (
  path: string,
  data: readonly ReturnType<typeof logRow>[],
  next: string | null,
) => ({
  status: 200,
  body: {
    data,
    columns: new URL(path, "https://example.com").searchParams.get("columns")?.split(","),
    pagination: { has_more: next !== null, next_cursor: next },
  },
});

describe("Statsig collection", () => {
  it("follows opaque cursors in bounded windows and counts each production event once", async () => {
    const install = logRow("install", "installation_created", {
      "user.appVersion": "0.5.7",
      "user.custom.os": "darwin",
      "user.custom.channel": "nightly",
      "metadata.profile": "existing",
    });
    const landing = logRow("landing", "landing_viewed");
    const development = logRow("dev", "landing_viewed", {
      "user.statsigEnvironment.tier": "development",
    });
    const starts: string[] = [];
    const get = async (path: string) => {
      const params = new URL(path, "https://example.com").searchParams;
      const start = params.get("start_ts")!;
      starts.push(start);
      expect(Number(params.get("end_ts")) - Number(start)).toBeLessThanOrEqual(7 * DAY_MS);
      if (Number(start) > window.start) return logPage(path, [landing], null);
      if (params.has("after")) {
        expect(params.get("after")).toBe("opaque+/=");
        return logPage(path, [install, landing], null);
      }
      return logPage(path, [install, development], "opaque+/=");
    };

    const { events, status } = await collectStatsigEvents(
      get,
      window.start,
      window.start + 8 * DAY_MS,
      ["installation_created", "landing_viewed"],
    );
    expect(starts).toEqual([
      String(window.start),
      String(window.start),
      String(window.start + 7 * DAY_MS),
    ]);
    expect(status).toEqual({ status: "ok" });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      name: "installation_created",
      installationId: "some-statsig-id",
      fields: { appVersion: "0.5.7", os: "darwin", channel: "nightly", profile: "existing" },
    });
    expect(events[1]).toMatchObject({ name: "landing_viewed", installationId: null });
  });

  it("keeps collected pages and flags a cursor that cannot advance", async () => {
    const get = async (path: string) => logPage(path, [logRow("x", "app_active")], "repeat");
    const result = await collectStatsigEvents(get, window.start, now, ["app_active"]);
    expect(result).toMatchObject({ collected: true, status: { truncated: true } });
    expect(result.status.status).toMatch(/pagination stopped/);
    expect(result.events).toHaveLength(1);
  });
});

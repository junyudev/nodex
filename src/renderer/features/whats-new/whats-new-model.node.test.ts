import { describe, expect, test } from "vite-plus/test";
import type { ChangelogRelease } from "../../../shared/changelog-feed";
import {
  advanceSeenVersion,
  compareReleaseVersions,
  newestReleaseVersion,
  releasesNewSince,
} from "./whats-new-model";

const release = (version: string): ChangelogRelease => ({
  version,
  date: "2026-11-24",
  url: `https://nodex.jyu.app/changelog/#v${version}`,
  headline: `Release ${version}`,
  sections: [{ kind: "added", entries: [{ lead: "Something.", detail: "" }] }],
});

describe("compareReleaseVersions", () => {
  test.each([
    ["0.5.12", "0.5.9", 1],
    ["0.5.9", "0.5.12", -1],
    ["1.0.0", "0.99.99", 1],
    ["0.5.12", "0.5.12", 0],
    ["0.6.0-beta.1", "0.6.0", -1],
    ["0.6.0", "0.6.0-beta.1", 1],
    ["0.6.0-beta.2", "0.6.0-beta.1", 1],
    ["0.6.0+build.7", "0.6.0", 0],
    ["0.5.1", "not-a-version", 1],
    ["not-a-version", "0.5.1", -1],
  ])("%s against %s is %i", (left, right, expected) => {
    expect(compareReleaseVersions(left, right)).toBe(expected);
  });
});

describe("what is new to the person", () => {
  const releases = [release("0.5.12"), release("0.5.11"), release("0.5.10")];

  test("the feed as first shown is the baseline", () => {
    expect([...releasesNewSince(releases, null)]).toEqual([]);
    expect(advanceSeenVersion(null, releases)).toBe("0.5.12");
  });

  test("releases after the last one seen are new", () => {
    expect([...releasesNewSince(releases, "0.5.10")]).toEqual(["0.5.12", "0.5.11"]);
    expect([...releasesNewSince(releases, "0.5.12")]).toEqual([]);
    expect(advanceSeenVersion("0.5.10", releases)).toBe("0.5.12");
  });

  test("what has been seen never moves back to an older release", () => {
    expect(advanceSeenVersion("0.6.0", releases)).toBe("0.6.0");
    expect(advanceSeenVersion("0.6.0", [])).toBe("0.6.0");
    expect(advanceSeenVersion(null, [])).toBeNull();
  });

  test("the newest release is found whatever the order", () => {
    expect(newestReleaseVersion([release("0.5.2"), release("0.5.10"), release("0.5.9")])).toBe(
      "0.5.10",
    );
  });
});

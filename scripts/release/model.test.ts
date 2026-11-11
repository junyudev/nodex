import { describe, expect, test } from "vite-plus/test";
import {
  buildVersionForMainlineOrdinal,
  compareBuildVersions,
  nightlyLabelFor,
  parseReleaseIdentity,
} from "./model";

const sha = "a".repeat(40);
const tree = "b".repeat(40);

describe("release versions", () => {
  test("nightly display version advances the source patch deterministically", () => {
    expect(nightlyLabelFor("0.2.1", "2026-08-13", 842)).toBe("0.2.1-nightly.20260813.842");
  });

  test.each([
    [842, "1.8.42"],
    [9_999, "1.99.99"],
    [10_000, "2.0.0"],
  ])("encodes mainline ordinal %i as monotonic Apple build version %s", (ordinal, expected) => {
    expect(buildVersionForMainlineOrdinal(ordinal)).toBe(expected);
  });

  test("compares Apple build versions numerically", () => {
    expect(compareBuildVersions("1.99.99", "2.0.0")).toBe(-1);
    expect(compareBuildVersions("2.0.1", "2.0.0")).toBe(1);
    expect(compareBuildVersions("2.0.0", "2.0.0")).toBe(0);
  });
});

describe("Release Identity", () => {
  test("accepts a coherent nightly identity", () => {
    expect(
      parseReleaseIdentity({
        schemaVersion: 1,
        channel: "nightly",
        sourceSha: sha,
        sourceTree: tree,
        version: "0.2.1",
        buildVersion: "1.8.42",
        tag: "v0.2.1-nightly.20260813.842",
        mainlineOrdinal: 842,
        sourceDate: "2026-08-13",
      }),
    ).toMatchObject({ channel: "nightly", version: "0.2.1" });
  });

  test("accepts a coherent stable identity", () => {
    expect(
      parseReleaseIdentity({
        schemaVersion: 1,
        channel: "stable",
        sourceSha: sha,
        sourceTree: tree,
        version: "0.2.1",
        buildVersion: "1.8.42",
        tag: "v0.2.1",
        mainlineOrdinal: 842,
        sourceDate: "2026-08-13",
      }),
    ).toMatchObject({ channel: "stable", version: "0.2.1" });
  });

  test.each([
    ["version", "0.2.2-nightly.20260813.841"],
    ["buildVersion", "1.8.41"],
    ["tag", "v0.2.2-nightly.20260813.841"],
    ["sourceDate", "2026-02-30"],
  ])("rejects an incoherent %s", (key, value) => {
    expect(() =>
      parseReleaseIdentity({
        schemaVersion: 1,
        channel: "nightly",
        sourceSha: sha,
        sourceTree: tree,
        version: "0.2.1",
        buildVersion: "1.8.42",
        tag: "v0.2.1-nightly.20260813.842",
        mainlineOrdinal: 842,
        sourceDate: "2026-08-13",
        [key]: value,
      }),
    ).toThrow();
  });

  test("rejects unknown keys instead of silently accepting schema drift", () => {
    expect(() =>
      parseReleaseIdentity({
        schemaVersion: 1,
        channel: "stable",
        sourceSha: sha,
        sourceTree: tree,
        version: "0.2.1",
        buildVersion: "1.8.42",
        tag: "v0.2.1",
        mainlineOrdinal: 842,
        sourceDate: "2026-08-13",
        extra: true,
      }),
    ).toThrow("unexpected or missing fields");
  });
});

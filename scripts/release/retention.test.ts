import { expect, test } from "vite-plus/test";
import { extractNightlyTagsFromAppcasts, planNightlyRetention } from "./retention";

const release = (
  id: number,
  tag: string,
  publishedAt: string,
  overrides: Partial<{ draft: boolean; immutable: boolean; prerelease: boolean }> = {},
) => ({
  draft: false,
  id,
  immutable: true,
  prerelease: true,
  published_at: publishedAt,
  tag_name: tag,
  ...overrides,
});

test("nightly retention requires age, verified immutable bytes, and no live feed reference", () => {
  const newest = "v0.2.2-nightly.20260818.5";
  const young = "v0.2.2-nightly.20260810.4";
  const protectedTag = "v0.2.2-nightly.20260720.3";
  const unverified = "v0.2.2-nightly.20260719.2";
  const deletable = "v0.2.2-nightly.20260718.1";
  const plan = planNightlyRetention(
    [
      release(1, newest, "2026-08-18T03:00:00Z"),
      release(2, "v0.2.2", "2026-08-17T03:00:00Z", { prerelease: false }),
      release(3, young, "2026-08-10T03:00:00Z"),
      release(4, protectedTag, "2026-07-20T03:00:00Z"),
      release(5, unverified, "2026-07-19T03:00:00Z", { immutable: false }),
      release(6, deletable, "2026-07-18T03:00:00Z"),
    ],
    {
      keepCount: 1,
      minAgeDays: 14,
      now: new Date("2026-08-18T04:00:00Z"),
      protectedTags: new Set([protectedTag]),
      verifiedTags: new Set([newest, young, protectedTag, deletable]),
    },
  );

  expect(plan.keep).toEqual([newest]);
  expect(plan.tooYoung).toEqual([young]);
  expect(plan.protected).toEqual([protectedTag]);
  expect(plan.skippedUnverified).toEqual([unverified]);
  expect(plan.delete).toEqual([{ id: 6, tag: deletable }]);
});

test("extracts only strict Nightly tags referenced by appcast enclosures", () => {
  expect([
    ...extractNightlyTagsFromAppcasts([
      '<enclosure url="https://github.com/NodexApp/Nodex/releases/download/v0.2.2-nightly.20260818.3/Nodex.tar.xz"/>',
      '<enclosure url="https://github.com/NodexApp/Nodex/releases/download/v0.2.2/Nodex.tar.xz"/>',
    ]),
  ]).toEqual(["v0.2.2-nightly.20260818.3"]);
});

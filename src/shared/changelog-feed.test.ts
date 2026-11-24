import { expect, test } from "vite-plus/test";
import { CHANGELOG_PAGE_URL, decodeChangelogFeed } from "./changelog-feed";

const entry = { lead: "Read **new** release notes.", detail: "" };
const section = { kind: "added", entries: [entry] };
const release = {
  version: "1.2.3-rc.1+build.2",
  date: "2028-02-29",
  url: `${CHANGELOG_PAGE_URL}#v1.2.3-rc.1+build.2`,
  headline: "Read new release notes",
  sections: [section],
};
const feed = { schemaVersion: 1, url: CHANGELOG_PAGE_URL, releases: [release] };

test("skips unknown sections and releases that have nothing to display", () => {
  const futureSection = { kind: "future", entries: { new: "shape" } };
  expect(
    decodeChangelogFeed({
      ...feed,
      releases: [
        { ...release, sections: [futureSection, section] },
        { ...release, version: "1.2.2", sections: [futureSection] },
        { ...release, version: "1.2.1", sections: [] },
      ],
    }),
  ).toEqual(feed);
});

test("accepts a headline up to 120 characters", () => {
  const value = { ...feed, releases: [{ ...release, headline: "x".repeat(120) }] };
  expect(decodeChangelogFeed(value)).toEqual(value);
});

test.each([
  { ...feed, schemaVersion: 2 },
  { ...feed, url: "http://nodex.jyu.app/changelog/" },
  { ...feed, releases: [{ ...release, version: "next" }] },
  { ...feed, releases: [{ ...release, date: "2026-02-29" }] },
  { ...feed, releases: [{ ...release, url: "javascript:alert(0)" }] },
  { ...feed, releases: [{ ...release, headline: "" }] },
  { ...feed, releases: [{ ...release, headline: "x".repeat(121) }] },
  { ...feed, releases: [{ ...release, headline: undefined, title: release.headline }] },
  { ...feed, releases: [{ ...release, sections: [{ ...section, entries: null }] }] },
  {
    ...feed,
    releases: [{ ...release, sections: [{ ...section, entries: Array(101).fill(entry) }] }],
  },
  { ...feed, releases: Array(51).fill(release) },
])("rejects invalid or oversized feed case %#", (value) => {
  expect(() => decodeChangelogFeed(value)).toThrow();
});

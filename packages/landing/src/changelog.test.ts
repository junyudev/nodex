import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { CHANGELOG_PAGE_URL, decodeChangelogFeed } from "../../../src/shared/changelog-feed";

import {
  changelogFeed,
  formatReleaseDate,
  inlineHtml,
  parseChangelog,
  releasesToShow,
  splitEntry,
} from "./changelog";

const sampleChangelog = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Added a public changelog page.

### Changed

## [0.1.2] - 2026-03-13

Safer, simpler releases

### Added
- Added release automation with \`bun run release\`.

### Fixed
- Fixed HTML-ish notes like <script>alert("x")</script>.

## [0.1.1] - 2026-03-12

Clearer release notes

### Fixed
- Fixed older release notes.
`;

test("parseChangelog keeps Unreleased first, without a version or date", () => {
  const releases = parseChangelog(sampleChangelog);

  expect(releases.length).toBe(3);
  expect(releases[0]?.label).toBe("Unreleased");
  expect(releases[0]?.date).toBe(null);
  expect(releases[0]?.version).toBe(null);
  expect(releases[0]?.headline).toBe(null);
});

test("parseChangelog renders dated releases with categories and bullets", () => {
  const releases = parseChangelog(sampleChangelog);
  const release = releases[1];

  expect(release?.label).toBe("v0.1.2");
  expect(release?.date).toBe("2026-03-13");
  expect(release?.headline).toBe("Safer, simpler releases");
  expect(release?.categories.length).toBe(2);
  expect(release?.categories[0]?.title).toBe("Added");
  expect(release?.categories[0]?.items[0]?.text).toBe(
    "Added release automation with `bun run release`.",
  );
});

test("parseChangelog drops categories without entries", () => {
  const unreleased = parseChangelog(sampleChangelog)[0];

  expect(unreleased?.categories.map((category) => category.title)).toEqual(["Added"]);
});

test("releasesToShow leaves out an Unreleased section that has no entries yet", () => {
  const releases = releasesToShow(`# Changelog

## [Unreleased]

### Added

### Fixed

## [0.5.0] - 2026-10-29

A more reliable Nodex

### Fixed
- Fixed a crash.
`);

  expect(releases.map((release) => release.label)).toEqual(["v0.5.0"]);
});

test("releasesToShow reads every release's kinds of change in one order", () => {
  const [release] = releasesToShow(`# Changelog

## [0.5.0] - 2026-10-29

A more reliable Nodex

### Fixed
- Fixed a crash.

### Security
- Patched a dependency.

### Added
- Added a feature.
`);

  expect(release?.categories.map((category) => category.title)).toEqual([
    "Added",
    "Fixed",
    "Security",
  ]);
});

test("changelogFeed limits dated releases in source order and keeps Markdown in the entries", () => {
  const feed = changelogFeed(
    `# Changelog

## [Unreleased]

### Fixed
- An unreleased fix.

## [1.2.3-rc.1+build.2] - 2026-03-13

More ways to configure Nodex

### Fixed
- Fixed an older bug.

### Added
- Use **bold**, *italics*, _emphasis_ and \`MY_SETTING\` with [the *guide*](https://example.com/path_(extra)). Read **more**.

## [1.2.2] - 2026-03-12

Work faster in Nodex

### Added
- Another feature.
`,
    { limit: 1 },
  );

  expect(feed).toEqual({
    schemaVersion: 1,
    url: CHANGELOG_PAGE_URL,
    releases: [
      {
        version: "1.2.3-rc.1+build.2",
        date: "2026-03-13",
        url: `${CHANGELOG_PAGE_URL}#v1.2.3-rc.1+build.2`,
        headline: "More ways to configure Nodex",
        sections: [
          {
            kind: "added",
            entries: [
              {
                lead: "Use **bold**, *italics*, _emphasis_ and `MY_SETTING` with [the *guide*](https://example.com/path_(extra)).",
                detail: "Read **more**.",
              },
            ],
          },
          { kind: "fixed", entries: [{ lead: "Fixed an older bug.", detail: "" }] },
        ],
      },
    ],
  });
});

test("requires a valid headline for each dated release", () => {
  const missing = sampleChangelog.replace("Safer, simpler releases\n\n", "");
  expect(() => parseChangelog(missing)).toThrow("Release 0.1.2 needs a headline");

  const invalid = sampleChangelog.replace("Safer, simpler releases", "# A formatted headline");
  expect(() => parseChangelog(invalid)).toThrow("Release 0.1.2 needs a headline");
});

test("reads an optional headline on Unreleased", () => {
  const withHeadline = sampleChangelog.replace(
    "## [Unreleased]\n\n",
    "## [Unreleased]\n\nA site for release notes\n\n",
  );
  expect(parseChangelog(withHeadline)[0]?.headline).toBe("A site for release notes");
});

test("still rejects stray prose within a category", () => {
  const invalid = sampleChangelog.replace("- Fixed older release notes.", "Stray prose");
  expect(() => parseChangelog(invalid)).toThrow("Unsupported changelog content");
});

test("the desktop decoder accepts the latest 12 releases from the root changelog", () => {
  const rootChangelog = readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
  const feed = changelogFeed(rootChangelog);
  expect(feed.releases).toHaveLength(12);
  expect(decodeChangelogFeed(feed)).toEqual(feed);
});

test("inlineHtml escapes text and renders code and strong spans", () => {
  expect(inlineHtml("Added release automation with `bun run release`.")).toBe(
    "Added release automation with <code>bun run release</code>.",
  );
  expect(inlineHtml("Open **Settings > Agents** & choose an agent.")).toBe(
    "Open <strong>Settings &gt; Agents</strong> &amp; choose an agent.",
  );
  expect(inlineHtml('Fixed HTML-ish notes like <script>alert("x")</script>.')).toBe(
    "Fixed HTML-ish notes like &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;.",
  );
});

test("inlineHtml preserves code spans that contain backticks", () => {
  expect(inlineHtml("Fixed default code export as ```` ```text ````.")).toBe(
    "Fixed default code export as <code>```text</code>.",
  );
});

test("splitEntry leads with the first sentence or the clause before a colon", () => {
  expect(splitEntry("Chats fork from the sidebar. The fork keeps its history.")).toEqual({
    lead: "Chats fork from the sidebar.",
    rest: "The fork keeps its history.",
  });
  expect(splitEntry("Files shows changes in place: pick a commit, then step through.")).toEqual({
    lead: "Files shows changes in place:",
    rest: "pick a commit, then step through.",
  });
  expect(splitEntry("One sentence with no detail after it.")).toEqual({
    lead: "One sentence with no detail after it.",
    rest: "",
  });
});

test("splitEntry never splits inside a code span", () => {
  expect(splitEntry("Run `vp run check. Then` again: it passes.")).toEqual({
    lead: "Run `vp run check. Then` again:",
    rest: "it passes.",
  });
});

test("splitEntry separates a sentence that opens with bold Markdown", () => {
  expect(
    splitEntry(
      "Use Nodex in Simplified Chinese. **Settings > General > Language** follows your system.",
    ),
  ).toEqual({
    lead: "Use Nodex in Simplified Chinese.",
    rest: "**Settings > General > Language** follows your system.",
  });
});

test("formatReleaseDate reads the same in every time zone", () => {
  expect(formatReleaseDate("2026-10-22")).toBe("Oct 22, 2026");
  expect(formatReleaseDate("2026-01-01")).toBe("Jan 1, 2026");
});

test("parseChangelog rejects malformed release headings", () => {
  let errorMessage = "";

  try {
    parseChangelog(`# Changelog

## [0.1.2]

### Added
- Added a note.
`);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  expect(errorMessage.includes("must include a YYYY-MM-DD date")).toBe(true);
});

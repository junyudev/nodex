import { expect, test } from "vite-plus/test";
import { CHANGELOG_PAGE_URL } from "../../../src/shared/changelog-feed";

import {
  changelogFeed,
  formatReleaseDate,
  inlineHtml,
  releasesToShow,
  splitEntry,
} from "./changelog";

const sampleChangelog = `# Changelog

The notes of every Nodex release, newest first. Changes that have not been released yet are files in [\`changes/\`](changes/).

## [0.1.2] - 2026-03-13

Safer, simpler releases

### Added

- Use **bold**, *italics*, _emphasis_ and \`MY_SETTING\` with [the *guide*](https://example.com/path_(extra)). Read **more**.

### Fixed

- Fixed an older bug.

## [0.1.1] - 2026-03-12

Clearer release notes

### Fixed

- Fixed older release notes.
`;

const sampleChanges = [
  {
    path: "changes/fixed/2026-03-15-editor.md",
    content: "Fixed a crash in the editor.\n",
  },
  {
    path: "changes/added/2026-03-14-public-page.md",
    content: `---\nmedia:\n  - caption: Read the changelog\n    light: ${"a".repeat(64)}.png\n---\n\nAdded a public changelog page.\n`,
  },
];

test("the page shows unreleased changes first, followed by every published release", () => {
  const releases = releasesToShow(sampleChangelog, sampleChanges);

  expect(releases.map(({ label }) => label)).toEqual(["Unreleased", "v0.1.2", "v0.1.1"]);
  expect(releases[0]).toEqual({
    label: "Unreleased",
    date: null,
    version: null,
    headline: null,
    categories: [
      { title: "Added", items: [{ text: "Added a public changelog page." }] },
      { title: "Fixed", items: [{ text: "Fixed a crash in the editor." }] },
    ],
  });
  expect(releases[1]).toMatchObject({
    date: "2026-03-13",
    version: "0.1.2",
    headline: "Safer, simpler releases",
  });
  expect(releases[1]?.categories.map(({ title }) => title)).toEqual(["Added", "Fixed"]);
});

test("the page leaves out Unreleased when there are no change files", () => {
  const releases = releasesToShow(sampleChangelog, []);

  expect(releases.map(({ label }) => label)).toEqual(["v0.1.2", "v0.1.1"]);
});

test("changelogFeed limits published releases in source order and keeps Markdown in the entries", () => {
  expect(changelogFeed(sampleChangelog, { limit: 1 })).toEqual({
    schemaVersion: 1,
    url: CHANGELOG_PAGE_URL,
    releases: [
      {
        version: "0.1.2",
        date: "2026-03-13",
        url: `${CHANGELOG_PAGE_URL}#v0.1.2`,
        headline: "Safer, simpler releases",
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

import { describe, expect, test } from "vite-plus/test";
import {
  assertReleaseHeadline,
  formatChangelog,
  formatReleaseNotes,
  parseChangelog,
  parseReleaseNotes,
  readUnreleasedChanges,
  type PublishedRelease,
} from "./changelog";

const change = (path: string, content = "An entry.\n") => ({ path: `changes/${path}`, content });

describe("changes not released yet", () => {
  test("group by kind in release order and read in file-name order", () => {
    expect(
      readUnreleasedChanges([
        { path: "changes/README.md", content: "# How to write a change\n\n- Not an entry.\n" },
        change("fixed/2026-11-25-later.md", "Fixed later.\n"),
        change("fixed/2026-11-24-earlier.md", "Fixed earlier.\n"),
        change("added/2026-11-26-feature.md", "Added a **feature**.\n"),
      ]),
    ).toEqual([
      { kind: "added", entries: ["Added a **feature**."] },
      { kind: "fixed", entries: ["Fixed earlier.", "Fixed later."] },
    ]);
    expect(readUnreleasedChanges([])).toEqual([]);
  });

  test("a wrapped paragraph reads as one entry", () => {
    expect(
      readUnreleasedChanges([
        change("changed/2026-11-24-wrapped.md", "\r\nOne sentence\r\n  that wraps.  \r\n\r\n"),
      ]),
    ).toEqual([{ kind: "changed", entries: ["One sentence that wraps."] }]);
  });

  test.each([
    "changes/fixed.md",
    "changes/fixes/2026-11-24-typo.md",
    "changes/fixed/2026-02-30-impossible-day.md",
    "changes/fixed/2026-13-01-impossible-month.md",
    "changes/fixed/2026-11-24-Upper-Case.md",
    "changes/fixed/2026-11-24-under_score.md",
    "changes/fixed/2026-11-24-.md",
    "changes/fixed/2026-11-24-entry.txt",
    "changes/fixed/nested/2026-11-24-entry.md",
    "changes/notes.md",
  ])("%s is not a change", (path) => {
    expect(() => readUnreleasedChanges([{ path, content: "An entry.\n" }])).toThrow(
      /is not a change.*changes\/README\.md/su,
    );
  });

  test.each([
    ["an empty file", " \n\n", "is empty"],
    ["two paragraphs", "First.\n\nSecond.\n", "one paragraph"],
    ["a list marker", "- An entry.\n", "list marker"],
    ["a nested list", "An entry.\n* Another.\n", "list marker"],
    ["a heading", "### Fixed\nAn entry.\n", "heading"],
    ["HTML", "<details>An entry.</details>\n", "HTML"],
  ])("a change holding %s is turned away", (_, content, message) => {
    expect(() => readUnreleasedChanges([change("fixed/2026-11-24-entry.md", content)])).toThrow(
      message,
    );
  });
});

describe("release notes", () => {
  const notes = {
    headline: "Release notes people read",
    sections: [
      { kind: "added", entries: ["Added `code` and **strong** text."] },
      { kind: "fixed", entries: ["Fixed one.", "Fixed two."] },
    ],
  } as const;
  const markdown =
    "Release notes people read\n\n### Added\n\n- Added `code` and **strong** text.\n\n### Fixed\n\n- Fixed one.\n- Fixed two.\n";

  test("lead with the headline and list each kind of change", () => {
    expect(formatReleaseNotes(notes)).toBe(markdown);
    expect(parseReleaseNotes(markdown, "Release 1.0.0")).toEqual(notes);
  });

  test("read the same however a host stored line endings and blank lines", () => {
    const stored = `\r\n${markdown.replaceAll("\n", "\r\n").replace("- Fixed one.", "\r\n- Fixed one.").trimEnd()}`;
    expect(parseReleaseNotes(stored, "Release 1.0.0")).toEqual(notes);
  });

  test.each([
    ["no headline", "### Added\n\n- Added.\n", "needs a headline"],
    ["two headline lines", "Headline\nMore\n\n### Added\n\n- Added.\n", "only its headline"],
    ["no entries", "Headline\n\n### Added\n", "empty Added"],
    ["nothing at all", "Headline\n", "has no entries"],
    ["an unknown section", "Headline\n\n### Improved\n\n- Better.\n", "unknown section"],
    [
      "sections out of order",
      "Headline\n\n### Fixed\n\n- A.\n\n### Added\n\n- B.\n",
      "in the order",
    ],
    ["a repeated section", "Headline\n\n### Fixed\n\n- A.\n\n### Fixed\n\n- B.\n", "once"],
    ["a continuation line", "Headline\n\n### Fixed\n\n- A.\n  More.\n", "one-line entries"],
  ])("notes with %s are turned away", (_, value, message) => {
    expect(() => parseReleaseNotes(value, "Release 1.0.0")).toThrow(message);
  });

  test.each([
    "Plugin tools for Claude Code and ACP",
    "x".repeat(48),
    "Ready?",
    "Ready!",
    "See Settings > Agents",
    "Use MY_SETTING",
  ])("allows the plain headline %j", (headline) => {
    expect(assertReleaseHeadline(headline, "Release 1.0.0")).toBe(headline);
  });

  test.each([
    "",
    "x".repeat(49),
    "Wrapped\nheadline",
    "Trailing space ",
    " Leading space",
    "Closing period.",
    "Open `Settings`",
    "Use *emphasis*",
    "Use _emphasis_",
    "__Open Settings__",
    "Read [the guide](https://example.test)",
    "Read ~~old news~~",
    "Open <em>Settings</em>",
    "# Heading",
    "- Bullet",
    "1. List item",
    "> Quote",
  ])("turns away the headline %j", (headline) => {
    expect(() => assertReleaseHeadline(headline, "Release 1.0.0")).toThrow(
      /Release 1\.0\.0 needs a headline: .*at most 48 characters/u,
    );
  });
});

describe("CHANGELOG.md", () => {
  const releases: readonly PublishedRelease[] = [
    {
      version: "1.0.10",
      date: "2026-11-24",
      headline: "Newest release",
      sections: [{ kind: "fixed", entries: ["Fixed a thing."] }],
    },
    {
      version: "1.0.9",
      date: "2026-11-20",
      headline: "Older release",
      sections: [
        { kind: "added", entries: ["Added a thing."] },
        { kind: "security", entries: ["Closed a hole."] },
      ],
    },
  ];
  const changelog = formatChangelog(releases);

  test("lists published releases newest first and reads back exactly", () => {
    expect(changelog).toBe(`# Changelog

The notes of every Nodex release, newest first. Changes that have not been released yet are files in [\`changes/\`](changes/).

## [1.0.10] - 2026-11-24

Newest release

### Fixed

- Fixed a thing.

## [1.0.9] - 2026-11-20

Older release

### Added

- Added a thing.

### Security

- Closed a hole.
`);
    expect(parseChangelog(changelog)).toEqual(releases);
    expect(parseChangelog(changelog.replaceAll("\n", "\r\n"))).toEqual(releases);
  });

  test("turns away an Unreleased section and points to changes/", () => {
    const withUnreleased = changelog.replace(
      "## [1.0.10]",
      "## [Unreleased]\n\n### Added\n\n- New.\n\n## [1.0.10]",
    );
    expect(() => parseChangelog(withUnreleased)).toThrow(/published releases only.*changes\//su);
  });

  test.each([
    [
      "a blank line between entries",
      (value: string) => value.replace("- Added a thing.", "- Added a thing.\n"),
    ],
    ["an edited preamble", (value: string) => value.replace("newest first", "latest first")],
    ["a trailing blank line", (value: string) => `${value}\n`],
  ])("turns away %s, which release automation never writes", (_, edit) => {
    expect(() => parseChangelog(edit(changelog))).toThrow("form release automation writes");
  });

  test.each([
    ["a heading without a date", "## [1.0.11]"],
    ["an impossible date", "## [1.0.11] - 2026-02-30"],
    ["a prerelease version", "## [1.0.11-rc.1] - 2026-11-25"],
  ])("turns away %s", (_, heading) => {
    expect(() =>
      parseChangelog(
        changelog.replace(
          "## [1.0.10]",
          `${heading}\n\nHeadline\n\n### Fixed\n\n- A.\n\n## [1.0.10]`,
        ),
      ),
    ).toThrow("names no published release");
  });

  test("requires releases newest first", () => {
    expect(() => formatChangelog([...releases].reverse())).toThrow("newest first");
    expect(() => formatChangelog([releases[0]!, releases[0]!])).toThrow("newest first");
  });
});

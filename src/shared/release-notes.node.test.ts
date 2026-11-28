import { expect, test, describe } from "vite-plus/test";
import { readUnreleasedChangesWithMedia } from "./change-media";
import { CHANGELOG_PAGE_URL, decodeChangelogFeed } from "./changelog-feed";
import { changelogInlineTokens } from "./changelog-inline";
import { mediaUrl } from "./release-media";
import {
  assertReleaseHeadline,
  formatChangelog,
  formatReleaseNotes,
  parseChangelog,
  parseReleaseNotes,
  readUnreleasedChanges,
  type PublishedRelease,
} from "./changelog";

describe("changelog feed", () => {
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
  const permalink = `${CHANGELOG_PAGE_URL}v1.2.3/example/`;
  const image = { src: mediaUrl(`${"a".repeat(64)}.1600w.webp`), width: 1600, height: 900 };
  const picture = { caption: "New release notes", light: image };
  const withEntries = (entries: readonly unknown[]) => ({
    ...feed,
    releases: [{ ...release, sections: [{ ...section, entries }] }],
  });

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

  test.each(
    [
      [{ ...picture, light: { ...image, src: "https://media.nodex.jyu.app.evil.test/capture" } }],
      [{ ...picture, light: { ...image, src: "https://media.nodex.jyu.app:8443/capture" } }],
      [{ ...picture, light: { ...image, src: "http://media.nodex.jyu.app/capture" } }],
      [{ ...picture, light: { ...image, src: "https://user@media.nodex.jyu.app/capture" } }],
      [{ ...picture, light: { ...image, height: 12.5 } }],
      [{ ...picture, light: { ...image, width: 16_384 } }],
      [{ caption: picture.caption }],
      [{ ...picture, caption: " " }],
      [picture, picture, picture, picture, picture],
    ].map((media) => [media] as const),
  )(
    "drops malformed entry media without dropping its permalink, neighbors or release %#",
    (media) => {
      const valid = { ...entry, url: permalink, media: [picture] };
      const textAndUrl = { ...entry, url: permalink };
      expect(decodeChangelogFeed(withEntries([{ ...textAndUrl, media }, valid]))).toStrictEqual(
        withEntries([textAndUrl, valid]),
      );
    },
  );

  test("drops a permalink outside the website while keeping valid media", () => {
    const illustrated = { ...entry, media: [picture] };
    expect(
      decodeChangelogFeed(withEntries([{ ...illustrated, url: "https://other.test/changelog/" }])),
    ).toStrictEqual(withEntries([illustrated]));
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
});

describe("changelogInlineTokens", () => {
  test("keeps code spans and strong runs apart from text", () => {
    expect(
      changelogInlineTokens("**Settings > General > Language** follows `LANG` by default."),
    ).toEqual([
      { kind: "strong", text: "Settings > General > Language" },
      { kind: "text", text: " follows " },
      { kind: "code", text: "LANG" },
      { kind: "text", text: " by default." },
    ]);
  });

  test("a code span keeps asterisks and shorter backtick runs as code", () => {
    expect(changelogInlineTokens("Rename `` a`b `` and `NODEX_**`.")).toEqual([
      { kind: "text", text: "Rename " },
      { kind: "code", text: "a`b" },
      { kind: "text", text: " and " },
      { kind: "code", text: "NODEX_**" },
      { kind: "text", text: "." },
    ]);
  });

  test("unmatched markers stay as written", () => {
    expect(changelogInlineTokens("Use ** and ` freely")).toEqual([
      { kind: "text", text: "Use ** and ` freely" },
    ]);
  });
});

describe("changelog", () => {
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

    const light = `${"a".repeat(64)}.png`;
    const dark = `${"b".repeat(64)}.mp4`;
    const frontMatter = (yaml: string) => `---\n${yaml}\n---\n\nAn entry.\n`;

    test("reads media and entry metadata in release order, with the same text as release notes", () => {
      const fixed = change("fixed/2026-11-24-no-media.md", "Fixed an issue.\n");
      const changed = change(
        "changed/2026-11-26-feature.md",
        frontMatter(
          `media:\n  - caption: See both themes\n    light: ${light}\n    dark: ${dark}\n  - caption: See the result\n    dark: ${"c".repeat(64)}.png`,
        ).replaceAll("\n", "\r\n"),
      );
      const files = [fixed, changed];
      expect(readUnreleasedChangesWithMedia(files)).toEqual([
        {
          kind: "changed",
          date: "2026-11-26",
          slug: "feature",
          path: changed.path,
          entry: "An entry.",
          media: [
            { caption: "See both themes", light, dark },
            { caption: "See the result", dark: `${"c".repeat(64)}.png` },
          ],
        },
        {
          kind: "fixed",
          date: "2026-11-24",
          slug: "no-media",
          path: fixed.path,
          entry: "Fixed an issue.",
          media: [],
        },
      ]);
      expect(readUnreleasedChanges(files)).toEqual([
        { kind: "changed", entries: ["An entry."] },
        { kind: "fixed", entries: ["Fixed an issue."] },
      ]);
    });

    test("requires unique slugs across kinds and dates", () => {
      const files = [change("added/2026-11-24-setup.md"), change("fixed/2026-11-26-setup.md")];
      const duplicate =
        /changes\/fixed\/2026-11-26-setup\.md.*same slug "setup".*changes\/added\/2026-11-24-setup\.md.*changes\/README\.md/u;
      expect(() => readUnreleasedChanges(files)).toThrow(duplicate);
      expect(() => readUnreleasedChangesWithMedia(files)).toThrow(duplicate);
    });

    test("opens and closes front matter on exact delimiter lines", () => {
      expect(
        readUnreleasedChanges([change("fixed/2026-11-24-entry.md", "--- \nAn entry.\n")]),
      ).toEqual([{ kind: "fixed", entries: ["--- An entry."] }]);
      const file = change("fixed/2026-11-24-entry.md", "---\nmedia: []\n--- \nAn entry.\n");
      expect(() => readUnreleasedChangesWithMedia([file])).toThrow(
        /changes\/fixed\/2026-11-24-entry\.md.*needs a closing ---.*changes\/README\.md/u,
      );
    });

    test.each([
      ["empty front matter", "", "only front matter key"],
      ["unknown front matter key", "media: []\ntitle: Other", "only front matter key"],
      ["an empty list", "media: []", "at least one item"],
      ["a map instead of a list", "media: {}", "at least one item"],
      ["malformed YAML", "media: [", "valid YAML"],
      ["duplicate YAML keys", "media: []\nmedia: []", "unique keys"],
      [
        "unknown item key",
        `media: [{ caption: Sample, light: ${light}, alt: Something }]`,
        "only caption, light and dark",
      ],
      ["missing caption", `media: [{ light: ${light} }]`, "media caption"],
      ["no themes", "media: [{ caption: Sample }]", "light or dark file"],
      [
        "an explicit null theme",
        `media: [{ caption: Sample, light: ${light}, dark: null }]`,
        "dark media file",
      ],
      [
        "an uppercase hash",
        `media: [{ caption: Sample, light: ${light.toUpperCase()} }]`,
        "light media file",
      ],
      [
        "a non-media extension",
        `media: [{ caption: Sample, light: ${"a".repeat(64)}.gif }]`,
        "light media file",
      ],
      [
        "a duplicate in two themes",
        `media: [{ caption: Sample, light: ${light}, dark: ${light} }]`,
        "more than once",
      ],
      [
        "a duplicate in two items",
        `media: [{ caption: Sample, light: ${light} }, { caption: Other, dark: ${light} }]`,
        "more than once",
      ],
    ])("rejects %s in release media", (_, yaml, message) => {
      const file = change("added/2026-11-26-feature.md", frontMatter(yaml));
      expect(() => readUnreleasedChangesWithMedia([file])).toThrow(
        new RegExp(`^${file.path} .*?${message}.*? See changes/README\\.md\\.$`, "u"),
      );
    });

    test.each([
      " ",
      " Caption",
      "Caption ",
      "a".repeat(121),
      "First\nSecond",
      "**Strong**",
      "`code`",
      "[A link]",
      "<b>HTML</b>",
    ])("rejects a caption that is not one line of plain text: %j", (caption) => {
      const file = change(
        "added/2026-11-26-feature.md",
        frontMatter(`media: [{ caption: ${JSON.stringify(caption)}, light: ${light} }]`),
      );
      expect(() => readUnreleasedChangesWithMedia([file])).toThrow("media caption");
    });

    test("still requires one paragraph after front matter", () => {
      const file = change(
        "added/2026-11-26-feature.md",
        `${frontMatter(`media: [{ caption: Sample, light: ${light} }]`)}\nAnother paragraph.\n`,
      );
      expect(() => readUnreleasedChangesWithMedia([file])).toThrow("must hold one paragraph");
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
});

import { expect, test } from "vite-plus/test";
import { mergeReleaseMedia, parseReleaseMedia } from "../../../scripts/release/release-media";
import {
  readTaggedChanges,
  readUnreleasedChangesWithMedia,
} from "../../../src/shared/change-media";
import { parseChangelog } from "../../../src/shared/changelog";
import { mediaUrl } from "../../../src/shared/release-media";
import { CHANGELOG_PAGE_URL, decodeChangelogFeed } from "../../../src/shared/changelog-feed";

import {
  changelogFeed,
  formatReleaseDate,
  inlineHtml,
  permalinkEntries,
  releasesToShow,
  resolvePublishedMedia,
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

const published = parseChangelog(sampleChangelog);
const imageHash = "a".repeat(64);
const imageReference = `${imageHash}.png`;
const videoHash = "b".repeat(64);
const videoReference = `${videoHash}.mp4`;
const backfillReference = `${"c".repeat(64)}.png`;
const backfillYaml = (version = "0.1.2", slug = "guide") =>
  `"${version}":\n  ${slug}:\n    - caption: Look at the guide\n      dark: ${backfillReference}\n`;

const sampleChanges = [
  {
    path: "changes/fixed/2026-03-15-editor.md",
    content: "Fixed a crash in the editor.\n",
  },
  {
    path: "changes/added/2026-03-14-public-page.md",
    content: `---\nmedia:\n  - caption: Read the changelog\n    light: ${imageReference}\n---\n\nAdded a public changelog page.\n`,
  },
];

test("the page shows unreleased changes first, followed by every published release", () => {
  const releases = releasesToShow(published, readUnreleasedChangesWithMedia(sampleChanges));

  expect(releases.map(({ label }) => label)).toEqual(["Unreleased", "v0.1.2", "v0.1.1"]);
  expect(releases[0]).toEqual({
    label: "Unreleased",
    date: null,
    version: null,
    headline: null,
    categories: [
      { kind: "added", title: "Added", items: [{ text: "Added a public changelog page." }] },
      { kind: "fixed", title: "Fixed", items: [{ text: "Fixed a crash in the editor." }] },
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
  const releases = releasesToShow(published, []);

  expect(releases.map(({ label }) => label)).toEqual(["v0.1.2", "v0.1.1"]);
});

const taggedFiles = [
  {
    path: "changes/fixed/2026-03-13-older-bug.md",
    content: "Fixed an older bug.",
  },
  {
    path: "changes/added/2026-03-12-guide.md",
    content: `---\nmedia:\n  - caption: Explore the guide\n    light: ${imageReference}\n    dark: ${videoReference}\n---\n${published[0]!.sections[0]!.entries[0]}`,
  },
];

const imageDescription = {
  version: 1,
  type: "image",
  width: 1600,
  height: 900,
  bytes: 2000,
  variants: [
    { file: `${imageHash}.800w.webp`, width: 800, height: 450 },
    { file: `${imageHash}.1600w.webp`, width: 1600, height: 900 },
  ],
};

const videoDescription = {
  version: 1,
  type: "video",
  width: 1280,
  height: 720,
  bytes: 3000,
  variants: [],
  poster: { file: `${videoHash}.poster.webp`, width: 1280, height: 720 },
};

test("tagged entries carry their source slugs and both themes in changelog and permalink order", () => {
  const [recent, older] = published;
  const taggedChanges = new Map([
    [recent!.version, readTaggedChanges(recent!, taggedFiles)],
    [older!.version, readTaggedChanges(older!, [{ path: "changes/README.md", content: "Guide." }])],
  ]);
  const image = resolvePublishedMedia(imageReference, { value: imageDescription }, true);
  const video = resolvePublishedMedia(videoReference, { value: videoDescription }, true);
  if (!("file" in image) || !("file" in video)) throw new Error("Expected published media.");

  const releases = releasesToShow(published, readUnreleasedChangesWithMedia(sampleChanges), {
    taggedChanges,
    publishedMedia: new Map([
      [imageReference, image.file],
      [videoReference, video.file],
    ]),
  });
  const media = [
    {
      caption: "Explore the guide",
      light: {
        type: "image",
        width: 1600,
        height: 900,
        src: mediaUrl(imageReference),
        sources: [
          { url: mediaUrl(`${imageHash}.1600w.webp`), width: 1600, height: 900 },
          { url: mediaUrl(`${imageHash}.800w.webp`), width: 800, height: 450 },
        ],
      },
      dark: {
        type: "video",
        width: 1280,
        height: 720,
        src: mediaUrl(videoReference),
        sources: [],
        poster: mediaUrl(`${videoHash}.poster.webp`),
      },
    },
  ];
  expect(releases[1]?.categories[0]?.items).toEqual([
    { slug: "guide", text: recent!.sections[0]!.entries[0], media },
  ]);
  expect(releases[2]?.categories[0]?.items).toEqual([{ text: "Fixed older release notes." }]);
  expect(permalinkEntries(releases)).toEqual([
    {
      version: "0.1.2",
      date: "2026-03-13",
      kind: "added",
      slug: "guide",
      text: recent!.sections[0]!.entries[0],
      media,
    },
    {
      version: "0.1.2",
      date: "2026-03-13",
      kind: "fixed",
      slug: "older-bug",
      text: "Fixed an older bug.",
      media: [],
    },
  ]);
});

test("appends release media after tagged pictures without changing other entries", () => {
  const release = published[0]!;
  const tagged = readTaggedChanges(release, taggedFiles);
  const merged = mergeReleaseMedia(parseReleaseMedia(backfillYaml()), published, () => tagged);
  expect(merged.get(release.version)).toEqual(
    tagged.map((change) =>
      change.slug === "guide"
        ? {
            ...change,
            media: [...change.media, { caption: "Look at the guide", dark: backfillReference }],
          }
        : change,
    ),
  );
});

test.each([
  ["9.9.9", "guide", [], /v9\.9\.9.*not a published release/u],
  ["0.1.2", "guide", undefined, /needs change files at stable tag v0\.1\.2/u],
  ["0.1.2", "guide", [], /needs change files at stable tag v0\.1\.2/u],
  ["0.1.2", "unknown", taggedFiles, /unknown.*does not match a change slug at tag v0\.1\.2/u],
] as const)("rejects an invalid attachment target at v%s / %s", (version, slug, files, message) => {
  expect(() =>
    mergeReleaseMedia(
      parseReleaseMedia(backfillYaml(version, slug)),
      published,
      (release) => files && readTaggedChanges(release, files),
    ),
  ).toThrow(message);
});

test("refuses to attach tagged entries when the text or order differs from CHANGELOG.md", () => {
  const [recent] = published;
  const [fixed, added] = taggedFiles;
  const wrong = { ...fixed!, content: "Fixed a different bug." };
  expect(() => readTaggedChanges(recent!, [wrong, added!])).toThrow(
    /v0\.1\.2 do not match its sections in CHANGELOG\.md/u,
  );

  const more = { path: "changes/fixed/2026-03-12-more.md", content: "Fixed one more bug." };
  const reordered = {
    ...recent!,
    sections: [
      recent!.sections[0]!,
      {
        kind: "fixed" as const,
        entries: [fixed!.content, more.content],
      },
    ],
  };
  expect(() => readTaggedChanges(reordered, [fixed!, added!, more])).toThrow(/do not match/u);
});

test.each([
  { description: { error: "HTTP 404" }, reason: /HTTP 404/u },
  { description: { value: { ...imageDescription, width: 0 } }, reason: /whole-pixel width/u },
])(
  "a description failure warns locally and fails a deploy ($reason)",
  ({ description, reason }) => {
    expect(resolvePublishedMedia(imageReference, description, false)).toEqual({
      warning: expect.stringMatching(reason),
    });
    expect(() => resolvePublishedMedia(imageReference, description, true)).toThrow(reason);
  },
);

test("a missing media theme leaves the other theme and unavailable media leaves the entry", () => {
  const [recent] = published;
  const taggedChanges = new Map([[recent!.version, readTaggedChanges(recent!, taggedFiles)]]);
  const video = resolvePublishedMedia(videoReference, { value: videoDescription }, false);
  if (!("file" in video)) throw new Error("Expected published clip.");
  const releases = releasesToShow(published, [], {
    taggedChanges,
    publishedMedia: new Map([[videoReference, video.file]]),
  });

  expect(permalinkEntries(releases)[0]?.media).toEqual([
    { caption: "Explore the guide", dark: video.file },
  ]);
  expect(permalinkEntries(releasesToShow(published, [], { taggedChanges }))[0]).toMatchObject({
    slug: "guide",
    media: [],
  });
});

test("changelogFeed limits published releases in source order and keeps Markdown in the entries", () => {
  const releases = releasesToShow(published, readUnreleasedChangesWithMedia(sampleChanges));
  expect(changelogFeed(releases, { limit: 1 })).toEqual({
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

test("the feed uses tagged permalinks and the widest WebP dimensions while skipping videos", () => {
  const taggedChanges = mergeReleaseMedia(parseReleaseMedia(backfillYaml()), published, (release) =>
    readTaggedChanges(release, taggedFiles),
  );
  const image = resolvePublishedMedia(
    imageReference,
    {
      value: {
        ...imageDescription,
        height: 901,
        variants: [...imageDescription.variants].reverse(),
      },
    },
    true,
  );
  const video = resolvePublishedMedia(videoReference, { value: videoDescription }, true);
  const backfillHash = backfillReference.slice(0, -4);
  const backfillWebp = `${backfillHash}.640w.webp`;
  const backfill = resolvePublishedMedia(
    backfillReference,
    {
      value: {
        ...imageDescription,
        width: 640,
        height: 360,
        variants: [{ file: backfillWebp, width: 640, height: 360 }],
      },
    },
    true,
  );
  if (!("file" in image) || !("file" in video) || !("file" in backfill)) {
    throw new Error("Expected published media.");
  }
  const releases = releasesToShow(published, [], {
    taggedChanges,
    publishedMedia: new Map([
      [imageReference, image.file],
      [videoReference, video.file],
      [backfillReference, backfill.file],
    ]),
  });

  const feed = changelogFeed(releases);
  expect(decodeChangelogFeed(feed)).toStrictEqual(feed);
  expect(feed.releases[0]?.sections[0]?.entries[0]).toMatchObject({
    url: `${CHANGELOG_PAGE_URL}v0.1.2/guide/`,
    media: [
      {
        caption: "Explore the guide",
        light: { src: mediaUrl(`${imageHash}.1600w.webp`), width: 1600, height: 900 },
      },
      {
        caption: "Look at the guide",
        dark: { src: mediaUrl(backfillWebp), width: 640, height: 360 },
      },
    ],
  });
  expect(feed.releases[0]?.sections[0]?.entries[0]?.media?.[0]).not.toHaveProperty("dark");
  expect(feed.releases[0]?.sections[1]?.entries[0]).toStrictEqual({
    lead: "Fixed an older bug.",
    detail: "",
    url: `${CHANGELOG_PAGE_URL}v0.1.2/older-bug/`,
  });
  expect(feed.releases[1]?.sections[0]?.entries[0]).toStrictEqual({
    lead: "Fixed older release notes.",
    detail: "",
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

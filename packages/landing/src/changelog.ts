import {
  readUnreleasedChangesWithMedia,
  type ChangeMediaItem,
  type UnreleasedChange,
} from "../../../src/shared/change-media";
import {
  CHANGELOG_SECTION_KINDS,
  CHANGELOG_SECTION_TITLES,
  formatReleaseSections,
  groupChangeEntries,
  parseChangelog,
  type ChangelogSectionKind,
  type PublishedRelease,
  type RepositoryFile,
} from "../../../src/shared/changelog";
import { CHANGELOG_PAGE_URL, type ChangelogFeed } from "../../../src/shared/changelog-feed";
import { changelogInlineTokens } from "../../../src/shared/changelog-inline";
import { mediaUrl, parsePublishedMedia } from "../../../src/shared/release-media";

export type ShownMediaFile = {
  readonly type: "image" | "video";
  readonly width: number;
  readonly height: number;
  readonly src: string;
  readonly sources: readonly { readonly url: string; readonly width: number }[];
  readonly poster?: string;
};

export type ShownMedia = {
  readonly caption: string;
  readonly light?: ShownMediaFile;
  readonly dark?: ShownMediaFile;
};

/** An entry on the changelog page, with its inline Markdown intact. */
export type ChangelogItem = {
  text: string;
  slug?: string;
  media?: readonly ShownMedia[];
};

export type ChangelogCategory = {
  kind: ChangelogSectionKind;
  items: ChangelogItem[];
  title: string;
};

export type ChangelogRelease = {
  categories: ChangelogCategory[];
  date: string | null;
  headline: string | null;
  label: string;
  version: string | null;
};

export type ChangelogPermalinkEntry = {
  readonly version: string;
  readonly date: string;
  readonly kind: ChangelogSectionKind;
  readonly slug: string;
  readonly text: string;
  readonly media: readonly ShownMedia[];
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escapes entry text and renders the inline Markdown shared with the desktop. */
export function inlineHtml(value: string): string {
  return changelogInlineTokens(value)
    .map(({ kind, text }) => {
      const escaped = escapeHtml(text);
      return kind === "text" ? escaped : `<${kind}>${escaped}</${kind}>`;
    })
    .join("");
}

function countBacktickRun(value: string, start: number): number {
  let end = start;

  while (value[end] === "`") {
    end += 1;
  }

  return end - start;
}

function findMatchingBacktickRun(value: string, start: number, delimiterLength: number): number {
  let cursor = start;

  while (cursor < value.length) {
    const nextBacktick = value.indexOf("`", cursor);

    if (nextBacktick === -1) {
      return -1;
    }

    const nextDelimiterLength = countBacktickRun(value, nextBacktick);

    if (nextDelimiterLength === delimiterLength) {
      return nextBacktick;
    }

    cursor = nextBacktick + nextDelimiterLength;
  }

  return -1;
}

/** Entry text without its inline Markdown, for titles, descriptions and alt text. */
export function plainText(value: string): string {
  return changelogInlineTokens(value)
    .map(({ text }) => text)
    .join("");
}

/** The page of one published change. */
export const permalinkPath = (version: string, slug: string): string =>
  `/changelog/v${version}/${slug}/`;

/** Each kind of change keeps the color its status has in the app. */
export const CHANGE_TONE: Record<string, string> = {
  Added: "bg-status-done",
  Changed: "bg-status-doing",
  Deprecated: "bg-ink-3",
  Removed: "bg-status-review",
  Fixed: "bg-status-plan",
  Security: "bg-free",
};

/** Verifies the text and order before a tagged source can supply entry slugs or media. */
export function readTaggedChanges(
  release: PublishedRelease,
  files: readonly RepositoryFile[],
): readonly UnreleasedChange[] {
  const changes = readUnreleasedChangesWithMedia(files);
  if (changes.length === 0) return changes;

  const tag = `v${release.version}`;
  if (
    formatReleaseSections(groupChangeEntries(changes)) !== formatReleaseSections(release.sections)
  ) {
    throw new Error(
      `The change files at ${tag} do not match its sections in CHANGELOG.md. Check the release's entry text and order against the tag.`,
    );
  }
  return changes;
}

type MediaDescription = { readonly value: unknown } | { readonly error: string };
type MediaResolution = { readonly file: ShownMediaFile } | { readonly warning: string };

/** Converts a fetched description into display data, with the build's failure policy. */
export function resolvePublishedMedia(
  reference: string,
  description: MediaDescription,
  strict: boolean,
): MediaResolution {
  function unavailable(reason: string): MediaResolution {
    const message = `Cannot use published changelog media ${reference}: ${reason}`;
    if (strict) throw new Error(message);
    return { warning: message };
  }

  if ("error" in description) return unavailable(description.error);
  try {
    const { type, width, height, variants, poster } = parsePublishedMedia(
      description.value,
      reference,
    );
    return {
      file: {
        type,
        width,
        height,
        src: mediaUrl(reference),
        sources: variants
          .map(({ file, width }) => ({ url: mediaUrl(file), width }))
          .sort((left, right) => right.width - left.width),
        ...(poster ? { poster: mediaUrl(poster.file) } : {}),
      },
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

function showMedia(
  items: readonly ChangeMediaItem[],
  files: ReadonlyMap<string, ShownMediaFile>,
): ShownMedia[] {
  return items.flatMap(({ caption, light, dark }) => {
    const lightFile = light === undefined ? undefined : files.get(light);
    const darkFile = dark === undefined ? undefined : files.get(dark);
    if (!lightFile && !darkFile) return [];
    return [
      { caption, ...(lightFile && { light: lightFile }), ...(darkFile && { dark: darkFile }) },
    ];
  });
}

function toChangeCategories(
  changes: readonly UnreleasedChange[],
  mediaFiles: ReadonlyMap<string, ShownMediaFile>,
  includeSlugs: boolean,
): ChangelogCategory[] {
  return CHANGELOG_SECTION_KINDS.flatMap((kind) => {
    const items = changes
      .filter((change) => change.kind === kind)
      .map(({ entry, slug, media }): ChangelogItem => {
        const shown = showMedia(media, mediaFiles);
        return {
          text: entry,
          ...(includeSlugs && { slug }),
          ...(shown.length > 0 && { media: shown }),
        };
      });
    return items.length > 0 ? [{ kind, title: CHANGELOG_SECTION_TITLES[kind], items }] : [];
  });
}

/** Unreleased notes, if any, followed by every published release. */
export function releasesToShow(
  releases: readonly PublishedRelease[],
  unreleasedChanges: readonly UnreleasedChange[],
  {
    taggedChanges = new Map<string, readonly UnreleasedChange[]>(),
    publishedMedia = new Map<string, ShownMediaFile>(),
    localMedia = new Map<string, ShownMediaFile>(),
  }: {
    readonly taggedChanges?: ReadonlyMap<string, readonly UnreleasedChange[]>;
    readonly publishedMedia?: ReadonlyMap<string, ShownMediaFile>;
    readonly localMedia?: ReadonlyMap<string, ShownMediaFile>;
  } = {},
): ChangelogRelease[] {
  const unreleased = toChangeCategories(unreleasedChanges, localMedia, false);
  const published = releases.map(({ version, date, headline, sections }) => {
    const changes = taggedChanges.get(version);
    const categories = changes?.length
      ? toChangeCategories(changes, publishedMedia, true)
      : sections.map(({ kind, entries }) => ({
          kind,
          title: CHANGELOG_SECTION_TITLES[kind],
          items: entries.map((text) => ({ text })),
        }));
    return { version, date, headline, label: `v${version}`, categories };
  });
  if (unreleased.length === 0) return published;
  return [
    { label: "Unreleased", version: null, date: null, headline: null, categories: unreleased },
    ...published,
  ];
}

/** Every published entry with a slug, in changelog order, including entries without media. */
export function permalinkEntries(releases: readonly ChangelogRelease[]): ChangelogPermalinkEntry[] {
  return releases.flatMap(({ version, date, categories }) => {
    if (version === null || date === null) return [];
    return categories.flatMap(({ kind, items }) =>
      items.flatMap(({ slug, text, media = [] }) =>
        slug === undefined ? [] : [{ version, date, kind, slug, text, media }],
      ),
    );
  });
}

/** The latest published releases for Nodex's What's new. */
export function changelogFeed(
  content: string,
  { limit = 12 }: { readonly limit?: number } = {},
): ChangelogFeed {
  const releases = parseChangelog(content)
    .slice(0, limit)
    .map(({ version, date, headline, sections }) => ({
      version,
      date,
      url: `${CHANGELOG_PAGE_URL}#v${version}`,
      headline,
      sections: sections.map(({ kind, entries }) => ({
        kind,
        entries: entries.map((entry) => {
          const { lead, rest: detail } = splitEntry(entry);
          return { lead, detail };
        }),
      })),
    }));
  return { schemaVersion: 1, url: CHANGELOG_PAGE_URL, releases };
}

/**
 * Splits an entry after its first sentence or the clause before its first colon, so the page can
 * set that lead apart from the detail after it. Code spans are never split.
 */
export function splitEntry(text: string): { lead: string; rest: string } {
  let cursor = 0;

  while (cursor < text.length) {
    if (text[cursor] === "`") {
      const delimiterLength = countBacktickRun(text, cursor);
      const closingIndex = findMatchingBacktickRun(text, cursor + delimiterLength, delimiterLength);
      if (closingIndex === -1) break;
      cursor = closingIndex + delimiterLength;
      continue;
    }

    const character = text[cursor];
    const next = text[cursor + 2];
    const endsSentence =
      (character === "." || character === "!" || character === "?") &&
      text[cursor + 1] === " " &&
      next !== undefined &&
      /[A-Z`"“(*]/.test(next);
    const endsClause = character === ":" && text[cursor + 1] === " ";

    if (endsSentence || endsClause) {
      return { lead: text.slice(0, cursor + 1), rest: text.slice(cursor + 2) };
    }

    cursor += 1;
  }

  return { lead: text, rest: "" };
}

const releaseDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** A release's YYYY-MM-DD date as people read it, the same in every time zone. */
export function formatReleaseDate(date: string): string {
  return releaseDate.format(new Date(`${date}T00:00:00Z`));
}

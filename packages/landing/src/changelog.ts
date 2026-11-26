import { readChangeSections } from "../../../src/shared/change-media";
import {
  CHANGELOG_SECTION_TITLES,
  parseChangelog,
  type ReleaseNotesSection,
  type RepositoryFile,
} from "../../../src/shared/changelog";
import { CHANGELOG_PAGE_URL, type ChangelogFeed } from "../../../src/shared/changelog-feed";
import { changelogInlineTokens } from "../../../src/shared/changelog-inline";

/** An entry on the changelog page, with its inline Markdown intact. */
export type ChangelogItem = {
  text: string;
};

export type ChangelogCategory = {
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

/** Each kind of change keeps the color its status has in the app. */
export const CHANGE_TONE: Record<string, string> = {
  Added: "bg-status-done",
  Changed: "bg-status-doing",
  Deprecated: "bg-ink-3",
  Removed: "bg-status-review",
  Fixed: "bg-status-plan",
  Security: "bg-free",
};

function toCategories(sections: readonly ReleaseNotesSection[]): ChangelogCategory[] {
  return sections.map(({ kind, entries }) => ({
    title: CHANGELOG_SECTION_TITLES[kind],
    items: entries.map((text) => ({ text })),
  }));
}

/** Unreleased notes, if any, followed by every published release. */
export function releasesToShow(
  content: string,
  changeFiles: readonly RepositoryFile[],
): ChangelogRelease[] {
  const unreleased = toCategories(readChangeSections(changeFiles));
  const published = parseChangelog(content).map(({ version, date, headline, sections }) => ({
    version,
    date,
    headline,
    label: `v${version}`,
    categories: toCategories(sections),
  }));
  if (unreleased.length === 0) return published;
  return [
    { label: "Unreleased", version: null, date: null, headline: null, categories: unreleased },
    ...published,
  ];
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

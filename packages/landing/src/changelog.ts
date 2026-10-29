/**
 * The root CHANGELOG.md as data for the changelog page: releases in source order, Unreleased
 * first, each with its categories and entries. Entries keep their Markdown; the page renders their
 * code spans with `inlineHtml` and leads each one with its first sentence (`splitEntry`).
 */
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
  label: string;
  version: string | null;
};

const releaseHeadingPattern = /^## \[(?<label>[^\]]+)\](?: - (?<date>\d{4}-\d{2}-\d{2}))?$/;
const categoryHeadingPattern = /^### (?<title>.+)$/;

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** An entry's Markdown as HTML: text escaped, code spans kept. */
export function inlineHtml(value: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const openingIndex = value.indexOf("`", cursor);

    if (openingIndex === -1) {
      output += escapeHtml(value.slice(cursor));
      break;
    }

    output += escapeHtml(value.slice(cursor, openingIndex));

    const delimiterLength = countBacktickRun(value, openingIndex);
    const closingIndex = findMatchingBacktickRun(
      value,
      openingIndex + delimiterLength,
      delimiterLength,
    );

    if (closingIndex === -1) {
      output += escapeHtml(value.slice(openingIndex));
      break;
    }

    output += `<code>${escapeHtml(value.slice(openingIndex + delimiterLength, closingIndex))}</code>`;
    cursor = closingIndex + delimiterLength;
  }

  return output;
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

function readMeaningfulReleaseCategories(content: string, heading: string): ChangelogCategory[] {
  const categories: ChangelogCategory[] = [];
  let activeCategory: ChangelogCategory | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    const categoryHeading = line.match(categoryHeadingPattern);

    if (categoryHeading?.groups?.title) {
      activeCategory = {
        title: categoryHeading.groups.title.trim(),
        items: [],
      };
      categories.push(activeCategory);
      continue;
    }

    if (line.trim().length === 0) {
      continue;
    }

    if (!line.startsWith("- ")) {
      throw new Error(`Unsupported changelog content in ${heading}: "${line}".`);
    }

    if (!activeCategory) {
      throw new Error(`Changelog bullets must appear below a category heading in ${heading}.`);
    }

    activeCategory.items.push({
      text: line.slice(2).trim(),
    });
  }

  return categories.filter((category) => category.items.length > 0);
}

function parseReleaseHeading(
  heading: string,
): Pick<ChangelogRelease, "date" | "label" | "version"> {
  const match = heading.match(releaseHeadingPattern);
  const label = match?.groups?.label;
  const date = match?.groups?.date ?? null;

  if (!label) {
    throw new Error(`Unsupported changelog release heading: "${heading}".`);
  }

  if (label === "Unreleased") {
    if (date) {
      throw new Error("The Unreleased changelog section must not include a date.");
    }

    return {
      date: null,
      label: "Unreleased",
      version: null,
    };
  }

  if (!date) {
    throw new Error(`Release heading "${heading}" must include a YYYY-MM-DD date.`);
  }

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(label)) {
    throw new Error(`Release heading "${heading}" must use a semver version label.`);
  }

  return {
    date,
    label: `v${label}`,
    version: label,
  };
}

export function parseChangelog(content: string): ChangelogRelease[] {
  const normalizedContent = normalizeContent(content);
  const lines = normalizedContent.split("\n");
  const releaseSections: Array<{ bodyLines: string[]; heading: string }> = [];
  let activeSection: { bodyLines: string[]; heading: string } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.startsWith("## ")) {
      activeSection = {
        heading: line,
        bodyLines: [],
      };
      releaseSections.push(activeSection);
      continue;
    }

    if (line.startsWith("# ")) {
      continue;
    }

    if (!activeSection) {
      continue;
    }

    activeSection.bodyLines.push(line);
  }

  if (releaseSections.length === 0) {
    throw new Error("Unable to find any changelog release sections.");
  }

  return releaseSections.map((section) => {
    const release = parseReleaseHeading(section.heading);
    const categories = readMeaningfulReleaseCategories(
      section.bodyLines.join("\n"),
      section.heading,
    );

    return {
      ...release,
      categories,
    };
  });
}

/** Kinds of change in the order the changelog page reads them, whatever order a release uses. */
export const CHANGE_ORDER = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

/**
 * The releases the changelog page shows: each one with entries, in source order, its kinds of
 * change in CHANGE_ORDER. An Unreleased section with no entries yet is left out.
 */
export function releasesToShow(content: string): ChangelogRelease[] {
  const rank = (category: ChangelogCategory) => {
    const index = CHANGE_ORDER.indexOf(category.title);
    return index === -1 ? CHANGE_ORDER.length : index;
  };
  return parseChangelog(content)
    .filter((release) => release.categories.length > 0)
    .map((release) => ({
      ...release,
      categories: [...release.categories].sort((a, b) => rank(a) - rank(b)),
    }));
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
      /[A-Z`"“(]/.test(next);
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

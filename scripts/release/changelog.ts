import {
  readChangelogHeadline,
  splitChangelogReleaseBody,
} from "../../src/shared/changelog-headline";

const DEFAULT_UNRELEASED_CATEGORIES = ["### Added", "### Changed", "### Fixed"];
const RELEASE_HEADING = /^## \[(?<label>[^\]]+)\](?: - (?<date>\d{4}-\d{2}-\d{2}))?$/gmu;

const normalizeContent = (content: string): string => content.replace(/\r\n/g, "\n");
const trimTrailingWhitespace = (content: string): string => content.replace(/[ \t]+$/gm, "");

const hasMeaningfulReleaseNotes = (categories: string): boolean =>
  categories
    .split("\n")
    .map((line) => line.trim())
    .some((line) => /^[-*]\s+\S/u.test(line));

function releaseSections(content: string) {
  const headings = [...content.matchAll(RELEASE_HEADING)];
  return headings.map((heading, index) => {
    const start = heading.index;
    const end = headings[index + 1]?.index ?? content.length;
    return {
      label: heading.groups!.label,
      date: heading.groups!.date,
      body: content.slice(start + heading[0].length, end),
      start,
      end,
    };
  });
}

function unreleasedSection(sections: ReturnType<typeof releaseSections>) {
  const section = sections.find(({ label, date }) => label === "Unreleased" && !date);
  if (!section) throw new Error("Unable to find the Unreleased changelog section.");
  return section;
}

function nextVersionSections(content: string, version: string) {
  const sections = releaseSections(content);
  const unreleased = unreleasedSection(sections);
  if (sections.some(({ label, date }) => label === version && date)) {
    throw new Error(`Source version ${version} already has a dated changelog section.`);
  }
  return { sections, unreleased };
}

function categoryBlocks(categories: string) {
  return trimTrailingWhitespace(categories)
    .split(/(?=^### )/m)
    .filter(Boolean)
    .map((section) => {
      const newline = section.indexOf("\n");
      return newline === -1
        ? { heading: section, body: "" }
        : { heading: section.slice(0, newline), body: section.slice(newline + 1).trim() };
    });
}

export function extractReleaseNotes(changelogContent: string, version: string): string {
  const section = releaseSections(normalizeContent(changelogContent)).find(
    ({ label, date }) => label === version && date,
  );
  if (!section) throw new Error(`Unable to find the changelog section for release ${version}.`);
  const { beforeCategories, categories } = splitChangelogReleaseBody(section.body);
  const headline = readChangelogHeadline(beforeCategories, version);
  if (!hasMeaningfulReleaseNotes(categories)) {
    throw new Error(`Release ${version} does not contain any changelog notes.`);
  }
  return `${headline}\n\n${trimTrailingWhitespace(categories).trim()}\n`;
}

export function validateNextVersionChangelog(content: string, version: string): void {
  const { sections } = nextVersionSections(normalizeContent(content), version);
  for (const { body, label, date } of sections) {
    if (date || label === "Unreleased") {
      const { beforeCategories } = splitChangelogReleaseBody(body);
      readChangelogHeadline(beforeCategories, label, { required: !!date });
    }
  }
}

export function extractUnreleasedNotes(content: string): string {
  const { body } = unreleasedSection(releaseSections(normalizeContent(content)));
  const { beforeCategories, categories } = splitChangelogReleaseBody(body);
  const meaningful = hasMeaningfulReleaseNotes(categories);
  const headline = readChangelogHeadline(beforeCategories, "Unreleased", { required: meaningful });
  if (!meaningful) throw new Error("The Unreleased changelog section is empty.");

  // A blank line after each heading keeps the rolled changelog in its formatted shape.
  const notes = categoryBlocks(categories)
    .filter(({ body }) => body)
    .map(({ heading, body }) => `${heading}\n\n${body}`);
  return [headline, ...notes].join("\n\n") + "\n";
}

// Match whole Markdown entries within their category, including continuation lines.
function changelogEntries(categories: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const { heading, body } of categoryBlocks(categories)) {
    const category = entries.get(heading) ?? [];
    if (body) category.push(...body.split(/\n(?=[-*] )/u).map((entry) => entry.trim()));
    entries.set(heading, category);
  }
  return entries;
}

export function advanceChangelog(
  content: string,
  notes: string,
  version: string,
  date: string,
): string {
  const normalized = normalizeContent(content);
  const { unreleased } = nextVersionSections(normalized, version);
  const released = splitChangelogReleaseBody(notes);
  const headline = readChangelogHeadline(released.beforeCategories, version);
  const remaining = changelogEntries(splitChangelogReleaseBody(unreleased.body).categories);
  for (const [heading, entries] of changelogEntries(released.categories)) {
    const candidates = remaining.get(heading);
    if (!candidates) continue;
    for (const entry of entries) {
      const index = candidates.indexOf(entry);
      if (index !== -1) candidates.splice(index, 1);
    }
  }
  const sections = new Map([
    ...DEFAULT_UNRELEASED_CATEGORIES.map((heading): [string, string[]] => [heading, []]),
    ...remaining,
  ]);
  const pending = [...sections].map(([heading, entries]) =>
    [heading, entries.join("\n")].filter(Boolean).join("\n\n"),
  );
  return (
    [
      normalized.slice(0, unreleased.start).trimEnd(),
      ["## [Unreleased]", ...pending].join("\n\n"),
      [`## [${version}] - ${date}`, headline, released.categories.trim()].join("\n\n"),
      normalized.slice(unreleased.end).trim(),
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}

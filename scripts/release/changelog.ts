const EMPTY_UNRELEASED_SECTION = [
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "### Changed",
  "",
  "### Fixed",
].join("\n");

interface SectionRange {
  readonly content: string;
  readonly end: number;
  readonly start: number;
}

const normalizeContent = (content: string): string => content.replace(/\r\n/g, "\n");
const trimTrailingWhitespace = (content: string): string => content.replace(/[ \t]+$/gm, "");
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasMeaningfulReleaseNotes = (content: string): boolean =>
  content
    .split("\n")
    .map((line) => line.trim())
    .some((line) => /^[-*]\s+\S/u.test(line));

const trimBlankLines = (lines: readonly string[]): string[] => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim().length === 0) start += 1;
  while (end > start && lines[end - 1].trim().length === 0) end -= 1;
  return lines.slice(start, end);
};

const omitEmptySubsections = (content: string): string => {
  const normalized = trimTrailingWhitespace(content).trim();
  if (!normalized) return "";

  const blocks: Array<{ heading: string | null; lines: string[] }> = [];
  let current: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  for (const line of normalized.split("\n")) {
    if (!line.startsWith("### ")) {
      current.lines.push(line);
      continue;
    }
    blocks.push(current);
    current = { heading: line, lines: [] };
  }
  blocks.push(current);

  return blocks
    .map((block) => {
      const body = trimBlankLines(block.lines);
      if (body.length === 0) return "";
      return block.heading ? `${block.heading}\n${body.join("\n")}` : body.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
};

const sectionRange = (content: string, headingPattern: RegExp): SectionRange => {
  const normalized = normalizeContent(content);
  const headings = Array.from(normalized.matchAll(/^## \[.*\](?: - \d{4}-\d{2}-\d{2})?$/gm));
  const target = headings.find((match) => headingPattern.test(match[0]));
  if (target?.index === undefined) {
    throw new Error(`Unable to find changelog section matching ${headingPattern}.`);
  }
  const next = headings.find((match) => (match.index ?? 0) > target.index!);
  return {
    content: normalized.slice(target.index, next?.index ?? normalized.length).trim(),
    end: next?.index ?? normalized.length,
    start: target.index,
  };
};

export function extractReleaseNotes(changelogContent: string, version: string): string {
  const section = sectionRange(
    changelogContent,
    new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`),
  );
  const heading = section.content.match(/^## \[.*\] - \d{4}-\d{2}-\d{2}$/m)?.[0];
  if (!heading) throw new Error(`Unable to read the heading for release ${version}.`);
  const notes = section.content.slice(heading.length).trim();
  if (!hasMeaningfulReleaseNotes(notes)) {
    throw new Error(`Release ${version} does not contain any changelog notes.`);
  }
  return `${trimTrailingWhitespace(notes)}\n`;
}

const UNRELEASED = /^## \[Unreleased\]$/;

export function validateNextVersionChangelog(content: string, version: string): void {
  sectionRange(content, UNRELEASED);
  if (
    new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").test(
      normalizeContent(content),
    )
  ) {
    throw new Error(`Source version ${version} already has a dated changelog section.`);
  }
}

export function extractUnreleasedNotes(content: string): string {
  const notes = omitEmptySubsections(
    sectionRange(content, UNRELEASED).content.slice("## [Unreleased]".length),
  );
  if (!hasMeaningfulReleaseNotes(notes))
    throw new Error("The Unreleased changelog section is empty.");
  return `${notes}\n`;
}

// Match whole Markdown entries within their category, including continuation lines.
function changelogEntries(notes: string): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const section of trimTrailingWhitespace(notes).split(/(?=^### )/m)) {
    const heading = /^### .+$/m.exec(section)?.[0] ?? "";
    const body = section.slice(heading.length).trim();
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
  validateNextVersionChangelog(content, version);
  const normalized = normalizeContent(content);
  const unreleased = sectionRange(normalized, UNRELEASED);
  const remaining = changelogEntries(unreleased.content.slice("## [Unreleased]".length));
  for (const [heading, entries] of changelogEntries(notes)) {
    const candidates = remaining.get(heading);
    if (!candidates) continue;
    for (const entry of entries) {
      const index = candidates.indexOf(entry);
      if (index !== -1) candidates.splice(index, 1);
    }
  }
  const sections = new Map([
    ...changelogEntries(EMPTY_UNRELEASED_SECTION.slice("## [Unreleased]".length)),
    ...remaining,
  ]);
  const pending = [...sections]
    .map(([heading, entries]) => [heading, entries.join("\n")].filter(Boolean).join("\n\n"))
    .filter(Boolean);
  return (
    [
      normalized.slice(0, unreleased.start).trimEnd(),
      ["## [Unreleased]", ...pending].join("\n\n"),
      `## [${version}] - ${date}\n\n${notes.trim()}`,
      normalized.slice(unreleased.end).trim(),
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}

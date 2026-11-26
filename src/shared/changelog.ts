/**
 * Nodex's release notes as they live in the repository, read the same way by release automation,
 * the website and the desktop.
 *
 * - Each change not released yet is a file of its own, `changes/<kind>/<YYYY-MM-DD>-<slug>.md`,
 *   holding one entry. Its author writes it with the change, so concurrent branches never edit
 *   the same lines.
 * - A release's notes are a headline, written by whoever promotes the release, and the entries the
 *   promoted source holds, grouped by kind.
 * - CHANGELOG.md archives the notes of every published release, newest first. Only release
 *   automation writes it, in exactly the form `formatChangelog` produces.
 */

/** Kinds of change in the order a release reads them. */
export const CHANGELOG_SECTION_KINDS = [
  "added",
  "changed",
  "deprecated",
  "removed",
  "fixed",
  "security",
] as const;
export type ChangelogSectionKind = (typeof CHANGELOG_SECTION_KINDS)[number];

/** How a release names each kind of change. */
export const CHANGELOG_SECTION_TITLES = {
  added: "Added",
  changed: "Changed",
  deprecated: "Deprecated",
  removed: "Removed",
  fixed: "Fixed",
  security: "Security",
} as const satisfies Record<ChangelogSectionKind, string>;

export interface ReleaseNotesSection {
  readonly kind: ChangelogSectionKind;
  /** Single-line inline Markdown, in the order the release reads them. */
  readonly entries: readonly string[];
}

export interface ReleaseNotes {
  /** What people will care about most in the release, as plain text. */
  readonly headline: string;
  /** Sections with entries, in CHANGELOG_SECTION_KINDS order. */
  readonly sections: readonly ReleaseNotesSection[];
}

export interface PublishedRelease extends ReleaseNotes {
  /** Stable semver without a `v`, such as `0.5.12`. */
  readonly version: string;
  /** Publication day as `YYYY-MM-DD`. */
  readonly date: string;
}

/** A repository file by its repository-relative POSIX path. */
export interface RepositoryFile {
  readonly path: string;
  readonly content: string;
}

export const CHANGES_DIRECTORY = "changes";
/** The one file under `changes/` that is not a change: how to write one. */
export const CHANGES_README = `${CHANGES_DIRECTORY}/README.md`;
const CHANGES_HELP = `See ${CHANGES_README}.`;

const normalize = (text: string): string => text.replace(/\r\n?/gu, "\n");

const isSectionKind = (value: string): value is ChangelogSectionKind =>
  (CHANGELOG_SECTION_KINDS as readonly string[]).includes(value);

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------------------------
// Headline

export const MAX_HEADLINE_LENGTH = 48;
const markdownPunctuation = /[`*[\]]/u;
const markdownLineStart = /^(?:[#>-]|\+\s|\d+[.)]\s)/u;
const markdownEmphasis = /(?:^|[^\p{L}\p{N}_])_+\S(?:.*?\S)?_+(?![\p{L}\p{N}_])/u;

/** Returns `headline` when it can lead a release's notes, and throws a correction otherwise. */
export function assertReleaseHeadline(headline: string, release: string): string {
  if (
    !headline ||
    headline !== headline.trim() ||
    headline.length > MAX_HEADLINE_LENGTH ||
    headline.endsWith(".") ||
    markdownPunctuation.test(headline) ||
    markdownLineStart.test(headline) ||
    markdownEmphasis.test(headline) ||
    /<[^>]+>|~~.+~~/u.test(headline) ||
    /[\n\r\u2028\u2029]/u.test(headline)
  ) {
    throw new Error(
      `${release} needs a headline: one plain-text line of at most ${MAX_HEADLINE_LENGTH} characters, without Markdown or a closing period, naming the changes people will care about most.`,
    );
  }
  return headline;
}

// ---------------------------------------------------------------------------------------------
// Changes not released yet

const CHANGE_FILE =
  /^changes\/(?<kind>[^/]+)\/(?<date>\d{4}-\d{2}-\d{2})-(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;
const blockStart = /^(?:[-*+]\s|\d+[.)]\s|#|>|```|~~~|<)/u;

/** The optional YAML header and the untouched entry body. */
export function splitChangeFile(file: RepositoryFile): {
  readonly frontMatter: string | null;
  readonly body: string;
} {
  const opener = /^---(?:\r\n?|\n|$)/u.exec(file.content);
  if (!opener) return { frontMatter: null, body: file.content };
  const rest = file.content.slice(opener[0].length);
  const closer = /(?:^|(?<=[\r\n]))---(?:\r\n?|\n|$)/u.exec(rest);
  if (!closer)
    throw new Error(`${file.path} needs a closing --- for its front matter. ${CHANGES_HELP}`);
  return {
    frontMatter: rest.slice(0, closer.index),
    body: rest.slice(closer.index + closer[0].length),
  };
}

function changeEntry(path: string, body: string): string {
  const lines = normalize(body)
    .split("\n")
    .map((line) => line.trim());
  while (lines.at(-1) === "") lines.pop();
  while (lines[0] === "") lines.shift();
  if (lines.length === 0) throw new Error(`${path} is empty. ${CHANGES_HELP}`);
  if (lines.includes("")) {
    throw new Error(`${path} must hold one paragraph, the entry itself. ${CHANGES_HELP}`);
  }
  if (lines.some((line) => blockStart.test(line))) {
    throw new Error(
      `${path} must be the entry's text alone, without a list marker, heading, quote, code block or HTML. ${CHANGES_HELP}`,
    );
  }
  return lines.join(" ");
}

export interface ChangeEntry {
  readonly kind: ChangelogSectionKind;
  readonly date: string;
  readonly slug: string;
  readonly path: string;
  readonly entry: string;
  readonly frontMatter: string | null;
}

/** Reads the release set in kind and file-name order, leaving front matter as text. */
export function readChangeEntries(files: readonly RepositoryFile[]): readonly ChangeEntry[] {
  const changes: ChangeEntry[] = [];
  const pathsBySlug = new Map<string, string>();
  for (const file of files) {
    if (file.path === CHANGES_README) continue;
    const { kind = "", date = "", slug = "" } = CHANGE_FILE.exec(file.path)?.groups ?? {};
    if (!isSectionKind(kind) || !isCalendarDate(date)) {
      throw new Error(
        `${file.path} is not a change. Name each change ${CHANGES_DIRECTORY}/<kind>/<YYYY-MM-DD>-<slug>.md, where <kind> is one of ${CHANGELOG_SECTION_KINDS.join(", ")} and <slug> is lowercase ASCII words joined by hyphens. ${CHANGES_HELP}`,
      );
    }
    const previous = pathsBySlug.get(slug);
    if (previous !== undefined) {
      throw new Error(
        `${file.path} uses the same slug "${slug}" as ${previous}. Give each change a unique slug. ${CHANGES_HELP}`,
      );
    }
    pathsBySlug.set(slug, file.path);
    const { body, frontMatter } = splitChangeFile(file);
    changes.push({
      kind,
      date,
      slug,
      path: file.path,
      entry: changeEntry(file.path, body),
      frontMatter,
    });
  }
  return changes.sort((left, right) => {
    const kindOrder =
      CHANGELOG_SECTION_KINDS.indexOf(left.kind) - CHANGELOG_SECTION_KINDS.indexOf(right.kind);
    return kindOrder || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  });
}

/** Groups entries already read in release order into the sections used for release notes. */
export function groupChangeEntries(
  changes: readonly Pick<ChangeEntry, "kind" | "entry">[],
): readonly ReleaseNotesSection[] {
  return CHANGELOG_SECTION_KINDS.flatMap((kind) => {
    const entries = changes.filter((change) => change.kind === kind).map(({ entry }) => entry);
    return entries.length === 0 ? [] : [{ kind, entries }];
  });
}

/** Reads the text of changes not released yet without interpreting their front matter. */
export function readUnreleasedChanges(
  files: readonly RepositoryFile[],
): readonly ReleaseNotesSection[] {
  return groupChangeEntries(readChangeEntries(files));
}

// ---------------------------------------------------------------------------------------------
// A release's notes

function assertSections(sections: readonly ReleaseNotesSection[], release: string): void {
  if (sections.length === 0) {
    throw new Error(`${release} has no entries.`);
  }
  let previous = -1;
  for (const { kind, entries } of sections) {
    const rank = CHANGELOG_SECTION_KINDS.indexOf(kind);
    if (rank <= previous) {
      throw new Error(
        `${release} must list each kind of change once, in the order ${CHANGELOG_SECTION_KINDS.join(", ")}.`,
      );
    }
    previous = rank;
    if (entries.length === 0)
      throw new Error(`${release} has an empty ${CHANGELOG_SECTION_TITLES[kind]} section.`);
    for (const entry of entries) {
      if (!entry || entry !== entry.trim() || /[\n\r\u2028\u2029]/u.test(entry)) {
        throw new Error(`${release} has an entry that is not one trimmed line: "${entry}".`);
      }
    }
  }
}

/** A release's entries under their section headings, as its notes list them. */
export function formatReleaseSections(
  sections: readonly ReleaseNotesSection[],
  release = "The release",
): string {
  assertSections(sections, release);
  const blocks = sections.map(
    ({ kind, entries }) =>
      `### ${CHANGELOG_SECTION_TITLES[kind]}\n\n${entries.map((entry) => `- ${entry}`).join("\n")}`,
  );
  return `${blocks.join("\n\n")}\n`;
}

/** The Markdown a release publishes on GitHub, in its update feeds and under its CHANGELOG.md heading. */
export function formatReleaseNotes(notes: ReleaseNotes, release = "The release"): string {
  assertReleaseHeadline(notes.headline, release);
  return `${notes.headline}\n\n${formatReleaseSections(notes.sections, release)}`;
}

const sectionKindByTitle = new Map<string, ChangelogSectionKind>(
  CHANGELOG_SECTION_KINDS.map((kind) => [CHANGELOG_SECTION_TITLES[kind], kind] as const),
);

/**
 * Reads release notes written by `formatReleaseNotes`, such as a published GitHub release's body.
 * Blank lines are not significant; everything else must be a headline, a section heading or a
 * single-line entry.
 */
export function parseReleaseNotes(markdown: string, release: string): ReleaseNotes {
  const lines = normalize(markdown)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  const [headline = "", ...rest] = lines;
  if (headline.startsWith("### ")) assertReleaseHeadline("", release);
  const sections: { kind: ChangelogSectionKind; entries: string[] }[] = [];
  for (const line of rest) {
    if (line.startsWith("### ")) {
      const kind = sectionKindByTitle.get(line.slice(4));
      if (!kind) {
        throw new Error(
          `${release} has an unknown section "${line}". Sections are ${Object.values(CHANGELOG_SECTION_TITLES).join(", ")}.`,
        );
      }
      sections.push({ kind, entries: [] });
      continue;
    }
    const section = sections.at(-1);
    if (!line.startsWith("- ") || !section) {
      throw new Error(
        `${release} may hold only its headline, section headings and one-line entries: "${line}".`,
      );
    }
    section.entries.push(line.slice(2).trim());
  }
  const notes = { headline: assertReleaseHeadline(headline, release), sections };
  assertSections(sections, release);
  return notes;
}

// ---------------------------------------------------------------------------------------------
// CHANGELOG.md

const CHANGELOG_PREAMBLE = `# Changelog

The notes of every Nodex release, newest first. Changes that have not been released yet are files in [\`${CHANGES_DIRECTORY}/\`](${CHANGES_DIRECTORY}/).
`;
const RELEASE_HEADING = /^## \[(?<version>[^\]]+)\](?: - (?<date>.+))?$/u;
const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

/** CHANGELOG.md for these releases, which must be ordered newest first. */
export function formatChangelog(releases: readonly PublishedRelease[]): string {
  releases.forEach((release, index) => {
    if (!STABLE_VERSION_PATTERN.test(release.version)) {
      throw new Error(
        `Release ${release.version} must be named by a stable version such as 1.2.3.`,
      );
    }
    if (!isCalendarDate(release.date)) {
      throw new Error(`Release ${release.version} needs its publication day as YYYY-MM-DD.`);
    }
    const older = releases[index + 1];
    if (older && compareVersions(release.version, older.version) <= 0) {
      throw new Error(
        `CHANGELOG.md lists releases newest first: ${release.version} must come after ${older.version}.`,
      );
    }
  });
  const sections = releases.map(
    (release) =>
      `## [${release.version}] - ${release.date}\n\n${formatReleaseNotes(release, `Release ${release.version}`)}`,
  );
  return [CHANGELOG_PREAMBLE, ...sections].join("\n");
}

/**
 * The published releases in CHANGELOG.md, newest first. The file must be exactly what release
 * automation writes, so an entry for a change that has not been released is turned away here.
 */
export function parseChangelog(markdown: string): readonly PublishedRelease[] {
  const content = normalize(markdown);
  const [, ...blocks] = content.split(/^(?=## )/mu);
  const releases = blocks.map((block): PublishedRelease => {
    const newline = block.indexOf("\n");
    const heading = newline === -1 ? block : block.slice(0, newline);
    const match = RELEASE_HEADING.exec(heading);
    const version = match?.groups?.version ?? "";
    const date = match?.groups?.date ?? "";
    if (version === "Unreleased") {
      throw new Error(
        `CHANGELOG.md holds published releases only. Write a change that has not been released as a file in ${CHANGES_DIRECTORY}/. ${CHANGES_HELP}`,
      );
    }
    if (!match || !STABLE_VERSION_PATTERN.test(version) || !isCalendarDate(date)) {
      throw new Error(`CHANGELOG.md has a heading that names no published release: "${heading}".`);
    }
    const release = `Release ${version}`;
    return { version, date, ...parseReleaseNotes(block.slice(heading.length), release) };
  });
  if (formatChangelog(releases) !== content) {
    throw new Error(
      `CHANGELOG.md must stay in the form release automation writes. Changes that have not been released belong in ${CHANGES_DIRECTORY}/. ${CHANGES_HELP}`,
    );
  }
  return releases;
}

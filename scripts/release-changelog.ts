import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const defaultPackageJsonPath = resolve(projectRoot, "package.json");
const defaultChangelogPath = resolve(projectRoot, "CHANGELOG.md");
const emptyUnreleasedSection = ["## [Unreleased]", "", "### Added", "", "### Changed", "", "### Fixed"].join("\n");

type PrepareReleaseOptions = {
  changelogContent: string;
  version: string;
  date: string;
};

type PreparedReleaseArtifacts = {
  changelogContent: string;
  commitMessage: string;
  releaseNotes: string;
};

type ExtractReleaseNotesOptions = {
  changelogContent: string;
  version: string;
};

type CliOptions = {
  changelogPath: string;
  commitMessageOutputPath: string | null;
  date: string;
  packageJsonPath: string;
  releaseNotesOutputPath: string | null;
  version: string | null;
};

type SectionRange = {
  content: string;
  end: number;
  start: number;
};

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function trimTrailingWhitespace(content: string): string {
  return content.replace(/[ \t]+$/gm, "");
}

function hasMeaningfulReleaseNotes(content: string): boolean {
  return content
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("### "));
}

function hasSection(changelogContent: string, headingPattern: RegExp): boolean {
  return Array.from(normalizeContent(changelogContent).matchAll(/^## \[.*\](?: - \d{4}-\d{2}-\d{2})?$/gm)).some((match) =>
    headingPattern.test(match[0]),
  );
}

function getSectionRange(changelogContent: string, headingPattern: RegExp): SectionRange {
  const normalizedChangelog = normalizeContent(changelogContent);
  const sectionMatches = Array.from(normalizedChangelog.matchAll(/^## \[.*\](?: - \d{4}-\d{2}-\d{2})?$/gm));
  const targetSection = sectionMatches.find((match) => headingPattern.test(match[0]));

  if (!targetSection || targetSection.index === undefined) {
    throw new Error(`Unable to find changelog section matching ${headingPattern}.`);
  }

  const nextSection = sectionMatches.find((match) => (match.index ?? 0) > targetSection.index!);
  const start = targetSection.index;
  const end = nextSection?.index ?? normalizedChangelog.length;

  return {
    start,
    end,
    content: normalizedChangelog.slice(start, end).trim(),
  };
}

function readPackageVersion(packageJsonPath: string): string {
  const rawPackageJson = readFileSync(packageJsonPath, "utf8");
  const parsedPackageJson = JSON.parse(rawPackageJson) as { version?: unknown };

  if (typeof parsedPackageJson.version !== "string" || parsedPackageJson.version.trim().length === 0) {
    throw new Error(`Unable to read a valid version from ${packageJsonPath}.`);
  }

  return parsedPackageJson.version.trim();
}

function writeOptionalFile(outputPath: string | null, content: string): void {
  if (!outputPath) {
    return;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, "utf8");
}

function buildReleaseSection(version: string, date: string, releaseNotes: string): string {
  return `## [${version}] - ${date}\n\n${releaseNotes}`;
}

export function extractReleaseNotes(options: ExtractReleaseNotesOptions): string {
  const versionSection = getSectionRange(
    options.changelogContent,
    new RegExp(`^## \\[${escapeRegExp(options.version)}\\] - \\d{4}-\\d{2}-\\d{2}$`),
  );
  const versionHeading = versionSection.content.match(/^## \[.*\] - \d{4}-\d{2}-\d{2}$/m)?.[0];

  if (!versionHeading) {
    throw new Error(`Unable to read the heading for release ${options.version}.`);
  }

  const releaseNotes = versionSection.content.slice(versionHeading.length).trim();

  if (!hasMeaningfulReleaseNotes(releaseNotes)) {
    throw new Error(`Release ${options.version} does not contain any changelog notes.`);
  }

  return `${trimTrailingWhitespace(releaseNotes)}\n`;
}

export function prepareReleaseArtifacts(options: PrepareReleaseOptions): PreparedReleaseArtifacts {
  const normalizedChangelog = normalizeContent(options.changelogContent);

  if (hasSection(normalizedChangelog, new RegExp(`^## \\[${escapeRegExp(options.version)}\\] - \\d{4}-\\d{2}-\\d{2}$`))) {
    throw new Error(`Release ${options.version} already exists in CHANGELOG.md.`);
  }

  const unreleasedSection = getSectionRange(normalizedChangelog, /^## \[Unreleased\]$/);
  const unreleasedHeading = unreleasedSection.content.match(/^## \[Unreleased\]$/m)?.[0];

  if (!unreleasedHeading) {
    throw new Error("Unable to read the Unreleased changelog heading.");
  }

  const releaseNotes = unreleasedSection.content.slice(unreleasedHeading.length).trim();

  if (!hasMeaningfulReleaseNotes(releaseNotes)) {
    throw new Error("The Unreleased changelog section is empty. Refusing to cut a release without notes.");
  }

  const beforeUnreleased = normalizedChangelog.slice(0, unreleasedSection.start).trimEnd();
  const afterUnreleased = normalizedChangelog.slice(unreleasedSection.end).trimStart();
  const normalizedReleaseNotes = trimTrailingWhitespace(releaseNotes).trim();
  const releaseSection = buildReleaseSection(options.version, options.date, normalizedReleaseNotes);
  const nextChangelog = [beforeUnreleased, emptyUnreleasedSection, releaseSection, afterUnreleased]
    .filter((section) => section.length > 0)
    .join("\n\n");
  const commitMessage = `release: v${options.version}\n\n${normalizedReleaseNotes}\n`;

  return {
    changelogContent: `${nextChangelog}\n`,
    releaseNotes: `${normalizedReleaseNotes}\n`,
    commitMessage,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseCliOptions(argv: string[]): { command: "extract" | "prepare"; options: CliOptions } {
  const [command, ...rest] = argv;

  if (command !== "prepare" && command !== "extract") {
    throw new Error('Expected a subcommand of "prepare" or "extract".');
  }

  const options: CliOptions = {
    changelogPath: defaultChangelogPath,
    commitMessageOutputPath: null,
    date: process.env.RELEASE_DATE?.trim() || getTodayDate(),
    packageJsonPath: defaultPackageJsonPath,
    releaseNotesOutputPath: null,
    version: null,
  };

  for (let index = 0; index < rest.length; ) {
    const argument = rest[index];

    if (argument === "--") {
      index += 1;
      continue;
    }

    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument "${argument}".`);
    }

    const value = rest[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }

    switch (argument) {
      case "--changelog-path":
        options.changelogPath = resolve(value);
        break;
      case "--commit-message-output":
        options.commitMessageOutputPath = resolve(value);
        break;
      case "--date":
        options.date = value;
        break;
      case "--package-json-path":
        options.packageJsonPath = resolve(value);
        break;
      case "--release-notes-output":
        options.releaseNotesOutputPath = resolve(value);
        break;
      case "--version":
        options.version = value;
        break;
      default:
        throw new Error(`Unknown argument "${argument}".`);
    }

    index += 2;
  }

  return {
    command,
    options,
  };
}

function runPrepare(options: CliOptions): void {
  const version = options.version ?? readPackageVersion(options.packageJsonPath);
  const changelogContent = readFileSync(options.changelogPath, "utf8");
  const preparedArtifacts = prepareReleaseArtifacts({
    changelogContent,
    version,
    date: options.date,
  });

  writeFileSync(options.changelogPath, preparedArtifacts.changelogContent, "utf8");
  writeOptionalFile(options.releaseNotesOutputPath, preparedArtifacts.releaseNotes);
  writeOptionalFile(options.commitMessageOutputPath, preparedArtifacts.commitMessage);
  console.log(`Prepared CHANGELOG.md for v${version}.`);
}

function runExtract(options: CliOptions): void {
  const version = options.version ?? readPackageVersion(options.packageJsonPath);
  const changelogContent = readFileSync(options.changelogPath, "utf8");
  const releaseNotes = extractReleaseNotes({
    changelogContent,
    version,
  });

  writeOptionalFile(options.releaseNotesOutputPath, releaseNotes);
  if (!options.releaseNotesOutputPath) {
    process.stdout.write(releaseNotes);
    return;
  }

  console.log(`Wrote release notes for v${version}.`);
}

function main(): void {
  const { command, options } = parseCliOptions(process.argv.slice(2));

  if (command === "prepare") {
    runPrepare(options);
    return;
  }

  runExtract(options);
}

if (import.meta.main) {
  main();
}

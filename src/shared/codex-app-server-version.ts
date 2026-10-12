const versionPattern =
  /(?:^|\s)(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?:\s|$)/u;
export const parseCodexCliVersion = (output: string): string | null =>
  versionPattern.exec(output)?.groups?.version ?? null;
/** Desktop connections require the stable 0.141.0 protocol or an explicit development build. */
export const isSupportedCodexAppServerVersion = (version: string): boolean => {
  if (version === "0.0.0") return true;
  const parsed = /^(\d+)\.(\d+)\.(\d+)(-[^+]+)?(?:\+.*)?$/u.exec(version);
  if (!parsed) return false;
  const major = Number(parsed[1]),
    minor = Number(parsed[2]),
    patch = Number(parsed[3]);
  return major > 0 || minor > 141 || (minor === 141 && (patch > 0 || parsed[4] === undefined));
};

export const CODEX_THREAD_TIMELINE_MINIMUM_VERSION = "0.150.0-alpha.9";

const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const NON_NUMERIC_IDENTIFIER = "(?:\\d*[A-Za-z-][0-9A-Za-z-]*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|${NON_NUMERIC_IDENTIFIER})`;
const PRERELEASE = `${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*`;
const BUILD = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const SEMANTIC_VERSION_PATTERN_SOURCE = `${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}\\.${NUMERIC_IDENTIFIER}(?:-${PRERELEASE})?(?:\\+${BUILD})?`;

const EXACT_SEMANTIC_VERSION_PATTERN = new RegExp(`^(${SEMANTIC_VERSION_PATTERN_SOURCE})$`, "u");
// initialize.userAgent is generated as originator/server-version, where originator is the
// client's name, not a fixed Codex product name. Only inspect its leading product token.
const ORIGINATOR_USER_AGENT_VERSION_PATTERN = new RegExp(
  `^[^/();\\r\\n]+/v?(${SEMANTIC_VERSION_PATTERN_SOURCE})(?=$|[\\s;)])`,
  "u",
);
const CODEX_USER_AGENT_VERSION_PATTERN = new RegExp(
  `(?:^|[\\s;(])(?:Codex Desktop|codex-cli|codex_cli_rs|codex-app-server)[/\\s]+v?(${SEMANTIC_VERSION_PATTERN_SOURCE})(?=$|[\\s;)])`,
  "iu",
);

interface ParsedSemanticVersion {
  readonly core: readonly [string, string, string];
  readonly prerelease: readonly string[] | null;
}

const parseSemanticVersion = (value: string): ParsedSemanticVersion | null => {
  const match = EXACT_SEMANTIC_VERSION_PATTERN.exec(value);
  if (!match) return null;

  const coreAndPrerelease = value.split("+", 1)[0]!;
  const prereleaseSeparator = coreAndPrerelease.indexOf("-");
  const core = (
    prereleaseSeparator === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, prereleaseSeparator)
  ).split(".");
  if (core.length !== 3) return null;

  const prerelease =
    prereleaseSeparator === -1 ? null : coreAndPrerelease.slice(prereleaseSeparator + 1).split(".");
  return {
    core: core as [string, string, string],
    prerelease,
  };
};

const compareNumericIdentifiers = (left: string, right: string): -1 | 0 | 1 => {
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const comparePrereleaseIdentifiers = (left: string, right: string): -1 | 0 | 1 => {
  const leftIsNumeric = /^\d+$/u.test(left);
  const rightIsNumeric = /^\d+$/u.test(right);
  if (leftIsNumeric && rightIsNumeric) return compareNumericIdentifiers(left, right);
  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const compareSemanticVersions = (
  left: ParsedSemanticVersion,
  right: ParsedSemanticVersion,
): -1 | 0 | 1 => {
  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareNumericIdentifiers(left.core[index]!, right.core[index]!);
    if (comparison !== 0) return comparison;
  }

  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  const sharedLength = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = comparePrereleaseIdentifiers(
      left.prerelease[index]!,
      right.prerelease[index]!,
    );
    if (comparison !== 0) return comparison;
  }

  if (left.prerelease.length < right.prerelease.length) return -1;
  if (left.prerelease.length > right.prerelease.length) return 1;
  return 0;
};

/** Compares two exact app-server SemVer strings without inferring support for unknown versions. */
export function isCodexAppServerVersionAtLeast(
  version: string | null | undefined,
  minimumVersion: string,
): boolean {
  if (!version) return false;
  const parsedVersion = parseSemanticVersion(version);
  const parsedMinimum = parseSemanticVersion(minimumVersion);
  return (
    parsedVersion !== null &&
    parsedMinimum !== null &&
    compareSemanticVersions(parsedVersion, parsedMinimum) >= 0
  );
}

/** Extracts only an app-server product version, never an unrelated OS/browser version. */
export function extractCodexAppServerVersion(userAgent: string | null | undefined): string | null {
  const normalized = userAgent?.trim();
  if (!normalized) return null;

  const exact = EXACT_SEMANTIC_VERSION_PATTERN.exec(normalized);
  if (exact?.[1]) return exact[1];

  return (
    ORIGINATOR_USER_AGENT_VERSION_PATTERN.exec(normalized)?.[1] ??
    CODEX_USER_AGENT_VERSION_PATTERN.exec(normalized)?.[1] ??
    null
  );
}

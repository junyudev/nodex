import { createHash } from "node:crypto";
import { openSync, closeSync, readSync } from "node:fs";

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NIGHTLY_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.(\d{8})\.([1-9]\d*)$/;
const APPLE_BUILD_VERSION_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BUILD_IDENTITY_KEYS = [
  "schemaVersion",
  "sourceSha",
  "sourceTree",
  "version",
  "buildVersion",
  "mainlineOrdinal",
  "sourceDate",
] as const;

export type ReleaseChannel = "stable" | "nightly";

export interface BuildIdentity {
  readonly schemaVersion: 1;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly mainlineOrdinal: number;
  readonly sourceDate: string;
}

export interface ReleaseIdentity extends BuildIdentity {
  readonly channel: ReleaseChannel;
  readonly tag: string;
}

interface StableVersionParts {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
}

function stableVersionParts(value: string, label: string): StableVersionParts {
  const normalized = normalizeStableVersion(value, label);
  const [major, minor, patch] = normalized.split(".").map((part) => BigInt(part));
  return { major, minor, patch };
}

function normalizeNightlyVersion(value: string, label = "version"): string {
  const normalized = value.trim();
  if (!NIGHTLY_VERSION_PATTERN.test(normalized)) {
    throw new Error(
      `${label} must be a nightly semantic version such as 0.2.2-nightly.20260813.842.`,
    );
  }
  return normalized;
}

function normalizeMainlineOrdinal(value: number, label = "mainlineOrdinal"): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function assertGitObject(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !GIT_OBJECT_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase 40-character Git object id.`);
  }
}

function normalizeReleaseDate(value: unknown, label = "sourceDate"): string {
  if (typeof value !== "string" || !RELEASE_DATE_PATTERN.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real calendar date.`);
  }
  return value;
}

function identityRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Identity must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function normalizeStableVersion(value: string, label = "version"): string {
  const normalized = value.trim();
  if (!STABLE_VERSION_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a stable semantic version such as 0.2.0.`);
  }
  return normalized;
}

export function normalizeReleaseVersion(value: string, label = "version"): string {
  try {
    return normalizeStableVersion(value, label);
  } catch {
    return normalizeNightlyVersion(value, label);
  }
}

export function compareStableVersions(leftValue: string, rightValue: string): number {
  const left = stableVersionParts(leftValue, "left version");
  const right = stableVersionParts(rightValue, "right version");
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

export function nextPatchVersion(value: string): string {
  const { major, minor, patch } = stableVersionParts(value, "source version");
  return `${major}.${minor}.${patch + 1n}`;
}

export function nightlyLabelFor(
  version: string,
  sourceDate: string,
  mainlineOrdinal: number,
): string {
  const date = normalizeReleaseDate(sourceDate).replaceAll("-", "");
  const ordinal = normalizeMainlineOrdinal(mainlineOrdinal);
  return `${normalizeStableVersion(version)}-nightly.${date}.${ordinal}`;
}

export function buildVersionForMainlineOrdinal(mainlineOrdinal: number): string {
  const ordinal = normalizeMainlineOrdinal(mainlineOrdinal);
  const major = 1 + Math.floor(ordinal / 10_000);
  const minor = Math.floor(ordinal / 100) % 100;
  const patch = ordinal % 100;
  if (major > 9_999) {
    throw new Error("mainlineOrdinal exceeds Apple's four-digit major build-version limit.");
  }
  return `${major}.${minor}.${patch}`;
}

export function normalizeAppleBuildVersion(value: string, label = "buildVersion"): string {
  const normalized = value.trim();
  if (!APPLE_BUILD_VERSION_PATTERN.test(normalized)) {
    throw new Error(`${label} must be an Apple build version such as 1.8.42.`);
  }
  return normalized;
}

export function compareBuildVersions(leftValue: string, rightValue: string): number {
  const left = normalizeAppleBuildVersion(leftValue, "left build version").split(".").map(Number);
  const right = normalizeAppleBuildVersion(rightValue, "right build version")
    .split(".")
    .map(Number);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function tagForReleaseVersion(version: string): string {
  return `v${normalizeReleaseVersion(version)}`;
}

export function stableVersionFromAppTag(tag: string): string | null {
  if (!tag.startsWith("v")) return null;
  try {
    return normalizeStableVersion(tag.slice(1), "app tag");
  } catch {
    return null;
  }
}

export function parseBuildIdentity(input: unknown): BuildIdentity {
  const record = identityRecord(input);
  if (
    Object.keys(record).length !== BUILD_IDENTITY_KEYS.length ||
    BUILD_IDENTITY_KEYS.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error("Build Identity contains unexpected or missing fields.");
  }
  assertGitObject(record.sourceSha, "sourceSha");
  assertGitObject(record.sourceTree, "sourceTree");
  if (
    record.schemaVersion !== 1 ||
    typeof record.version !== "string" ||
    typeof record.mainlineOrdinal !== "number"
  ) {
    throw new Error("Build Identity schema, version or ordinal is invalid.");
  }
  const sourceDate = normalizeReleaseDate(record.sourceDate);
  const mainlineOrdinal = normalizeMainlineOrdinal(record.mainlineOrdinal);
  const buildVersion = buildVersionForMainlineOrdinal(mainlineOrdinal);
  const version = normalizeStableVersion(record.version);
  if (record.buildVersion !== buildVersion || record.version !== version) {
    throw new Error("Build Identity version or buildVersion does not match its source.");
  }
  return {
    schemaVersion: 1,
    sourceSha: record.sourceSha,
    sourceTree: record.sourceTree,
    version,
    buildVersion,
    mainlineOrdinal,
    sourceDate,
  };
}

export function buildIdentityOf({
  channel: _channel,
  tag: _tag,
  ...build
}: ReleaseIdentity): BuildIdentity {
  return build;
}

export function publicationIdentity(
  build: BuildIdentity,
  channel: ReleaseChannel,
): ReleaseIdentity {
  const label =
    channel === "stable"
      ? build.version
      : nightlyLabelFor(build.version, build.sourceDate, build.mainlineOrdinal);
  return { ...build, channel, tag: tagForReleaseVersion(label) };
}

export function parseReleaseIdentity(input: unknown): ReleaseIdentity {
  const { channel, tag, ...record } = identityRecord(input);
  if (channel !== "stable" && channel !== "nightly") {
    throw new Error("Release Identity channel must be stable or nightly.");
  }
  const identity = publicationIdentity(parseBuildIdentity(record), channel);
  if (tag !== identity.tag) throw new Error(`Release Identity tag must be ${identity.tag}.`);
  return identity;
}

export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

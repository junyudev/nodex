import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildVersionForMainlineOrdinal,
  nightlyVersionFor,
  parseReleaseIdentity,
  tagForReleaseVersion,
  type ReleaseChannel,
  type ReleaseIdentity,
} from "./model";
import { detectReleaseTransition, inspectReleaseSourceAtRef } from "./source";

export type NightlyCandidateResolution =
  | {
      readonly shouldRelease: false;
      readonly reason: "source-is-stable-transition";
      readonly sourceSha: string;
    }
  | { readonly shouldRelease: true; readonly identity: ReleaseIdentity };

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const sourceDateAtRef = (cwd: string, ref: string): string => {
  const timestamp = git(cwd, ["show", "-s", "--format=%cI", ref]);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()))
    throw new Error(`Git returned an invalid commit date for ${ref}.`);
  return parsed.toISOString().slice(0, 10);
};

export function createReleaseIdentity(options: {
  readonly channel: ReleaseChannel;
  readonly mainlineOrdinal: number;
  readonly sourceDate: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly sourceVersion: string;
}): ReleaseIdentity {
  const version =
    options.channel === "stable"
      ? options.sourceVersion
      : nightlyVersionFor(options.sourceVersion, options.sourceDate, options.mainlineOrdinal);
  return parseReleaseIdentity({
    schemaVersion: 1,
    channel: options.channel,
    sourceSha: options.sourceSha,
    sourceTree: options.sourceTree,
    sourceVersion: options.sourceVersion,
    version,
    buildVersion: buildVersionForMainlineOrdinal(options.mainlineOrdinal),
    tag: tagForReleaseVersion(version),
    mainlineOrdinal: options.mainlineOrdinal,
    sourceDate: options.sourceDate,
  });
}

export function resolveReleaseIdentity(options: {
  readonly channel: ReleaseChannel;
  readonly cwd: string;
  readonly ref: string;
}): ReleaseIdentity {
  const cwd = resolve(options.cwd);
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error(
      "Release Identity requires complete Git history; shallow repositories cannot assign build versions.",
    );
  }
  const sourceSha = git(cwd, ["rev-parse", `${options.ref}^{commit}`]);
  const sourceTree = git(cwd, ["rev-parse", `${options.ref}^{tree}`]);
  const sourceVersion = inspectReleaseSourceAtRef(cwd, sourceSha).packageVersion;
  const mainlineOrdinal = Number(git(cwd, ["rev-list", "--first-parent", "--count", sourceSha]));
  return createReleaseIdentity({
    channel: options.channel,
    mainlineOrdinal,
    sourceDate: sourceDateAtRef(cwd, sourceSha),
    sourceSha,
    sourceTree,
    sourceVersion,
  });
}

export function assertSameReleaseIdentity(
  expected: ReleaseIdentity,
  actual: ReleaseIdentity,
): ReleaseIdentity {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("Release Identity does not match the exact source ref.");
  }
  return actual;
}

export function verifyReleaseIdentityAtRef(options: {
  readonly cwd: string;
  readonly identity: ReleaseIdentity;
  readonly ref: string;
}): ReleaseIdentity {
  const expected = resolveReleaseIdentity({
    channel: options.identity.channel,
    cwd: options.cwd,
    ref: options.ref,
  });
  return assertSameReleaseIdentity(expected, options.identity);
}

export function resolveStableReleaseIdentity(options: {
  readonly base: string;
  readonly cwd: string;
  readonly head: string;
}): ReleaseIdentity {
  const transition = detectReleaseTransition(options.cwd, options.base, options.head);
  if (!transition.shouldRelease)
    throw new Error(`${options.head} is not a stable release transition.`);
  return resolveReleaseIdentity({ channel: "stable", cwd: options.cwd, ref: options.head });
}

export function resolveNightlyCandidate(options: {
  readonly cwd: string;
  readonly head: string;
}): NightlyCandidateResolution {
  const cwd = resolve(options.cwd);
  const sourceSha = git(cwd, ["rev-parse", `${options.head}^{commit}`]);
  const parents = git(cwd, ["rev-list", "--parents", "-n", "1", sourceSha]).split(/\s+/);
  if (parents.length === 2) {
    const transition = detectReleaseTransition(cwd, parents[1], sourceSha);
    if (transition.shouldRelease) {
      return { shouldRelease: false, reason: "source-is-stable-transition", sourceSha };
    }
  }
  return {
    shouldRelease: true,
    identity: resolveReleaseIdentity({ channel: "nightly", cwd, ref: sourceSha }),
  };
}

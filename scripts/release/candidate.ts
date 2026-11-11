import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  buildVersionForMainlineOrdinal,
  parseBuildIdentity,
  publicationIdentity,
  type BuildIdentity,
  type ReleaseIdentity,
} from "./model";
import { isVersionAdvance, inspectReleaseSourceAtRef } from "./source";

export type NightlyCandidateResolution =
  | {
      readonly shouldRelease: false;
      readonly reason: "version-advance-only";
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

export function createBuildIdentity(options: {
  readonly mainlineOrdinal: number;
  readonly sourceDate: string;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly version: string;
}): BuildIdentity {
  return parseBuildIdentity({
    ...options,
    schemaVersion: 1,
    buildVersion: buildVersionForMainlineOrdinal(options.mainlineOrdinal),
  });
}

export function resolveBuildIdentity(options: {
  readonly cwd: string;
  readonly ref: string;
}): BuildIdentity {
  const cwd = resolve(options.cwd);
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error(
      "Build Identity requires complete Git history; shallow repositories cannot assign build versions.",
    );
  }
  const sourceSha = git(cwd, ["rev-parse", `${options.ref}^{commit}`]);
  const sourceTree = git(cwd, ["rev-parse", `${options.ref}^{tree}`]);
  const version = inspectReleaseSourceAtRef(cwd, sourceSha).packageVersion;
  const mainlineOrdinal = Number(git(cwd, ["rev-list", "--first-parent", "--count", sourceSha]));
  return createBuildIdentity({
    mainlineOrdinal,
    sourceDate: sourceDateAtRef(cwd, sourceSha),
    sourceSha,
    sourceTree,
    version,
  });
}

export function assertSameBuildIdentity(
  expected: BuildIdentity,
  actual: BuildIdentity,
): BuildIdentity {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("Build Identity does not match the exact source ref.");
  }
  return actual;
}

export function verifyBuildIdentityAtRef(options: {
  readonly cwd: string;
  readonly identity: BuildIdentity;
  readonly ref: string;
}): BuildIdentity {
  const expected = resolveBuildIdentity({
    cwd: options.cwd,
    ref: options.ref,
  });
  return assertSameBuildIdentity(expected, options.identity);
}

export function resolveNightlyCandidate(options: {
  readonly cwd: string;
  readonly head: string;
}): NightlyCandidateResolution {
  const cwd = resolve(options.cwd);
  const sourceSha = git(cwd, ["rev-parse", `${options.head}^{commit}`]);
  const parents = git(cwd, ["rev-list", "--parents", "-n", "1", sourceSha]).split(/\s+/);
  if (parents.length === 2 && isVersionAdvance(cwd, parents[1], sourceSha)) {
    return { shouldRelease: false, reason: "version-advance-only", sourceSha };
  }
  return {
    shouldRelease: true,
    identity: publicationIdentity(resolveBuildIdentity({ cwd, ref: sourceSha }), "nightly"),
  };
}

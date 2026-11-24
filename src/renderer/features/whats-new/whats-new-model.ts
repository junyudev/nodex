import type { ChangelogRelease } from "../../../shared/changelog-feed";

/** How many releases What's new lists before Full changelog takes over. */
export const WHATS_NEW_RELEASE_COUNT = 3;

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Orders two release versions the way semver does: by their numbers, then a prerelease before its
 * release. A version that does not parse sorts before every version that does.
 */
export function compareReleaseVersions(left: string, right: string): number {
  const a = left.match(VERSION_PATTERN);
  const b = right.match(VERSION_PATTERN);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (const index of [1, 2, 3]) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  const [preA, preB] = [a[4], b[4]];
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

/** The newest version among releases, or null when there are none. */
export function newestReleaseVersion(releases: readonly ChangelogRelease[]): string | null {
  return releases.reduce<string | null>(
    (newest, release) =>
      newest === null || compareReleaseVersions(release.version, newest) > 0
        ? release.version
        : newest,
    null,
  );
}

/**
 * The releases that are new to someone who last saw `seen`. Before anything has been seen, the
 * feed as first shown is the baseline and nothing in it is new; later releases are.
 */
export function releasesNewSince(
  releases: readonly ChangelogRelease[],
  seen: string | null,
): ReadonlySet<string> {
  if (seen === null) return new Set();
  return new Set(
    releases
      .filter((release) => compareReleaseVersions(release.version, seen) > 0)
      .map((release) => release.version),
  );
}

/** What has been seen after looking at releases; it never moves back to an older version. */
export function advanceSeenVersion(
  seen: string | null,
  releases: readonly ChangelogRelease[],
): string | null {
  const newest = newestReleaseVersion(releases);
  if (newest === null) return seen;
  if (seen === null) return newest;
  return compareReleaseVersions(newest, seen) > 0 ? newest : seen;
}

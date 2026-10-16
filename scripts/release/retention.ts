import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleaseBundleManifest } from "./bundle";
import { remoteReleaseAssetIdentities } from "./github-release";

interface RemoteAsset {
  readonly digest?: string | null;
  readonly name: string;
  readonly size: number;
}

interface RemoteRelease {
  readonly assets?: readonly RemoteAsset[];
  readonly draft: boolean;
  readonly id: number;
  readonly immutable?: boolean;
  readonly prerelease: boolean;
  readonly published_at: string | null;
  readonly tag_name: string;
}

const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/u;
const NIGHTLY_FEEDS = ["https://nodex.jyu.app/updates/nightly/arm64/appcast.xml"] as const;

const gh = (args: readonly string[]): string =>
  execFileSync("gh", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const fetchText = (url: string): string =>
  execFileSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "10",
      "--max-time",
      "60",
      "--retry",
      "2",
      url,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

const publishedAtMs = (release: RemoteRelease): number => {
  if (!release.published_at) return Number.NaN;
  return Date.parse(release.published_at);
};

const isStrictNightly = (release: RemoteRelease): boolean =>
  !release.draft && release.prerelease && NIGHTLY_TAG.test(release.tag_name);

export interface NightlyRetentionPlan {
  readonly delete: readonly { readonly id: number; readonly tag: string }[];
  readonly keep: readonly string[];
  readonly protected: readonly string[];
  readonly skippedUnverified: readonly string[];
  readonly tooYoung: readonly string[];
  readonly keepCount: number;
  readonly minAgeDays: number;
}

export function extractNightlyTagsFromAppcasts(appcasts: readonly string[]): ReadonlySet<string> {
  const tags = new Set<string>();
  for (const appcast of appcasts) {
    for (const match of appcast.matchAll(/\/releases\/download\/([^/"'<>\s]+)\//gu)) {
      const tag = decodeURIComponent(match[1]);
      if (NIGHTLY_TAG.test(tag)) tags.add(tag);
    }
  }
  return tags;
}

export function planNightlyRetention(
  releases: readonly RemoteRelease[],
  options: {
    readonly keepCount?: number;
    readonly minAgeDays?: number;
    readonly now?: Date;
    readonly protectedTags?: ReadonlySet<string>;
    readonly verifiedTags?: ReadonlySet<string>;
  } = {},
): NightlyRetentionPlan {
  const keepCount = options.keepCount ?? 20;
  const minAgeDays = options.minAgeDays ?? 14;
  if (!Number.isSafeInteger(keepCount) || keepCount < 1)
    throw new Error("keepCount must be positive.");
  if (!Number.isSafeInteger(minAgeDays) || minAgeDays < 1)
    throw new Error("minAgeDays must be positive.");
  const now = options.now ?? new Date();
  if (Number.isNaN(now.valueOf())) throw new Error("Retention clock must be valid.");
  const protectedTags = options.protectedTags ?? new Set<string>();
  const verifiedTags = options.verifiedTags ?? new Set<string>();
  const cutoff = now.valueOf() - minAgeDays * 24 * 60 * 60 * 1_000;
  const nightlies = releases
    .filter(isStrictNightly)
    .sort((left, right) => publishedAtMs(right) - publishedAtMs(left));
  const newest = new Set(nightlies.slice(0, keepCount).map(({ tag_name }) => tag_name));
  const keep: string[] = [];
  const protectedReleases: string[] = [];
  const skippedUnverified: string[] = [];
  const tooYoung: string[] = [];
  const deletions: { id: number; tag: string }[] = [];

  for (const release of nightlies) {
    const tag = release.tag_name;
    if (newest.has(tag)) {
      keep.push(tag);
      continue;
    }
    if (protectedTags.has(tag)) {
      protectedReleases.push(tag);
      continue;
    }
    if (!Number.isFinite(publishedAtMs(release)) || publishedAtMs(release) >= cutoff) {
      tooYoung.push(tag);
      continue;
    }
    if (release.immutable !== true || !verifiedTags.has(tag)) {
      skippedUnverified.push(tag);
      continue;
    }
    deletions.push({ id: release.id, tag });
  }

  return {
    delete: deletions,
    keep,
    protected: protectedReleases,
    skippedUnverified,
    tooYoung,
    keepCount,
    minAgeDays,
  };
}

const verifyReleaseBundleIndex = (repo: string, release: RemoteRelease): boolean => {
  const directory = mkdtempSync(join(tmpdir(), "nodex-nightly-retention-"));
  try {
    for (const pattern of ["release-bundle.json", "SHA256SUMS"]) {
      gh([
        "release",
        "download",
        release.tag_name,
        "--repo",
        repo,
        "--pattern",
        pattern,
        "--dir",
        directory,
      ]);
    }
    const bundlePath = join(directory, "release-bundle.json");
    const bundle = parseReleaseBundleManifest(JSON.parse(readFileSync(bundlePath, "utf8")));
    if (bundle.releaseIdentity.channel !== "nightly" || bundle.tag !== release.tag_name)
      return false;
    const expected = remoteReleaseAssetIdentities(bundlePath);
    const actual = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
    if (actual.size !== expected.size) return false;
    for (const [name, identity] of expected) {
      const asset = actual.get(name);
      if (
        !asset ||
        asset.size !== identity.bytes ||
        asset.digest?.replace(/^sha256:/u, "") !== identity.sha256
      )
        return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

export function runNightlyRetention(options: {
  readonly destructive: boolean;
  readonly keepCount: number;
  readonly minAgeDays: number;
  readonly repo: string;
}): NightlyRetentionPlan {
  const releases = (
    JSON.parse(
      gh(["api", `repos/${options.repo}/releases?per_page=100`, "--paginate", "--slurp"]),
    ) as RemoteRelease[][]
  ).flat();
  const nightlies = releases.filter(isStrictNightly);
  if (nightlies.length === 0) {
    return planNightlyRetention([], {
      keepCount: options.keepCount,
      minAgeDays: options.minAgeDays,
    });
  }
  const protectedTags = extractNightlyTagsFromAppcasts(NIGHTLY_FEEDS.map(fetchText));
  const preliminary = planNightlyRetention(releases, {
    keepCount: options.keepCount,
    minAgeDays: options.minAgeDays,
    protectedTags,
    verifiedTags: new Set(nightlies.map(({ tag_name }) => tag_name)),
  });
  const candidateTags = new Set(preliminary.delete.map(({ tag }) => tag));
  const verifiedTags = new Set(
    nightlies
      .filter((release) => candidateTags.has(release.tag_name))
      .filter((release) => verifyReleaseBundleIndex(options.repo, release))
      .map(({ tag_name }) => tag_name),
  );
  const plan = planNightlyRetention(releases, {
    keepCount: options.keepCount,
    minAgeDays: options.minAgeDays,
    protectedTags,
    verifiedTags,
  });
  if (options.destructive) {
    const failures: string[] = [];
    for (const release of plan.delete) {
      try {
        gh(["api", "--method", "DELETE", `repos/${options.repo}/releases/${release.id}`]);
      } catch {
        failures.push(release.tag);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Nightly retention failed to delete: ${failures.join(", ")}.`);
    }
  }
  return plan;
}

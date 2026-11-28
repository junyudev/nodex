import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseImmutableReleaseDownloadUrl,
  RELEASE_DOWNLOAD_ORIGIN,
  releaseTagChannel,
} from "../../src/shared/release-download";
import type { ReleaseBucket } from "./r2";
import { readPublishedReleaseIndex } from "./github-release";
import { parseAppcastXml } from "./sparkle-appcast-contract";
import { RELEASE_ARCHITECTURES } from "./targets";

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

const NIGHTLY_PREFIX = "nightly/";
const NIGHTLY_FEEDS = RELEASE_ARCHITECTURES.map(
  (architecture) => `https://nodex.jyu.app/updates/nightly/${architecture}/appcast.xml`,
);

const gh = (args: readonly string[]): string =>
  execFileSync("gh", [...args], {
    encoding: "utf8",
    // Node stops a child at 1 MiB of output by default, less than the release list with its notes.
    maxBuffer: 256 * 1024 * 1024,
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
  !release.draft && release.prerelease && releaseTagChannel(release.tag_name) === "nightly";

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
    const document = parseAppcastXml(appcast, "Nightly appcast");
    for (const enclosure of Array.from(document.getElementsByTagName("enclosure"))) {
      const url = parseImmutableReleaseDownloadUrl(enclosure.getAttribute("url") ?? "");
      if (url?.channel === "nightly") tags.add(url.tag);
    }
  }
  return tags;
}

/** The tag's mainline ordinal gives the same build order regardless of backfill order. */
const nightlyOrdinal = (tag: string): bigint => BigInt(tag.slice(tag.lastIndexOf(".") + 1));

export function planR2NightlyRetention(
  keys: readonly string[],
  protectedTags: ReadonlySet<string>,
  keepCount = 3,
) {
  if (!Number.isSafeInteger(keepCount) || keepCount < 1)
    throw new Error("R2 keep count must be positive.");
  const byTag = new Map<string, string[]>();
  for (const key of keys) {
    const asset = parseImmutableReleaseDownloadUrl(`${RELEASE_DOWNLOAD_ORIGIN}/${key}`);
    if (asset?.channel !== "nightly") continue;
    const assets = byTag.get(asset.tag);
    if (assets) assets.push(key);
    else byTag.set(asset.tag, [key]);
  }
  const tags = [...byTag.keys()].sort((left, right) => {
    const order = nightlyOrdinal(right) - nightlyOrdinal(left);
    return order > 0n ? 1 : order < 0n ? -1 : left.localeCompare(right);
  });
  const keep = tags.slice(0, keepCount);
  const candidates = tags.slice(keepCount);
  return {
    keep,
    keepCount,
    protected: candidates.filter((tag) => protectedTags.has(tag)),
    delete: candidates
      .filter((tag) => !protectedTags.has(tag))
      .map((tag) => ({ tag, keys: byTag.get(tag)! })),
  };
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
    const { assets: expected, bundle } = readPublishedReleaseIndex(
      join(directory, "release-bundle.json"),
    );
    if (bundle.releaseIdentity.channel !== "nightly" || bundle.tag !== release.tag_name)
      return false;
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

export async function runNightlyRetention(options: {
  readonly bucket: ReleaseBucket;
  readonly destructive: boolean;
  readonly keepCount: number;
  readonly minAgeDays: number;
  readonly repo: string;
  readonly r2KeepCount: number;
}) {
  const releases = (
    JSON.parse(
      gh(["api", `repos/${options.repo}/releases?per_page=100`, "--paginate", "--slurp"]),
    ) as RemoteRelease[][]
  ).flat();
  const nightlies = releases.filter(isStrictNightly);
  const r2Keys = await options.bucket.listKeys(NIGHTLY_PREFIX);
  const protectedTags = new Set(
    nightlies.length === 0 && r2Keys.length === 0
      ? []
      : NIGHTLY_FEEDS.flatMap((url) => {
          const tags = extractNightlyTagsFromAppcasts([fetchText(url)]);
          if (tags.size === 0)
            throw new Error(`Nightly appcast has no recognized enclosures: ${url}`);
          return [...tags];
        }),
  );
  const r2 = planR2NightlyRetention(r2Keys, protectedTags, options.r2KeepCount);
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
  const github = planNightlyRetention(releases, {
    keepCount: options.keepCount,
    minAgeDays: options.minAgeDays,
    protectedTags,
    verifiedTags,
  });
  if (!options.destructive) return { github, r2 };

  const failures: string[] = [];
  for (const release of github.delete) {
    try {
      gh(["api", "--method", "DELETE", `repos/${options.repo}/releases/${release.id}`]);
    } catch {
      failures.push(`GitHub ${release.tag}`);
    }
  }
  for (const key of r2.delete.flatMap(({ keys }) => keys)) {
    try {
      await options.bucket.deleteObject(key);
    } catch (error) {
      failures.push(`R2 ${key} (${String(error)})`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Nightly retention failed to delete: ${failures.join(", ")}.`);
  }
  return { github, r2 };
}

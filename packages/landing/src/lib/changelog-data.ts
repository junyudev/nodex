import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { root } from "astro:config/server";
import changelog from "../../../../CHANGELOG.md?raw";
import { resolveMediaStore } from "../../../../scripts/media/store";
import { readChangeFilesAtRef } from "../../../../scripts/release/changelog";
import { mergeReleaseMedia, parseReleaseMedia } from "../../../../scripts/release/release-media";
import {
  readTaggedChanges,
  readUnreleasedChangesWithMedia,
  type UnreleasedChange,
} from "../../../../src/shared/change-media";
import { parseChangelog, type PublishedRelease } from "../../../../src/shared/changelog";
import { mediaDescriptionFile, mediaUrl } from "../../../../src/shared/release-media";
import {
  releasesToShow,
  resolvePublishedMedia,
  type ChangelogRelease,
  type ShownMediaFile,
} from "../changelog";
import releaseMedia from "../release-media.yaml?raw";

const repositoryRoot = fileURLToPath(new URL("../../", root));
const strict = process.env.NODEX_LANDING_DEPLOY === "1";
const execFileAsync = promisify(execFile);

const changeSources = import.meta.glob<string>("../../../../changes/*/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const changeFiles = Object.entries(changeSources).map(([path, content]) => ({
  path: path.slice("../../../../".length),
  content,
}));

// The public tag archive starts at v0.1.3. Read older tags too if a checkout has them.
const untaggedArchive = /^0\.(?:0\.[1-9]|1\.[0-2])$/u;

function readPublishedChanges(releases: readonly PublishedRelease[]) {
  const tags = existsSync(join(repositoryRoot, ".git"))
    ? execFileSync("git", ["tag", "--list", "v*"], { cwd: repositoryRoot, encoding: "utf8" })
    : "";
  const available = new Set(tags.trim().split(/\r?\n/u));
  const missing: string[] = [];
  const changes = new Map<string, readonly UnreleasedChange[]>();
  for (const release of releases) {
    const tag = `v${release.version}`;
    if (available.has(tag)) {
      changes.set(
        release.version,
        readTaggedChanges(release, readChangeFilesAtRef(repositoryRoot, `refs/tags/${tag}`)),
      );
    } else if (!untaggedArchive.test(release.version)) {
      missing.push(tag);
    }
  }
  if (missing.length > 0) {
    const message = `Missing stable changelog tags: ${missing.join(", ")}.`;
    if (strict) throw new Error(`${message} Fetch the stable release tags before deploying.`);
    console.warn(`${message} Showing those releases as text only.`);
  }
  return changes;
}

function mediaReferences(changes: Iterable<readonly UnreleasedChange[]>): Set<string> {
  const references = new Set<string>();
  for (const release of changes) {
    for (const { light, dark } of release.flatMap(({ media }) => media)) {
      if (light) references.add(light);
      if (dark) references.add(dark);
    }
  }
  return references;
}

function mediaError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchDescription(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { error: `HTTP ${response.status} at ${url}` };
    return { value: (await response.json()) as unknown };
  } catch (error) {
    return { error: `${url}: ${mediaError(error)}` };
  }
}

async function loadPublishedMedia(references: Set<string>): Promise<Map<string, ShownMediaFile>> {
  const descriptions = new Map<string, ReturnType<typeof fetchDescription>>();
  const files = new Map<string, ShownMediaFile>();
  await Promise.all(
    [...references].map(async (reference) => {
      const url = mediaUrl(mediaDescriptionFile(reference));
      const description = descriptions.get(url) ?? fetchDescription(url);
      descriptions.set(url, description);
      const resolution = resolvePublishedMedia(reference, await description, strict);
      if ("warning" in resolution) {
        console.warn(resolution.warning);
        return;
      }
      files.set(reference, resolution.file);
    }),
  );
  return files;
}

async function localDimensions(path: string, type: ShownMediaFile["type"]) {
  if (type === "image") {
    const { default: sharp } = await import("sharp");
    const { width, height } = await sharp(path).metadata();
    return { width, height };
  }
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "V:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0:s=x",
      path,
    ],
    { timeout: 10_000 },
  );
  const [width, height] = stdout.trim().split("x").map(Number);
  return { width, height };
}

async function loadLocalMedia(references: Set<string>): Promise<Map<string, ShownMediaFile>> {
  const files = new Map<string, ShownMediaFile>();
  if (references.size === 0) return files;
  if (!process.env.NODEX_MEDIA_STORE && !existsSync(join(repositoryRoot, ".git"))) {
    console.warn(
      "Cannot preview unreleased changelog media without a checkout or NODEX_MEDIA_STORE.",
    );
    return files;
  }

  const store = resolveMediaStore(repositoryRoot);
  await Promise.all(
    [...references].map(async (reference) => {
      const path = join(store, reference);
      try {
        if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`Missing media file ${path}`);
        }
        const type = reference.endsWith(".png") ? "image" : "video";
        const { width, height } = await localDimensions(path, type);
        if (
          !width ||
          !height ||
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width < 0 ||
          height < 0
        ) {
          throw new Error("The file has no usable dimensions.");
        }
        files.set(reference, {
          type,
          width,
          height,
          src: `/@fs/${pathToFileURL(path).pathname.slice(1)}`,
          sources: [],
        });
      } catch (error) {
        console.warn(
          `Cannot preview unreleased changelog media ${reference}: ${mediaError(error)}`,
        );
      }
    }),
  );
  return files;
}

async function loadChangelogReleases(): Promise<ChangelogRelease[]> {
  const releases = parseChangelog(changelog);
  const unreleased = readUnreleasedChangesWithMedia(changeFiles);
  const taggedChanges = readPublishedChanges(releases);
  const backfilledChanges = mergeReleaseMedia(
    parseReleaseMedia(releaseMedia),
    releases,
    ({ version }) => taggedChanges.get(version),
  );
  for (const [version, changes] of backfilledChanges) taggedChanges.set(version, changes);
  const [publishedMedia, localMedia] = await Promise.all([
    loadPublishedMedia(mediaReferences(taggedChanges.values())),
    import.meta.env.DEV ? loadLocalMedia(mediaReferences([unreleased])) : undefined,
  ]);
  return releasesToShow(releases, unreleased, { taggedChanges, publishedMedia, localMedia });
}

let changelogReleases: Promise<ChangelogRelease[]> | undefined;

/** Shares the same release data across the changelog index, entry routes, and feed. */
export function getChangelogReleases(): Promise<ChangelogRelease[]> {
  return (changelogReleases ??= loadChangelogReleases());
}

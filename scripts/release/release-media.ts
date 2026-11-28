import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, parseDocument, Scalar } from "yaml";
import {
  readTaggedChanges,
  upsertMediaItem,
  validateChangeMedia,
  type ChangeMediaItem,
  type UnreleasedChange,
} from "../../src/shared/change-media";
import { RELEASE_MEDIA_PATH, type PublishedRelease } from "../../src/shared/changelog";
import { readChangeFilesAtRef, resolveReleaseRef } from "./changelog";

interface ReleaseMediaAttachment {
  readonly path: string;
  readonly media: readonly ChangeMediaItem[];
}

type ReleaseMedia = ReadonlyMap<string, ReadonlyMap<string, ReleaseMediaAttachment>>;

const attachmentPath = (version: string, slug: string) =>
  `${RELEASE_MEDIA_PATH} (v${version}, ${slug})`;

function parseReleaseMediaDocument(content: string) {
  const document = parseDocument(content, { stringKeys: true, merge: false });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`${RELEASE_MEDIA_PATH} needs valid YAML with unique keys.`);
  }
  return document;
}

function mapping(value: unknown, path: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${path} needs a YAML mapping.`);
}

function readAttachments(document: ReturnType<typeof parseReleaseMediaDocument>): ReleaseMedia {
  let value: unknown;
  try {
    value = document.toJS();
  } catch {
    throw new Error(`${RELEASE_MEDIA_PATH} needs valid YAML.`);
  }

  const releases = new Map<string, ReadonlyMap<string, ReleaseMediaAttachment>>();
  for (const [version, entries] of Object.entries(mapping(value, RELEASE_MEDIA_PATH))) {
    const path = `${RELEASE_MEDIA_PATH} (v${version})`;
    const changes = new Map<string, ReleaseMediaAttachment>();
    for (const [slug, items] of Object.entries(mapping(entries, path))) {
      const source = attachmentPath(version, slug);
      changes.set(slug, { path: source, media: validateChangeMedia(items, source) });
    }
    if (changes.size === 0) throw new Error(`${path} needs at least one change slug.`);
    releases.set(version, changes);
  }
  return releases;
}

export function parseReleaseMedia(content: string): ReleaseMedia {
  return readAttachments(parseReleaseMediaDocument(content));
}

export function readReleaseMedia(cwd: string): ReleaseMedia {
  const path = join(cwd, RELEASE_MEDIA_PATH);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${RELEASE_MEDIA_PATH} must be a regular file.`);
  return parseReleaseMedia(readFileSync(path, "utf8"));
}

export function readReleaseMediaAtRef(cwd: string, ref: string): ReleaseMedia {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const sha = resolveReleaseRef(cwd, ref);
  const file = git("ls-tree", sha, "--", RELEASE_MEDIA_PATH);
  if (!file) return new Map();
  if (!/^100(?:644|755) blob /u.test(file)) {
    throw new Error(`${RELEASE_MEDIA_PATH} at ${ref} must be a regular file.`);
  }
  return parseReleaseMedia(git("show", `${sha}:${RELEASE_MEDIA_PATH}`));
}

export function releaseMediaAttachments(media: ReleaseMedia): readonly ReleaseMediaAttachment[] {
  return [...media.values()].flatMap((changes) => [...changes.values()]);
}

/** Returns the tagged changes for releases with backfills, appending media in file order. */
export function mergeReleaseMedia(
  backfill: ReleaseMedia,
  releases: readonly PublishedRelease[],
  readTag: (release: PublishedRelease) => readonly UnreleasedChange[] | undefined,
): ReadonlyMap<string, readonly UnreleasedChange[]> {
  const merged = new Map<string, readonly UnreleasedChange[]>();
  for (const [version, additions] of backfill) {
    const release = releases.find((release) => release.version === version);
    if (!release) {
      throw new Error(
        `${RELEASE_MEDIA_PATH} references v${version}, which is not a published release.`,
      );
    }
    const changes = readTag(release);
    if (!changes?.length) {
      throw new Error(
        `${RELEASE_MEDIA_PATH} needs change files at stable tag v${version}. Fetch the tag if it is missing.`,
      );
    }
    const slugs = new Set(changes.map(({ slug }) => slug));
    for (const [slug, { path }] of additions) {
      if (!slugs.has(slug))
        throw new Error(`${path} does not match a change slug at tag v${version}.`);
    }
    merged.set(
      version,
      changes.map((change) => {
        const addition = additions.get(change.slug);
        return addition ? { ...change, media: [...change.media, ...addition.media] } : change;
      }),
    );
  }
  return merged;
}

export function validateReleaseMediaTargets(
  cwd: string,
  backfill: ReleaseMedia,
  releases: readonly PublishedRelease[],
): void {
  if (backfill.size === 0) return;
  const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd, encoding: "utf8" });
  const available = new Set(tags.trim().split(/\r?\n/u));
  mergeReleaseMedia(backfill, releases, (release) => {
    const tag = `v${release.version}`;
    if (!available.has(tag)) return undefined;
    return readTaggedChanges(release, readChangeFilesAtRef(cwd, `refs/tags/${tag}`));
  });
}

/** Adds a picture or replaces the item with the same caption in the selected change. */
export function upsertReleaseMedia(
  content: string,
  version: string,
  slug: string,
  item: ChangeMediaItem,
): string {
  const document = parseReleaseMediaDocument(content);
  const releases = readAttachments(document);
  const media = upsertMediaItem(
    releases.get(version)?.get(slug)?.media ?? [],
    item,
    attachmentPath(version, slug),
  );
  if (releases.has(version)) {
    document.setIn([version, slug], media);
  } else {
    const key = new Scalar(version);
    key.type = Scalar.QUOTE_DOUBLE;
    if (isMap(document.contents)) document.contents.flow = false;
    document.add(document.createPair(key, { [slug]: media }));
  }
  return document.toString({ lineWidth: 0 });
}

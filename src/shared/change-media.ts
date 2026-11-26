import { parseDocument } from "yaml";
import { isMediaCaption, MEDIA_FILE } from "./release-media";
import {
  CHANGES_README,
  formatReleaseSections,
  groupChangeEntries,
  readChangeEntries,
  splitChangeFile,
  type ChangeEntry,
  type PublishedRelease,
  type ReleaseNotesSection,
  type RepositoryFile,
} from "./changelog";

export interface ChangeMediaItem {
  readonly caption: string;
  readonly light?: string;
  readonly dark?: string;
}

export interface UnreleasedChange extends Omit<ChangeEntry, "frontMatter"> {
  readonly media: readonly ChangeMediaItem[];
}

const mediaKeys = ["caption", "light", "dark"];

function invalidMedia(path: string, message: string): never {
  throw new Error(`${path} ${message} See ${CHANGES_README}.`);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateChangeMedia(items: unknown, path: string): readonly ChangeMediaItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    invalidMedia(path, "must list at least one item under media.");
  }
  const seen = new Set<string>();
  return items.map((item: unknown) => {
    if (!isMapping(item) || Object.keys(item).some((key) => !mediaKeys.includes(key))) {
      invalidMedia(path, "must use only caption, light and dark in each media item.");
    }
    const { caption } = item;
    if (!isMediaCaption(caption)) {
      invalidMedia(
        path,
        "needs a trimmed, one-line plain-text media caption of at most 120 characters.",
      );
    }
    if (!Object.hasOwn(item, "light") && !Object.hasOwn(item, "dark")) {
      invalidMedia(path, "needs a light or dark file for each media item.");
    }
    const result: { caption: string; light?: string; dark?: string } = { caption };
    for (const theme of ["light", "dark"] as const) {
      if (!Object.hasOwn(item, theme)) continue;
      const name = item[theme];
      if (typeof name !== "string" || !MEDIA_FILE.test(name)) {
        invalidMedia(
          path,
          `needs a ${theme} media file named with a lowercase SHA-256 followed by .png or .mp4.`,
        );
      }
      if (seen.has(name)) invalidMedia(path, `references the media file ${name} more than once.`);
      seen.add(name);
      result[theme] = name;
    }
    return result;
  });
}

function readMedia(frontMatter: string | null, path: string): readonly ChangeMediaItem[] {
  if (frontMatter === null) return [];
  const document = parseDocument(frontMatter.replace(/\r\n?/gu, "\n"), {
    stringKeys: true,
    merge: false,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    invalidMedia(path, "needs valid YAML front matter with unique keys.");
  }
  let value: unknown;
  try {
    value = document.toJS();
  } catch {
    invalidMedia(path, "needs valid YAML front matter.");
  }
  if (!isMapping(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "media")) {
    invalidMedia(path, "must use media as the only front matter key.");
  }
  return validateChangeMedia(value.media, path);
}

/** Reads and validates an entire release set. Changes without front matter have an empty media list. */
export function readUnreleasedChangesWithMedia(
  files: readonly RepositoryFile[],
): readonly UnreleasedChange[] {
  return readChangeEntries(files).map(({ frontMatter, ...change }) => ({
    ...change,
    media: readMedia(frontMatter, change.path),
  }));
}

/** Verifies the text and order before a tagged source can supply entry slugs or media. */
export function readTaggedChanges(
  release: PublishedRelease,
  files: readonly RepositoryFile[],
): readonly UnreleasedChange[] {
  const changes = readUnreleasedChangesWithMedia(files);
  if (changes.length === 0) return changes;

  const tag = `v${release.version}`;
  if (
    formatReleaseSections(groupChangeEntries(changes)) !== formatReleaseSections(release.sections)
  ) {
    throw new Error(
      `The change files at ${tag} do not match its sections in CHANGELOG.md. Check the release's entry text and order against the tag.`,
    );
  }
  return changes;
}

/** Reads the text for release notes after validating the change files and their media references. */
export function readChangeSections(
  files: readonly RepositoryFile[],
): readonly ReleaseNotesSection[] {
  return groupChangeEntries(readUnreleasedChangesWithMedia(files));
}

/** Adds a media item or replaces a reshoot with the same caption, leaving the entry body intact. */
export function upsertChangeMedia(
  file: RepositoryFile,
  item: ChangeMediaItem,
): { readonly media: readonly ChangeMediaItem[]; readonly body: string } {
  const [change] = readUnreleasedChangesWithMedia([file]);
  if (!change) invalidMedia(file.path, "is not a change.");
  return {
    media: upsertMediaItem(change.media, item, file.path),
    body: splitChangeFile(file).body,
  };
}

export function upsertMediaItem(
  items: readonly ChangeMediaItem[],
  item: ChangeMediaItem,
  path: string,
): readonly ChangeMediaItem[] {
  const media = [...items];
  const previous = media.findIndex(({ caption }) => caption === item.caption);
  if (previous === -1) media.push(item);
  else media[previous] = item;

  return validateChangeMedia(media, path);
}

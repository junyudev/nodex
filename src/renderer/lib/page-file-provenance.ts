import { actorSchema, type Actor } from "../../shared/actor";
import type { LibraryPageFileItem } from "../../shared/library-files";
import type { PageFileTreeFile } from "./page-file-tree";

export type PageFileSource = Actor;
export const pageFileSource = (item: LibraryPageFileItem): PageFileSource | null =>
  item.attachment?.attached_by ?? null;

/** Actor keys retain Member and delegation identity when grouping attachments. */
export const pageFileSourceKey = (source: PageFileSource): string => JSON.stringify(source);
export const parsePageFileSourceKey = (key: string): PageFileSource | null => {
  try {
    const result = actorSchema.safeParse(JSON.parse(key));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

const attachedAtMs = (item: LibraryPageFileItem): number | null => {
  const value = item.attachment?.attached_at;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const toPageFileTreeFile = (
  item: LibraryPageFileItem,
): PageFileTreeFile<LibraryPageFileItem> => {
  const source = pageFileSource(item);
  return {
    fileId: item.file.file_id,
    logicalPath: item.logical_path ?? null,
    defaultName: item.file.default_name,
    sourceKey: source ? pageFileSourceKey(source) : null,
    attachedAtMs: source ? attachedAtMs(item) : null,
    value: item,
  };
};

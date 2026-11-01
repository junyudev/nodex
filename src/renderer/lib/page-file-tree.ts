/**
 * A Page's Files as the tree its paths describe. Paths become folders; Files used only in the
 * Page body have no path and gather in a trailing `In page` group. Each attachment origin is
 * shown once, on the narrowest node it covers: a whole tree from one source states it in the
 * summary, a folder from one source states it on the folder, and anything else on its File.
 */

export interface PageFileTreeFile<T> {
  readonly fileId: string;
  /** The Page path, or null for a File used only in the Page body. */
  readonly logicalPath: string | null;
  readonly defaultName: string;
  /** Who attached the entry, as a stable identity key; null when nothing is recorded. */
  readonly sourceKey: string | null;
  /** When the entry was attached, as epoch milliseconds; null when unknown. */
  readonly attachedAtMs: number | null;
  readonly value: T;
}

/** One origin and the latest time it attached anything under the node that states it. */
export interface PageFileTreeProvenance {
  readonly sourceKey: string;
  readonly latestAttachedAtMs: number | null;
}

export type PageFileTreeRow<T> =
  | {
      readonly kind: "folder";
      readonly key: string;
      /** Folder path without a trailing slash. */
      readonly path: string;
      readonly name: string;
      readonly depth: number;
      readonly expanded: boolean;
      readonly fileCount: number;
      readonly provenance: PageFileTreeProvenance | null;
    }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly name: string;
      readonly depth: 0;
      readonly fileCount: number;
    }
  | {
      readonly kind: "file";
      readonly key: string;
      readonly name: string;
      readonly depth: number;
      readonly file: PageFileTreeFile<T>;
      readonly provenance: PageFileTreeProvenance | null;
    };

export interface PageFileTree<T> {
  /** Visible rows in display order under the current folder expansion. */
  readonly rows: readonly PageFileTreeRow<T>[];
  /** Stated by the summary when every File shares one origin. */
  readonly provenance: PageFileTreeProvenance | null;
  readonly fileCount: number;
}

export const PAGE_FILE_TREE_BODY_GROUP_KEY = "group:in-page";

interface FolderNode<T> {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, FolderNode<T>>;
  readonly files: PageFileTreeFile<T>[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (left: string, right: string): number =>
  collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);

const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const createFolder = <T>(name: string, path: string): FolderNode<T> => ({
  name,
  path,
  folders: new Map(),
  files: [],
});

const insert = <T>(root: FolderNode<T>, file: PageFileTreeFile<T>, path: string): void => {
  const segments = path.split("/").filter(Boolean);
  let folder = root;
  for (const segment of segments.slice(0, -1)) {
    const folderPath = folder.path ? `${folder.path}/${segment}` : segment;
    let child = folder.folders.get(segment);
    if (!child) {
      child = createFolder(segment, folderPath);
      folder.folders.set(segment, child);
    }
    folder = child;
  }
  folder.files.push(file);
};

const collectFiles = <T>(folder: FolderNode<T>): PageFileTreeFile<T>[] => [
  ...folder.files,
  ...[...folder.folders.values()].flatMap(collectFiles),
];

/** The single origin shared by every File, if there is one. */
export const sharedPageFileProvenance = <T>(
  files: readonly PageFileTreeFile<T>[],
): PageFileTreeProvenance | null => {
  const sourceKey = files[0]?.sourceKey ?? null;
  if (sourceKey === null || files.some((file) => file.sourceKey !== sourceKey)) return null;
  const times = files.flatMap((file) => (file.attachedAtMs === null ? [] : [file.attachedAtMs]));
  return { sourceKey, latestAttachedAtMs: times.length ? Math.max(...times) : null };
};

const fileProvenance = <T>(file: PageFileTreeFile<T>): PageFileTreeProvenance | null =>
  file.sourceKey === null
    ? null
    : { sourceKey: file.sourceKey, latestAttachedAtMs: file.attachedAtMs };

/**
 * Builds the visible tree. Folders start expanded; `collapsedFolders` holds folder paths the
 * person folded.
 */
export function buildPageFileTree<T>(
  files: readonly PageFileTreeFile<T>[],
  collapsedFolders: ReadonlySet<string> = new Set(),
): PageFileTree<T> {
  const root = createFolder<T>("", "");
  const bodyOnly: PageFileTreeFile<T>[] = [];
  for (const file of files) {
    if (file.logicalPath) insert(root, file, file.logicalPath);
    else bodyOnly.push(file);
  }

  const provenance = sharedPageFileProvenance(files);
  const rows: PageFileTreeRow<T>[] = [];

  const visit = (folder: FolderNode<T>, depth: number, stated: boolean): void => {
    for (const child of [...folder.folders.values()].sort((a, b) => byName(a.name, b.name))) {
      const shared = stated ? null : sharedPageFileProvenance(collectFiles(child));
      const expanded = !collapsedFolders.has(child.path);
      rows.push({
        kind: "folder",
        key: `folder:${child.path}`,
        path: child.path,
        name: child.name,
        depth,
        expanded,
        fileCount: collectFiles(child).length,
        provenance: shared,
      });
      if (expanded) visit(child, depth + 1, stated || shared !== null);
    }
    for (const file of folder.files.toSorted((a, b) =>
      byName(lastSegment(a.logicalPath ?? ""), lastSegment(b.logicalPath ?? "")),
    )) {
      rows.push({
        kind: "file",
        key: `file:${file.fileId}`,
        name: lastSegment(file.logicalPath ?? file.defaultName),
        depth,
        file,
        provenance: stated ? null : fileProvenance(file),
      });
    }
  };
  visit(root, 0, provenance !== null);

  if (bodyOnly.length > 0) {
    rows.push({
      kind: "group",
      key: PAGE_FILE_TREE_BODY_GROUP_KEY,
      name: "In page",
      depth: 0,
      fileCount: bodyOnly.length,
    });
    for (const file of bodyOnly.toSorted((a, b) => byName(a.defaultName, b.defaultName))) {
      rows.push({
        kind: "file",
        key: `file:${file.fileId}`,
        name: file.defaultName,
        depth: 0,
        file,
        provenance: null,
      });
    }
  }

  return { rows, provenance, fileCount: files.length };
}

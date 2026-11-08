export interface FileTreePathEntry {
  readonly displayPath: string;
  readonly path: string;
}

/** Keeps display collisions distinct without changing the actual file identity. */
export function buildFileTreePaths<T extends FileTreePathEntry>(entries: readonly T[]) {
  const directories = new Set(
    buildFileTreeAncestorPaths(entries.map((entry) => entry.displayPath)),
  );
  const originalPaths = new Set(entries.map((entry) => entry.displayPath));
  const assigned = new Set<string>();
  const pathsByIndex = new Map<number, string>();
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      if (left.entry.displayPath !== right.entry.displayPath) {
        return left.entry.displayPath < right.entry.displayPath ? -1 : 1;
      }
      if (left.entry.path === right.entry.path) return left.index - right.index;
      return left.entry.path < right.entry.path ? -1 : 1;
    });
  for (const { entry, index } of sorted) {
    let treePath = entry.displayPath;
    if (directories.has(treePath) || assigned.has(treePath)) {
      do treePath += "\u2063";
      while (originalPaths.has(treePath) || directories.has(treePath) || assigned.has(treePath));
    }
    pathsByIndex.set(index, treePath);
    assigned.add(treePath);
  }
  return entries.map((entry, index) => ({ entry, treePath: pathsByIndex.get(index)! }));
}

/** Every folder that contains one of `paths`, without a trailing slash, outermost first. */
export function buildFileTreeAncestorPaths(paths: Iterable<string>): string[] {
  const ancestors = new Set<string>();
  for (const rawPath of paths) {
    const path = rawPath.replace(/\/$/, "");
    for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
      ancestors.add(path.slice(0, index));
    }
  }
  return [...ancestors];
}

/**
 * Tree input where every folder is an explicit `folder/` entry, so a diff of two inputs adds and
 * removes folders exactly like files and a folder's expansion is addressable before its children
 * load.
 */
export function withFileTreeFolders(paths: readonly string[]): string[] {
  const result = [...new Set(paths)];
  const present = new Set(result);
  for (const path of paths) {
    const end = path.endsWith("/") ? path.length - 1 : path.length;
    for (let index = path.lastIndexOf("/", end - 1); index > 0;) {
      const folder = path.slice(0, index + 1);
      if (present.has(folder)) break;
      present.add(folder);
      result.push(folder);
      index = path.lastIndexOf("/", index - 1);
    }
  }
  return result;
}

/** Names the placeholder row an expanded folder shows while its entries load. */
export const FILE_TREE_LOADING_ROW_NAME = ".nodex-loading";

/**
 * The rows a tree holds: the given entries, a placeholder inside each loading folder, and every
 * containing folder as an explicit entry.
 */
export function buildFileTreeInput(
  paths: readonly string[],
  loadingDirectoryPaths: readonly string[] = [],
) {
  const taken = new Set(paths.map(stripTrailingSlash));
  const loadingRows = new Set<string>();
  for (const directory of loadingDirectoryPaths) {
    let row = `${stripTrailingSlash(directory)}/${FILE_TREE_LOADING_ROW_NAME}`;
    while (taken.has(row)) row += "_";
    taken.add(row);
    loadingRows.add(row);
  }
  const treePaths = withFileTreeFolders([...paths, ...loadingRows]);
  const folders = treePaths.filter((path) => path.endsWith("/")).map(stripTrailingSlash);
  return { treePaths, folders, loadingRows: loadingRows as ReadonlySet<string> };
}

const stripTrailingSlash = (path: string) => (path.endsWith("/") ? path.slice(0, -1) : path);

export type FileTreePathOperation =
  | { readonly type: "add"; readonly path: string }
  | { readonly type: "remove"; readonly path: string };

/**
 * The batch that turns one tree input into the next. Removals run deepest first, so a folder is
 * empty by the time it is removed, and every other entry keeps its node and expansion.
 */
export function diffFileTreePaths(
  previous: readonly string[],
  next: readonly string[],
): FileTreePathOperation[] {
  const before = new Set(previous);
  const after = new Set(next);
  const operations: FileTreePathOperation[] = [...before]
    .filter((path) => !after.has(path))
    .sort()
    .reverse()
    .map((path) => ({ type: "remove", path }));
  for (const path of after) if (!before.has(path)) operations.push({ type: "add", path });
  return operations;
}

/** The slice of a tree folder handle that expansion needs. */
export interface FileTreeFolderHandle {
  isExpanded(): boolean;
  /** Opens the folder and, like every tree expansion, each collapsed folder above it. */
  expand(): void;
  collapse(): void;
}

const folderDepth = (path: string) => path.split("/").length;

/**
 * Sets exactly the requested folders' own expansion. Opening a folder also opens the folders
 * above it, so folders opened only as a side effect close again afterwards: a collapsed parent
 * stays collapsed while its expanded child keeps its state for the next time the parent opens.
 */
export function applyFileTreeExpansion(
  getFolder: (path: string) => FileTreeFolderHandle | null,
  { expand, collapse }: { readonly expand: Iterable<string>; readonly collapse: Iterable<string> },
) {
  const expanded = new Set(expand);
  const incidental: string[] = [];
  for (const path of [...expanded].sort((left, right) => folderDepth(left) - folderDepth(right))) {
    const folder = getFolder(path);
    if (!folder || folder.isExpanded()) continue;
    for (const ancestor of buildFileTreeAncestorPaths([path])) {
      if (!expanded.has(ancestor) && getFolder(ancestor)?.isExpanded() === false)
        incidental.push(ancestor);
    }
    folder.expand();
  }
  for (const path of new Set([...collapse, ...incidental])) {
    if (expanded.has(path)) continue;
    const folder = getFolder(path);
    if (folder?.isExpanded()) folder.collapse();
  }
}

export function getFileTreeEventPath(event: Event, filesOnly = false): string | null {
  for (const target of event.composedPath()) {
    if (!(target instanceof Element)) continue;
    if (filesOnly && target.getAttribute("data-item-type") !== "file") continue;
    const path =
      target.getAttribute("data-item-path") ?? target.getAttribute("data-file-tree-sticky-path");
    if (path) return path;
  }
  return null;
}

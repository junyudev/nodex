export interface FileTreePathEntry {
  readonly displayPath: string;
  readonly path: string;
}

/** Keeps display collisions distinct without changing the actual file identity. */
export function buildFileTreePaths<T extends FileTreePathEntry>(entries: readonly T[]) {
  const directories = new Set(
    buildFileTreeExpandedPaths(entries.map((entry) => entry.displayPath)),
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

export function buildFileTreeExpandedPaths(paths: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const rawPath of paths) {
    const path = rawPath.replace(/\/$/, "");
    for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
      expanded.add(path.slice(0, index));
    }
  }
  return [...expanded];
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

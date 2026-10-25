import { getWorkspaceFileParentPath } from "./workbench-workspace-context";
import type { FileSearchMatch, FileSearchScope } from "../../shared/file-search";
import {
  normalizeSearchPath,
  resolveSearchResultPath,
  searchPathsEqual,
  searchRootContainsPath,
} from "../../shared/file-search-paths";

interface RecentWorkspaceFile {
  readonly hostId: string;
  readonly path: string;
}

const STORAGE_KEY = "nodex-workspace-search-recent-files";

function readRecentFiles(): RecentWorkspaceFile[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is RecentWorkspaceFile =>
        typeof item === "object" &&
        item !== null &&
        typeof item.hostId === "string" &&
        typeof item.path === "string",
    );
  } catch {
    return [];
  }
}

/** Successful file navigation supplies the first search partitions on that same computer. */
export function recordWorkspaceSearchFile(hostId: string, path: string): void {
  try {
    const canonicalPath = resolveSearchResultPath(path, path);
    const previous = readRecentFiles().filter(
      (item) => item.hostId !== hostId || !searchPathsEqual(item.path, path),
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ hostId, path: canonicalPath }, ...previous].slice(0, 100)),
    );
  } catch {
    // Navigation remains available when browser storage is unavailable.
  }
}

export function getWorkspaceSearchPriorityFolders(hostId: string): string[] {
  return readRecentFiles()
    .filter((item) => item.hostId === hostId)
    .map((item) => getWorkspaceFileParentPath(item.path))
    .filter((path): path is string => Boolean(path))
    .filter(
      (path, index, paths) => paths.findIndex((other) => searchPathsEqual(path, other)) === index,
    )
    .slice(0, 20);
}

export function getRecentWorkspaceSearchFiles(scope: FileSearchScope): FileSearchMatch[] {
  return readRecentFiles()
    .filter((item) => item.hostId === scope.hostId)
    .flatMap((item) => {
      const path = normalizeSearchPath(item.path);
      const root = scope.roots.find((root) => searchRootContainsPath(root, path));
      if (!root && scope.roots.length > 0) return [];
      const relativePath = root
        ? path.slice(normalizeSearchPath(root).replace(/\/+$/u, "").length + 1)
        : path;
      return [
        {
          root: root ?? getWorkspaceFileParentPath(path),
          relativePath,
          path: relativePath,
          fsPath: item.path,
          label: path.split("/").at(-1) || path,
          directoryPath: getWorkspaceFileParentPath(relativePath),
          kind: "file" as const,
        },
      ];
    })
    .slice(0, 10);
}

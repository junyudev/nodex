import { useEffect, useState } from "react";
import type { FileSearchMatch, FileSearchScope } from "../../shared/file-search";
import {
  isAbsoluteSearchPath,
  normalizeSearchPath,
  resolveSearchResultPath,
  searchRootContainsPath,
} from "../../shared/file-search-paths";
import { readWorkspaceFileMetadata } from "./workspace-file-operations";
import { getWorkspaceFileParentPath } from "./workbench-workspace-context";
import { getRecentWorkspaceSearchFiles } from "./workspace-search-recent-files";
import { resolveCommandPaletteFilePath } from "./command-palette-workspace-operations";
import { useFileSearch } from "./use-file-search";

function missingPath(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  if ("code" in cause && (cause.code === "not_found" || cause.code === "ENOENT")) return true;
  return /ENOENT|No such file or directory|\(os error 2\)/.test(cause.message);
}

/** Explicit paths are host lookups; names use the shared native search session. */
export function useCommandPaletteFileSearch(input: {
  readonly enabled: boolean;
  readonly query: string;
  readonly scope: FileSearchScope | null;
  readonly showRecent: boolean;
  /** Explicit folder overrides constrain absolute paths; default project roots do not. */
  readonly restrictToRoots?: boolean;
}) {
  const query = input.query.trim();
  const hostId = input.scope?.hostId ?? "local";
  const direct = isAbsoluteSearchPath(query) || query.startsWith("~/") || query.startsWith("~\\");
  const native = useFileSearch({ ...input, enabled: input.enabled && !direct });
  const [retryTick, retry] = useState(0);
  const rootsKey = JSON.stringify(input.scope?.roots ?? []);
  const key = JSON.stringify([hostId, rootsKey, input.restrictToRoots, query, retryTick]);
  const [lookup, setLookup] = useState<{
    key: string;
    match: FileSearchMatch | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!input.enabled || !direct) return;
    let current = true;
    const roots = JSON.parse(rootsKey) as string[];
    void resolveCommandPaletteFilePath(hostId, query)
      .then(async (resolvedPath) => {
        if (!current) return;
        const path = resolveSearchResultPath(resolvedPath, resolvedPath);
        if (input.restrictToRoots && !roots.some((root) => searchRootContainsPath(root, path))) {
          setLookup({ key, error: null, match: null });
          return;
        }
        const metadata = await readWorkspaceFileMetadata({ hostId, path });
        if (!current) return;
        const normalized = normalizeSearchPath(path);
        setLookup({
          key,
          error: null,
          match: {
            root: getWorkspaceFileParentPath(path),
            relativePath: normalized.split("/").at(-1) || normalized,
            path,
            fsPath: path,
            label: normalized.split("/").at(-1) || normalized,
            directoryPath: getWorkspaceFileParentPath(path),
            kind: metadata.isFile ? "file" : "directory",
          },
        });
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setLookup({
          key,
          match: null,
          error: missingPath(cause)
            ? null
            : cause instanceof Error
              ? cause.message
              : "Couldn't check path",
        });
      });
    return () => {
      current = false;
    };
  }, [input.enabled, input.restrictToRoots, direct, hostId, query, key, rootsKey]);
  const retryLookup = () => retry((value) => value + 1);
  if (!input.enabled) return { matches: [], loading: false, error: null, retry: null };
  if (!query && input.showRecent)
    return {
      matches: getRecentWorkspaceSearchFiles(input.scope ?? { hostId, roots: [] }),
      loading: false,
      error: null,
      retry: null,
    };
  if (!direct) return { ...native, retry: null };
  if (lookup?.key !== key) return { matches: [], loading: true, error: null, retry: null };
  return {
    matches: lookup.match ? [lookup.match] : [],
    loading: false,
    error: lookup.error,
    retry: lookup.error ? retryLookup : null,
  };
}

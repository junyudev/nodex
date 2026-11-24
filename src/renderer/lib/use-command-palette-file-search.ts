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
import { useFileSearch, type FileSearchState } from "./use-file-search";

function missingPath(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  if ("code" in cause && (cause.code === "not_found" || cause.code === "ENOENT")) return true;
  return /ENOENT|No such file or directory|\(os error 2\)/.test(cause.message);
}

export interface CommandPaletteFileSearchState extends Omit<FileSearchState, "retry"> {
  /** A search or path check that could not run; selecting it runs it again. */
  readonly retry: { readonly target: "files" | "path"; readonly run: () => void } | null;
}

const IDLE: CommandPaletteFileSearchState = {
  matches: [],
  loading: false,
  incomplete: null,
  retry: null,
};

/** Explicit paths are host lookups; names use the shared native search session. */
export function useCommandPaletteFileSearch(input: {
  readonly enabled: boolean;
  readonly query: string;
  readonly scope: FileSearchScope | null;
  readonly showRecent: boolean;
  /** Explicit folder overrides constrain absolute paths; default project roots do not. */
  readonly restrictToRoots?: boolean;
}): CommandPaletteFileSearchState {
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
    failed: boolean;
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
          setLookup({ key, failed: false, match: null });
          return;
        }
        const metadata = await readWorkspaceFileMetadata({ hostId, path });
        if (!current) return;
        const normalized = normalizeSearchPath(path);
        setLookup({
          key,
          failed: false,
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
        if (!missingPath(cause)) console.warn("Could not check path", cause);
        setLookup({ key, match: null, failed: !missingPath(cause) });
      });
    return () => {
      current = false;
    };
  }, [input.enabled, input.restrictToRoots, direct, hostId, query, key, rootsKey]);
  if (!input.enabled) return IDLE;
  if (!query && input.showRecent)
    return {
      ...IDLE,
      matches: getRecentWorkspaceSearchFiles(input.scope ?? { hostId, roots: [] }),
    };
  if (!direct)
    return {
      ...native,
      retry: native.retry && { target: "files", run: native.retry },
    };
  if (lookup?.key !== key) return { ...IDLE, loading: true };
  return {
    ...IDLE,
    matches: lookup.match ? [lookup.match] : [],
    retry: lookup.failed ? { target: "path", run: () => retry((value) => value + 1) } : null,
  };
}

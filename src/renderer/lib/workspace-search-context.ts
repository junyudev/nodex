import type { FileSearchScope } from "../../shared/file-search";
import { compactFileSearchRoots } from "../../shared/file-search-paths";

export interface WorkspaceSearchContext extends FileSearchScope {
  readonly skillRoots: readonly string[];
}

/** A worktree replaces the primary checkout; secondary Project roots remain in context. */
export function resolveWorkspaceSearchContext(input: {
  readonly hostId: string;
  readonly projectRoots: readonly string[];
  readonly executionCwd: string | null;
  readonly workspaceBrowserRoot: string | null;
  readonly isWorktree: boolean;
  readonly isCloud: boolean;
}): WorkspaceSearchContext | null {
  if (input.isCloud) return null;
  const projectRoots = [...new Set(input.projectRoots.map((root) => root.trim()).filter(Boolean))];
  const cwd = input.executionCwd?.trim() || null;
  const roots =
    cwd && input.isWorktree
      ? [cwd, ...projectRoots.slice(1)]
      : projectRoots.length > 0
        ? projectRoots
        : [input.workspaceBrowserRoot?.trim() || cwd].filter((root): root is string =>
            Boolean(root),
          );
  return {
    hostId: input.hostId,
    roots: compactFileSearchRoots(roots),
    skillRoots: [...new Set([...(cwd ? [cwd] : []), ...roots])],
  };
}

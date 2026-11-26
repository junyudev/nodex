import * as path from "node:path";
import { normalizeWorktreePathForIdentity } from "./codex-managed-worktree-effects";
import type { CodexThreadExecutionLocation } from "./codex-thread-handoff-journal";

const isOutside = (relative: string) =>
  relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

/**
 * The root a relocation moves from: the managed checkout itself, never a nested cwd that a
 * Session may list first among its roots. The chat and every descendant sharing its workspace
 * map relative to this same root.
 */
export function relocationSourceRoot(source: CodexThreadExecutionLocation): string {
  return source.managedWorktreePath ?? source.workspaceRoots[0] ?? source.cwd;
}

/** Map the cwd relative to the old workspace and retain the order of independent roots. */
export function planWorkspaceRelocation(
  source: CodexThreadExecutionLocation,
  checkout: string,
): { readonly mappedCwd: string; readonly additionalRoots: readonly string[] } {
  const sourceRoot = relocationSourceRoot(source);
  const relative = path.relative(sourceRoot, source.cwd);
  const replacedRoots = new Set(
    [sourceRoot, source.workspaceRoots[0] ?? sourceRoot, checkout].map(
      normalizeWorktreePathForIdentity,
    ),
  );
  return {
    mappedCwd: isOutside(relative) ? checkout : path.join(checkout, relative),
    additionalRoots: source.workspaceRoots.filter(
      (root) => !replacedRoots.has(normalizeWorktreePathForIdentity(root)),
    ),
  };
}

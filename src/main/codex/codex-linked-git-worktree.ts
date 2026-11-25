import * as path from "node:path";

export const LINKED_GIT_WORKTREE_PROBE = [
  "rev-parse",
  "--path-format=absolute",
  "--show-toplevel",
  "--git-dir",
  "--git-common-dir",
] as const;

/** A linked checkout has a private Git directory distinct from the common repository. */
export function linkedGitWorktreeRoot(output: string | null): string | null {
  const [root, gitDir, commonDir] = output?.trim().split(/\r?\n/u) ?? [];
  if (!root || !gitDir || !commonDir || ![root, gitDir, commonDir].every(path.isAbsolute))
    return null;
  return path.relative(gitDir, commonDir) !== "" ? root : null;
}

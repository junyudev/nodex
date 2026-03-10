import {
  DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX,
  normalizeWorktreeAutoBranchPrefix,
} from "../../shared/worktree-auto-branch";

export {
  DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX,
  normalizeWorktreeAutoBranchPrefix,
};

export const WORKTREE_AUTO_BRANCH_PREFIX_STORAGE_KEY =
  "nodex-worktree-auto-branch-prefix-v1";

export function readWorktreeAutoBranchPrefix(): string {
  try {
    const raw = localStorage.getItem(WORKTREE_AUTO_BRANCH_PREFIX_STORAGE_KEY);
    return normalizeWorktreeAutoBranchPrefix(raw);
  } catch {
    return DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX;
  }
}

export function writeWorktreeAutoBranchPrefix(value: string): string {
  const normalized = normalizeWorktreeAutoBranchPrefix(value);
  try {
    localStorage.setItem(WORKTREE_AUTO_BRANCH_PREFIX_STORAGE_KEY, normalized);
  } catch {
    // Ignore localStorage failures.
  }
  return normalized;
}

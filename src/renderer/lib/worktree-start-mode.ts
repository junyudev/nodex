import type { WorktreeStartMode } from "./types";

const WORKTREE_START_MODE_STORAGE_KEY = "nodex-worktree-start-mode-v1";

function normalizeWorktreeStartMode(value: unknown): WorktreeStartMode {
  return value === "autoBranch" ? "autoBranch" : "detachedHead";
}

export function readWorktreeStartMode(): WorktreeStartMode {
  try {
    const raw = localStorage.getItem(WORKTREE_START_MODE_STORAGE_KEY);
    return normalizeWorktreeStartMode(raw);
  } catch {
    return "detachedHead";
  }
}

export function writeWorktreeStartMode(value: WorktreeStartMode): WorktreeStartMode {
  const normalized = normalizeWorktreeStartMode(value);
  try {
    localStorage.setItem(WORKTREE_START_MODE_STORAGE_KEY, normalized);
  } catch {
    // Ignore localStorage failures.
  }
  return normalized;
}

import { asciiSlug } from "./ascii-name";

export const DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX = "nodex/";
export const DEFAULT_WORKTREE_THREAD_SLUG = "thread";
const MAX_WORKTREE_SLUG_WORDS = 5;

function sanitizePrefixSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeWorktreeAutoBranchPrefix(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX;
  }

  const segments = value
    .trim()
    .split("/")
    .map((segment) => sanitizePrefixSegment(segment))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX;
  }

  return `${segments.join("/")}/`;
}

export function buildWorktreeThreadSlug(value: string | null | undefined): string {
  return (
    asciiSlug(value ?? "", { maxWords: MAX_WORKTREE_SLUG_WORDS }) || DEFAULT_WORKTREE_THREAD_SLUG
  );
}

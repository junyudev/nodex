import type { FileDiffMetadata } from "@pierre/diffs";
import type { GitStatus } from "@pierre/trees";
import type { GitReviewFileStatus } from "../../shared/types";
import { buildFileTreeExpandedPaths } from "./file-tree-paths";

export function buildReviewFileTreeDefaultExpandedPaths(
  entries: readonly { readonly displayPath: string }[],
): string[] {
  return buildFileTreeExpandedPaths(entries.map((entry) => entry.displayPath));
}

/** A turn patch describes its own change, independently of today's worktree status. */
export function reviewFileStatusFromDiff(type: FileDiffMetadata["type"]): GitReviewFileStatus {
  switch (type) {
    case "change":
      return "modified";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "new":
      return "added";
    case "deleted":
      return "deleted";
  }
}

export function reviewFileTreeGitStatus(status: GitReviewFileStatus): GitStatus {
  switch (status) {
    case "added":
    case "deleted":
    case "modified":
    case "renamed":
    case "untracked":
      return status;
    case "copied":
      return "added";
    case "type-changed":
    case "unmerged":
      return "modified";
  }
}

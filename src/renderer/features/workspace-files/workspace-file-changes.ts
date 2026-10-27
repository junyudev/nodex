import type { GitReviewBaseBranchResult, GitReviewFileSummary } from "@/lib/types";
import type { ReviewSourceIntent } from "@/features/review/model/review-view-state";
import type { WorkspaceFileGitSource } from "./workspace-file-git-model";
import { getWorkspaceRelativePath, resolveWorkspaceTreeFilePath } from "./workspace-file-model";

export type WorkspaceFileComparison = ReviewSourceIntent;
export interface WorkspaceFileRootChange extends GitReviewFileSummary {
  /** Path within the selected browse root. */
  readonly path: string;
  readonly gitPath: string;
  readonly absolutePath: string;
}

export interface WorkspaceFileComparisonContext {
  readonly comparison?: WorkspaceFileComparison | null;
  readonly comparisonRoot?: string | null;
  readonly repositoryRoot: string | null;
}

export function shouldDeriveWorkspaceFileComparison({
  comparison,
  comparisonRoot,
  repositoryRoot,
}: WorkspaceFileComparisonContext): boolean {
  if (comparison?.kind === "last-turn" || comparison?.kind === "selected-turn") return false;
  return (
    comparisonRoot === undefined ||
    comparison === null ||
    (comparisonRoot !== null && repositoryRoot !== null && comparisonRoot !== repositoryRoot)
  );
}

/** A comparison follows its repository; a last-turn comparison follows the conversation. */
export function resolveWorkspaceFileComparison(
  input: WorkspaceFileComparisonContext & {
    /** Undefined means the base-branch query has not settled. */
    readonly baseBranch: GitReviewBaseBranchResult | null | undefined;
  },
): WorkspaceFileComparison | null {
  if (!shouldDeriveWorkspaceFileComparison(input)) return input.comparison ?? null;
  if (input.baseBranch === undefined) return null;
  // Without a remote base there is no branch to compare against, so show working-tree edits.
  const baseRef = input.baseBranch?.remote;
  return baseRef ? { kind: "git", mode: "branch", baseRef } : { kind: "git", mode: "unstaged" };
}

/** The Git source a changed file opens with, so it shows the changes the tree listed. */
export function workspaceFileGitSourceForComparison(
  comparison: WorkspaceFileComparison | null,
): WorkspaceFileGitSource | null {
  if (comparison?.kind === "git")
    return comparison.mode === "branch"
      ? { kind: "branch", baseBranch: comparison.baseRef }
      : { kind: comparison.mode };
  if (comparison?.kind === "commit") return { kind: "commit", commitSha: comparison.sha };
  return null;
}

/** Summaries use Git-root paths; browsing can be scoped to a nested workspace directory. */
export function projectWorkspaceFileChanges({
  files,
  repositoryRoot,
  workspaceRoot,
}: {
  readonly files: readonly GitReviewFileSummary[];
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
}): WorkspaceFileRootChange[] {
  return files.flatMap((file) => {
    const absolutePath = resolveWorkspaceTreeFilePath(repositoryRoot, file.path);
    const path = getWorkspaceRelativePath(workspaceRoot, absolutePath);
    if (!path) return [];
    return [{ ...file, path, gitPath: file.path, absolutePath }];
  });
}

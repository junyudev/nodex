import { expect, test } from "vite-plus/test";
import type { GitReviewFileSummary } from "@/lib/types";
import { buildReviewFileSafety } from "../../../shared/review-file-safety";
import {
  projectWorkspaceFileChanges,
  resolveWorkspaceFileComparison,
} from "./workspace-file-changes";

test("uses the selected comparison only for its repository, preserving transcript comparisons", () => {
  const comparison = { kind: "git", mode: "staged" } as const;
  expect(
    resolveWorkspaceFileComparison({
      comparison,
      comparisonRoot: "/repo",
      repositoryRoot: "/repo",
      baseBranch: undefined,
    }),
  ).toBe(comparison);
  expect(
    resolveWorkspaceFileComparison({
      comparison,
      comparisonRoot: null,
      repositoryRoot: "/repo",
      baseBranch: undefined,
    }),
  ).toBe(comparison);
  expect(
    resolveWorkspaceFileComparison({
      comparison,
      comparisonRoot: "/other",
      repositoryRoot: "/repo",
      baseBranch: undefined,
    }),
  ).toBeNull();
  expect(
    resolveWorkspaceFileComparison({ comparison, repositoryRoot: "/repo", baseBranch: null }),
  ).toEqual({ kind: "git", mode: "unstaged" });
  const lastTurn = { kind: "last-turn", threadId: "thread" } as const;
  expect(
    resolveWorkspaceFileComparison({
      comparison: lastTurn,
      repositoryRoot: null,
      baseBranch: undefined,
    }),
  ).toBe(lastTurn);
});

test("auto comparison waits for base metadata and compares a branch only against a remote base", () => {
  expect(
    resolveWorkspaceFileComparison({ repositoryRoot: "/repo", baseBranch: undefined }),
  ).toBeNull();
  expect(
    resolveWorkspaceFileComparison({
      repositoryRoot: "/repo",
      baseBranch: { cwd: "/repo", remote: "origin/main", local: "main", errorMessage: null },
    }),
  ).toEqual({ kind: "git", mode: "branch", baseRef: "origin/main" });
  expect(
    resolveWorkspaceFileComparison({
      repositoryRoot: "/repo",
      baseBranch: { cwd: "/repo", remote: null, local: "main", errorMessage: null },
    }),
  ).toEqual({ kind: "git", mode: "unstaged" });
});

test("projects repository changes into the browse root without losing rename or deletion identity", () => {
  const files: GitReviewFileSummary[] = ["src/a.ts", "src/deleted.ts", "src-other/b.ts"].map(
    (path) => ({
      path,
      previousPath: "old.ts",
      status: "deleted",
      rawStatus: "D",
      oldOid: "base",
      newOid: null,
      revision: "revision",
      additions: null,
      deletions: null,
      safety: buildReviewFileSafety(),
    }),
  );
  const projected = projectWorkspaceFileChanges({
    files,
    repositoryRoot: "/repo",
    workspaceRoot: "/repo/src",
  });
  expect(
    projected.map(({ path, gitPath, absolutePath }) => ({ path, gitPath, absolutePath })),
  ).toEqual([
    { path: "a.ts", gitPath: "src/a.ts", absolutePath: "/repo/src/a.ts" },
    { path: "deleted.ts", gitPath: "src/deleted.ts", absolutePath: "/repo/src/deleted.ts" },
  ]);
  expect(projected[0]).toMatchObject({
    previousPath: "old.ts",
    status: "deleted",
    revision: "revision",
  });
});

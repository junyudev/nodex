import { it } from "@effect/vitest";
import { afterEach, expect } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import {
  applyGitReviewPatch,
  filterGitReviewWorkingTreePaths,
  GitReviewRuntime,
  invalidateGitReviewSnapshot,
  initializeGitRepositoryAndReadReviewSnapshot,
  readBranchDiffStats,
  readGitReviewBaseBranch,
  readGitReviewBlameFile,
  readGitReviewBranchCommits,
  readGitReviewCatFile,
  readGitReviewDiff,
  readGitReviewGeneratedPaths,
  readGitReviewPatch,
  readGitReviewRepositoryMetadata,
  readGitReviewSnapshot,
  readGitReviewSummary,
  resolveGitMergeBase,
  searchGitReview,
} from "./git-review-operations";
import { makeGitCommandRunner } from "./git-command-runner";
import * as GitCommandPlatformNode from "../platform/node/GitCommandPlatformNode";
import type {
  GitReviewSearchResult,
  ReviewDiffResult,
  ReviewDiffSuccessResult,
} from "../../shared/types";

type GitReviewSearchSuccess = Extract<GitReviewSearchResult, { type: "success" }>;

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initializeRepository(cwd: string): void {
  runGit(cwd, ["init", "-b", "main"]);
  runGit(cwd, ["config", "user.name", "Nodex Test"]);
  runGit(cwd, ["config", "user.email", "nodex@example.com"]);
}

function commitAll(cwd: string, message: string): void {
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", message]);
}

function expectSuccessfulDiff(result: ReviewDiffResult): asserts result is ReviewDiffSuccessResult {
  expect(result.type).toBe("success");
  if (result.type !== "success") throw new Error("Expected a successful diff.");
}

function expectSuccessfulSearch(
  result: GitReviewSearchResult,
): asserts result is GitReviewSearchSuccess {
  expect(result.type).toBe("success");
  if (result.type !== "success") throw new Error("Expected search result.");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

it.layer(GitCommandPlatformNode.nodeLive)("git review service", (it) => {
  const runtimeTest = (name: string, run: () => Promise<void>): void => {
    it.effect(name, () =>
      makeGitCommandRunner({ environment: process.env }).pipe(
        Effect.flatMap((runner) =>
          Effect.promise(() =>
            new GitReviewRuntime({ commandRunner: runner }).run(new AbortController().signal, run),
          ),
        ),
      ),
    );
  };

  runtimeTest("reports non-git directories without throwing", async () => {
    const cwd = createTempDir("nodex-git-review-non-git-");

    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "unstaged",
    });

    expect(snapshot.isGitRepository).toBe(false);
    expect(snapshot.files.length).toBe(0);
    expect(snapshot.patch).toBe("");
  });

  runtimeTest("preserves local and remote base-branch identities", async () => {
    const cwd = createTempDir("nodex-git-review-base-branch-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "base\n", "utf8");
    commitAll(cwd, "initial");
    runGit(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    runGit(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    await expect(readGitReviewBaseBranch({ cwd })).resolves.toEqual({
      cwd,
      local: "main",
      remote: "origin/main",
      errorMessage: null,
    });
  });

  runtimeTest("filters ignored and unchanged watcher paths with Git status", async () => {
    const cwd = createTempDir("nodex-git-review-path-filter-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, ".gitignore"), "ignored/\n", "utf8");
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    mkdirSync(path.join(cwd, "ignored"));
    const ignoredPath = path.join(cwd, "ignored", "agent.log");
    const trackedPath = path.join(cwd, "README.md");
    writeFileSync(ignoredPath, "noise\n", "utf8");

    const unchanged = await filterGitReviewWorkingTreePaths({
      root: cwd,
      changedPaths: [ignoredPath, trackedPath],
    });
    expect(unchanged).toEqual({ type: "filtered", changedPaths: [] });

    writeFileSync(trackedPath, "alpha\nbeta\n", "utf8");
    const changed = await filterGitReviewWorkingTreePaths({
      root: cwd,
      changedPaths: [ignoredPath, trackedPath],
    });
    expect(changed).toEqual({
      type: "filtered",
      changedPaths: [trackedPath],
    });

    const unknown = await filterGitReviewWorkingTreePaths({
      root: cwd,
      changedPaths: [path.join(cwd, "..", "outside.txt")],
    });
    expect(unknown).toEqual({ type: "full" });
  });

  runtimeTest("returns unstaged snapshots with tracked and untracked files", async () => {
    const cwd = createTempDir("nodex-git-review-unstaged-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    writeFileSync(path.join(cwd, "new-file.ts"), "export const staged = false;\n", "utf8");

    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "unstaged",
    });

    expect(snapshot.isGitRepository).toBe(true);
    expect(snapshot.files.length).toBe(2);
    expect(snapshot.files.some((file) => file.path === "README.md")).toBe(true);
    expect(snapshot.files.some((file) => file.path === "new-file.ts")).toBe(true);
    expect(snapshot.patch).toBe("");
  });

  runtimeTest("reports untracked binary files without decoding them as text", async () => {
    const cwd = createTempDir("nodex-git-review-untracked-binary-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    writeFileSync(
      path.join(cwd, "image.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, ...Buffer.from("secret-binary-body")]),
    );

    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "unstaged",
    });
    const file = snapshot.files.find((candidate) => candidate.path === "image.png") ?? null;
    const diff = await readGitReviewDiff({
      cwd,
      source: "unstaged",
      files: [
        {
          path: "image.png",
          status: file?.status ?? "untracked",
          revision: file?.revision,
        },
      ],
      snapshotGeneration: snapshot.snapshotGeneration,
    });
    expectSuccessfulDiff(diff);
    const bodySearch = await searchGitReview({
      cwd,
      source: "unstaged",
      query: "secret-binary-body",
    });
    const pathSearch = await searchGitReview({
      cwd,
      source: "unstaged",
      query: "image.png",
    });
    expectSuccessfulSearch(bodySearch);
    expectSuccessfulSearch(pathSearch);

    expect(file !== null).toBe(true);
    expect(file?.safety.binary ?? false).toBe(true);
    expect(file ? file.additions : "missing").toBe(null);
    expect(file ? file.deletions : "missing").toBe(null);
    expect(snapshot.patch.includes("secret-binary-body")).toBe(false);
    expect(diff.files[0]?.loadStatus ?? "").toBe("binary");
    expect(diff.files[0]?.diff ?? "not-empty").toBe("");
    expect(bodySearch.matches.length).toBe(0);
    expect(pathSearch.matches[0]?.path ?? "").toBe("image.png");
  });

  runtimeTest("returns staged snapshots from the git index", async () => {
    const cwd = createTempDir("nodex-git-review-staged-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    runGit(cwd, ["add", "README.md"]);

    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "staged",
    });

    expect(snapshot.isGitRepository).toBe(true);
    expect(snapshot.files.length).toBe(1);
    expect(snapshot.files[0]?.path).toBe("README.md");
    expect(snapshot.files[0]?.revision !== null).toBe(true);
    const diff = await readGitReviewDiff({
      cwd,
      source: "staged",
      files: [
        {
          path: "README.md",
          status: snapshot.files[0]?.status ?? "modified",
          revision: snapshot.files[0]?.revision,
        },
      ],
      snapshotGeneration: snapshot.snapshotGeneration,
    });
    expectSuccessfulDiff(diff);
    expect(diff.patch.includes("@@ -1 +1,2 @@")).toBe(true);
  });

  runtimeTest("reports staged binary files from numstat metadata", async () => {
    const cwd = createTempDir("nodex-git-review-staged-binary-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    writeFileSync(
      path.join(cwd, "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, ...Buffer.from("binary-logo-body")]),
    );
    runGit(cwd, ["add", "logo.png"]);

    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "staged",
    });

    expect(snapshot.files.length).toBe(1);
    expect(snapshot.files[0]?.path ?? "").toBe("logo.png");
    expect(snapshot.files[0]?.safety.binary ?? false).toBe(true);
    expect(snapshot.files[0] ? snapshot.files[0].additions : "missing").toBe(null);
    expect(snapshot.files[0] ? snapshot.files[0].deletions : "missing").toBe(null);
  });

  runtimeTest("returns branch snapshots against the default branch", async () => {
    const cwd = createTempDir("nodex-git-review-branch-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    runGit(cwd, ["checkout", "--quiet", "-b", "feature/review"]);
    writeFileSync(path.join(cwd, "feature.ts"), "export const branchDiff = true;\n", "utf8");
    commitAll(cwd, "feature");

    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "branch",
    });

    expect(snapshot.isGitRepository).toBe(true);
    expect(snapshot.baseRef).toBe("main");
    expect(snapshot.files.length).toBe(1);
    expect(snapshot.files[0]?.path).toBe("feature.ts");
  });

  runtimeTest("returns branch commits against the merge base", async () => {
    const cwd = createTempDir("nodex-git-review-branch-commits-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    runGit(cwd, ["checkout", "--quiet", "-b", "feature/review"]);
    writeFileSync(path.join(cwd, "feature-a.ts"), "export const featureA = true;\n", "utf8");
    commitAll(cwd, "feat: add feature a");
    writeFileSync(path.join(cwd, "feature-b.ts"), "export const featureB = true;\n", "utf8");
    commitAll(cwd, "fix: add feature b");

    const result = await readGitReviewBranchCommits({
      cwd,
      baseBranch: "main",
      operationSource: "review_model",
    });

    expect(result.errorMessage).toBe(null);
    expect(result.baseBranch).toBe("main");
    expect(result.commits.length).toBe(2);
    expect(result.commits.map((commit) => commit.subject).join("|")).toBe(
      "fix: add feature b|feat: add feature a",
    );
  });

  runtimeTest("returns commit snapshots for a selected commit", async () => {
    const cwd = createTempDir("nodex-git-review-commit-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(path.join(cwd, "feature.ts"), "export const committed = true;\n", "utf8");
    commitAll(cwd, "feature");
    const commitSha = runGit(cwd, ["rev-parse", "HEAD"]).trim();

    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "commit",
      commitSha,
    });

    expect(snapshot.isGitRepository).toBe(true);
    expect(snapshot.source).toBe("commit");
    expect(snapshot.files.length).toBe(1);
    expect(snapshot.files[0]?.path).toBe("feature.ts");
    expect(snapshot.patch).toBe("");
    const diff = await readGitReviewDiff({
      cwd,
      source: "commit",
      commitSha,
      files: [
        {
          path: "feature.ts",
          status: snapshot.files[0]?.status ?? "added",
          revision: snapshot.files[0]?.revision,
        },
      ],
      snapshotGeneration: snapshot.snapshotGeneration,
    });
    expectSuccessfulDiff(diff);
    expect(diff.patch.includes("+++ b/feature.ts")).toBe(true);
  });

  runtimeTest("reviews a root commit against Git's empty tree", async () => {
    const cwd = createTempDir("nodex-git-review-root-commit-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "root.ts"), "export const rootCommit = true;\n", "utf8");
    commitAll(cwd, "root");
    const commitSha = runGit(cwd, ["rev-parse", "HEAD"]).trim();

    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "commit",
      commitSha,
    });
    expect(snapshot.files.map((file) => file.path)).toEqual(["root.ts"]);
    const file = snapshot.files[0];
    if (!file) throw new Error("Expected root commit file.");

    const diff = await readGitReviewDiff({
      cwd,
      source: "commit",
      commitSha,
      files: [
        {
          path: file.path,
          status: file.status,
          revision: file.revision,
        },
      ],
      snapshotGeneration: snapshot.snapshotGeneration,
    });
    expectSuccessfulDiff(diff);
    expect(diff.files[0]?.diff).toContain("export const rootCommit = true;");
  });

  runtimeTest("loads per-file diffs whose Git headers require C-style quoting", async () => {
    const cwd = createTempDir("nodex-git-review-quoted-path-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    const quotedPath = 'quote"needle.ts';
    writeFileSync(path.join(cwd, quotedPath), "export const quotedPath = true;\n", "utf8");
    runGit(cwd, ["add", quotedPath]);

    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "staged",
    });
    const file = snapshot.files.find((candidate) => candidate.path === quotedPath);
    if (!file) throw new Error("Expected quoted-path file.");
    const diff = await readGitReviewDiff({
      cwd,
      source: "staged",
      files: [
        {
          path: file.path,
          status: file.status,
          revision: file.revision,
        },
      ],
      snapshotGeneration: snapshot.snapshotGeneration,
    });
    expectSuccessfulDiff(diff);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.path).toBe(quotedPath);
    expect(diff.files[0]?.diff).toContain("export const quotedPath = true;");
  });

  runtimeTest("returns codex-shaped per-file review diffs", async () => {
    const cwd = createTempDir("nodex-git-review-diff-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    writeFileSync(path.join(cwd, "feature.ts"), "export const feature = true;\n", "utf8");

    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "unstaged",
    });
    const result = await readGitReviewDiff({
      cwd,
      source: "unstaged",
      files: [
        {
          path: "feature.ts",
          status: snapshot.files.find((file) => file.path === "feature.ts")?.status ?? "untracked",
          revision: snapshot.files.find((file) => file.path === "feature.ts")?.revision,
        },
      ],
      snapshotGeneration: snapshot.snapshotGeneration,
    });
    expectSuccessfulDiff(result);

    expect(result.isGitRepository).toBe(true);
    expect(result.files.length).toBe(1);
    expect(result.files[0]?.path).toBe("feature.ts");
    expect(result.files[0]?.loadStatus).toBe("loaded");
    expect(result.patch.includes("README.md")).toBe(false);
  });

  runtimeTest("returns branch diff stats and merge base", async () => {
    const cwd = createTempDir("nodex-git-review-branch-stats-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    const mainHead = runGit(cwd, ["rev-parse", "HEAD"]).trim();
    runGit(cwd, ["checkout", "--quiet", "-b", "feature/review"]);
    writeFileSync(path.join(cwd, "feature.ts"), "export const branchDiff = true;\n", "utf8");
    commitAll(cwd, "feature");
    writeFileSync(path.join(cwd, "untracked.ts"), "export const untracked = true;\n", "utf8");

    const stats = await readBranchDiffStats({
      cwd,
      baseBranch: "main",
      includeUntrackedFiles: true,
    });
    const trackedStats = await readBranchDiffStats({
      cwd,
      baseBranch: "main",
      includeUntrackedFiles: false,
    });
    const mergeBase = await resolveGitMergeBase({
      cwd,
      baseBranch: "main",
    });

    expect(stats.files.map((file) => file.path).sort()).toEqual(["feature.ts", "untracked.ts"]);
    expect(stats.additions).toBe(2);
    expect(trackedStats.files.map((file) => file.path)).toEqual(["feature.ts"]);
    expect(mergeBase.mergeBaseSha).toBe(mainHead);
  });

  runtimeTest("returns generic review summary totals", async () => {
    const cwd = createTempDir("nodex-git-review-summary-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    const summary = await readGitReviewSummary({
      cwd,
      source: "unstaged",
    });

    expect(summary.type).toBe("success");
    if (summary.type !== "success") throw new Error("Expected summary.");
    expect(summary.source).toBe("unstaged");
    expect(summary.files.length).toBe(1);
    expect(summary.files[0]?.additions).toBe(1);
    expect(summary.files[0]?.deletions).toBe(0);
  });

  runtimeTest("reads a full review patch separately from the metadata snapshot", async () => {
    const cwd = createTempDir("nodex-git-review-full-patch-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    const snapshot = await readGitReviewSnapshot({
      cwd,
      source: "unstaged",
    });
    const patch = await readGitReviewPatch({
      cwd,
      source: "unstaged",
    });

    expect(snapshot.patch).toBe("");
    expect(patch.diff.type).toBe("success");
    const unifiedDiff = patch.diff.type === "success" ? patch.diff.unifiedDiff : "";
    expect(Boolean(unifiedDiff.includes("diff --git a/README.md b/README.md"))).toBe(true);
    expect(Boolean(unifiedDiff.includes("+beta"))).toBe(true);
  });

  runtimeTest("initializes a git repository when requested", async () => {
    const cwd = createTempDir("nodex-git-review-init-");

    const snapshot = await initializeGitRepositoryAndReadReviewSnapshot(cwd);

    expect(snapshot.isGitRepository).toBe(true);
    expect(snapshot.currentBranch).toBe("main");
  });

  runtimeTest("stages an unstaged file patch through git apply", async () => {
    const cwd = createTempDir("nodex-git-review-apply-stage-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    const unstagedSnapshot = await readGitReviewSnapshot({
      cwd,
      source: "unstaged",
    });
    const unstagedDiff = await readGitReviewDiff({
      cwd,
      source: "unstaged",
      files: [
        {
          path: "README.md",
          status: unstagedSnapshot.files[0]?.status ?? "modified",
          revision: unstagedSnapshot.files[0]?.revision,
        },
      ],
      snapshotGeneration: unstagedSnapshot.snapshotGeneration,
    });
    expectSuccessfulDiff(unstagedDiff);

    const result = await applyGitReviewPatch({
      cwd,
      diff: unstagedDiff.patch,
      target: "staged",
    });
    const stagedSnapshot = await readGitReviewSnapshot({
      cwd,
      source: "staged",
    });

    expect(result.status).toBe("success");
    expect(stagedSnapshot.files.length).toBe(1);
    expect(stagedSnapshot.files[0]?.path).toBe("README.md");
  });

  runtimeTest("reverts a staged file patch through git apply", async () => {
    const cwd = createTempDir("nodex-git-review-apply-revert-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    runGit(cwd, ["add", "README.md"]);
    const stagedSnapshot = await readGitReviewSnapshot({
      cwd,
      source: "staged",
    });
    const stagedDiff = await readGitReviewDiff({
      cwd,
      source: "staged",
      files: [
        {
          path: "README.md",
          status: stagedSnapshot.files[0]?.status ?? "modified",
          revision: stagedSnapshot.files[0]?.revision,
        },
      ],
      snapshotGeneration: stagedSnapshot.snapshotGeneration,
    });
    expectSuccessfulDiff(stagedDiff);

    const result = await applyGitReviewPatch({
      cwd,
      diff: stagedDiff.patch,
      target: "staged",
      revert: true,
    });
    const nextStagedSnapshot = await readGitReviewSnapshot({
      cwd,
      source: "staged",
    });

    expect(result.status).toBe("success");
    expect(nextStagedSnapshot.files.length).toBe(0);
  });

  runtimeTest("applies and reverts binary patches through git apply", async () => {
    const cwd = createTempDir("nodex-git-review-apply-binary-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "logo.bin"), Buffer.from([0, 1, 2, 3, 4]));
    commitAll(cwd, "initial");

    writeFileSync(path.join(cwd, "logo.bin"), Buffer.from([0, 1, 9, 9, 4]));
    const binaryPatch = runGit(cwd, ["diff", "--binary", "--", "logo.bin"]);

    const applyResult = await applyGitReviewPatch({
      cwd,
      diff: binaryPatch,
      target: "staged",
    });
    const stagedSnapshot = await readGitReviewSnapshot({
      cwd,
      source: "staged",
    });

    expect(applyResult.status).toBe("success");
    expect(stagedSnapshot.files.length).toBe(1);
    expect(stagedSnapshot.files[0]?.path ?? "").toBe("logo.bin");

    const revertResult = await applyGitReviewPatch({
      cwd,
      diff: binaryPatch,
      target: "staged",
      revert: true,
    });
    const nextStagedSnapshot = await readGitReviewSnapshot({
      cwd,
      source: "staged",
    });

    expect(revertResult.status).toBe("success");
    expect(nextStagedSnapshot.files.length).toBe(0);
  });

  runtimeTest("reads Git objects in a generation-bound batch with disk fallback", async () => {
    const cwd = createTempDir("nodex-git-review-cat-file-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");

    const snapshot = await readGitReviewSnapshot({ cwd, source: "unstaged" });
    const file = snapshot.files[0];
    if (!file) throw new Error("Expected an unstaged file.");
    const result = await readGitReviewCatFile({
      cwd,
      snapshotGeneration: snapshot.snapshotGeneration,
      requests: [
        {
          oid: file.oldOid,
          path: file.previousPath ?? file.path,
        },
        {
          oid: null,
          path: file.path,
          fallbackToDisk: true,
        },
      ],
    });

    expect(result.results[0]).toEqual({
      type: "success",
      lines: ["alpha\n"],
    });
    expect(result.results[1]).toEqual({
      type: "success",
      lines: ["alpha\n", "beta\n"],
    });
  });

  runtimeTest("parses multibyte object sizes and applies the five MiB disk cap", async () => {
    const cwd = createTempDir("nodex-git-review-cat-file-bytes-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "utf8.txt"), "你好🙂\nsecond\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(path.join(cwd, "medium.txt"), Buffer.alloc(2 * 1024 * 1024, 97));
    writeFileSync(path.join(cwd, "too-large.txt"), Buffer.alloc(5_242_881, 98));

    const snapshot = await readGitReviewSnapshot({ cwd, source: "unstaged" });
    const result = await readGitReviewCatFile({
      cwd,
      snapshotGeneration: snapshot.snapshotGeneration,
      requests: [
        { oid: "HEAD:utf8.txt", path: "utf8.txt" },
        { oid: null, path: "medium.txt", fallbackToDisk: true },
        { oid: null, path: "too-large.txt", fallbackToDisk: true },
      ],
    });

    expect(result.results[0]).toEqual({
      type: "success",
      lines: ["你好🙂\n", "second\n"],
    });
    expect(result.results[1]).toMatchObject({ type: "success" });
    expect(result.results[2]).toEqual({
      type: "error",
      error: { type: "too-large", limitBytes: 5_242_880 },
    });
  });

  runtimeTest("rejects stale snapshot generations before publishing file data", async () => {
    const cwd = createTempDir("nodex-git-review-stale-generation-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");
    const snapshot = await readGitReviewSnapshot({ cwd, source: "unstaged" });

    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\ngamma\n", "utf8");
    invalidateGitReviewSnapshot(cwd);
    const catFile = await readGitReviewCatFile({
      cwd,
      snapshotGeneration: snapshot.snapshotGeneration,
      requests: [
        {
          oid: snapshot.files[0]?.oldOid ?? null,
          path: "README.md",
        },
      ],
    });

    expect(catFile.results).toEqual([{ type: "error", error: { type: "unknown" } }]);
    await expect(
      readGitReviewDiff({
        cwd,
        source: "unstaged",
        files: [{ path: "README.md", status: "modified" }],
        snapshotGeneration: snapshot.snapshotGeneration,
      }),
    ).resolves.toEqual({ type: "stale-snapshot", source: "unstaged" });
  });

  runtimeTest("shares snapshot generations across cwd aliases in one repository", async () => {
    const cwd = createTempDir("nodex-git-review-repository-identity-");
    const nestedCwd = path.join(cwd, "packages", "example");
    mkdirSync(nestedCwd, { recursive: true });
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(path.join(cwd, "README.md"), "alpha\nbeta\n", "utf8");

    const [rootSummary, nestedSummary] = await Promise.all([
      readGitReviewSummary({ cwd, source: "unstaged" }),
      readGitReviewSummary({ cwd: nestedCwd, source: "unstaged" }),
    ]);
    if (rootSummary.type !== "success" || nestedSummary.type !== "success") {
      throw new Error("Expected repository summaries.");
    }
    expect(nestedSummary.snapshotGeneration).toBe(rootSummary.snapshotGeneration);
    const [rootMetadata, nestedMetadata] = await Promise.all([
      readGitReviewRepositoryMetadata({ cwd }),
      readGitReviewRepositoryMetadata({ cwd: nestedCwd }),
    ]);
    expect(rootMetadata.isGitRepository).toBe(true);
    expect(nestedMetadata).toMatchObject({
      isGitRepository: true,
      root: rootMetadata.root,
      gitDir: rootMetadata.gitDir,
      commonDir: rootMetadata.commonDir,
    });

    invalidateGitReviewSnapshot(nestedCwd);
    await expect(
      readGitReviewDiff({
        cwd,
        source: "unstaged",
        files: [{ path: "README.md", status: "modified" }],
        snapshotGeneration: rootSummary.snapshotGeneration,
      }),
    ).resolves.toEqual({ type: "stale-snapshot", source: "unstaged" });

    const refreshed = await readGitReviewSummary({
      cwd: nestedCwd,
      source: "unstaged",
    });
    if (refreshed.type !== "success") {
      throw new Error("Expected refreshed summary.");
    }
    expect(refreshed.snapshotGeneration).toBeGreaterThan(rootSummary.snapshotGeneration);
  });

  runtimeTest("reads git blame for file source tabs", async () => {
    const cwd = createTempDir("nodex-git-review-blame-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    const result = await readGitReviewBlameFile({
      cwd,
      path: "README.md",
    });

    expect(result.errorMessage).toBe(null);
    expect(result.lines.length).toBe(1);
    expect(result.lines[0]?.author).toBe("Nodex Test");
  });

  runtimeTest("searches git review content across file paths and contents", async () => {
    const cwd = createTempDir("nodex-git-review-search-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");

    writeFileSync(path.join(cwd, "feature.ts"), "export const reviewSearch = true;\n", "utf8");
    runGit(cwd, ["add", "feature.ts"]);
    const result = await searchGitReview({
      cwd,
      source: "staged",
      query: "reviewsearch",
    });
    expectSuccessfulSearch(result);

    expect(result.matches.length).toBe(1);
    expect(result.matches[0]).toMatchObject({
      path: "feature.ts",
      hunkId: "0",
      snippet: { match: "reviewSearch" },
    });
  });

  runtimeTest("returns trimmed, case-insensitive UTF-16 match offsets", async () => {
    const cwd = createTempDir("nodex-git-review-search-unicode-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(path.join(cwd, "unicode.ts"), "😀 NEEDLE needle\n", "utf8");
    runGit(cwd, ["add", "unicode.ts"]);

    const result = await searchGitReview({
      cwd,
      source: "staged",
      query: "  NeEdLe  ",
    });
    expectSuccessfulSearch(result);

    expect(result.query).toBe("NeEdLe");
    expect(result.matches).toEqual([
      {
        path: "unicode.ts",
        hunkId: "0",
        lineStart: 1,
        lineEnd: 1,
        start: 3,
        end: 9,
        snippet: {
          before: "😀 ",
          match: "NEEDLE",
          after: " needle",
        },
      },
      {
        path: "unicode.ts",
        hunkId: "0",
        lineStart: 1,
        lineEnd: 1,
        start: 10,
        end: 16,
        snippet: {
          before: "😀 NEEDLE ",
          match: "needle",
          after: "",
        },
      },
    ]);
  });

  runtimeTest("decodes Git-quoted UTF-8 paths before path search", async () => {
    const cwd = createTempDir("nodex-git-review-search-unicode-path-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(path.join(cwd, "目录.ts"), "export const value = 1;\n", "utf8");
    runGit(cwd, ["add", "目录.ts"]);

    const result = await searchGitReview({
      cwd,
      source: "staged",
      query: "目录",
    });
    expectSuccessfulSearch(result);

    expect(result.matches).toEqual([
      {
        path: "目录.ts",
        hunkId: "path",
        lineStart: 1,
        lineEnd: 1,
        start: 0,
        end: 2,
        snippet: {
          before: "",
          match: "目录",
          after: ".ts",
        },
      },
    ]);
  });

  runtimeTest("indexes rename paths before body hunks", async () => {
    const cwd = createTempDir("nodex-git-review-search-rename-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "old-needle.ts"), "export const value = 1;\n", "utf8");
    commitAll(cwd, "initial");
    runGit(cwd, ["mv", "old-needle.ts", "new-needle.ts"]);

    const result = await searchGitReview({
      cwd,
      source: "staged",
      query: "needle",
    });
    expectSuccessfulSearch(result);

    const pathText = "old-needle.ts -> new-needle.ts";
    const firstStart = pathText.indexOf("needle");
    const secondStart = pathText.indexOf("needle", firstStart + 1);
    expect(result.matches).toEqual([
      {
        path: "new-needle.ts",
        hunkId: "path",
        lineStart: 1,
        lineEnd: 1,
        start: firstStart,
        end: firstStart + "needle".length,
        snippet: {
          before: pathText.slice(0, firstStart),
          match: "needle",
          after: pathText.slice(firstStart + "needle".length),
        },
      },
      {
        path: "new-needle.ts",
        hunkId: "path",
        lineStart: 1,
        lineEnd: 1,
        start: secondStart,
        end: secondStart + "needle".length,
        snippet: {
          before: pathText.slice(0, secondStart),
          match: "needle",
          after: pathText.slice(secondStart + "needle".length),
        },
      },
    ]);
  });

  runtimeTest("resets offsets and increments hunk ids for each file hunk", async () => {
    const cwd = createTempDir("nodex-git-review-search-hunks-");
    initializeRepository(cwd);
    const baseLines = Array.from(
      { length: 20 },
      (_, index) => `row-${String(index + 1).padStart(2, "0")}`,
    );
    writeFileSync(path.join(cwd, "hunks.txt"), `${baseLines.join("\n")}\n`, "utf8");
    commitAll(cwd, "initial");
    const changedLines = [...baseLines];
    changedLines[1] = "needle first";
    changedLines[17] = "needle second";
    writeFileSync(path.join(cwd, "hunks.txt"), `${changedLines.join("\n")}\n`, "utf8");

    const result = await searchGitReview({
      cwd,
      source: "unstaged",
      query: "needle",
    });
    expectSuccessfulSearch(result);

    expect(
      result.matches.map((match) => ({
        hunkId: match.hunkId,
        lineStart: match.lineStart,
        lineEnd: match.lineEnd,
        start: match.start,
      })),
    ).toEqual([
      { hunkId: "0", lineStart: 1, lineEnd: 5, start: 14 },
      { hunkId: "1", lineStart: 15, lineEnd: 20, start: 28 },
    ]);
  });

  runtimeTest("preserves deterministic untracked-file match order", async () => {
    const cwd = createTempDir("nodex-git-review-search-untracked-order-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(path.join(cwd, "zeta.ts"), "needle zeta\n", "utf8");
    writeFileSync(path.join(cwd, "alpha.ts"), "needle alpha\n", "utf8");

    const result = await searchGitReview({
      cwd,
      source: "unstaged",
      query: "needle",
    });
    expectSuccessfulSearch(result);

    expect(result.matches.map((match) => match.path)).toEqual(["alpha.ts", "zeta.ts"]);
  });

  runtimeTest("preserves path matches for empty untracked files without a patch body", async () => {
    const cwd = createTempDir("nodex-git-review-search-empty-untracked-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "README.md"), "alpha\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(path.join(cwd, "needle-empty.txt"), "", "utf8");

    const result = await searchGitReview({
      cwd,
      source: "unstaged",
      query: "needle-empty",
    });
    expectSuccessfulSearch(result);
    expect(result.matches).toEqual([
      {
        path: "needle-empty.txt",
        hunkId: "path",
        lineStart: 1,
        lineEnd: 1,
        start: 0,
        end: "needle-empty".length,
        snippet: {
          before: "",
          match: "needle-empty",
          after: ".txt",
        },
      },
    ]);
  });

  runtimeTest(
    "resolves generated attributes for turn paths, nested overrides, and unmatched rules",
    async () => {
      const cwd = createTempDir("nodex-git-generated-tree-");
      runGit(cwd, ["init"]);
      mkdirSync(path.join(cwd, "src"));
      writeFileSync(path.join(cwd, ".gitattributes"), "*.ts linguist-generated\n", "utf8");
      writeFileSync(
        path.join(cwd, "src", ".gitattributes"),
        "keep.ts -linguist-generated\n",
        "utf8",
      );
      const paths = [path.join(cwd, "src", "generated.ts"), path.join(cwd, "src", "keep.ts")];
      expect(await readGitReviewGeneratedPaths({ cwd, paths })).toEqual({
        paths: [paths[0]],
        hasLinguistGeneratedAttributes: true,
      });
      const canonicalPath = path.join(realpathSync(cwd), "src", "generated.ts");
      expect(await readGitReviewGeneratedPaths({ cwd, paths: [canonicalPath] })).toEqual({
        paths: [canonicalPath],
        hasLinguistGeneratedAttributes: true,
      });
      expect(await readGitReviewGeneratedPaths({ cwd, paths: ["README.md"] })).toEqual({
        paths: [],
        hasLinguistGeneratedAttributes: true,
      });
      expect(await readGitReviewGeneratedPaths({ cwd, paths: ["../outside.ts"] })).toEqual({
        paths: [],
        hasLinguistGeneratedAttributes: true,
      });
    },
  );

  runtimeTest("excludes generated file paths and bodies from search", async () => {
    const cwd = createTempDir("nodex-git-review-search-generated-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, ".gitattributes"), "generated.ts linguist-generated\n", "utf8");
    writeFileSync(path.join(cwd, "generated.ts"), "export const base = 1;\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(path.join(cwd, "generated.ts"), "export const generatedNeedle = true;\n", "utf8");
    const bodyResult = await searchGitReview({
      cwd,
      source: "unstaged",
      query: "generatedneedle",
    });
    const pathResult = await searchGitReview({
      cwd,
      source: "unstaged",
      query: "generated.ts",
    });
    expectSuccessfulSearch(bodyResult);
    expectSuccessfulSearch(pathResult);

    expect(bodyResult.matches).toEqual([]);
    expect(pathResult.matches).toEqual([]);
  });

  runtimeTest("caps stored search matches at 250 while counting the full diff stream", async () => {
    const cwd = createTempDir("nodex-git-review-search-cap-");
    initializeRepository(cwd);
    writeFileSync(path.join(cwd, "matches.ts"), "export const base = 1;\n", "utf8");
    commitAll(cwd, "initial");
    writeFileSync(
      path.join(cwd, "matches.ts"),
      Array.from({ length: 251 }, (_, index) => `needle ${index}\n`).join(""),
      "utf8",
    );

    const result = await searchGitReview({
      cwd,
      source: "unstaged",
      query: "needle",
    });
    expectSuccessfulSearch(result);

    expect(result.matches).toHaveLength(250);
    expect(result.totalMatches).toBe(251);
    expect(result.isCapped).toBe(true);
  });
});

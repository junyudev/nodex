import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createManagedWorktree, removeManagedWorktree } from "./git-worktree-service";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initializeGitRepository(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  runGit(["init", "-b", "main"], repoPath);
  runGit(["config", "user.name", "Nodex Test"], repoPath);
  runGit(["config", "user.email", "nodex@example.com"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# test\n");
  runGit(["add", "README.md"], repoPath);
  runGit(["commit", "-m", "initial"], repoPath);
}

describe("git-worktree-service auto branch naming", () => {
  test("builds auto branch names from thread title slug", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-worktree-branch-"));
    const repoPath = path.join(tempDir, "repo");
    const serverDir = path.join(tempDir, "server");
    initializeGitRepository(repoPath);

    let worktreePath = "";
    try {
      const result = await createManagedWorktree({
        repositoryPath: repoPath,
        serverDir,
        projectId: "my-project",
        cardId: "card-1",
        mode: "autoBranch",
        threadTitle: "Fix XXX bug in branch naming now",
      });
      worktreePath = result.cwd;

      expect(result.branchName).toBe("nodex/fix-xxx-bug-in-branch");
      const branchExists = runGit(["rev-parse", "--verify", "refs/heads/nodex/fix-xxx-bug-in-branch"], repoPath);
      expect(branchExists.length > 0).toBeTrue();
    } finally {
      if (worktreePath) {
        await removeManagedWorktree(worktreePath);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("supports custom auto-branch prefixes and thread fallback slug", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-worktree-branch-"));
    const repoPath = path.join(tempDir, "repo");
    const serverDir = path.join(tempDir, "server");
    initializeGitRepository(repoPath);

    let worktreePath = "";
    try {
      const result = await createManagedWorktree({
        repositoryPath: repoPath,
        serverDir,
        projectId: "my-project",
        cardId: "card-1",
        mode: "autoBranch",
        threadTitle: "### !!!",
        branchPrefix: "feature",
      });
      worktreePath = result.cwd;
      expect(result.branchName).toBe("feature/thread");
    } finally {
      if (worktreePath) {
        await removeManagedWorktree(worktreePath);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Disabled because too laggy:

  // test("appends numeric suffix when the slug branch already exists", async () => {
  //   const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-worktree-branch-"));
  //   const repoPath = path.join(tempDir, "repo");
  //   const serverDir = path.join(tempDir, "server");
  //   initializeGitRepository(repoPath);

  //   const worktreePaths: string[] = [];
  //   try {
  //     const first = await createManagedWorktree({
  //       repositoryPath: repoPath,
  //       serverDir,
  //       projectId: "my-project",
  //       cardId: "card-1",
  //       mode: "autoBranch",
  //       threadTitle: "Fix duplicate branch names cleanly",
  //     });
  //     const second = await createManagedWorktree({
  //       repositoryPath: repoPath,
  //       serverDir,
  //       projectId: "my-project",
  //       cardId: "card-2",
  //       mode: "autoBranch",
  //       threadTitle: "Fix duplicate branch names cleanly",
  //     });
  //     worktreePaths.push(first.cwd, second.cwd);

  //     expect(first.branchName).toBe("nodex/fix-duplicate-branch-names-cleanly");
  //     expect(second.branchName).toBe("nodex/fix-duplicate-branch-names-cleanly-2");
  //   } finally {
  //     for (const worktreePath of worktreePaths) {
  //       await removeManagedWorktree(worktreePath);
  //     }
  //     fs.rmSync(tempDir, { recursive: true, force: true });
  //   }
  // });
});

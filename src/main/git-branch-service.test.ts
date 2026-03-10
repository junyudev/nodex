import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkoutGitBranch,
  createAndCheckoutGitBranch,
  readGitBranchState,
  watchGitBranch,
} from "./git-branch-service";

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createGitRepo(): string {
  const dir = createTempDir("nodex-git-branch-");
  runGit(["init"], dir);
  runGit(["config", "user.name", "Nodex Test"], dir);
  runGit(["config", "user.email", "test@example.com"], dir);

  writeFileSync(join(dir, "README.md"), "# repo\n");
  runGit(["add", "README.md"], dir);
  runGit(["commit", "-m", "initial"], dir);
  runGit(["branch", "-M", "main"], dir);
  runGit(["checkout", "-b", "feature"], dir);
  runGit(["checkout", "main"], dir);

  return dir;
}

describe("git-branch-service", () => {
  test("reads the current branch and local branches", async () => {
    const repoDir = createGitRepo();
    try {
      const state = await readGitBranchState(repoDir);

      expect(state.currentBranch).toBe("main");
      expect(JSON.stringify(state.branches)).toBe(JSON.stringify(["feature", "main"]));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("returns an empty state for directories that are not git repositories", async () => {
    const dir = createTempDir("nodex-not-a-repo-");
    try {
      const state = await readGitBranchState(dir);

      expect(state.currentBranch === null).toBeTrue();
      expect(JSON.stringify(state.branches)).toBe(JSON.stringify([]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checks out an existing branch and returns refreshed state", async () => {
    const repoDir = createGitRepo();
    try {
      const state = await checkoutGitBranch({
        cwd: repoDir,
        branch: "feature",
      });

      expect(state.currentBranch).toBe("feature");
      expect(runGit(["branch", "--show-current"], repoDir)).toBe("feature");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("rejects option-like checkout targets", async () => {
    const repoDir = createGitRepo();
    let message = "";

    try {
      await checkoutGitBranch({
        cwd: repoDir,
        branch: "--detach",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }

    expect(message.toLowerCase().includes("valid branch name")).toBeTrue();
    expect(message.toLowerCase().includes("detach")).toBeTrue();
  });

  test("creates and checks out a new branch", async () => {
    const repoDir = createGitRepo();
    try {
      const state = await createAndCheckoutGitBranch({
        cwd: repoDir,
        branch: "topic/new-ui",
      });

      expect(state.currentBranch).toBe("topic/new-ui");
      expect(state.branches.includes("topic/new-ui")).toBeTrue();
      expect(runGit(["branch", "--show-current"], repoDir)).toBe("topic/new-ui");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("watches the resolved Git HEAD path and fires after an external checkout", async () => {
    const repoDir = createGitRepo();
    let stopWatching = () => { };

    try {
      let resolveChange: (() => void) | null = null;
      const changeSeen = new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error("Timed out waiting for Git HEAD watch event"));
        }, 1_500);

        resolveChange = () => {
          clearTimeout(timeoutId);
          resolve();
        };
      });

      stopWatching = await watchGitBranch(repoDir, () => {
        if (!resolveChange) return;
        const finish = resolveChange;
        resolveChange = null;
        finish();
      });

      runGit(["checkout", "feature"], repoDir);
      await changeSeen;

      const state = await readGitBranchState(repoDir);
      expect(state.currentBranch).toBe("feature");
    } finally {
      stopWatching();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

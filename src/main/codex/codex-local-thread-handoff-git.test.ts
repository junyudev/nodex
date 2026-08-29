import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  prepareLocalThreadHandoff,
  rollbackLocalThreadHandoff,
} from "./codex-local-thread-handoff-git";

const fixtureRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository(): { readonly root: string; readonly managedRoot: string } {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "nodex-local-handoff-"));
  fixtureRoots.push(fixtureRoot);
  const root = path.join(fixtureRoot, "repository");
  const managedRoot = path.join(fixtureRoot, "managed");
  git(fixtureRoot, "init", "-b", "main", root);
  git(root, "config", "user.email", "handoff@example.com");
  git(root, "config", "user.name", "Handoff Test");
  writeFileSync(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "base");
  git(root, "checkout", "-b", "feature/handoff");
  writeFileSync(path.join(root, "feature.txt"), "feature base\n");
  git(root, "add", "feature.txt");
  git(root, "commit", "-m", "feature");
  return { root, managedRoot };
}

function dirtyRepository(root: string): void {
  writeFileSync(path.join(root, "tracked.txt"), "dirty tracked\n");
  git(root, "add", "tracked.txt");
  writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(path.join(root, "untracked.txt"), "untracked\n");
}

function options() {
  return {
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local thread handoff Git transaction", () => {
  test("moves tracked, binary, and untracked state to a worktree and rolls it back", async () => {
    const fixture = createRepository();
    dirtyRepository(fixture.root);

    const prepared = await prepareLocalThreadHandoff(
      {
        requestId: "handoff-to-worktree",
        hostId: "local",
        managedRoot: fixture.managedRoot,
        nodexHome: path.dirname(fixture.managedRoot),
        projectId: "project-1",
        threadId: "thread-1",
        threadTitle: "Move this task",
        sourceCwd: fixture.root,
        sourceWorkspaceRoot: fixture.root,
        sourceManagedWorktreePath: null,
        destinationCheckoutRoot: null,
      },
      options(),
    );

    expect(prepared.direction).toBe("to-worktree");
    expect(git(fixture.root, "branch", "--show-current")).toBe("main");
    expect(git(fixture.root, "status", "--porcelain")).toBe("");
    expect(git(prepared.destinationWorkspaceRoot, "branch", "--show-current")).toBe(
      "feature/handoff",
    );
    expect(readFileSync(path.join(prepared.destinationWorkspaceRoot, "tracked.txt"), "utf8")).toBe(
      "dirty tracked\n",
    );
    expect(readFileSync(path.join(prepared.destinationWorkspaceRoot, "binary.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(
      readFileSync(path.join(prepared.destinationWorkspaceRoot, "untracked.txt"), "utf8"),
    ).toBe("untracked\n");

    await rollbackLocalThreadHandoff(
      {
        requestId: "rollback-to-worktree",
        hostId: "local",
        prepared,
      },
      options(),
    );

    expect(existsSync(prepared.destinationGitRoot)).toBe(false);
    expect(git(fixture.root, "branch", "--show-current")).toBe("feature/handoff");
    expect(readFileSync(path.join(fixture.root, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
    expect(readFileSync(path.join(fixture.root, "binary.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    expect(readFileSync(path.join(fixture.root, "untracked.txt"), "utf8")).toBe("untracked\n");
  });

  test("moves a worktree branch back to a clean checkout and can compensate", async () => {
    const fixture = createRepository();
    dirtyRepository(fixture.root);
    const toWorktree = await prepareLocalThreadHandoff(
      {
        requestId: "seed-worktree",
        hostId: "local",
        managedRoot: fixture.managedRoot,
        nodexHome: path.dirname(fixture.managedRoot),
        projectId: "project-1",
        threadId: "thread-1",
        threadTitle: "Move this task",
        sourceCwd: fixture.root,
        sourceWorkspaceRoot: fixture.root,
        sourceManagedWorktreePath: null,
        destinationCheckoutRoot: null,
      },
      options(),
    );

    const toCheckout = await prepareLocalThreadHandoff(
      {
        requestId: "handoff-to-checkout",
        hostId: "local",
        managedRoot: fixture.managedRoot,
        nodexHome: path.dirname(fixture.managedRoot),
        projectId: "project-1",
        threadId: "thread-1",
        threadTitle: "Move this task",
        sourceCwd: toWorktree.destinationWorkspaceRoot,
        sourceWorkspaceRoot: toWorktree.destinationWorkspaceRoot,
        sourceManagedWorktreePath: toWorktree.managedWorktreePath,
        destinationCheckoutRoot: fixture.root,
      },
      options(),
    );

    expect(toCheckout.direction).toBe("to-checkout");
    expect(git(fixture.root, "branch", "--show-current")).toBe("feature/handoff");
    expect(readFileSync(path.join(fixture.root, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
    expect(git(toWorktree.destinationWorkspaceRoot, "branch", "--show-current")).toBe("");
    expect(git(toWorktree.destinationWorkspaceRoot, "status", "--porcelain")).toBe("");

    await rollbackLocalThreadHandoff(
      {
        requestId: "rollback-to-checkout",
        hostId: "local",
        prepared: toCheckout,
      },
      options(),
    );

    expect(git(fixture.root, "branch", "--show-current")).toBe("main");
    expect(git(fixture.root, "status", "--porcelain")).toBe("");
    expect(git(toWorktree.destinationWorkspaceRoot, "branch", "--show-current")).toBe(
      "feature/handoff",
    );
    expect(
      readFileSync(path.join(toWorktree.destinationWorkspaceRoot, "tracked.txt"), "utf8"),
    ).toBe("dirty tracked\n");
  });

  test("refuses to overwrite a dirty local checkout", async () => {
    const fixture = createRepository();
    const toWorktree = await prepareLocalThreadHandoff(
      {
        requestId: "seed-clean-worktree",
        hostId: "local",
        managedRoot: fixture.managedRoot,
        nodexHome: path.dirname(fixture.managedRoot),
        projectId: "project-1",
        threadId: "thread-1",
        threadTitle: "Move this task",
        sourceCwd: fixture.root,
        sourceWorkspaceRoot: fixture.root,
        sourceManagedWorktreePath: null,
        destinationCheckoutRoot: null,
      },
      options(),
    );
    writeFileSync(path.join(fixture.root, "local-only.txt"), "do not overwrite\n");

    await expect(
      prepareLocalThreadHandoff(
        {
          requestId: "blocked-to-checkout",
          hostId: "local",
          managedRoot: fixture.managedRoot,
          nodexHome: path.dirname(fixture.managedRoot),
          projectId: "project-1",
          threadId: "thread-1",
          threadTitle: "Move this task",
          sourceCwd: toWorktree.destinationWorkspaceRoot,
          sourceWorkspaceRoot: toWorktree.destinationWorkspaceRoot,
          sourceManagedWorktreePath: toWorktree.managedWorktreePath,
          destinationCheckoutRoot: fixture.root,
        },
        options(),
      ),
    ).rejects.toThrow("Stash or commit your local changes to hand off");

    expect(readFileSync(path.join(fixture.root, "local-only.txt"), "utf8")).toBe(
      "do not overwrite\n",
    );
    expect(git(toWorktree.destinationWorkspaceRoot, "branch", "--show-current")).toBe(
      "feature/handoff",
    );
  });
});

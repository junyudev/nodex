import type { CodexThreadHandoffBranches } from "../../shared/codex-thread-handoff";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  prepareLocalThreadHandoff,
  rollbackLocalThreadHandoff,
  LocalThreadHandoffPreparationError,
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

    const branches: CodexThreadHandoffBranches[] = [];
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
        allocatedWorktreePath: path.join(fixture.managedRoot, "260930-1200-deadbeef"),
        destinationCheckoutRoot: null,
      },
      {
        ...options(),
        onProgress: (_step, _status, context) => {
          if (context) branches.push(context);
        },
      },
    );

    expect(prepared.direction).toBe("to-worktree");
    expect(branches.length).toBeGreaterThan(0);
    expect(
      branches.every(
        (context) =>
          context.sourceBranch === "feature/handoff" &&
          context.localBranch === "main" &&
          context.worktreeBranch === "feature/handoff",
      ),
    ).toBe(true);
    expect(git(fixture.root, "branch", "--show-current")).toBe("main");
    expect(git(fixture.root, "status", "--porcelain")).toBe("");
    expect(git(prepared.destinationWorkspaceRoot, "branch", "--show-current")).toBe(
      "feature/handoff",
    );
    expect(git(prepared.destinationWorkspaceRoot, "diff", "--cached", "--name-only")).toBe(
      "tracked.txt",
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
    expect(git(fixture.root, "diff", "--cached", "--name-only")).toBe("tracked.txt");
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
        allocatedWorktreePath: path.join(fixture.managedRoot, "260930-1200-deadbeef"),
        destinationCheckoutRoot: null,
      },
      options(),
    );

    const branches: CodexThreadHandoffBranches[] = [];
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
        allocatedWorktreePath: null,
        destinationCheckoutRoot: fixture.root,
      },
      {
        ...options(),
        onProgress: (_step, _status, context) => {
          if (context) branches.push(context);
        },
      },
    );

    expect(toCheckout.direction).toBe("to-checkout");
    expect(branches.length).toBeGreaterThan(0);
    expect(branches.every((context) => context.localBranch === "feature/handoff")).toBe(true);
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
    dirtyRepository(fixture.root);
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
        allocatedWorktreePath: path.join(fixture.managedRoot, "260930-1200-deadbeef"),
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
          allocatedWorktreePath: null,
          destinationCheckoutRoot: fixture.root,
        },
        options(),
      ),
    ).rejects.toMatchObject({
      preparationRestored: true,
      message: expect.stringContaining("Stash or commit your local changes to hand off"),
    });

    expect(readFileSync(path.join(fixture.root, "local-only.txt"), "utf8")).toBe(
      "do not overwrite\n",
    );
    expect(git(toWorktree.destinationWorkspaceRoot, "branch", "--show-current")).toBe(
      "feature/handoff",
    );
    expect(
      readFileSync(path.join(toWorktree.destinationWorkspaceRoot, "tracked.txt"), "utf8"),
    ).toBe("dirty tracked\n");
    expect(
      readFileSync(path.join(toWorktree.destinationWorkspaceRoot, "untracked.txt"), "utf8"),
    ).toBe("untracked\n");
  });

  test("a detached source rejection proves no files were moved", async () => {
    const fixture = createRepository();
    dirtyRepository(fixture.root);
    git(fixture.root, "checkout", "--detach");
    const destination = path.join(fixture.managedRoot, "260930-1200-deadbeef");
    await expect(
      prepareLocalThreadHandoff(
        {
          requestId: "detached",
          hostId: "local",
          managedRoot: fixture.managedRoot,
          allocatedWorktreePath: destination,
          nodexHome: path.dirname(fixture.managedRoot),
          projectId: "project",
          threadId: "thread",
          threadTitle: "Task",
          sourceCwd: fixture.root,
          sourceWorkspaceRoot: fixture.root,
          sourceManagedWorktreePath: null,
          destinationCheckoutRoot: null,
        },
        options(),
      ),
    ).rejects.toMatchObject({ preparationRestored: true });
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(path.join(fixture.root, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
  });

  test("interrupted restoration keeps recovery uncertain and retains the destination", async () => {
    const fixture = createRepository();
    dirtyRepository(fixture.root);
    const destination = path.join(fixture.managedRoot, "260930-1200-deadbeef");
    const controller = new AbortController();
    await expect(
      prepareLocalThreadHandoff(
        {
          requestId: "interrupted",
          hostId: "local",
          managedRoot: fixture.managedRoot,
          allocatedWorktreePath: destination,
          nodexHome: path.dirname(fixture.managedRoot),
          projectId: "project",
          threadId: "thread",
          threadTitle: "Task",
          sourceCwd: fixture.root,
          sourceWorkspaceRoot: fixture.root,
          sourceManagedWorktreePath: null,
          destinationCheckoutRoot: null,
        },
        {
          signal: controller.signal,
          onProgress: (step, status) => {
            if (step === "checkout-local-branch" && status === "completed") controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ preparationRestored: false });
    expect(existsSync(destination)).toBe(true);
    expect(git(fixture.root, "stash", "list")).toContain("Nodex thread handoff interrupted");
  });

  test("an error after applying changes never deletes the only prepared working copy", async () => {
    const fixture = createRepository();
    dirtyRepository(fixture.root);
    const destination = path.join(fixture.managedRoot, "260930-1200-deadbeef");
    const result = await prepareLocalThreadHandoff(
      {
        requestId: "after-apply",
        hostId: "local",
        managedRoot: fixture.managedRoot,
        allocatedWorktreePath: destination,
        nodexHome: path.dirname(fixture.managedRoot),
        projectId: "project",
        threadId: "thread",
        threadTitle: "Task",
        sourceCwd: fixture.root,
        sourceWorkspaceRoot: fixture.root,
        sourceManagedWorktreePath: null,
        destinationCheckoutRoot: null,
      },
      {
        ...options(),
        onProgress: (step, status) => {
          if (step === "apply-changes-to-worktree" && status === "completed")
            throw new Error("Progress transport disconnected");
        },
      },
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(LocalThreadHandoffPreparationError);
    expect(result).toMatchObject({ preparationRestored: false });
    expect(readFileSync(path.join(destination, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
    expect(readFileSync(path.join(destination, "untracked.txt"), "utf8")).toBe("untracked\n");
  });
});

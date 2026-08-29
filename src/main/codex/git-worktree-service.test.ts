import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  createManagedWorktree,
  resolveManagedWorktreeDefaultStartingState,
  setManagedWorktreeOwnerThread,
} from "./git-worktree-service";

const cryptoBoundary = vi.hoisted(() => ({
  randomUUID: vi.fn<() => `${string}-${string}-${string}-${string}-${string}`>(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  cryptoBoundary.randomUUID.mockImplementation(() => crypto.randomUUID());
  return {
    ...crypto,
    randomUUID: cryptoBoundary.randomUUID,
  };
});

interface CommandResult {
  stdout: string;
  stderr: string;
}

const tempRoots: string[] = [];

function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

async function createRepository(): Promise<{ repositoryPath: string; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "nodex-git-worktree-abort-"));
  tempRoots.push(root);
  const repositoryPath = path.join(root, "repository");
  await mkdir(repositoryPath);
  await runCommand("git", ["init"], repositoryPath);
  await runCommand("git", ["config", "user.email", "nodex@example.test"], repositoryPath);
  await runCommand("git", ["config", "user.name", "Nodex Test"], repositoryPath);
  await writeFile(path.join(repositoryPath, "README.md"), "base\n", "utf8");
  await runCommand("git", ["add", "README.md"], repositoryPath);
  await runCommand("git", ["commit", "-m", "chore: initialize fixture"], repositoryPath);
  await runCommand("git", ["branch", "-M", "main"], repositoryPath);
  return { repositoryPath, root };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => Promise<boolean>, description: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await wait(10);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function listWorktreeAllocations(worktreesRoot: string): Promise<string[]> {
  return (await readdir(worktreesRoot)).filter((name) => name !== ".metadata_never_index");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("createManagedWorktree starting state", () => {
  test("resolves the pending request default branch before worktree creation", async () => {
    const { repositoryPath } = await createRepository();

    const startingState = await resolveManagedWorktreeDefaultStartingState(repositoryPath);

    expect(startingState.type).toBe("branch");
    expect(startingState.branchName).toBe("main");
  });

  test("uses the remote default branch instead of the current local branch", async () => {
    const { repositoryPath, root } = await createRepository();
    const remotePath = path.join(root, "origin.git");
    await mkdir(remotePath);
    await runCommand("git", ["init", "--bare"], remotePath);
    await runCommand("git", ["remote", "add", "origin", remotePath], repositoryPath);
    await runCommand("git", ["checkout", "-b", "release/default"], repositoryPath);
    await writeFile(path.join(repositoryPath, "release.txt"), "release\n", "utf8");
    await runCommand("git", ["add", "release.txt"], repositoryPath);
    await runCommand("git", ["commit", "-m", "test: add remote default"], repositoryPath);
    await runCommand("git", ["push", "origin", "release/default"], repositoryPath);
    await runCommand("git", ["symbolic-ref", "HEAD", "refs/heads/release/default"], remotePath);
    await runCommand("git", ["checkout", "main"], repositoryPath);

    const startingState = await resolveManagedWorktreeDefaultStartingState(repositoryPath);

    expect(startingState.branchName).toBe("release/default");
  });

  test("uses a cached remote master when the remote HEAD is unknown", async () => {
    const { repositoryPath, root } = await createRepository();
    const remotePath = path.join(root, "origin.git");
    await mkdir(remotePath);
    await runCommand("git", ["init", "--bare"], remotePath);
    await runCommand("git", ["branch", "-M", "master"], repositoryPath);
    await runCommand("git", ["remote", "add", "origin", remotePath], repositoryPath);
    await runCommand("git", ["push", "origin", "master"], repositoryPath);
    await runCommand("git", ["symbolic-ref", "HEAD", "refs/heads/unknown"], remotePath);

    const startingState = await resolveManagedWorktreeDefaultStartingState(repositoryPath);

    expect(startingState.branchName).toBe("master");
  });

  test("falls back to literal main instead of the current or first local branch", async () => {
    const { repositoryPath } = await createRepository();
    await runCommand("git", ["branch", "-M", "topic/only-local-branch"], repositoryPath);

    const startingState = await resolveManagedWorktreeDefaultStartingState(repositoryPath);

    expect(startingState.branchName).toBe("main");
  });

  test("creates a detached worktree from the requested local branch", async () => {
    const { repositoryPath, root } = await createRepository();
    await runCommand("git", ["checkout", "-b", "feature/starting-state"], repositoryPath);
    await writeFile(path.join(repositoryPath, "feature.txt"), "feature branch\n", "utf8");
    await runCommand("git", ["add", "feature.txt"], repositoryPath);
    await runCommand("git", ["commit", "-m", "feat: add branch fixture"], repositoryPath);
    const featureHead = (
      await runCommand("git", ["rev-parse", "HEAD"], repositoryPath)
    ).stdout.trim();
    await runCommand("git", ["checkout", "main"], repositoryPath);

    const result = await createManagedWorktree({
      repositoryPath,
      nodexHome: path.join(root, "server"),
      projectId: "project-branch-start",
      targetId: "target-branch-start",
      mode: "detachedHead",
      startingState: {
        type: "branch",
        branchName: "feature/starting-state",
      },
    });

    const childHead = (
      await runCommand("git", ["rev-parse", "HEAD"], result.worktreeWorkspaceRoot)
    ).stdout.trim();
    const childBranch = (
      await runCommand("git", ["branch", "--show-current"], result.worktreeWorkspaceRoot)
    ).stdout.trim();
    expect(result.baseRef).toBe("feature/starting-state");
    expect(result.branchName).toBe(null);
    expect(childHead).toBe(featureHead);
    expect(childBranch).toBe("");
    expect(await readFile(path.join(result.worktreeWorkspaceRoot, "feature.txt"), "utf8")).toBe(
      "feature branch\n",
    );
  });

  test("allocates future worktrees beneath the configured managed root", async () => {
    const { repositoryPath, root } = await createRepository();
    const managedRoot = path.join(root, "custom managed root");

    const result = await createManagedWorktree({
      repositoryPath,
      nodexHome: path.join(root, "server"),
      managedRoot,
      projectId: "project-custom-root",
      targetId: "target-custom-root",
      mode: "detachedHead",
      startingState: { type: "branch", branchName: "main" },
    });

    expect(path.relative(managedRoot, result.worktreeGitRoot).startsWith("..")).toBe(false);
    expect(result.worktreeGitRoot).toContain(`${path.sep}custom managed root${path.sep}`);
    expect(existsSync(result.worktreeGitRoot)).toBe(true);
  });

  test("uses the full remote ref and creates its missing local tracking branch", async () => {
    const { repositoryPath, root } = await createRepository();
    const remotePath = path.join(root, "origin.git");
    await mkdir(remotePath);
    await runCommand("git", ["init", "--bare"], remotePath);
    await runCommand("git", ["remote", "add", "origin", remotePath], repositoryPath);
    await runCommand("git", ["checkout", "-b", "remote-only"], repositoryPath);
    await writeFile(path.join(repositoryPath, "remote-only.txt"), "remote only\n", "utf8");
    await runCommand("git", ["add", "remote-only.txt"], repositoryPath);
    await runCommand("git", ["commit", "-m", "test: add remote-only branch"], repositoryPath);
    await runCommand("git", ["push", "origin", "remote-only"], repositoryPath);
    const remoteHead = (
      await runCommand("git", ["rev-parse", "HEAD"], repositoryPath)
    ).stdout.trim();
    await runCommand("git", ["checkout", "main"], repositoryPath);
    await runCommand("git", ["branch", "-D", "remote-only"], repositoryPath);

    const remoteRef = "refs/remotes/origin/remote-only";
    const result = await createManagedWorktree({
      repositoryPath,
      nodexHome: path.join(root, "server-remote-ref"),
      projectId: "project-remote-ref",
      targetId: "target-remote-ref",
      mode: "detachedHead",
      startingState: {
        type: "branch",
        branchName: "origin/remote-only",
        remoteRef,
      },
    });

    const childHead = (
      await runCommand("git", ["rev-parse", "HEAD"], result.worktreeGitRoot)
    ).stdout.trim();
    const trackingHead = (
      await runCommand("git", ["rev-parse", "refs/heads/origin/remote-only"], repositoryPath)
    ).stdout.trim();
    const upstream = (
      await runCommand(
        "git",
        ["for-each-ref", "--format=%(upstream)", "refs/heads/origin/remote-only"],
        repositoryPath,
      )
    ).stdout.trim();
    const syncedConfigPath = (
      await runCommand(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", "codex-synced-branch.json"],
        result.worktreeGitRoot,
      )
    ).stdout.trim();

    expect(result.baseRef).toBe(remoteRef);
    expect(childHead).toBe(remoteHead);
    expect(trackingHead).toBe(remoteHead);
    expect(upstream).toBe(remoteRef);
    expect(
      await stat(syncedConfigPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  test("accepts tags, remote refs, and commit SHAs when synced metadata is disabled", async () => {
    const { repositoryPath, root } = await createRepository();
    const remotePath = path.join(root, "origin.git");
    await mkdir(remotePath);
    await runCommand("git", ["init", "--bare"], remotePath);
    await runCommand("git", ["remote", "add", "origin", remotePath], repositoryPath);
    await runCommand("git", ["push", "origin", "main"], repositoryPath);
    await runCommand("git", ["tag", "fixture-tag"], repositoryPath);
    const commitSha = (
      await runCommand("git", ["rev-parse", "HEAD"], repositoryPath)
    ).stdout.trim();
    const startingRefs = ["fixture-tag", "origin/main", commitSha];

    for (const [index, startingRef] of startingRefs.entries()) {
      const result = await createManagedWorktree({
        repositoryPath,
        nodexHome: path.join(root, `server-ref-${String(index)}`),
        projectId: `project-ref-${String(index)}`,
        targetId: `target-ref-${String(index)}`,
        mode: "detachedHead",
        startingState: {
          type: "branch",
          branchName: startingRef,
        },
        setUpSyncedBranch: false,
      });
      const childHead = (
        await runCommand("git", ["rev-parse", "HEAD"], result.worktreeGitRoot)
      ).stdout.trim();

      expect(result.baseRef).toBe(startingRef);
      expect(childHead).toBe(commitSha);
    }
  });

  test("returns distinct Git and nested workspace roots and names the path from the source Git root", async () => {
    const { repositoryPath, root } = await createRepository();
    const nestedWorkspace = path.join(repositoryPath, "packages", "app");
    await mkdir(nestedWorkspace, { recursive: true });
    await writeFile(path.join(nestedWorkspace, "app.txt"), "nested workspace\n", "utf8");
    await runCommand("git", ["add", "packages/app/app.txt"], repositoryPath);
    await runCommand("git", ["commit", "-m", "test: add nested workspace"], repositoryPath);

    const result = await createManagedWorktree({
      repositoryPath: nestedWorkspace,
      nodexHome: path.join(root, "server-nested"),
      projectId: "project-id-must-not-name-the-path",
      targetId: "target-nested",
      mode: "detachedHead",
      startingState: {
        type: "branch",
        branchName: "main",
      },
    });

    expect(path.basename(result.worktreeGitRoot)).toBe(path.basename(repositoryPath));
    expect(result.worktreeWorkspaceRoot).toBe(path.join(result.worktreeGitRoot, "packages", "app"));
    expect(await readFile(path.join(result.worktreeWorkspaceRoot, "app.txt"), "utf8")).toBe(
      "nested workspace\n",
    );
    expect(await readFile(path.join(result.worktreeGitRoot, "README.md"), "utf8")).toBe("base\n");
  });

  test("retries UUID-prefix collisions when allocating the worktree path", async () => {
    const { repositoryPath, root } = await createRepository();
    const nodexHome = path.join(root, "server-uuid-path");
    await mkdir(path.join(nodexHome, "worktrees", "a1b2", "repository"), { recursive: true });
    cryptoBoundary.randomUUID
      .mockReturnValueOnce("a1b2c3d4-1111-4111-8111-111111111111")
      .mockReturnValueOnce("c3d4e5f6-2222-4222-8222-222222222222");

    const result = await createManagedWorktree({
      repositoryPath,
      nodexHome,
      projectId: "project-uuid-path",
      targetId: "target-uuid-path",
      mode: "detachedHead",
      startingState: { type: "branch", branchName: "main" },
    });

    expect(result.worktreeGitRoot).toBe(path.join(nodexHome, "worktrees", "c3d4", "repository"));
  });

  test("publishes allocated roots before Git creation and cleans them when canceled", async () => {
    const { repositoryPath, root } = await createRepository();
    const nodexHome = path.join(root, "server-path-event");
    const controller = new AbortController();
    let allocatedRoots: {
      worktreeGitRoot: string;
      worktreeWorkspaceRoot: string;
    } | null = null;
    let worktreeExistedAtAllocation = true;
    let tokenDirectoryExistedAtAllocation = false;

    await expect(
      createManagedWorktree({
        repositoryPath,
        nodexHome,
        projectId: "project-path-event",
        targetId: "target-path-event",
        mode: "detachedHead",
        startingState: { type: "branch", branchName: "main" },
        onPathAllocated: (roots) => {
          allocatedRoots = roots;
          worktreeExistedAtAllocation = existsSync(roots.worktreeGitRoot);
          tokenDirectoryExistedAtAllocation = existsSync(path.dirname(roots.worktreeGitRoot));
          controller.abort();
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow("Request canceled");

    expect(allocatedRoots).not.toBe(null);
    expect(worktreeExistedAtAllocation).toBe(false);
    expect(tokenDirectoryExistedAtAllocation).toBe(true);
    const worktreesRoot = path.join(nodexHome, "worktrees");
    expect(await listWorktreeAllocations(worktreesRoot)).toEqual([]);
    if (process.platform === "darwin") {
      expect(existsSync(path.join(worktreesRoot, ".metadata_never_index"))).toBe(true);
    }
    const worktreeList = await runCommand(
      "git",
      ["worktree", "list", "--porcelain"],
      repositoryPath,
    );
    expect(worktreeList.stdout.includes(nodexHome)).toBe(false);
  });

  test("copies ignored Codex workspace files and records the no-environment lifecycle", async () => {
    const { repositoryPath, root } = await createRepository();
    await mkdir(path.join(repositoryPath, "docs"));
    await writeFile(
      path.join(repositoryPath, ".gitignore"),
      ["AGENTS.override.md", "secrets/", "ignored-only.txt", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(repositoryPath, ".worktreeinclude"),
      ["secrets/*.env", ""].join("\n"),
      "utf8",
    );
    await writeFile(path.join(repositoryPath, "docs", ".keep"), "", "utf8");
    await runCommand(
      "git",
      ["add", ".gitignore", ".worktreeinclude", "docs/.keep"],
      repositoryPath,
    );
    await runCommand("git", ["commit", "-m", "test: add copy rules"], repositoryPath);
    await mkdir(path.join(repositoryPath, "secrets"));
    await writeFile(path.join(repositoryPath, "AGENTS.override.md"), "root override\n", "utf8");
    await writeFile(
      path.join(repositoryPath, "docs", "AGENTS.override.md"),
      "nested override\n",
      "utf8",
    );
    await writeFile(path.join(repositoryPath, "secrets", "local.env"), "TOKEN=test\n", "utf8");
    await writeFile(path.join(repositoryPath, "ignored-only.txt"), "do not copy\n", "utf8");
    const logs: Array<{ stream: string; data: string }> = [];

    const result = await createManagedWorktree({
      repositoryPath,
      nodexHome: path.join(root, "server-copy-rules"),
      projectId: "project-copy-rules",
      targetId: "target-copy-rules",
      mode: "detachedHead",
      startingState: {
        type: "branch",
        branchName: "main",
      },
      onLog: (output) => {
        logs.push(output);
      },
    });

    expect(await readFile(path.join(result.worktreeGitRoot, "AGENTS.override.md"), "utf8")).toBe(
      "root override\n",
    );
    expect(
      await readFile(path.join(result.worktreeGitRoot, "docs", "AGENTS.override.md"), "utf8"),
    ).toBe("nested override\n");
    expect(await readFile(path.join(result.worktreeGitRoot, "secrets", "local.env"), "utf8")).toBe(
      "TOKEN=test\n",
    );
    expect(
      await stat(path.join(result.worktreeGitRoot, "ignored-only.txt"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    const selectedEnvironment = (
      await runCommand(
        "git",
        ["config", "--worktree", "--get", "codex.localEnvironmentConfigPath"],
        result.worktreeWorkspaceRoot,
      )
    ).stdout.trim();
    expect(selectedEnvironment).toBe("__none__");
    expect(logs.some((entry) => entry.data === "Copied 1 file from .worktreeinclude\n")).toBe(true);
    expect(
      logs.some(
        (entry) =>
          entry.stream === "info" &&
          entry.data === `Worktree created at ${result.worktreeWorkspaceRoot}\n`,
      ),
    ).toBe(true);
    expect(logs.some((entry) => entry.data === "No local environment selected\n")).toBe(true);
  });

  test("writes the exact owner thread config into the worktree git path", async () => {
    const { repositoryPath, root } = await createRepository();
    const result = await createManagedWorktree({
      repositoryPath,
      nodexHome: path.join(root, "server-owner"),
      projectId: "project-owner",
      targetId: "target-owner",
      mode: "detachedHead",
      startingState: { type: "branch", branchName: "main" },
    });

    await setManagedWorktreeOwnerThread(result.worktreeGitRoot, "thread-owner-1");

    const ownerConfigPath = (
      await runCommand(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", "codex-thread.json"],
        result.worktreeGitRoot,
      )
    ).stdout.trim();
    expect(await readFile(ownerConfigPath, "utf8")).toBe(
      `${JSON.stringify({ version: 1, ownerThreadId: "thread-owner-1" }, null, 2)}\n`,
    );

    if (process.platform !== "win32") {
      const [sourceStat, worktreeStat, ownerStat] = await Promise.all([
        stat(repositoryPath),
        stat(result.worktreeGitRoot),
        stat(ownerConfigPath),
      ]);
      expect({ uid: worktreeStat.uid, gid: worktreeStat.gid }).toEqual({
        uid: sourceStat.uid,
        gid: sourceStat.gid,
      });
      expect(worktreeStat.mode & 0o777).toBe(0o755);
      expect(ownerStat.mode & 0o777).toBe(0o644);
    }

    const [sourceCommonDir, worktreeCommonDir] = await Promise.all([
      runCommand(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        repositoryPath,
      ),
      runCommand(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        result.worktreeGitRoot,
      ),
    ]);
    expect(path.resolve(worktreeCommonDir.stdout.trim())).toBe(
      path.resolve(sourceCommonDir.stdout.trim()),
    );
  });

  test("records a non-remote-default starting branch as synced metadata", async () => {
    const { repositoryPath, root } = await createRepository();
    await runCommand("git", ["checkout", "-b", "feature/synced"], repositoryPath);
    await writeFile(path.join(repositoryPath, "synced.txt"), "synced branch\n", "utf8");
    await runCommand("git", ["add", "synced.txt"], repositoryPath);
    await runCommand("git", ["commit", "-m", "test: add synced branch"], repositoryPath);
    const tree = (
      await runCommand("git", ["rev-parse", "refs/heads/feature/synced^{tree}"], repositoryPath)
    ).stdout.trim();

    const result = await createManagedWorktree({
      repositoryPath,
      nodexHome: path.join(root, "server-synced"),
      projectId: "project-synced",
      targetId: "target-synced",
      mode: "detachedHead",
      startingState: { type: "branch", branchName: "feature/synced" },
    });
    const syncedConfigPath = (
      await runCommand(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-path", "codex-synced-branch.json"],
        result.worktreeGitRoot,
      )
    ).stdout.trim();
    const synced = JSON.parse(await readFile(syncedConfigPath, "utf8")) as {
      branch: string;
      lastSyncedTreeRef: string;
    };

    expect(synced.branch).toBe("refs/heads/feature/synced");
    expect(synced.lastSyncedTreeRef).toBe(tree);
  });

  test("does not record synced metadata when HEAD has no branch identity", async () => {
    const { repositoryPath, root } = await createRepository();
    await runCommand("git", ["checkout", "--detach", "HEAD"], repositoryPath);

    for (const [name, startingState] of [
      ["working-tree", { type: "working-tree" as const }],
      ["head", { type: "branch" as const, branchName: "HEAD" }],
    ] as const) {
      const result = await createManagedWorktree({
        repositoryPath,
        nodexHome: path.join(root, `server-detached-${name}`),
        projectId: `project-detached-${name}`,
        targetId: `target-detached-${name}`,
        mode: "detachedHead",
        startingState,
      });
      const syncedConfigPath = (
        await runCommand(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-path", "codex-synced-branch.json"],
          result.worktreeGitRoot,
        )
      ).stdout.trim();

      expect(
        await stat(syncedConfigPath)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
    }
  });

  test("replays tracked, staged, and binary changes then copies untracked files", async () => {
    const { repositoryPath, root } = await createRepository();
    const baseBinary = Buffer.from([0, 1, 2, 3, 4, 255]);
    const changedBinary = Buffer.from([255, 4, 3, 2, 1, 0, 128]);
    await writeFile(path.join(repositoryPath, "binary.bin"), baseBinary);
    await writeFile(path.join(repositoryPath, "tracked-staged.txt"), "base staged\n", "utf8");
    await runCommand("git", ["add", "binary.bin", "tracked-staged.txt"], repositoryPath);
    await runCommand("git", ["commit", "-m", "test: add working tree fixtures"], repositoryPath);

    await writeFile(path.join(repositoryPath, "README.md"), "unstaged edit\n", "utf8");
    await writeFile(path.join(repositoryPath, "binary.bin"), changedBinary);
    await writeFile(path.join(repositoryPath, "tracked-staged.txt"), "staged edit\n", "utf8");
    await runCommand("git", ["add", "tracked-staged.txt"], repositoryPath);
    await writeFile(path.join(repositoryPath, "staged-new.txt"), "staged new\n", "utf8");
    await runCommand("git", ["add", "staged-new.txt"], repositoryPath);
    await writeFile(path.join(repositoryPath, "untracked.txt"), "untracked edit\n", "utf8");
    const untrackedBinary = Buffer.from([128, 0, 255, 64, 1, 2, 3]);
    await writeFile(path.join(repositoryPath, "untracked.bin"), untrackedBinary);
    const sourceStatusBefore = (await runCommand("git", ["status", "--porcelain"], repositoryPath))
      .stdout;
    const logs: string[] = [];

    const result = await createManagedWorktree({
      repositoryPath,
      nodexHome: path.join(root, "server"),
      projectId: "project-working-tree-start",
      targetId: "target-working-tree-start",
      mode: "detachedHead",
      startingState: {
        type: "working-tree",
      },
      onLog: ({ stream, data }) => {
        if (stream === "info") logs.push(data);
      },
    });

    expect(result.baseRef).toBe("main");
    expect(result.branchName).toBe(null);
    expect(await readFile(path.join(result.worktreeWorkspaceRoot, "README.md"), "utf8")).toBe(
      "unstaged edit\n",
    );
    expect(
      (await readFile(path.join(result.worktreeWorkspaceRoot, "binary.bin"))).equals(changedBinary),
    ).toBe(true);
    expect(
      await readFile(path.join(result.worktreeWorkspaceRoot, "tracked-staged.txt"), "utf8"),
    ).toBe("staged edit\n");
    expect(await readFile(path.join(result.worktreeWorkspaceRoot, "staged-new.txt"), "utf8")).toBe(
      "staged new\n",
    );
    expect(await readFile(path.join(result.worktreeWorkspaceRoot, "untracked.txt"), "utf8")).toBe(
      "untracked edit\n",
    );
    expect(
      (await readFile(path.join(result.worktreeWorkspaceRoot, "untracked.bin"))).equals(
        untrackedBinary,
      ),
    ).toBe(true);
    expect(logs.some((entry) => entry.includes("Applying working tree diff"))).toBe(true);
    expect(logs.some((entry) => entry.includes("Copying untracked files"))).toBe(true);
    const sourceStatusAfter = (await runCommand("git", ["status", "--porcelain"], repositoryPath))
      .stdout;
    expect(sourceStatusAfter).toBe(sourceStatusBefore);
  });

  test("rolls back when an untracked file cannot be copied exclusively", async () => {
    const { repositoryPath, root } = await createRepository();
    const nodexHome = path.join(root, "server-copy-conflict");
    const sourceUntrackedPath = path.join(repositoryPath, "untracked-conflict.txt");
    await writeFile(sourceUntrackedPath, "source remains\n", "utf8");
    const hookPath = path.join(repositoryPath, ".git", "hooks", "post-checkout");
    await writeFile(
      hookPath,
      [
        "#!/bin/sh",
        "target=$(git rev-parse --show-toplevel)",
        "printf 'destination already exists\\n' > \"$target/untracked-conflict.txt\"",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(hookPath, 0o755);

    await expect(
      createManagedWorktree({
        repositoryPath,
        nodexHome,
        projectId: "project-untracked-copy-conflict",
        targetId: "target-untracked-copy-conflict",
        mode: "detachedHead",
        startingState: { type: "working-tree" },
      }),
    ).rejects.toThrow("Failed to copy all untracked working tree files");

    expect(await listWorktreeAllocations(path.join(nodexHome, "worktrees"))).toEqual([]);
    const worktreeList = await runCommand(
      "git",
      ["worktree", "list", "--porcelain"],
      repositoryPath,
    );
    expect(worktreeList.stdout.includes(nodexHome)).toBe(false);
    expect(await readFile(sourceUntrackedPath, "utf8")).toBe("source remains\n");
  });

  test("rejects untracked symlinks instead of copying outside workspace contents", async () => {
    if (process.platform === "win32") return;
    const { repositoryPath, root } = await createRepository();
    const nodexHome = path.join(root, "server-symlink-copy");
    const outsidePath = path.join(root, "outside.txt");
    await writeFile(outsidePath, "outside remains\n", "utf8");
    await symlink(outsidePath, path.join(repositoryPath, "untracked-link"));

    await expect(
      createManagedWorktree({
        repositoryPath,
        nodexHome,
        projectId: "project-untracked-symlink",
        targetId: "target-untracked-symlink",
        mode: "detachedHead",
        startingState: { type: "working-tree" },
      }),
    ).rejects.toThrow("Failed to copy all untracked working tree files");

    expect(await readFile(outsidePath, "utf8")).toBe("outside remains\n");
    expect(await listWorktreeAllocations(path.join(nodexHome, "worktrees"))).toEqual([]);
  });

  test("fails without creating a worktree when dirty-state capture fails", async () => {
    const { repositoryPath, root } = await createRepository();
    const sourceReadmePath = path.join(repositoryPath, "README.md");
    const sourceOnlyPath = path.join(repositoryPath, "source-only.txt");
    const sourceIndexPath = path.join(repositoryPath, ".git", "index");
    await writeFile(sourceReadmePath, "source edit remains\n", "utf8");
    await writeFile(sourceOnlyPath, "source only remains\n", "utf8");
    await rm(sourceIndexPath);
    const nodexHome = path.join(root, "server");

    await expect(
      createManagedWorktree({
        repositoryPath,
        nodexHome,
        projectId: "project-failed-working-tree-capture",
        targetId: "target-failed-working-tree-capture",
        mode: "detachedHead",
        startingState: { type: "working-tree" },
      }),
    ).rejects.toThrow();

    expect(
      await stat(path.join(nodexHome, "worktrees"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    const worktreeList = await runCommand(
      "git",
      ["worktree", "list", "--porcelain"],
      repositoryPath,
    );
    expect(worktreeList.stdout.includes(nodexHome)).toBe(false);
    expect(await readFile(sourceReadmePath, "utf8")).toBe("source edit remains\n");
    expect(await readFile(sourceOnlyPath, "utf8")).toBe("source only remains\n");
    expect(
      await stat(sourceIndexPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  test("lets Git report an invalid explicit starting ref", async () => {
    const { repositoryPath, root } = await createRepository();
    let message = "";

    try {
      await createManagedWorktree({
        repositoryPath,
        nodexHome: path.join(root, "server"),
        projectId: "project-missing-branch",
        targetId: "target-missing-branch",
        mode: "detachedHead",
        startingState: {
          type: "branch",
          branchName: "missing/branch",
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.includes("invalid reference: missing/branch")).toBe(true);
  });
});

describe("createManagedWorktree cancellation", () => {
  test("fails before allocating server or worktree paths when already canceled", async () => {
    const { repositoryPath, root } = await createRepository();
    const nodexHome = path.join(root, "server");
    const controller = new AbortController();
    controller.abort();
    let message = "";

    try {
      await createManagedWorktree({
        repositoryPath,
        nodexHome,
        projectId: "project-canceled-before-start",
        targetId: "target-canceled-before-start",
        mode: "detachedHead",
        signal: controller.signal,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Request canceled");
    expect(
      await stat(nodexHome)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  test("does not swallow cancellation while capturing the working tree diff", async () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }

    const { repositoryPath, root } = await createRepository();
    const nodexHome = path.join(root, "server");
    const filteredPath = path.join(repositoryPath, "capture.txt");
    const sourceIndexPath = path.join(repositoryPath, ".git", "index");
    await writeFile(
      path.join(repositoryPath, ".gitattributes"),
      "capture.txt filter=slow-capture\n",
      "utf8",
    );
    await writeFile(filteredPath, "base capture\n", "utf8");
    await runCommand("git", ["add", ".gitattributes", "capture.txt"], repositoryPath);
    await runCommand("git", ["commit", "-m", "test: add capture fixture"], repositoryPath);

    const captureStartedPath = path.join(root, "capture-started");
    const capturePidPath = path.join(root, "capture-pid");
    const captureFilterPath = path.join(root, "slow-capture-filter");
    await writeFile(
      captureFilterPath,
      [
        "#!/bin/sh",
        `printf '%s' "$$" > ${quoteForPosixShell(capturePidPath)}`,
        `touch ${quoteForPosixShell(captureStartedPath)}`,
        "trap 'exit 143' TERM INT",
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(captureFilterPath, 0o755);
    await runCommand(
      "git",
      ["config", "filter.slow-capture.clean", captureFilterPath],
      repositoryPath,
    );
    await runCommand("git", ["config", "filter.slow-capture.required", "true"], repositoryPath);
    await writeFile(filteredPath, "source capture edit remains\n", "utf8");
    const sourceIndexBefore = await readFile(sourceIndexPath);

    const controller = new AbortController();
    const creation = createManagedWorktree({
      repositoryPath,
      nodexHome,
      projectId: "project-canceled-during-capture",
      targetId: "target-canceled-during-capture",
      mode: "detachedHead",
      startingState: {
        type: "working-tree",
      },
      signal: controller.signal,
    });
    await waitFor(
      () =>
        stat(captureStartedPath)
          .then(() => true)
          .catch(() => false),
      "the blocking clean filter",
    );
    const capturePid = Number.parseInt(await readFile(capturePidPath, "utf8"), 10);
    controller.abort();

    let message = "";
    try {
      await creation;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Request canceled");
    await waitFor(async () => !isProcessAlive(capturePid), "the canceled clean filter to exit");
    expect(
      await stat(path.join(nodexHome, "worktrees"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    const worktreeList = await runCommand(
      "git",
      ["worktree", "list", "--porcelain"],
      repositoryPath,
    );
    expect(worktreeList.stdout.includes(nodexHome)).toBe(false);
    expect(await readFile(filteredPath, "utf8")).toBe("source capture edit remains\n");
    expect((await readFile(sourceIndexPath)).equals(sourceIndexBefore)).toBe(true);
  });

  test("kills the in-flight git process tree and rolls back its allocated worktree", async () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }

    const { repositoryPath, root } = await createRepository();
    const nodexHome = path.join(root, "server");
    const hookStartedPath = path.join(root, "post-checkout-started");
    const hookPidPath = path.join(root, "post-checkout-pid");
    const hooksPath = path.join(repositoryPath, ".git", "hooks");
    const hookPath = path.join(hooksPath, "post-checkout");
    await writeFile(
      hookPath,
      [
        "#!/bin/sh",
        `printf '%s' \"$$\" > ${quoteForPosixShell(hookPidPath)}`,
        `touch ${quoteForPosixShell(hookStartedPath)}`,
        "trap 'exit 143' TERM INT",
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(hookPath, 0o755);

    const controller = new AbortController();
    const creation = createManagedWorktree({
      repositoryPath,
      nodexHome,
      projectId: "project-canceled-in-git",
      targetId: "target-canceled-in-git",
      mode: "detachedHead",
      signal: controller.signal,
    });
    await waitFor(
      () =>
        stat(hookStartedPath)
          .then(() => true)
          .catch(() => false),
      "the blocking post-checkout hook",
    );
    const hookPid = Number.parseInt(await readFile(hookPidPath, "utf8"), 10);
    controller.abort();

    let message = "";
    try {
      await creation;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Request canceled");
    await waitFor(async () => !isProcessAlive(hookPid), "the canceled git hook process to exit");
    const worktreesRoot = path.join(nodexHome, "worktrees");
    expect(await listWorktreeAllocations(worktreesRoot)).toEqual([]);
    const worktreeList = await runCommand(
      "git",
      ["worktree", "list", "--porcelain"],
      repositoryPath,
    );
    expect(worktreeList.stdout.includes(nodexHome)).toBe(false);
  });

  test("rolls back only the canceled child and preserves existing worktrees and source changes", async () => {
    if (process.platform === "win32") {
      expect(true).toBe(true);
      return;
    }

    const { repositoryPath, root } = await createRepository();
    const nodexHome = path.join(root, "server");
    const existing = await createManagedWorktree({
      repositoryPath,
      nodexHome,
      projectId: "project-existing",
      targetId: "target-existing",
      mode: "detachedHead",
    });
    await writeFile(path.join(repositoryPath, "README.md"), "source remains\n", "utf8");
    await writeFile(path.join(repositoryPath, "untracked-remains.txt"), "source only\n", "utf8");

    const hookStartedPath = path.join(root, "second-post-checkout-started");
    const hookPidPath = path.join(root, "second-post-checkout-pid");
    const hookPath = path.join(repositoryPath, ".git", "hooks", "post-checkout");
    await writeFile(
      hookPath,
      [
        "#!/bin/sh",
        `printf '%s' "$$" > ${quoteForPosixShell(hookPidPath)}`,
        `touch ${quoteForPosixShell(hookStartedPath)}`,
        "trap 'exit 143' TERM INT",
        "while :; do sleep 1; done",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(hookPath, 0o755);

    const controller = new AbortController();
    const creation = createManagedWorktree({
      repositoryPath,
      nodexHome,
      projectId: "project-canceled-with-existing",
      targetId: "target-canceled-with-existing",
      mode: "detachedHead",
      startingState: {
        type: "working-tree",
      },
      signal: controller.signal,
    });
    await waitFor(
      () =>
        stat(hookStartedPath)
          .then(() => true)
          .catch(() => false),
      "the second blocking post-checkout hook",
    );
    const hookPid = Number.parseInt(await readFile(hookPidPath, "utf8"), 10);
    controller.abort();

    let message = "";
    try {
      await creation;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Request canceled");
    await waitFor(async () => !isProcessAlive(hookPid), "the canceled second git hook to exit");
    expect(
      await stat(existing.worktreeWorkspaceRoot)
        .then((entry) => entry.isDirectory())
        .catch(() => false),
    ).toBe(true);
    expect(await readFile(path.join(existing.worktreeWorkspaceRoot, "README.md"), "utf8")).toBe(
      "base\n",
    );
    expect(await readFile(path.join(repositoryPath, "README.md"), "utf8")).toBe("source remains\n");
    expect(await readFile(path.join(repositoryPath, "untracked-remains.txt"), "utf8")).toBe(
      "source only\n",
    );
    const worktreeList = await runCommand(
      "git",
      ["worktree", "list", "--porcelain"],
      repositoryPath,
    );
    expect(worktreeList.stdout.includes(existing.worktreeGitRoot)).toBe(true);
    const worktreeTokens = await listWorktreeAllocations(path.join(nodexHome, "worktrees"));
    expect(worktreeTokens.length).toBe(1);
  });
});

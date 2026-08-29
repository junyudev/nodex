import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  inspectManagedWorktree,
  isCurrentManagedWorktreeDirectory,
  isLegacyManagedWorktreeParent,
  listManagedWorktreesOnHost,
  removeRetainedManagedWorktree,
  resolveManagedWorktreeId,
  resolveManagedWorktreeSnapshotRef,
  restoreManagedWorktree,
  snapshotManagedWorktree,
} from "./codex-managed-worktree-effects";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nodex-lifecycle-effects-"));
  roots.push(root);
  const repositoryPath = path.join(root, "source");
  const managedRoot = path.join(root, "managed");
  const worktreeGitRoot = path.join(managedRoot, "a1b2", "source");
  await mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, ["init"]);
  await git(repositoryPath, ["config", "user.name", "Nodex Test"]);
  await git(repositoryPath, ["config", "user.email", "nodex@example.test"]);
  await writeFile(path.join(repositoryPath, "tracked.txt"), "base\n");
  await git(repositoryPath, ["add", "tracked.txt"]);
  await git(repositoryPath, ["commit", "-m", "base"]);
  await mkdir(path.dirname(worktreeGitRoot), { recursive: true });
  await git(repositoryPath, ["worktree", "add", "--detach", worktreeGitRoot, "HEAD"]);
  return { root, repositoryPath, managedRoot, worktreeGitRoot };
}

function snapshotInput(input: Awaited<ReturnType<typeof fixture>>) {
  return {
    requestId: "snapshot:1",
    hostId: "local",
    worktreeGitRoot: input.worktreeGitRoot,
    reason: "archive" as const,
  };
}

describe("managed worktree data-safety effects", () => {
  test("recognizes only the two supported allocation layouts", () => {
    expect(isLegacyManagedWorktreeParent("a1B2")).toBe(true);
    expect(isLegacyManagedWorktreeParent("a1b23")).toBe(false);
    expect(isCurrentManagedWorktreeDirectory("260829-1430-a1B2c3D4")).toBe(true);
    expect(isCurrentManagedWorktreeDirectory("20260829-1430-a1b2c3d4")).toBe(false);
    expect(isCurrentManagedWorktreeDirectory("260829-143-a1b2c3d4")).toBe(false);
  });

  test("snapshots the final materialized tree without mutating the real index", async () => {
    const input = await fixture();
    await writeFile(path.join(input.worktreeGitRoot, "tracked.txt"), "working tree\n");
    await writeFile(path.join(input.worktreeGitRoot, "staged.txt"), "staged\n");
    await git(input.worktreeGitRoot, ["add", "staged.txt"]);
    await writeFile(path.join(input.worktreeGitRoot, "staged.txt"), "working after staged\n");
    await writeFile(
      path.join(input.worktreeGitRoot, "binary.bin"),
      Buffer.from([0, 1, 2, 255, 0, 19]),
    );
    await symlink("tracked.txt", path.join(input.worktreeGitRoot, "tracked-link"));
    const before = await git(input.worktreeGitRoot, ["status", "--porcelain=v1"]);

    const result = await snapshotManagedWorktree(snapshotInput(input));

    expect(result.worktreeId).toBe(resolveManagedWorktreeId(input.worktreeGitRoot));
    expect(result.snapshotRef).toBe(resolveManagedWorktreeSnapshotRef(input.worktreeGitRoot));
    expect(result.changed).toBe(true);
    expect(await git(input.repositoryPath, ["show", `${result.snapshotRef}:tracked.txt`])).toBe(
      "working tree",
    );
    expect(await git(input.repositoryPath, ["show", `${result.snapshotRef}:staged.txt`])).toBe(
      "working after staged",
    );
    const binary = await execFileAsync("git", ["show", `${result.snapshotRef}:binary.bin`], {
      cwd: input.repositoryPath,
      encoding: "buffer",
      maxBuffer: 1024,
    });
    expect(binary.stdout).toEqual(Buffer.from([0, 1, 2, 255, 0, 19]));
    expect(await git(input.worktreeGitRoot, ["status", "--porcelain=v1"])).toBe(before);
  });

  test("points an unchanged snapshot at HEAD and creates a root commit for unborn HEAD", async () => {
    const unchanged = await fixture();
    const head = await git(unchanged.worktreeGitRoot, ["rev-parse", "HEAD"]);
    await expect(snapshotManagedWorktree(snapshotInput(unchanged))).resolves.toMatchObject({
      commitId: head,
      changed: false,
    });

    const root = await mkdtemp(path.join(tmpdir(), "nodex-unborn-snapshot-"));
    roots.push(root);
    const managedRoot = path.join(root, "managed");
    const worktreeGitRoot = path.join(managedRoot, "beef", "unborn");
    await mkdir(worktreeGitRoot, { recursive: true });
    await git(worktreeGitRoot, ["init"]);
    await writeFile(path.join(worktreeGitRoot, "first.txt"), "first\n");
    const snapshot = await snapshotManagedWorktree({
      requestId: "snapshot:unborn",
      hostId: "local",
      worktreeGitRoot,
      reason: "archive",
    });
    expect(snapshot.changed).toBe(true);
    expect(await git(worktreeGitRoot, ["show", `${snapshot.snapshotRef}:first.txt`])).toBe("first");
    expect(
      await git(worktreeGitRoot, ["rev-list", "--parents", "-n", "1", snapshot.commitId]),
    ).toBe(snapshot.commitId);
  });

  test("removes with a required snapshot, reports restorable, and restores in place", async () => {
    const input = await fixture();
    const nestedCwd = path.join(input.worktreeGitRoot, "packages", "app");
    await mkdir(nestedCwd, { recursive: true });
    await writeFile(path.join(nestedCwd, "workspace.txt"), "nested workspace\n");
    await writeFile(path.join(input.worktreeGitRoot, "untracked.txt"), "recover me\n");

    const removed = await removeRetainedManagedWorktree({
      ...snapshotInput(input),
      requestId: "remove:1",
      snapshotPolicy: "required",
    });
    expect(removed.removed).toBe(true);
    expect(removed.snapshot?.snapshotRef).toBe(
      resolveManagedWorktreeSnapshotRef(input.worktreeGitRoot),
    );
    await expect(readFile(input.worktreeGitRoot)).rejects.toThrow();

    const inspectionInput = {
      requestId: "inspect:1",
      hostId: "local",
      worktreeGitRoot: input.worktreeGitRoot,
      cwd: nestedCwd,
      candidateRepositoryPaths: [input.repositoryPath],
    };
    await expect(inspectManagedWorktree(inspectionInput)).resolves.toEqual({
      availability: {
        state: "restorable",
        repositoryPath: input.repositoryPath,
        snapshotRef: resolveManagedWorktreeSnapshotRef(input.worktreeGitRoot),
      },
    });
    const restored = await restoreManagedWorktree({
      ...inspectionInput,
      requestId: "restore:1",
      ownerThreadId: "thread:one",
    });
    expect(restored.ownerWarning).toBeNull();
    await expect(readFile(path.join(input.worktreeGitRoot, "untracked.txt"), "utf8")).resolves.toBe(
      "recover me\n",
    );
    await expect(
      readFile(
        await git(input.worktreeGitRoot, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "codex-thread.json",
        ]),
        "utf8",
      ),
    ).resolves.toContain('"ownerThreadId": "thread:one"');
    await expect(
      restoreManagedWorktree({
        ...inspectionInput,
        requestId: "restore:again",
        ownerThreadId: "thread:one",
      }),
    ).resolves.toMatchObject({
      worktreeGitRoot: input.worktreeGitRoot,
      snapshotRef: resolveManagedWorktreeSnapshotRef(input.worktreeGitRoot),
    });
  });

  test("runs resolved cleanup before deletion and fails closed on cleanup errors", async () => {
    const input = await fixture();
    const environmentPath = ".codex/environments/environment.toml";
    await mkdir(path.join(input.repositoryPath, ".codex", "environments"), {
      recursive: true,
    });
    await writeFile(
      path.join(input.repositoryPath, environmentPath),
      [
        'name = "cleanup"',
        "[setup]",
        'script = ""',
        "[cleanup]",
        'script = "printf cleaned > $CODEX_SOURCE_TREE_PATH/cleanup.log"',
        "",
      ].join("\n"),
    );
    await git(input.repositoryPath, ["config", "extensions.worktreeConfig", "true"]);
    await git(input.worktreeGitRoot, [
      "config",
      "--worktree",
      "codex.localEnvironmentConfigPath",
      environmentPath,
    ]);
    await removeRetainedManagedWorktree({
      ...snapshotInput(input),
      requestId: "remove:cleanup",
      snapshotPolicy: "required",
    });
    await expect(readFile(path.join(input.repositoryPath, "cleanup.log"), "utf8")).resolves.toBe(
      "cleaned",
    );

    const failing = await fixture();
    await mkdir(path.join(failing.repositoryPath, ".codex", "environments"), {
      recursive: true,
    });
    await writeFile(
      path.join(failing.repositoryPath, environmentPath),
      [
        'name = "cleanup-failure"',
        "[setup]",
        'script = ""',
        "[cleanup]",
        'script = "exit 17"',
        "",
      ].join("\n"),
    );
    await git(failing.repositoryPath, ["config", "extensions.worktreeConfig", "true"]);
    await git(failing.worktreeGitRoot, [
      "config",
      "--worktree",
      "codex.localEnvironmentConfigPath",
      environmentPath,
    ]);
    await expect(
      removeRetainedManagedWorktree({
        ...snapshotInput(failing),
        requestId: "remove:cleanup-failure",
        snapshotPolicy: "required",
      }),
    ).rejects.toThrow("cleanup script failed");
    await expect(statDirectory(failing.worktreeGitRoot)).resolves.toBe(true);
    expect(
      await git(failing.repositoryPath, [
        "show-ref",
        "--verify",
        resolveManagedWorktreeSnapshotRef(failing.worktreeGitRoot),
      ]),
    ).toContain(resolveManagedWorktreeSnapshotRef(failing.worktreeGitRoot));
  });

  test("lists only supported two-level layouts and retains unresolved residue", async () => {
    const input = await fixture();
    await mkdir(path.join(input.managedRoot, "token", "not-a-repository"), {
      recursive: true,
    });
    const legacyResidue = path.join(input.managedRoot, "c0de", "damaged");
    const currentResidue = path.join(input.managedRoot, "bucket", "260829-1430-a1b2c3d4");
    await mkdir(legacyResidue, { recursive: true });
    await mkdir(currentResidue, { recursive: true });
    await symlink(legacyResidue, path.join(input.managedRoot, "c0de", "linked-residue"), "dir");
    const result = await listManagedWorktreesOnHost({
      requestId: "list:1",
      hostId: "local",
      managedRoot: input.managedRoot,
    });
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worktreeGitRoot: input.worktreeGitRoot,
          repositoryPath: await realpath(input.repositoryPath),
          ownerThreadId: null,
          ownerReadFailed: false,
        }),
        expect.objectContaining({ worktreeGitRoot: legacyResidue, repositoryPath: null }),
        expect.objectContaining({ worktreeGitRoot: currentResidue, repositoryPath: null }),
      ]),
    );
    expect(result.entries).toHaveLength(3);
  });

  test("removes an exact unresolved residue under best-effort policy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nodex-managed-residue-remove-"));
    roots.push(root);
    const worktreeGitRoot = path.join(root, "bucket", "260829-1234-deadbeef");
    await mkdir(worktreeGitRoot, { recursive: true });
    await writeFile(path.join(worktreeGitRoot, "partial.txt"), "incomplete creation");

    const result = await removeRetainedManagedWorktree({
      requestId: "remove-residue",
      hostId: "local",
      worktreeGitRoot,
      reason: "settings-delete",
      snapshotPolicy: "best-effort",
    });

    expect(result.removed).toBe(true);
    expect(result.alreadyMissing).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    await expect(statDirectory(worktreeGitRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("treats a missing current root as an empty inventory", async () => {
    await expect(
      listManagedWorktreesOnHost({
        requestId: "list:missing",
        hostId: "local",
        managedRoot: path.join(tmpdir(), `missing-managed-${crypto.randomUUID()}`),
      }),
    ).resolves.toEqual({ entries: [] });
  });
});

async function statDirectory(filePath: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  return (await stat(filePath)).isDirectory();
}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  cleanupCrossHostThreadHandoff,
  exportCrossHostThreadHandoff,
  importCrossHostThreadHandoff,
} from "./codex-cross-host-thread-handoff-git";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, env: process.env })).stdout.trim();
}

async function fixture(): Promise<{
  readonly root: string;
  readonly source: string;
  readonly destination: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "nodex-cross-host-handoff-"));
  roots.push(root);
  const bare = path.join(root, "origin.git");
  const source = path.join(root, "source host", "repo");
  const destination = path.join(root, "destination host", "repo");
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await git(root, "init", "--bare", bare);
  await git(root, "clone", bare, source);
  await git(source, "config", "user.name", "Nodex Test");
  await git(source, "config", "user.email", "nodex@example.test");
  await writeFile(path.join(source, "tracked.txt"), "base\n");
  await git(source, "add", "tracked.txt");
  await git(source, "commit", "-m", "base");
  await git(source, "push", "origin", "HEAD:main");
  await git(root, "clone", "--branch", "main", bare, destination);
  await git(destination, "config", "user.name", "Nodex Test");
  await git(destination, "config", "user.email", "nodex@example.test");
  return { root, source, destination };
}

describe("cross-host thread handoff Git transaction", () => {
  test("bundles the complete dirty source tree and imports a detached managed worktree", async () => {
    const { root, source, destination } = await fixture();
    await writeFile(path.join(source, "tracked.txt"), "dirty\n");
    await writeFile(path.join(source, "staged.txt"), "staged\n");
    await git(source, "add", "staged.txt");
    await writeFile(path.join(source, "untracked.bin"), Buffer.from([0, 1, 2, 255]));
    const transferId = randomUUID();
    const sourceStaging = path.join(root, "source staging");
    const destinationStaging = path.join(root, "destination staging");
    const events: string[] = [];
    const exported = await exportCrossHostThreadHandoff(
      {
        requestId: "export",
        hostId: "source",
        transferId,
        sourceCwd: source,
        sourceWorkspaceRoot: source,
        stagingRoot: sourceStaging,
      },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === "handoff-progress") events.push(`${event.step}:${event.status}`);
        },
      },
    );
    await mkdir(path.join(destinationStaging, transferId), { recursive: true });
    const destinationBundle = path.join(destinationStaging, transferId, "source.bundle");
    const destinationRollout = path.join(destinationStaging, transferId, "rollout.jsonl");
    const destinationCodexHome = path.join(root, "destination codex");
    await writeFile(destinationBundle, await readFile(exported.bundle.path));
    await writeFile(destinationRollout, '{"type":"session_meta"}\n');
    const imported = await importCrossHostThreadHandoff(
      {
        requestId: "import",
        hostId: "destination",
        transferId,
        bundlePath: destinationBundle,
        rolloutPath: destinationRollout,
        rolloutRelativePath: "sessions/2026/08/14/thread.jsonl",
        destinationCodexHome,
        sourceCommit: exported.sourceCommit,
        repositoryIdentity: exported.repositoryIdentity,
        candidateRepositoryPaths: [destination],
        managedRoot: path.join(root, "destination worktrees"),
        allocatedWorktreePath: path.join(root, "destination worktrees", "260930-1200-deadbeef"),
        nodexHome: path.join(root, "destination nodex"),
        projectId: "project",
        threadId: "thread",
        threadTitle: "Cross host",
      },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === "handoff-progress") events.push(`${event.step}:${event.status}`);
        },
      },
    );

    await expect(
      readFile(path.join(imported.destinationWorkspaceRoot, "tracked.txt"), "utf8"),
    ).resolves.toBe("dirty\n");
    await expect(
      readFile(path.join(imported.destinationWorkspaceRoot, "staged.txt"), "utf8"),
    ).resolves.toBe("staged\n");
    expect(await readFile(path.join(imported.destinationWorkspaceRoot, "untracked.bin"))).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );
    await expect(readFile(imported.destinationRolloutPath, "utf8")).resolves.toBe(
      '{"type":"session_meta"}\n',
    );
    expect(events).toEqual([
      "snapshot-source:started",
      "snapshot-source:completed",
      "bundle-source:started",
      "bundle-source:completed",
      "import-bundle:started",
      "import-bundle:completed",
    ]);

    const destinationCleanup = await cleanupCrossHostThreadHandoff({
      requestId: "cleanup-destination",
      hostId: "destination",
      transferId,
      stagingRoot: destinationStaging,
      repositoryPath: destination,
      temporaryRef: imported.temporaryRef,
      managedRoot: path.join(root, "destination worktrees"),
      createdWorktreePath: null,
      createdRolloutPath: imported.destinationRolloutPath,
      destinationCodexHome,
      outcome: "rolled-back",
    });
    const sourceCleanup = await cleanupCrossHostThreadHandoff({
      requestId: "cleanup-source",
      hostId: "source",
      transferId,
      stagingRoot: sourceStaging,
      repositoryPath: source,
      temporaryRef: exported.temporaryRef,
      managedRoot: null,
      createdWorktreePath: null,
      createdRolloutPath: null,
      destinationCodexHome: null,
      outcome: "rolled-back",
    });
    expect(destinationCleanup).toEqual({ cleaned: true, warnings: [] });
    expect(sourceCleanup).toEqual({ cleaned: true, warnings: [] });
    await expect(git(source, "rev-parse", "--verify", exported.temporaryRef)).rejects.toThrow();
    await expect(
      git(destination, "rev-parse", "--verify", imported.temporaryRef),
    ).rejects.toThrow();
    await expect(readFile(imported.destinationRolloutPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("fails closed when no configured destination repository has the same identity", async () => {
    const { root, source } = await fixture();
    const unrelated = path.join(root, "unrelated");
    await mkdir(unrelated);
    await git(unrelated, "init");
    await git(unrelated, "config", "user.name", "Nodex Test");
    await git(unrelated, "config", "user.email", "nodex@example.test");
    await writeFile(path.join(unrelated, "other.txt"), "other\n");
    await git(unrelated, "add", ".");
    await git(unrelated, "commit", "-m", "other");
    const transferId = randomUUID();
    const exported = await exportCrossHostThreadHandoff(
      {
        requestId: "export",
        hostId: "source",
        transferId,
        sourceCwd: source,
        sourceWorkspaceRoot: source,
        stagingRoot: path.join(root, "staging"),
      },
      { signal: new AbortController().signal, onEvent: () => undefined },
    );

    await expect(
      importCrossHostThreadHandoff(
        {
          requestId: "import",
          hostId: "destination",
          transferId,
          bundlePath: exported.bundle.path,
          rolloutPath: exported.bundle.path,
          rolloutRelativePath: "sessions/2026/08/14/thread.jsonl",
          destinationCodexHome: path.join(root, "destination codex"),
          sourceCommit: exported.sourceCommit,
          repositoryIdentity: exported.repositoryIdentity,
          candidateRepositoryPaths: [unrelated],
          managedRoot: path.join(root, "worktrees"),
          allocatedWorktreePath: path.join(root, "worktrees", "260930-1200-deadbeef"),
          nodexHome: path.join(root, "nodex"),
          projectId: "project",
          threadId: "thread",
          threadTitle: "Cross host",
        },
        { signal: new AbortController().signal, onEvent: () => undefined },
      ),
    ).rejects.toThrow("No destination repository matches repo");
  });
});

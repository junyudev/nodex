import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vite-plus/test";
import { executeCodexWorktreeWorkerOperation } from "./codex-worktree-worker-operation";

const run = promisify(execFile);

describe("codex worktree worker git-root", () => {
  test("resolves a repository root on the execution host and classifies non-repositories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nodex-git-root-"));
    try {
      const repository = path.join(root, "repo");
      const nested = path.join(repository, "packages", "app");
      const plainDirectory = path.join(root, "plain");
      await mkdir(nested, { recursive: true });
      await mkdir(plainDirectory, { recursive: true });
      await run("git", ["init", repository], { env: process.env });

      const signal = new AbortController().signal;
      const repositoryResult = await executeCodexWorktreeWorkerOperation(
        {
          operation: "git-root",
          input: { requestId: "git-root:repo", hostId: "local", cwd: nested },
        },
        { signal, onEvent: () => undefined },
      );
      const plainResult = await executeCodexWorktreeWorkerOperation(
        {
          operation: "git-root",
          input: { requestId: "git-root:plain", hostId: "local", cwd: plainDirectory },
        },
        { signal, onEvent: () => undefined },
      );

      expect(repositoryResult).toEqual({
        operation: "git-root",
        value: { root: await realpath(repository) },
      });
      expect(plainResult).toEqual({ operation: "git-root", value: { root: null } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

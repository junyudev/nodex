import { createCodexRequestCanceledError } from "./codex-git-command";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  executeCodexWorktreeWorkerCreate,
  executeCodexWorktreeWorkerOperation,
} from "./codex-worktree-worker-operation";

import { createManagedWorktree, removeManagedWorktree } from "./git-worktree-service";
import { readWorktreeEnvironmentDefinition } from "./worktree-environment-service";
import {
  CodexWorktreeShellReleaseError,
  runCodexWorktreeSetupScript,
} from "./codex-worktree-shell-environment";

vi.mock("./git-worktree-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-worktree-service")>();
  return {
    ...actual,
    createManagedWorktree: vi.fn(actual.createManagedWorktree),
    removeManagedWorktree: vi.fn(actual.removeManagedWorktree),
  };
});
vi.mock("./worktree-environment-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktree-environment-service")>();
  return {
    ...actual,
    readWorktreeEnvironmentDefinition: vi.fn(actual.readWorktreeEnvironmentDefinition),
  };
});
vi.mock("./codex-worktree-shell-environment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-worktree-shell-environment")>();
  return { ...actual, runCodexWorktreeSetupScript: vi.fn(actual.runCodexWorktreeSetupScript) };
});

for (const outcome of [
  "canceled",
  "native-release-failed",
  "cleanup-failed",
  "operation-failed",
] as const) {
  test(`preserves the worktree creation outcome after cancellation (${outcome})`, async () => {
    const actualGit =
      await vi.importActual<typeof import("./git-worktree-service")>("./git-worktree-service");
    const actualEnvironment = await vi.importActual<
      typeof import("./worktree-environment-service")
    >("./worktree-environment-service");
    const actualShell = await vi.importActual<typeof import("./codex-worktree-shell-environment")>(
      "./codex-worktree-shell-environment",
    );
    const root = await mkdtemp(path.join(tmpdir(), "nodex-worker-release-test-"));
    const marker = path.join(root, "owned.txt");
    const controller = new AbortController();
    const cancellation = createCodexRequestCanceledError("Worktree environment setup canceled.");
    const nativeFailure = new Error("Native handles did not become signaled");
    const cleanupFailure = new Error("Worktree cleanup failed after cancellation");
    const failure =
      outcome === "native-release-failed"
        ? new CodexWorktreeShellReleaseError("setup", root, [cancellation, nativeFailure])
        : outcome === "operation-failed"
          ? new Error("Setup failed while canceled")
          : cancellation;
    try {
      await writeFile(marker, "owned command workspace");
      vi.mocked(createManagedWorktree).mockResolvedValueOnce({
        worktreeGitRoot: root,
        worktreeWorkspaceRoot: root,
        baseRef: "HEAD",
        branchName: null,
      });
      vi.mocked(readWorktreeEnvironmentDefinition).mockResolvedValueOnce({
        path: ".codex/environments/environment.toml",
        name: "fixture",
        setupScript: "owned setup",
        cleanupScript: null,
      });
      vi.mocked(runCodexWorktreeSetupScript).mockImplementationOnce(async () => {
        controller.abort();
        throw failure;
      });
      vi.mocked(removeManagedWorktree).mockImplementationOnce(async (directory) => {
        if (outcome === "cleanup-failed") throw cleanupFailure;
        await rm(directory, { recursive: true, force: true });
      });
      const operation = executeCodexWorktreeWorkerCreate(
        {
          requestId: "create:owned",
          hostId: "local",
          repositoryPath: root,
          nodexHome: root,
          managedRoot: root,
          projectId: "project",
          targetId: "target",
          threadTitle: "Owned command",
          startingState: { type: "branch", branchName: "main" },
          localEnvironmentConfigPath: ".codex/environments/environment.toml",
          setUpSyncedBranch: false,
          propagateLocalWorkspaceFiles: false,
        },
        { signal: controller.signal, onEvent: () => {} },
      );
      if (outcome !== "canceled") {
        await expect(operation).rejects.toBe(
          outcome === "cleanup-failed" ? cleanupFailure : failure,
        );
        if (outcome === "cleanup-failed")
          expect(removeManagedWorktree).toHaveBeenCalledExactlyOnceWith(root);
        else expect(removeManagedWorktree).not.toHaveBeenCalled();
        expect(await readFile(marker, "utf8")).toBe("owned command workspace");
      } else {
        await expect(operation).rejects.toThrow("Request canceled");
        expect(removeManagedWorktree).toHaveBeenCalledExactlyOnceWith(root);
        await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      vi.mocked(createManagedWorktree)
        .mockReset()
        .mockImplementation(actualGit.createManagedWorktree);
      vi.mocked(removeManagedWorktree)
        .mockReset()
        .mockImplementation(actualGit.removeManagedWorktree);
      vi.mocked(readWorktreeEnvironmentDefinition)
        .mockReset()
        .mockImplementation(actualEnvironment.readWorktreeEnvironmentDefinition);
      vi.mocked(runCodexWorktreeSetupScript)
        .mockReset()
        .mockImplementation(actualShell.runCodexWorktreeSetupScript);
      await rm(root, { recursive: true, force: true });
    }
  });
}

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

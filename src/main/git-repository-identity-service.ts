import path from "node:path";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import type { GitRepositoryIdentity } from "../shared/git-repository-identity";
import { parseGitRepositoryOwnerRepo } from "../shared/git-repository-identity";

interface GitCommandError extends Error {
  stderr?: string;
}

interface GitCommandResult {
  stdout: string;
}

const GIT_COMMAND_TIMEOUT_MS = 5_000;

async function ensureDirectory(cwd: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const normalizedCwd = cwd.trim();
  if (!normalizedCwd) {
    throw new Error("Working directory is required");
  }

  const entry = await stat(normalizedCwd).catch(() => null);
  signal?.throwIfAborted();
  if (!entry?.isDirectory()) {
    throw new Error(`Working directory not found: ${normalizedCwd}`);
  }

  return normalizedCwd;
}

function runGitCommand(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: GIT_COMMAND_TIMEOUT_MS,
        windowsHide: true,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as GitCommandError;
          failure.stderr = typeof stderr === "string" ? stderr : "";
          reject(failure);
          return;
        }

        resolve({ stdout: typeof stdout === "string" ? stdout : "" });
      },
    );
  });
}

function isNotGitRepositoryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return `${error.message}\n${stderr}`.toLowerCase().includes("not a git repository");
}

async function readRemoteUrl(repositoryRoot: string, signal?: AbortSignal): Promise<string | null> {
  const remoteList: string[] = await runGitCommand(["remote"], repositoryRoot, signal)
    .then(({ stdout }) =>
      stdout
        .split(/\r?\n/)
        .map((remote) => remote.trim())
        .filter(Boolean),
    )
    .catch((error) => {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return [];
    });
  const remote = remoteList.includes("origin") ? "origin" : remoteList[0];
  if (!remote) return null;

  return runGitCommand(["remote", "get-url", remote], repositoryRoot, signal)
    .then(({ stdout }) => stdout.trim() || null)
    .catch((error) => {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return null;
    });
}

export async function readGitRepositoryIdentity(
  cwd: string,
  signal?: AbortSignal,
): Promise<GitRepositoryIdentity | null> {
  const normalizedCwd = await ensureDirectory(cwd, signal);

  try {
    const repositoryRoot = await runGitCommand(
      ["rev-parse", "--show-toplevel"],
      normalizedCwd,
      signal,
    ).then(({ stdout }) => (stdout.trim() ? path.normalize(stdout.trim()) : ""));
    if (!repositoryRoot) return null;

    const originUrl = await readRemoteUrl(repositoryRoot, signal);
    return {
      repositoryRoot,
      ownerRepo: parseGitRepositoryOwnerRepo(originUrl),
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) return null;
    throw error;
  }
}

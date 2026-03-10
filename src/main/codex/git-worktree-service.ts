import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { WorktreeStartMode } from "../../shared/types";
import {
  buildWorktreeThreadSlug,
  normalizeWorktreeAutoBranchPrefix,
} from "../../shared/worktree-auto-branch";

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

type GitCommandOutputStream = "stdout" | "stderr" | "info";

const GIT_COMMAND_TIMEOUT_MS = 8_000;
const MAX_AUTO_BRANCH_NAME_ATTEMPTS = 100;

function normalizeBranchName(value: string): string {
  return value.trim();
}

function sanitizePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.length > 0 ? normalized : "project";
}

async function ensureDirectory(cwd: string): Promise<string> {
  const normalizedCwd = cwd.trim();
  if (!normalizedCwd) {
    throw new Error("Working directory is required");
  }

  const entry = await stat(normalizedCwd).catch(() => null);
  if (!entry?.isDirectory()) {
    throw new Error(`Working directory not found: ${normalizedCwd}`);
  }
  return normalizedCwd;
}

async function ensureGitRepository(cwd: string): Promise<void> {
  const result = await runGitCommand(["rev-parse", "--is-inside-work-tree"], cwd);
  if (result.stdout.trim() !== "true") {
    throw new Error(`Path is not a git repository: ${cwd}`);
  }
}

function runGitCommand(
  args: string[],
  cwd: string,
  options?: {
    onOutput?: (output: { stream: GitCommandOutputStream; data: string }) => void;
  },
): Promise<GitCommandResult> {
  const onOutput = options?.onOutput;
  if (!onOutput) {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          encoding: "utf8",
          timeout: GIT_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(typeof stderr === "string" && stderr.trim() ? stderr.trim() : String(error)));
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

  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      args,
      {
        cwd,
        env: process.env,
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 250).unref();
    }, GIT_COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      onOutput({
        stream: "stdout",
        data: text,
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      onOutput({
        stream: "stderr",
        data: text,
      });
    });

    child.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr });
        return;
      }

      if (timedOut) {
        reject(new Error(`git ${args.join(" ")} timed out after ${GIT_COMMAND_TIMEOUT_MS}ms`));
        return;
      }

      const message = stderr.trim() || stdout.trim() || `git exited with code ${String(code)}`;
      reject(new Error(message));
    });
  });
}

async function branchExists(cwd: string, branchName: string): Promise<boolean> {
  const exists = await runGitCommand(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    cwd,
  ).then(() => true).catch(() => false);
  return exists;
}

async function resolveAutoBranchName(input: {
  repositoryPath: string;
  threadTitle?: string | null;
  branchPrefix?: string | null;
}): Promise<string> {
  const normalizedPrefix = normalizeWorktreeAutoBranchPrefix(input.branchPrefix);
  const threadSlug = buildWorktreeThreadSlug(input.threadTitle);
  const branchBase = `${normalizedPrefix}${threadSlug}`;

  for (let attempt = 1; attempt <= MAX_AUTO_BRANCH_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? branchBase : `${branchBase}-${attempt}`;
    await runGitCommand(["check-ref-format", "--branch", candidate], input.repositoryPath);
    const exists = await branchExists(input.repositoryPath, candidate);
    if (exists) continue;
    return candidate;
  }

  throw new Error("Could not allocate a unique auto-branch name for new worktree");
}

async function resolveDefaultBaseRef(cwd: string, preferredBaseBranch?: string | null): Promise<string> {
  const normalizedPreferred = preferredBaseBranch?.trim() || "";
  if (normalizedPreferred) {
    await runGitCommand(["check-ref-format", "--branch", normalizedPreferred], cwd);
    await runGitCommand(["rev-parse", "--verify", `${normalizedPreferred}^{commit}`], cwd);
    return normalizedPreferred;
  }

  const [currentBranchResult, branchListResult, defaultRemoteResult] = await Promise.all([
    runGitCommand(["branch", "--show-current"], cwd),
    runGitCommand(["branch", "--format=%(refname:short)"], cwd),
    runGitCommand(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd).catch(() => null),
  ]);

  const currentBranch = normalizeBranchName(currentBranchResult.stdout) || null;
  const branches = branchListResult.stdout
    .split(/\r?\n/)
    .map((branch) => normalizeBranchName(branch))
    .filter((branch, index, items) => branch.length > 0 && items.indexOf(branch) === index);

  const remoteDefaultRaw = defaultRemoteResult?.stdout
    ? normalizeBranchName(defaultRemoteResult.stdout)
    : "";
  const remoteDefaultBranch = remoteDefaultRaw.startsWith("origin/")
    ? remoteDefaultRaw.slice("origin/".length)
    : remoteDefaultRaw || null;

  const candidates = [
    remoteDefaultBranch,
    "main",
    "master",
    currentBranch,
    branches[0] ?? null,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const commit = await runGitCommand(["rev-parse", "--verify", `${candidate}^{commit}`], cwd).catch(() => null);
    if (!commit) continue;
    return candidate;
  }

  throw new Error("Could not resolve a base branch for new worktree");
}

async function resolveWorktreeRepositoryPath(worktreePath: string): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    worktreePath,
  ).catch(() => null);
  const gitCommonDir = result?.stdout.trim();
  if (!gitCommonDir) return null;

  const resolvedGitDir = path.resolve(gitCommonDir);
  if (path.basename(resolvedGitDir) !== ".git") return null;
  return path.dirname(resolvedGitDir);
}

async function cleanupEmptyWorktreeTokenDir(worktreePath: string): Promise<void> {
  const tokenDir = path.dirname(worktreePath);
  const entries = await readdir(tokenDir).catch(() => null);
  if (!entries || entries.length > 0) return;

  await rm(tokenDir, { recursive: true, force: true }).catch(() => undefined);
}

export interface CreateManagedWorktreeInput {
  repositoryPath: string;
  serverDir: string;
  projectId: string;
  cardId: string;
  threadTitle?: string | null;
  branchPrefix?: string | null;
  preferredBaseBranch?: string | null;
  mode: WorktreeStartMode;
  onLog?: (output: { stream: GitCommandOutputStream; data: string }) => void;
}

export interface CreateManagedWorktreeResult {
  cwd: string;
  baseRef: string;
  branchName: string | null;
}

export async function removeManagedWorktree(worktreePath: string): Promise<void> {
  const normalizedPath = worktreePath.trim();
  if (!normalizedPath) {
    throw new Error("Worktree path is required");
  }

  const resolvedPath = path.resolve(normalizedPath);
  const existing = await stat(resolvedPath).catch(() => null);
  if (!existing?.isDirectory()) {
    await cleanupEmptyWorktreeTokenDir(resolvedPath);
    return;
  }

  const repositoryPath = await resolveWorktreeRepositoryPath(resolvedPath);
  if (!repositoryPath) {
    await rm(resolvedPath, { recursive: true, force: true });
    await cleanupEmptyWorktreeTokenDir(resolvedPath);
    return;
  }

  const removedByGit = await runGitCommand(
    ["worktree", "remove", "--force", resolvedPath],
    repositoryPath,
  ).then(() => true).catch(() => false);

  if (!removedByGit) {
    await rm(resolvedPath, { recursive: true, force: true });
  }

  await runGitCommand(["worktree", "prune"], repositoryPath).catch(() => undefined);
  await cleanupEmptyWorktreeTokenDir(resolvedPath);
}

export async function createManagedWorktree(input: CreateManagedWorktreeInput): Promise<CreateManagedWorktreeResult> {
  const repositoryPath = await ensureDirectory(input.repositoryPath);
  await ensureGitRepository(repositoryPath);
  const serverDir = path.resolve(input.serverDir.trim());
  await mkdir(serverDir, { recursive: true });
  const baseRef = await resolveDefaultBaseRef(repositoryPath, input.preferredBaseBranch);
  const projectPathSegment = sanitizePathSegment(input.projectId);
  const worktreesRoot = path.join(serverDir, "worktrees");
  await mkdir(worktreesRoot, { recursive: true });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = randomBytes(2).toString("hex");
    const worktreePath = path.join(worktreesRoot, token, projectPathSegment);
    const existing = await stat(worktreePath).catch(() => null);
    if (existing) continue;
    await mkdir(path.dirname(worktreePath), { recursive: true });

    if (input.mode === "autoBranch") {
      const branchName = await resolveAutoBranchName({
        repositoryPath,
        threadTitle: input.threadTitle,
        branchPrefix: input.branchPrefix,
      });
      await runGitCommand(
        ["worktree", "add", "-b", branchName, worktreePath, baseRef],
        repositoryPath,
        { onOutput: input.onLog },
      );
      return {
        cwd: worktreePath,
        baseRef,
        branchName,
      };
    }

    await runGitCommand(
      ["worktree", "add", "--detach", worktreePath, baseRef],
      repositoryPath,
      { onOutput: input.onLog },
    );
    return {
      cwd: worktreePath,
      baseRef,
      branchName: null,
    };
  }

  throw new Error("Could not allocate a unique worktree path");
}

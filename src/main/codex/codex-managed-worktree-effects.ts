import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CodexWorktreeWorkerEvent,
  CodexWorktreeWorkerInspectInput,
  CodexWorktreeWorkerInspectResult,
  CodexWorktreeWorkerListInput,
  CodexWorktreeWorkerListResult,
  CodexWorktreeWorkerRemoveInput,
  CodexWorktreeWorkerRemoveResult,
  CodexWorktreeWorkerRestoreInput,
  CodexWorktreeWorkerRestoreResult,
  CodexWorktreeWorkerSnapshotInput,
  CodexWorktreeWorkerSnapshotResult,
} from "./codex-worktree-worker-protocol";
import { runCodexGitCommand, throwIfCodexRequestAborted } from "./codex-git-command";
import {
  readManagedWorktreeOwnerThread,
  removeManagedWorktree,
  setManagedWorktreeOwnerThread,
} from "./git-worktree-service";
import { readWorktreeEnvironmentDefinition } from "./worktree-environment-service";
import { runCodexWorktreeCleanupScript } from "./codex-worktree-shell-environment";

const SNAPSHOT_REF_PREFIX = "refs/codex/snapshots/";
const LOCAL_ENVIRONMENT_CONFIG_KEY = "codex.localEnvironmentConfigPath";
const NO_LOCAL_ENVIRONMENT = "__none__";
const MAX_LISTED_WORKTREES = 100_000;
const MAX_UNTRACKED_PATHS = 100_000;

export function normalizeWorktreePathForIdentity(worktreePath: string): string {
  const resolved = path.normalize(path.resolve(worktreePath.trim())).normalize("NFC");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Resolves filesystem aliases only for comparisons. Durable identities keep the
 * spelling that the execution host returned so `/var` and `/private/var` do not
 * accidentally become two protection domains on macOS.
 */
export async function resolveWorktreePathComparisonKey(worktreePath: string): Promise<string> {
  try {
    return normalizeWorktreePathForIdentity(await realpath(worktreePath));
  } catch {
    return normalizeWorktreePathForIdentity(worktreePath);
  }
}

export function resolveManagedWorktreeId(worktreePath: string): string {
  return createHash("sha1")
    .update(normalizeWorktreePathForIdentity(worktreePath), "utf8")
    .digest("hex");
}

export function resolveManagedWorktreeSnapshotRef(worktreePath: string): string {
  return `${SNAPSHOT_REF_PREFIX}${resolveManagedWorktreeId(worktreePath)}`;
}

const LEGACY_MANAGED_PARENT_PATTERN = /^[0-9a-f]{4}$/iu;
const CURRENT_MANAGED_WORKTREE_PATTERN = /^\d{6}-\d{4}-[0-9a-f]{8}$/iu;

export function isLegacyManagedWorktreeParent(name: string): boolean {
  return LEGACY_MANAGED_PARENT_PATTERN.test(name);
}

export function isCurrentManagedWorktreeDirectory(name: string): boolean {
  return CURRENT_MANAGED_WORKTREE_PATTERN.test(name);
}

function assertExactManagedWorktreePath(worktreeGitRoot: string): string {
  const resolvedWorktreeRoot = path.resolve(worktreeGitRoot.trim());
  const filesystemRoot = path.parse(resolvedWorktreeRoot).root;
  if (!worktreeGitRoot.trim() || resolvedWorktreeRoot === filesystemRoot) {
    throw new Error("Managed worktree target is invalid");
  }
  const parentName = path.basename(path.dirname(resolvedWorktreeRoot));
  const targetName = path.basename(resolvedWorktreeRoot);
  if (
    !isLegacyManagedWorktreeParent(parentName) &&
    !isCurrentManagedWorktreeDirectory(targetName)
  ) {
    throw new Error("Managed worktree target does not match an allocation layout");
  }
  return resolvedWorktreeRoot;
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveRepositoryPath(
  worktreeGitRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runCodexGitCommand(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    worktreeGitRoot,
    { signal },
  );
  const commonDir = path.resolve(worktreeGitRoot, result.stdout.trim());
  if (path.basename(commonDir) !== ".git") {
    throw new Error("Managed worktree does not point to a non-bare source repository");
  }
  return path.dirname(commonDir);
}

async function readRef(
  repositoryPath: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runCodexGitCommand(["rev-parse", "--verify", ref], repositoryPath, {
    signal,
  }).catch((error) => {
    throwIfCodexRequestAborted(signal);
    if (error instanceof Error) return null;
    throw error;
  });
  return result?.stdout.trim() || null;
}

async function validateEligibleUntrackedEntries(
  worktreeGitRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const listed = await runCodexGitCommand(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    worktreeGitRoot,
    { signal },
  );
  const paths = listed.stdout.split("\0").filter(Boolean);
  if (paths.length > MAX_UNTRACKED_PATHS) {
    throw new Error("Worktree has too many untracked files to snapshot safely");
  }
  for (const relativePath of paths) {
    throwIfCodexRequestAborted(signal);
    const absolutePath = path.resolve(worktreeGitRoot, relativePath);
    if (!isPathWithin(worktreeGitRoot, absolutePath)) {
      throw new Error("Untracked worktree path escapes the worktree root");
    }
    const entry = await lstat(absolutePath);
    if (entry.isFile() || entry.isSymbolicLink()) continue;
    throw new Error(`Unsupported untracked worktree entry: ${relativePath}`);
  }
}

export async function snapshotManagedWorktree(
  input: CodexWorktreeWorkerSnapshotInput,
  options: {
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: CodexWorktreeWorkerEvent) => void;
    readonly operation?: "snapshot" | "remove";
  } = {},
): Promise<CodexWorktreeWorkerSnapshotResult> {
  const worktreeGitRoot = assertExactManagedWorktreePath(input.worktreeGitRoot);
  options.onEvent?.({
    operation: options.operation ?? "snapshot",
    type: "snapshot-started",
  });
  await validateEligibleUntrackedEntries(worktreeGitRoot, options.signal);
  const repositoryPath = await resolveRepositoryPath(worktreeGitRoot, options.signal);
  const worktreeId = resolveManagedWorktreeId(worktreeGitRoot);
  const snapshotRef = `${SNAPSHOT_REF_PREFIX}${worktreeId}`;
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "nodex-worktree-snapshot-"));
  const temporaryIndex = path.join(temporaryRoot, "index");
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  try {
    const head = await readRef(worktreeGitRoot, "HEAD", options.signal);
    await runCodexGitCommand(
      head ? ["read-tree", head] : ["read-tree", "--empty"],
      worktreeGitRoot,
      { env, signal: options.signal },
    );
    await runCodexGitCommand(["add", "-A", "--", "."], worktreeGitRoot, {
      env,
      signal: options.signal,
    });
    const tree = (
      await runCodexGitCommand(["write-tree"], worktreeGitRoot, {
        env,
        signal: options.signal,
      })
    ).stdout.trim();
    const headTree = head
      ? (
          await runCodexGitCommand(["rev-parse", `${head}^{tree}`], worktreeGitRoot, {
            signal: options.signal,
          })
        ).stdout.trim()
      : null;
    const changed = head === null || tree !== headTree;
    const commitId =
      !changed && head
        ? head
        : (
            await runCodexGitCommand(
              [
                "commit-tree",
                tree,
                ...(head ? ["-p", head] : []),
                "-m",
                `Codex worktree snapshot: ${input.reason}`,
              ],
              worktreeGitRoot,
              {
                env: {
                  ...env,
                  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Codex",
                  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "codex@localhost",
                  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Codex",
                  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "codex@localhost",
                },
                signal: options.signal,
              },
            )
          ).stdout.trim();
    await runCodexGitCommand(["update-ref", snapshotRef, commitId], repositoryPath, {
      signal: options.signal,
    });
    return { worktreeId, repositoryPath, snapshotRef, commitId, changed };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function inspectManagedWorktree(
  input: CodexWorktreeWorkerInspectInput,
  signal?: AbortSignal,
): Promise<CodexWorktreeWorkerInspectResult> {
  const worktreeGitRoot = assertExactManagedWorktreePath(input.worktreeGitRoot);
  if (!isPathWithin(worktreeGitRoot, input.cwd)) {
    throw new Error("Worktree cwd is outside the worktree root");
  }
  const cwdEntry = await stat(input.cwd).catch(() => null);
  throwIfCodexRequestAborted(signal);
  if (cwdEntry?.isDirectory()) return { availability: { state: "available" } };
  const worktreeEntry = await stat(worktreeGitRoot).catch(() => null);
  if (worktreeEntry?.isDirectory()) return { availability: { state: "gone" } };
  if (input.candidateRepositoryPaths.length === 0) {
    return {
      availability: {
        state: "unavailable",
        reason: "no-candidate-roots",
        message: "No source repository is available to inspect this worktree",
      },
    };
  }
  const snapshotRef = resolveManagedWorktreeSnapshotRef(worktreeGitRoot);
  let completedInspection = false;
  let lastError: Error | null = null;
  for (const candidate of input.candidateRepositoryPaths) {
    try {
      const repositoryPath = path.resolve(candidate);
      const isRepository =
        (
          await runCodexGitCommand(["rev-parse", "--is-inside-work-tree"], repositoryPath, {
            signal,
          })
        ).stdout.trim() === "true";
      if (!isRepository) continue;
      completedInspection = true;
      const commitId = await readRef(repositoryPath, snapshotRef, signal);
      if (commitId) {
        return {
          availability: { state: "restorable", repositoryPath, snapshotRef },
        };
      }
    } catch (error) {
      throwIfCodexRequestAborted(signal);
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (completedInspection) return { availability: { state: "gone" } };
  return {
    availability: {
      state: "unavailable",
      reason: "inspection-failed",
      message: lastError?.message ?? "Could not inspect a candidate source repository",
    },
  };
}

export async function restoreManagedWorktree(
  input: CodexWorktreeWorkerRestoreInput,
  options: {
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: CodexWorktreeWorkerEvent) => void;
  } = {},
): Promise<CodexWorktreeWorkerRestoreResult> {
  const worktreeGitRoot = assertExactManagedWorktreePath(input.worktreeGitRoot);
  options.onEvent?.({ operation: "restore", type: "restore-started" });
  const inspected = await inspectManagedWorktree(input, options.signal);
  if (inspected.availability.state === "available") {
    const snapshotRef = resolveManagedWorktreeSnapshotRef(worktreeGitRoot);
    for (const candidate of input.candidateRepositoryPaths) {
      const repositoryPath = path.resolve(candidate);
      const [expectedCommit, currentHead] = await Promise.all([
        readRef(repositoryPath, snapshotRef, options.signal),
        readRef(worktreeGitRoot, "HEAD", options.signal),
      ]);
      if (!expectedCommit || currentHead !== expectedCommit) continue;
      let ownerWarning: string | null = null;
      if (input.ownerThreadId?.trim()) {
        await setManagedWorktreeOwnerThread(
          worktreeGitRoot,
          input.ownerThreadId,
          options.signal,
        ).catch((error) => {
          ownerWarning = error instanceof Error ? error.message : String(error);
        });
      }
      return {
        worktreeGitRoot,
        cwd: input.cwd,
        repositoryPath,
        snapshotRef,
        ownerWarning,
      };
    }
    throw new Error("Available worktree does not match its recovery snapshot");
  }
  if (inspected.availability.state !== "restorable") {
    throw new Error("Worktree does not have a restorable snapshot");
  }
  const { repositoryPath, snapshotRef } = inspected.availability;
  const expectedCommit = await readRef(repositoryPath, snapshotRef, options.signal);
  if (!expectedCommit) throw new Error("Worktree snapshot disappeared before restore");
  const existing = await stat(worktreeGitRoot).catch(() => null);
  let created = false;
  if (existing) {
    if (!existing.isDirectory()) throw new Error("Restore path is occupied by another entry");
    const currentHead = await readRef(worktreeGitRoot, "HEAD", options.signal);
    if (currentHead !== expectedCommit) {
      throw new Error("Restore path contains a different worktree");
    }
  } else {
    await mkdir(path.dirname(worktreeGitRoot), { recursive: true });
    await runCodexGitCommand(
      ["worktree", "add", "--detach", worktreeGitRoot, snapshotRef],
      repositoryPath,
      { signal: options.signal },
    );
    created = true;
  }
  let ownerWarning: string | null = null;
  try {
    if (!(await stat(input.cwd).catch(() => null))?.isDirectory()) {
      const relativeCwd = path.relative(worktreeGitRoot, input.cwd);
      if (
        relativeCwd === "" ||
        relativeCwd === ".." ||
        relativeCwd.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeCwd)
      ) {
        throw new Error("Invalid restored worktree cwd");
      }
      await runCodexGitCommand(["sparse-checkout", "add", "--", relativeCwd], worktreeGitRoot, {
        signal: options.signal,
      });
      if (!(await stat(input.cwd).catch(() => null))?.isDirectory()) {
        throw new Error("Failed to materialize restored worktree cwd");
      }
    }
    if (input.ownerThreadId?.trim()) {
      await setManagedWorktreeOwnerThread(
        worktreeGitRoot,
        input.ownerThreadId,
        options.signal,
      ).catch((error) => {
        ownerWarning = error instanceof Error ? error.message : String(error);
      });
    }
    return { worktreeGitRoot, cwd: input.cwd, repositoryPath, snapshotRef, ownerWarning };
  } catch (error) {
    if (created) await removeManagedWorktree(worktreeGitRoot).catch(() => undefined);
    throw error;
  }
}

export async function removeRetainedManagedWorktree(
  input: CodexWorktreeWorkerRemoveInput,
  options: {
    readonly signal?: AbortSignal;
    readonly onEvent?: (event: CodexWorktreeWorkerEvent) => void;
    readonly loadBaseEnvironment?: () => Promise<NodeJS.ProcessEnv>;
  } = {},
): Promise<CodexWorktreeWorkerRemoveResult> {
  const worktreeGitRoot = assertExactManagedWorktreePath(input.worktreeGitRoot);
  const existing = await stat(worktreeGitRoot).catch(() => null);
  if (!existing?.isDirectory()) {
    return { removed: false, alreadyMissing: true, snapshot: null, warnings: [] };
  }
  if (input.snapshotPolicy === "ephemeral") {
    await removeManagedWorktree(worktreeGitRoot);
    return { removed: true, alreadyMissing: false, snapshot: null, warnings: [] };
  }
  const warnings: string[] = [];
  let snapshot: CodexWorktreeWorkerSnapshotResult | null = null;
  try {
    snapshot = await snapshotManagedWorktree(
      { ...input },
      {
        signal: options.signal,
        onEvent: options.onEvent,
        operation: "remove",
      },
    );
  } catch (error) {
    throwIfCodexRequestAborted(options.signal);
    if (input.snapshotPolicy === "required") throw error;
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  const repositoryPath = await resolveRepositoryPath(worktreeGitRoot, options.signal).catch(
    (error) => {
      throwIfCodexRequestAborted(options.signal);
      if (input.snapshotPolicy === "required") throw error;
      warnings.push(error instanceof Error ? error.message : String(error));
      return null;
    },
  );
  if (repositoryPath === null) {
    await removeManagedWorktree(worktreeGitRoot);
    return { removed: true, alreadyMissing: false, snapshot, warnings };
  }
  const selectedEnvironment = await runCodexGitCommand(
    ["config", "--worktree", "--get", LOCAL_ENVIRONMENT_CONFIG_KEY],
    worktreeGitRoot,
    { allowedExitCodes: [0, 1], signal: options.signal },
  )
    .then((result) => result.stdout.trim())
    .catch((error) => {
      throwIfCodexRequestAborted(options.signal);
      warnings.push(error instanceof Error ? error.message : String(error));
      return "";
    });
  if (selectedEnvironment && selectedEnvironment !== NO_LOCAL_ENVIRONMENT) {
    try {
      const environment = await readWorktreeEnvironmentDefinition({
        workspacePath: repositoryPath,
        environmentPath: selectedEnvironment,
      });
      if (environment.cleanupScript) {
        options.onEvent?.({ operation: "remove", type: "cleanup-started" });
        await runCodexWorktreeCleanupScript({
          script: environment.cleanupScript,
          cwd: worktreeGitRoot,
          signal: options.signal,
          loadBaseEnvironment: options.loadBaseEnvironment,
          environment: {
            CODEX_SOURCE_TREE_PATH: repositoryPath,
            CODEX_WORKTREE_PATH: worktreeGitRoot,
          },
          onOutput: (output) =>
            options.onEvent?.({
              operation: "remove",
              type: "output",
              phase: "cleanup",
              stream: output.stream,
              data: output.data,
            }),
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Worktree environment cleanup")) {
        throw error;
      }
      throwIfCodexRequestAborted(options.signal);
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  await removeManagedWorktree(worktreeGitRoot);
  return { removed: true, alreadyMissing: false, snapshot, warnings };
}

export async function listManagedWorktreesOnHost(
  input: CodexWorktreeWorkerListInput,
  signal?: AbortSignal,
): Promise<CodexWorktreeWorkerListResult> {
  const managedRoot = path.resolve(input.managedRoot);
  const tokenEntries = await readdir(managedRoot, { withFileTypes: true }).catch(() => []);
  const entries: CodexWorktreeWorkerListResult["entries"][number][] = [];
  for (const tokenEntry of tokenEntries) {
    if (!tokenEntry.isDirectory() || tokenEntry.isSymbolicLink()) continue;
    const tokenPath = path.join(managedRoot, tokenEntry.name);
    const worktreeEntries = await readdir(tokenPath, { withFileTypes: true }).catch(() => []);
    for (const worktreeEntry of worktreeEntries) {
      throwIfCodexRequestAborted(signal);
      if (!worktreeEntry.isDirectory() || worktreeEntry.isSymbolicLink()) continue;
      if (
        !isLegacyManagedWorktreeParent(tokenEntry.name) &&
        !isCurrentManagedWorktreeDirectory(worktreeEntry.name)
      ) {
        continue;
      }
      if (entries.length >= MAX_LISTED_WORKTREES) {
        throw new Error("Managed worktree inventory exceeds its host bound");
      }
      const worktreeGitRoot = path.join(tokenPath, worktreeEntry.name);
      const [repositoryPath, metadata, owner] = await Promise.all([
        resolveRepositoryPath(worktreeGitRoot, signal).catch(() => null),
        stat(worktreeGitRoot).catch(() => null),
        readManagedWorktreeOwnerThread(worktreeGitRoot, signal).then(
          (ownerThreadId) => ({ ownerThreadId, ownerReadFailed: false }),
          () => ({ ownerThreadId: null, ownerReadFailed: true }),
        ),
      ]);
      entries.push({
        worktreeGitRoot,
        repositoryPath,
        createdAtMs: metadata?.birthtimeMs ?? null,
        ownerThreadId: owner.ownerThreadId,
        ownerReadFailed: owner.ownerReadFailed,
      });
    }
  }
  return { entries };
}

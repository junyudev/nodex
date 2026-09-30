import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createManagedWorktree, removeManagedWorktree } from "./git-worktree-service";
import { describeCodexTransferFile } from "./codex-execution-host-file-transfer";
import { runCodexGitCommand, throwIfCodexRequestAborted } from "./codex-git-command";
import type {
  CodexRepositoryIdentity,
  CodexWorktreeWorkerCleanupTransferHandoffInput,
  CodexWorktreeWorkerCleanupTransferHandoffResult,
  CodexWorktreeWorkerExportHandoffInput,
  CodexWorktreeWorkerExportHandoffResult,
  CodexWorktreeWorkerImportHandoffInput,
  CodexWorktreeWorkerImportHandoffResult,
  CodexWorktreeWorkerOperationOptions,
} from "./codex-worktree-worker-protocol";

const SOURCE_REF_PREFIX = "refs/codex/handoff/source/";
const DESTINATION_REF_PREFIX = "refs/codex/handoff/destination/";
const MAX_UNTRACKED_PATHS = 100_000;

function transferToken(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]{1,200}$/u.test(normalized) || normalized === "." || normalized === "..") {
    throw new Error("Invalid cross-host handoff transfer id");
  }
  return normalized;
}

function isWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function repositoryRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  return path.resolve(
    (await runCodexGitCommand(["rev-parse", "--show-toplevel"], cwd, { signal })).stdout.trim(),
  );
}

function normalizedRemoteIdentity(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u.exec(trimmed);
  if (scp && !/^[A-Za-z]:[\\/]/u.test(trimmed)) {
    return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+|\.git\/?$/gu, "")}`;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:")
      return `file/${path.basename(parsed.pathname).replace(/\.git$/u, "")}`;
    return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+|\.git\/?$/gu, "")}`;
  } catch {
    if (path.isAbsolute(trimmed)) return `file/${path.basename(trimmed).replace(/\.git$/u, "")}`;
    return null;
  }
}

function identityKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readRepositoryIdentity(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<CodexRepositoryIdentity> {
  const remotes = await runCodexGitCommand(
    ["remote", "get-url", "--all", "origin"],
    repositoryPath,
    { allowedExitCodes: [0, 2], signal },
  ).then((result) =>
    result.stdout
      .split(/\r?\n/u)
      .map(normalizedRemoteIdentity)
      .filter((value): value is string => value !== null),
  );
  const displayName = path.basename(repositoryPath).replace(/\.git$/u, "") || "repository";
  const sourceKeys = remotes.length > 0 ? remotes : [`name/${displayName}`];
  return {
    displayName,
    keys: [...new Set(sourceKeys.map(identityKey))].sort(),
  };
}

async function validateUntrackedFiles(root: string, signal?: AbortSignal): Promise<void> {
  const listed = await runCodexGitCommand(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    root,
    { signal },
  );
  const relativePaths = listed.stdout.split("\0").filter(Boolean);
  if (relativePaths.length > MAX_UNTRACKED_PATHS) {
    throw new Error("Source has too many untracked files to hand off safely");
  }
  for (const relativePath of relativePaths) {
    throwIfCodexRequestAborted(signal);
    const candidate = path.resolve(root, relativePath);
    if (!isWithin(root, candidate))
      throw new Error("Untracked handoff path escapes the repository");
    const metadata = await lstat(candidate);
    if (!metadata.isFile() && !metadata.isSymbolicLink()) {
      throw new Error(`Unsupported untracked handoff entry: ${relativePath}`);
    }
  }
}

async function readCurrentBranch(root: string, signal?: AbortSignal): Promise<string> {
  return await runCodexGitCommand(["symbolic-ref", "--quiet", "--short", "HEAD"], root, { signal })
    .then((result) => result.stdout.trim())
    .catch(() => "HEAD");
}

/** Captures the complete materialized source tree without touching its real index. */
export async function exportCrossHostThreadHandoff(
  input: CodexWorktreeWorkerExportHandoffInput,
  options: CodexWorktreeWorkerOperationOptions,
): Promise<CodexWorktreeWorkerExportHandoffResult> {
  const transferId = transferToken(input.transferId);
  if (!isWithin(input.sourceWorkspaceRoot, input.sourceCwd)) {
    throw new Error("Cross-host handoff cwd is outside its primary workspace root");
  }
  const root = await repositoryRoot(input.sourceCwd, options.signal);
  const [canonicalRoot, canonicalWorkspaceRoot] = await Promise.all([
    realpath(root),
    realpath(input.sourceWorkspaceRoot),
  ]);
  if (
    !isWithin(canonicalRoot, canonicalWorkspaceRoot) &&
    !isWithin(canonicalWorkspaceRoot, canonicalRoot)
  ) {
    throw new Error("Cross-host handoff primary root does not belong to the source repository");
  }
  const stagingDirectory = path.join(path.resolve(input.stagingRoot), transferId);
  const bundlePath = path.join(stagingDirectory, "source.bundle");
  const temporaryRef = `${SOURCE_REF_PREFIX}${transferId}`;
  const temporaryIndexRoot = await mkdtemp(path.join(tmpdir(), "nodex-cross-host-index-"));
  const temporaryIndex = path.join(temporaryIndexRoot, "index");
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  let referenceCreated = false;
  options.onEvent({
    operation: "export-handoff",
    type: "handoff-progress",
    step: "snapshot-source",
    status: "started",
  });
  try {
    await validateUntrackedFiles(root, options.signal);
    const head = (
      await runCodexGitCommand(["rev-parse", "HEAD^{commit}"], root, {
        signal: options.signal,
      })
    ).stdout.trim();
    await runCodexGitCommand(["read-tree", head], root, { env, signal: options.signal });
    await runCodexGitCommand(["add", "-A", "--", "."], root, { env, signal: options.signal });
    const tree = (
      await runCodexGitCommand(["write-tree"], root, {
        env,
        signal: options.signal,
      })
    ).stdout.trim();
    const sourceCommit = (
      await runCodexGitCommand(
        ["commit-tree", tree, "-p", head, "-m", `Codex cross-host handoff ${transferId}`],
        root,
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
    await runCodexGitCommand(["update-ref", temporaryRef, sourceCommit], root, {
      signal: options.signal,
    });
    referenceCreated = true;
    options.onEvent({
      operation: "export-handoff",
      type: "handoff-progress",
      step: "snapshot-source",
      status: "completed",
    });

    options.onEvent({
      operation: "export-handoff",
      type: "handoff-progress",
      step: "bundle-source",
      status: "started",
    });
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    await rm(bundlePath, { force: true });
    await runCodexGitCommand(["bundle", "create", bundlePath, temporaryRef], root, {
      signal: options.signal,
      timeoutMs: 10 * 60_000,
    });
    const bundle = await describeCodexTransferFile(bundlePath, options.signal);
    options.onEvent({
      operation: "export-handoff",
      type: "handoff-progress",
      step: "bundle-source",
      status: "completed",
    });
    return {
      sourceRepositoryPath: root,
      sourceBranch: await readCurrentBranch(root, options.signal),
      sourceCommit,
      temporaryRef,
      repositoryIdentity: await readRepositoryIdentity(root, options.signal),
      bundle,
    };
  } catch (error) {
    options.onEvent({
      operation: "export-handoff",
      type: "handoff-progress",
      step: referenceCreated ? "bundle-source" : "snapshot-source",
      status: "failed",
    });
    if (referenceCreated) {
      await runCodexGitCommand(["update-ref", "-d", temporaryRef], root).catch(() => undefined);
    }
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(temporaryIndexRoot, { recursive: true, force: true });
  }
}

async function resolveDestinationRepository(
  candidates: readonly string[],
  sourceIdentity: CodexRepositoryIdentity,
  signal?: AbortSignal,
): Promise<string> {
  const sourceKeys = new Set(sourceIdentity.keys);
  const matches: string[] = [];
  for (const candidate of candidates) {
    throwIfCodexRequestAborted(signal);
    try {
      const root = await repositoryRoot(candidate, signal);
      const identity = await readRepositoryIdentity(root, signal);
      if (identity.keys.some((key) => sourceKeys.has(key))) matches.push(root);
    } catch {
      throwIfCodexRequestAborted(signal);
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length === 0) {
    throw new Error(`No destination repository matches ${sourceIdentity.displayName}`);
  }
  if (unique.length > 1) {
    throw new Error(`More than one destination repository matches ${sourceIdentity.displayName}`);
  }
  return unique[0]!;
}

/** Imports one verified source bundle and creates a detached destination worktree. */
export async function importCrossHostThreadHandoff(
  input: CodexWorktreeWorkerImportHandoffInput,
  options: CodexWorktreeWorkerOperationOptions,
): Promise<CodexWorktreeWorkerImportHandoffResult> {
  const transferId = transferToken(input.transferId);
  const destinationRef = `${DESTINATION_REF_PREFIX}${transferId}`;
  const repositoryPath = await resolveDestinationRepository(
    input.candidateRepositoryPaths,
    input.repositoryIdentity,
    options.signal,
  );
  options.onEvent({
    operation: "import-handoff",
    type: "handoff-progress",
    step: "import-bundle",
    status: "started",
  });
  let referenceCreated = false;
  let worktreePath: string | null = null;
  let rolloutCreated = false;
  const codexHome = path.resolve(input.destinationCodexHome);
  const rolloutPath = path.resolve(codexHome, input.rolloutRelativePath);
  if (!isWithin(codexHome, rolloutPath) || rolloutPath === codexHome) {
    throw new Error("Cross-host rollout destination escapes Codex home");
  }
  try {
    await runCodexGitCommand(
      [
        "fetch",
        "--no-tags",
        input.bundlePath,
        `${SOURCE_REF_PREFIX}${transferId}:${destinationRef}`,
      ],
      repositoryPath,
      { signal: options.signal, timeoutMs: 10 * 60_000 },
    );
    referenceCreated = true;
    const importedCommit = (
      await runCodexGitCommand(["rev-parse", `${destinationRef}^{commit}`], repositoryPath, {
        signal: options.signal,
      })
    ).stdout.trim();
    if (importedCommit !== input.sourceCommit) {
      throw new Error("Imported handoff commit does not match the exported source");
    }
    const created = await createManagedWorktree({
      repositoryPath,
      nodexHome: input.nodexHome,
      managedRoot: input.managedRoot,
      allocatedWorktreePath: input.allocatedWorktreePath,
      projectId: input.projectId,
      targetId: input.threadId,
      threadTitle: input.threadTitle,
      mode: "detachedHead",
      startingState: { type: "branch", branchName: "HEAD", remoteRef: destinationRef },
      localEnvironmentConfigPath: null,
      setUpSyncedBranch: false,
      propagateLocalWorkspaceFiles: false,
      signal: options.signal,
      onPathAllocated: (paths) =>
        options.onEvent({
          operation: "import-handoff",
          type: "path-allocated",
          ...paths,
        }),
    });
    worktreePath = created.worktreeGitRoot;
    await mkdir(path.dirname(rolloutPath), { recursive: true, mode: 0o700 });
    const incomingRollout = await describeCodexTransferFile(input.rolloutPath, options.signal);
    try {
      await copyFile(input.rolloutPath, rolloutPath, fsConstants.COPYFILE_EXCL);
      rolloutCreated = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await describeCodexTransferFile(rolloutPath, options.signal);
      if (existing.sha256 !== incomingRollout.sha256 || existing.size !== incomingRollout.size) {
        throw new Error("Destination already contains a different rollout for this task", {
          cause: error,
        });
      }
    }
    options.onEvent({
      operation: "import-handoff",
      type: "handoff-progress",
      step: "import-bundle",
      status: "completed",
    });
    return {
      destinationRepositoryPath: repositoryPath,
      destinationWorkspaceRoot: created.worktreeWorkspaceRoot,
      destinationGitRoot: created.worktreeGitRoot,
      managedWorktreePath: created.worktreeGitRoot,
      temporaryRef: destinationRef,
      destinationRolloutPath: rolloutPath,
      destinationRolloutCreated: rolloutCreated,
    };
  } catch (error) {
    options.onEvent({
      operation: "import-handoff",
      type: "handoff-progress",
      step: "import-bundle",
      status: "failed",
    });
    if (worktreePath) await removeManagedWorktree(worktreePath).catch(() => undefined);
    if (rolloutCreated) await rm(rolloutPath, { force: true }).catch(() => undefined);
    if (referenceCreated) {
      await runCodexGitCommand(["update-ref", "-d", destinationRef], repositoryPath).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

export async function cleanupCrossHostThreadHandoff(
  input: CodexWorktreeWorkerCleanupTransferHandoffInput,
  signal?: AbortSignal,
): Promise<CodexWorktreeWorkerCleanupTransferHandoffResult> {
  const transferId = transferToken(input.transferId);
  const warnings: string[] = [];
  let rollbackWorktreePaths = input.createdWorktreePath ? [input.createdWorktreePath] : [];
  if (
    input.outcome === "rolled-back" &&
    rollbackWorktreePaths.length === 0 &&
    input.managedRoot &&
    input.temporaryRef.startsWith(DESTINATION_REF_PREFIX)
  ) {
    const commit = await runCodexGitCommand(
      ["rev-parse", "--verify", `${input.temporaryRef}^{commit}`],
      input.repositoryPath,
      { allowedExitCodes: [0, 128], signal },
    ).then((result) => result.stdout.trim());
    if (commit) {
      const porcelain = await runCodexGitCommand(
        ["worktree", "list", "--porcelain"],
        input.repositoryPath,
        { signal },
      );
      let candidatePath: string | null = null;
      rollbackWorktreePaths = porcelain.stdout.split(/\r?\n/u).reduce<string[]>((matches, line) => {
        if (line.startsWith("worktree ")) {
          candidatePath = line.slice("worktree ".length).trim();
          return matches;
        }
        if (
          line === `HEAD ${commit}` &&
          candidatePath &&
          isWithin(input.managedRoot!, candidatePath)
        ) {
          matches.push(candidatePath);
        }
        return matches;
      }, []);
    }
  }
  if (input.outcome === "rolled-back" && rollbackWorktreePaths.length > 0) {
    if (
      !input.managedRoot ||
      rollbackWorktreePaths.some((worktreePath) => !isWithin(input.managedRoot!, worktreePath))
    ) {
      throw new Error("Cross-host rollback worktree is outside its managed root");
    }
    for (const worktreePath of rollbackWorktreePaths) {
      await removeManagedWorktree(worktreePath).catch(() =>
        warnings.push("remove-destination-worktree-failed"),
      );
    }
  }
  if (input.outcome === "rolled-back" && input.createdRolloutPath) {
    if (
      !input.destinationCodexHome ||
      !isWithin(input.destinationCodexHome, input.createdRolloutPath)
    ) {
      throw new Error("Cross-host rollback rollout is outside destination Codex home");
    }
    await rm(input.createdRolloutPath, { force: true }).catch(() =>
      warnings.push("remove-destination-rollout-failed"),
    );
  }
  await runCodexGitCommand(["update-ref", "-d", input.temporaryRef], input.repositoryPath, {
    signal,
  }).catch(() => warnings.push("delete-temporary-ref-failed"));
  const stagingDirectory = path.join(path.resolve(input.stagingRoot), transferId);
  if (!isWithin(input.stagingRoot, stagingDirectory)) {
    throw new Error("Cross-host staging path escapes its authorized root");
  }
  await rm(stagingDirectory, { recursive: true, force: true }).catch(() =>
    warnings.push("remove-transfer-staging-failed"),
  );
  return { cleaned: warnings.length === 0, warnings };
}

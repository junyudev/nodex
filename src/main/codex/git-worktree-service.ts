import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorktreeStartMode } from "../../shared/types";
import {
  buildWorktreeThreadSlug,
  normalizeWorktreeAutoBranchPrefix,
} from "../../shared/worktree-auto-branch";
import {
  runCodexGitCommand as runGitCommand,
  throwIfCodexRequestAborted as throwIfRequestAborted,
  type CodexGitCommandOutputStream as GitCommandOutputStream,
} from "./codex-git-command";

const MAX_STARTING_DIFF_BYTES = 64 * 1024 * 1024;
const MAX_AUTO_BRANCH_NAME_ATTEMPTS = 100;
const MAX_WORKSPACE_COPY_CONCURRENCY = 16;
const CODEX_LOCAL_ENVIRONMENT_CONFIG_KEY = "codex.localEnvironmentConfigPath";
const CODEX_NO_LOCAL_ENVIRONMENT = "__none__";
const CODEX_OVERRIDE_FILE = "AGENTS.override.md";
const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

const UNIFIED_DIFF_ARGS = [
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "core.quotePath=false",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--color=never",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--binary",
] as const;

async function runAbortChecked<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfRequestAborted(signal);
  const result = await operation();
  throwIfRequestAborted(signal);
  return result;
}

function normalizeBranchName(value: string): string {
  return value.trim();
}

async function ensureDirectory(cwd: string, signal?: AbortSignal): Promise<string> {
  throwIfRequestAborted(signal);
  const normalizedCwd = cwd.trim();
  if (!normalizedCwd) {
    throw new Error("Working directory is required");
  }

  const entry = await stat(normalizedCwd).catch(() => null);
  throwIfRequestAborted(signal);
  if (!entry?.isDirectory()) {
    throw new Error(`Working directory not found: ${normalizedCwd}`);
  }
  return normalizedCwd;
}

async function ensureGitRepository(cwd: string, signal?: AbortSignal): Promise<void> {
  const result = await runGitCommand(["rev-parse", "--is-inside-work-tree"], cwd, { signal });
  throwIfRequestAborted(signal);
  if (result.stdout.trim() !== "true") {
    throw new Error(`Path is not a git repository: ${cwd}`);
  }
}

async function branchExists(
  cwd: string,
  branchName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const exists = await runGitCommand(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    cwd,
    { signal },
  )
    .then(() => true)
    .catch(() => {
      throwIfRequestAborted(signal);
      return false;
    });
  return exists;
}

async function resolveAutoBranchName(input: {
  repositoryPath: string;
  threadTitle?: string | null;
  branchPrefix?: string | null;
  signal?: AbortSignal;
}): Promise<string> {
  const normalizedPrefix = normalizeWorktreeAutoBranchPrefix(input.branchPrefix);
  const threadSlug = buildWorktreeThreadSlug(input.threadTitle);
  const branchBase = `${normalizedPrefix}${threadSlug}`;

  for (let attempt = 1; attempt <= MAX_AUTO_BRANCH_NAME_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? branchBase : `${branchBase}-${attempt}`;
    await runGitCommand(["check-ref-format", "--branch", candidate], input.repositoryPath, {
      signal: input.signal,
    });
    const exists = await branchExists(input.repositoryPath, candidate, input.signal);
    if (exists) continue;
    throwIfRequestAborted(input.signal);
    return candidate;
  }

  throw new Error("Could not allocate a unique auto-branch name for new worktree");
}

async function resolveDefaultBaseRef(
  cwd: string,
  preferredBaseBranch?: string | null,
  signal?: AbortSignal,
): Promise<string> {
  const normalizedPreferred = preferredBaseBranch?.trim() || "";
  if (normalizedPreferred) {
    await runGitCommand(["check-ref-format", "--branch", normalizedPreferred], cwd, { signal });
    await runGitCommand(["rev-parse", "--verify", `${normalizedPreferred}^{commit}`], cwd, {
      signal,
    });
    throwIfRequestAborted(signal);
    return normalizedPreferred;
  }

  return await resolvePendingDefaultBranch(cwd, signal);
}

async function resolveRemoteDefaultBranch(
  repositoryPath: string,
  remote: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const locallyKnown = await runGitCommand(
    ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
    repositoryPath,
    { signal },
  ).catch(() => {
    throwIfRequestAborted(signal);
    return null;
  });
  const locallyKnownRef = normalizeBranchName(locallyKnown?.stdout ?? "");
  if (locallyKnownRef) return locallyKnownRef.split("/").at(-1) ?? null;

  const remoteDetails = await runGitCommand(["remote", "show", remote], repositoryPath, {
    signal,
    timeoutMs: 10_000,
  }).catch(() => {
    throwIfRequestAborted(signal);
    return null;
  });
  const remoteDefault = /HEAD branch:\s*(.+)/.exec(remoteDetails?.stdout ?? "")?.[1]?.trim();
  return remoteDefault && remoteDefault !== "(unknown)" ? remoteDefault : null;
}

async function remoteBranchExists(
  repositoryPath: string,
  remote: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return await runGitCommand(
    ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`],
    repositoryPath,
    { signal },
  )
    .then(() => true)
    .catch(() => {
      throwIfRequestAborted(signal);
      return false;
    });
}

async function resolvePendingDefaultBranch(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await resolveKnownRemoteDefaultBranch(repositoryPath, signal)) ?? "main";
}

async function resolveKnownRemoteDefaultBranch(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const remoteResult = await runGitCommand(["remote"], repositoryPath, { signal });
  const remotes = remoteResult.stdout
    .split(/\r?\n/)
    .map((remote) => remote.trim())
    .filter((remote) => remote.length > 0);
  const orderedRemotes =
    remotes.includes("origin") && remotes.length > 1
      ? ["origin", ...remotes.filter((remote) => remote !== "origin")]
      : remotes;

  for (const remote of orderedRemotes) {
    const remoteDefault = await resolveRemoteDefaultBranch(repositoryPath, remote, signal);
    if (remoteDefault) return remoteDefault;

    for (const recentDefault of ["main", "master"] as const) {
      if (await remoteBranchExists(repositoryPath, remote, recentDefault, signal)) {
        return recentDefault;
      }
    }
  }

  return null;
}

interface TemporaryGitIndex {
  directoryPath: string;
  env: NodeJS.ProcessEnv;
}

interface ResolvedDetachedStartingState {
  startingDiff: string | null;
  startingRef: string;
  syncedBranch: string | null;
  untrackedPaths: string[];
}

const REMOTE_TRACKING_REF_PREFIX = "refs/remotes/";

interface ResolvedSourceWorkspace {
  sourceGitRoot: string;
  sourceWorkspaceRoot: string;
  workspacePrefix: string;
}

async function resolveSourceWorkspace(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<ResolvedSourceWorkspace> {
  const sourceWorkspaceRoot = await ensureDirectory(repositoryPath, signal);
  await ensureGitRepository(sourceWorkspaceRoot, signal);
  const [gitRootResult, prefixResult] = await Promise.all([
    runGitCommand(["rev-parse", "--path-format=absolute", "--show-toplevel"], sourceWorkspaceRoot, {
      signal,
    }),
    runGitCommand(["rev-parse", "--show-prefix"], sourceWorkspaceRoot, { signal }),
  ]);
  throwIfRequestAborted(signal);

  const sourceGitRoot = gitRootResult.stdout.trim();
  if (!sourceGitRoot) {
    throw new Error(`Could not resolve git root for workspace: ${sourceWorkspaceRoot}`);
  }

  return {
    sourceGitRoot: path.resolve(sourceGitRoot),
    sourceWorkspaceRoot: path.resolve(sourceWorkspaceRoot),
    workspacePrefix: prefixResult.stdout.trim().replace(/[\\/]+$/, ""),
  };
}

function resolveWorktreeWorkspaceRoot(worktreeGitRoot: string, workspacePrefix: string): string {
  if (!workspacePrefix) return worktreeGitRoot;
  return path.join(worktreeGitRoot, ...workspacePrefix.split("/").filter(Boolean));
}

function resolveGitOutputPath(cwd: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

async function withTemporaryGitIndex<T>(
  cwd: string,
  signal: AbortSignal | undefined,
  operation: (index: TemporaryGitIndex) => Promise<T>,
): Promise<T> {
  throwIfRequestAborted(signal);
  const directoryPath = await runAbortChecked(signal, () =>
    mkdtemp(path.join(tmpdir(), "nodex-git-index-")),
  );

  try {
    const indexResult = await runGitCommand(
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      cwd,
      { signal },
    );
    const sourceIndexPath = resolveGitOutputPath(cwd, indexResult.stdout.trim());
    const temporaryIndexPath = path.join(directoryPath, "index");
    await runAbortChecked(signal, () => copyFile(sourceIndexPath, temporaryIndexPath));

    const sharedIndexResult = await runGitCommand(["rev-parse", "--shared-index-path"], cwd, {
      signal,
    }).catch(() => {
      throwIfRequestAborted(signal);
      return null;
    });
    const sharedIndexOutput = sharedIndexResult?.stdout.trim() ?? "";
    if (sharedIndexOutput) {
      const sourceSharedIndexPath = resolveGitOutputPath(cwd, sharedIndexOutput);
      const temporarySharedIndexPath = path.join(
        directoryPath,
        path.basename(sourceSharedIndexPath),
      );
      await runAbortChecked(signal, () =>
        copyFile(sourceSharedIndexPath, temporarySharedIndexPath),
      );
    }

    return await operation({
      directoryPath,
      env: {
        ...process.env,
        GIT_INDEX_FILE: temporaryIndexPath,
      },
    });
  } finally {
    await rm(directoryPath, { recursive: true, force: true });
  }
}

async function captureTrackedWorkingTreeDiff(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const unifiedDiff = await withTemporaryGitIndex(repositoryPath, signal, async ({ env }) => {
    await runGitCommand(["add", "-u"], repositoryPath, { env, signal });
    const result = await runGitCommand([...UNIFIED_DIFF_ARGS, "--cached"], repositoryPath, {
      env,
      signal,
    });
    return result.stdout;
  });
  throwIfRequestAborted(signal);
  if (Buffer.byteLength(unifiedDiff, "utf8") > MAX_STARTING_DIFF_BYTES) {
    throw new Error("Working tree diff exceeds the 64 MiB limit");
  }
  return unifiedDiff;
}

async function captureUntrackedWorkingTreePaths(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await runGitCommand(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    repositoryPath,
    { signal },
  );
  throwIfRequestAborted(signal);
  return splitNullDelimitedPaths(result.stdout);
}

async function resolveSpecifiedBranchRef(
  repositoryPath: string,
  branchName: string,
  signal?: AbortSignal,
): Promise<string> {
  const upstream = await runGitCommand(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branchName}@{u}`],
    repositoryPath,
    { signal },
  ).catch(() => {
    throwIfRequestAborted(signal);
    return null;
  });
  const upstreamRef = upstream?.stdout.trim() ?? "";
  if (!upstreamRef) return branchName;

  const counts = await runGitCommand(
    ["rev-list", "--left-right", "--count", `${branchName}...${upstreamRef}`],
    repositoryPath,
    { signal },
  ).catch(() => {
    throwIfRequestAborted(signal);
    return null;
  });
  const [leftAheadText, rightAheadText] = counts?.stdout.trim().split(/\s+/) ?? [];
  const leftAhead = Number.parseInt(leftAheadText ?? "", 10);
  const rightAhead = Number.parseInt(rightAheadText ?? "", 10);
  if (leftAhead === 0 && Number.isFinite(rightAhead) && rightAhead > 0) {
    return upstreamRef;
  }

  return branchName;
}

async function resolveWorkingTreeStartingRef(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const currentBranch = await resolveCurrentBranchName(repositoryPath, signal);
  if (currentBranch) return currentBranch;

  const remoteDefault = await runGitCommand(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    repositoryPath,
    { signal },
  ).catch(() => {
    throwIfRequestAborted(signal);
    return null;
  });
  const remoteDefaultName = normalizeBranchName(remoteDefault?.stdout ?? "")
    .split("/")
    .at(-1);
  if (remoteDefaultName) return remoteDefaultName;

  await runGitCommand(["rev-parse", "--verify", "HEAD^{commit}"], repositoryPath, { signal });
  return "HEAD";
}

async function resolveCurrentBranchName(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const headBranch = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], repositoryPath, {
    signal,
  });
  const headBranchName = normalizeBranchName(headBranch.stdout);
  if (headBranchName && headBranchName !== "HEAD") return headBranchName;

  const symbolicHead = await runGitCommand(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    repositoryPath,
    { signal },
  ).catch(() => {
    throwIfRequestAborted(signal);
    return null;
  });
  const symbolicHeadName = normalizeBranchName(symbolicHead?.stdout ?? "");
  if (symbolicHeadName) return symbolicHeadName;
  return null;
}

async function resolveSyncedBranchName(
  repositoryPath: string,
  startingState: Extract<ManagedWorktreeStartingState, { type: "branch" }>,
  signal?: AbortSignal,
): Promise<string | null> {
  if (startingState.remoteRef != null) return null;
  if (startingState.branchName === "HEAD") {
    return await resolveCurrentBranchName(repositoryPath, signal);
  }
  if (startingState.branchName.startsWith(REMOTE_TRACKING_REF_PREFIX)) {
    return startingState.branchName.slice(REMOTE_TRACKING_REF_PREFIX.length);
  }
  return startingState.branchName;
}

async function resolveDetachedStartingState(input: {
  repositoryPath: string;
  startingState: ManagedWorktreeStartingState;
  signal?: AbortSignal;
}): Promise<ResolvedDetachedStartingState> {
  if (input.startingState.type === "branch") {
    const startingRef =
      input.startingState.remoteRef ??
      (await resolveSpecifiedBranchRef(
        input.repositoryPath,
        input.startingState.branchName,
        input.signal,
      ));
    return {
      startingDiff: null,
      startingRef,
      syncedBranch: await resolveSyncedBranchName(
        input.repositoryPath,
        input.startingState,
        input.signal,
      ),
      untrackedPaths: [],
    };
  }

  const [startingRef, startingDiff, syncedBranch, untrackedPaths] = await Promise.all([
    resolveWorkingTreeStartingRef(input.repositoryPath, input.signal),
    captureTrackedWorkingTreeDiff(input.repositoryPath, input.signal),
    resolveCurrentBranchName(input.repositoryPath, input.signal),
    captureUntrackedWorkingTreePaths(input.repositoryPath, input.signal),
  ]);
  return {
    startingDiff,
    startingRef,
    syncedBranch,
    untrackedPaths,
  };
}

function collectUnifiedDiffPaths(unifiedDiff: string): string[] {
  const paths = new Set<string>();
  const headerPattern = /^diff --git a\/(.*?) b\/(.*)$/gm;
  let match: RegExpExecArray | null = null;

  while ((match = headerPattern.exec(unifiedDiff)) != null) {
    const sourcePath = match[1];
    const targetPath = match[2];
    if (sourcePath && sourcePath !== "/dev/null") paths.add(sourcePath);
    if (targetPath && targetPath !== "/dev/null") paths.add(targetPath);
  }

  return [...paths];
}

async function applyWorkingTreeDiff(input: {
  onLog?: (output: { stream: GitCommandOutputStream; data: string }) => void;
  signal?: AbortSignal;
  unifiedDiff: string;
  worktreePath: string;
}): Promise<void> {
  if (!input.unifiedDiff) return;

  input.onLog?.({
    stream: "info",
    data: "[info] Applying working tree diff to new worktree\n",
  });
  await withTemporaryGitIndex(input.worktreePath, input.signal, async ({ directoryPath, env }) => {
    const existingPaths: string[] = [];
    for (const relativePath of collectUnifiedDiffPaths(input.unifiedDiff)) {
      throwIfRequestAborted(input.signal);
      const entry = await stat(path.join(input.worktreePath, relativePath)).catch(() => null);
      if (entry) existingPaths.push(relativePath);
    }
    if (existingPaths.length > 0) {
      await runGitCommand(["add", "--", ...existingPaths], input.worktreePath, {
        env,
        signal: input.signal,
      });
    }

    const patchPath = path.join(directoryPath, "working-tree.patch");
    await runAbortChecked(input.signal, () => writeFile(patchPath, input.unifiedDiff, "utf8"));
    await runGitCommand(["apply", "--binary", "--3way", patchPath], input.worktreePath, {
      env,
      onOutput: input.onLog,
      signal: input.signal,
    });
  });
  throwIfRequestAborted(input.signal);
}

async function removeLocalTrackingBranch(
  repositoryPath: string,
  branchName: string,
): Promise<void> {
  await runGitCommand(["branch", "-D", branchName], repositoryPath).catch(() => undefined);
}

async function createMissingLocalTrackingBranch(input: {
  repositoryPath: string;
  startingRef: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (!input.startingRef.startsWith(REMOTE_TRACKING_REF_PREFIX)) return null;

  const branchName = input.startingRef.slice(REMOTE_TRACKING_REF_PREFIX.length);
  if (!branchName || (await branchExists(input.repositoryPath, branchName, input.signal))) {
    return null;
  }

  try {
    await runGitCommand(
      ["branch", "--track", branchName, input.startingRef],
      input.repositoryPath,
      { signal: input.signal },
    );
    throwIfRequestAborted(input.signal);
    return branchName;
  } catch (error) {
    if (await branchExists(input.repositoryPath, branchName).catch(() => false)) {
      await removeLocalTrackingBranch(input.repositoryPath, branchName);
    }
    throw error;
  }
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function splitNullDelimitedPaths(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function resolveWorkspaceCopyPath(workspaceRoot: string, relativePath: string): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const normalizedRelativePath = path.relative(resolvedRoot, resolvedPath);
  if (
    !normalizedRelativePath ||
    normalizedRelativePath === ".." ||
    normalizedRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalizedRelativePath)
  ) {
    throw new Error("Cannot copy a workspace file outside its workspace root");
  }
  return resolvedPath;
}

async function findIgnoredCodexOverrideFiles(
  sourceGitRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await runGitCommand(
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      `:(glob)**/${CODEX_OVERRIDE_FILE}`,
    ],
    sourceGitRoot,
    { signal },
  ).catch((error) => {
    throwIfRequestAborted(signal);
    throw new Error(`git ls-files failed while locating ${CODEX_OVERRIDE_FILE}`, {
      cause: error,
    });
  });

  return [
    ...new Set(
      splitNullDelimitedPaths(result.stdout).filter(
        (relativePath) =>
          relativePath === CODEX_OVERRIDE_FILE || relativePath.endsWith(`/${CODEX_OVERRIDE_FILE}`),
      ),
    ),
  ];
}

async function findWorktreeIncludedFiles(
  sourceGitRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const includePath = path.join(sourceGitRoot, WORKTREE_INCLUDE_FILE);
  try {
    await stat(includePath);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  }

  const [ignoredResult, includedResult] = await Promise.all([
    runGitCommand(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      sourceGitRoot,
      { signal },
    ),
    runGitCommand(
      ["ls-files", "--others", "--ignored", `--exclude-from=${WORKTREE_INCLUDE_FILE}`, "-z"],
      sourceGitRoot,
      { signal },
    ),
  ]).catch((error) => {
    throwIfRequestAborted(signal);
    throw new Error(`git ls-files failed while locating ${WORKTREE_INCLUDE_FILE} files`, {
      cause: error,
    });
  });
  const ignoredPaths = new Set(splitNullDelimitedPaths(ignoredResult.stdout));

  return [
    ...new Set(
      splitNullDelimitedPaths(includedResult.stdout).filter((relativePath) =>
        ignoredPaths.has(relativePath),
      ),
    ),
  ];
}

async function ensureSafeCopyDestinationParent(
  worktreeGitRoot: string,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfRequestAborted(signal);
  const destinationParent = path.dirname(destinationPath);
  const parentRelativePath = path.relative(worktreeGitRoot, destinationParent);
  if (
    parentRelativePath === ".." ||
    parentRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(parentRelativePath)
  ) {
    throw new Error("Cannot copy a workspace file outside the worktree");
  }

  let currentPath = worktreeGitRoot;
  for (const segment of parentRelativePath.split(path.sep).filter(Boolean)) {
    throwIfRequestAborted(signal);
    currentPath = path.join(currentPath, segment);
    try {
      const entry = await runAbortChecked(signal, () => lstat(currentPath));
      if (entry.isSymbolicLink()) {
        throw new Error("Cannot copy a workspace file through a symlinked workspace path");
      }
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT")) throw error;
      await runAbortChecked(signal, () => mkdir(destinationParent, { recursive: true }));
      return;
    }
  }
}

async function copyWorkspaceFile(input: {
  sourceGitRoot: string;
  worktreeGitRoot: string;
  relativePath: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const sourcePath = resolveWorkspaceCopyPath(input.sourceGitRoot, input.relativePath);
  const destinationPath = resolveWorkspaceCopyPath(input.worktreeGitRoot, input.relativePath);
  try {
    if (!(await runAbortChecked(input.signal, () => lstat(sourcePath))).isFile()) return false;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }

  await ensureSafeCopyDestinationParent(input.worktreeGitRoot, destinationPath, input.signal);
  try {
    await runAbortChecked(input.signal, () =>
      copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL),
    );
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function copyWorkspaceFiles(input: {
  sourceGitRoot: string;
  worktreeGitRoot: string;
  relativePaths: readonly string[];
  signal?: AbortSignal;
}): Promise<number> {
  let nextIndex = 0;
  let copiedCount = 0;
  const failures: unknown[] = [];
  const workerCount = Math.min(MAX_WORKSPACE_COPY_CONCURRENCY, input.relativePaths.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        if (failures.length > 0) return;
        const index = nextIndex;
        nextIndex += 1;
        const relativePath = input.relativePaths[index];
        if (relativePath === undefined) return;
        try {
          throwIfRequestAborted(input.signal);
          if (
            await copyWorkspaceFile({
              sourceGitRoot: input.sourceGitRoot,
              worktreeGitRoot: input.worktreeGitRoot,
              relativePath,
              signal: input.signal,
            })
          ) {
            copiedCount += 1;
          }
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length > 0) throw failures[0];
  return copiedCount;
}

async function copyUntrackedWorkingTreeFiles(input: {
  sourceGitRoot: string;
  worktreeGitRoot: string;
  relativePaths: readonly string[];
  onLog?: (output: { stream: GitCommandOutputStream; data: string }) => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.relativePaths.length === 0) return;

  input.onLog?.({
    stream: "info",
    data: "[info] Copying untracked files to new worktree\n",
  });
  const copiedCount = await copyWorkspaceFiles(input);
  if (copiedCount !== input.relativePaths.length) {
    throw new Error("Failed to copy all untracked working tree files");
  }
}

async function copyCodexWorkspaceFiles(input: {
  sourceGitRoot: string;
  worktreeGitRoot: string;
  onLog?: (output: { stream: GitCommandOutputStream; data: string }) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const overrideFiles = await findIgnoredCodexOverrideFiles(input.sourceGitRoot, input.signal);
  await copyWorkspaceFiles({
    sourceGitRoot: input.sourceGitRoot,
    worktreeGitRoot: input.worktreeGitRoot,
    relativePaths: overrideFiles,
    signal: input.signal,
  });

  const includedFiles = await findWorktreeIncludedFiles(input.sourceGitRoot, input.signal);
  const includedCount = await copyWorkspaceFiles({
    sourceGitRoot: input.sourceGitRoot,
    worktreeGitRoot: input.worktreeGitRoot,
    relativePaths: includedFiles,
    signal: input.signal,
  });
  if (includedCount > 0) {
    input.onLog?.({
      stream: "info",
      data: `Copied ${String(includedCount)} file${includedCount === 1 ? "" : "s"} from ${WORKTREE_INCLUDE_FILE}\n`,
    });
  }
}

async function persistSelectedWorktreeEnvironment(input: {
  worktreeWorkspaceRoot: string;
  localEnvironmentConfigPath: string | null;
  onLog?: (output: { stream: GitCommandOutputStream; data: string }) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const configValue = input.localEnvironmentConfigPath ?? CODEX_NO_LOCAL_ENVIRONMENT;
  const writeConfig = async (): Promise<{ success: true } | { success: false; error: unknown }> => {
    try {
      await runGitCommand(
        ["config", "--worktree", CODEX_LOCAL_ENVIRONMENT_CONFIG_KEY, configValue],
        input.worktreeWorkspaceRoot,
        { signal: input.signal },
      );
      return { success: true };
    } catch (error) {
      throwIfRequestAborted(input.signal);
      return { success: false, error };
    }
  };

  let result = await writeConfig();
  if (
    !result.success &&
    result.error instanceof Error &&
    result.error.message.toLowerCase().includes("worktreeconfig")
  ) {
    const enabled = await runGitCommand(
      ["config", "extensions.worktreeConfig", "true"],
      input.worktreeWorkspaceRoot,
      { signal: input.signal },
    )
      .then(() => true)
      .catch(() => {
        throwIfRequestAborted(input.signal);
        return false;
      });
    if (enabled) result = await writeConfig();
  }

  if (!result.success) {
    input.onLog?.({
      stream: "stderr",
      data: "Failed to store selected environment in git config\n",
    });
  }
}

async function finishManagedWorktreeCreation(input: {
  sourceGitRoot: string;
  worktreeGitRoot: string;
  worktreeWorkspaceRoot: string;
  localEnvironmentConfigPath: string | null;
  propagateLocalWorkspaceFiles: boolean;
  onLog?: (output: { stream: GitCommandOutputStream; data: string }) => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.propagateLocalWorkspaceFiles) {
    await copyCodexWorkspaceFiles(input);
  }
  throwIfRequestAborted(input.signal);
  input.onLog?.({
    stream: "info",
    data: `Worktree created at ${input.worktreeWorkspaceRoot}\n`,
  });
  await persistSelectedWorktreeEnvironment(input);
  if (input.localEnvironmentConfigPath === null) {
    input.onLog?.({
      stream: "info",
      data: "No local environment selected\n",
    });
  }
}

async function persistSyncedBranchMetadata(input: {
  sourceGitRoot: string;
  worktreeGitRoot: string;
  syncedBranch: string;
  signal?: AbortSignal;
}): Promise<void> {
  const knownRemoteDefault = await resolveKnownRemoteDefaultBranch(
    input.sourceGitRoot,
    input.signal,
  );
  if (knownRemoteDefault === input.syncedBranch) return;

  const branchRef = input.syncedBranch.startsWith("refs/")
    ? input.syncedBranch
    : `refs/heads/${input.syncedBranch}`;
  const tree = await runGitCommand(["rev-parse", `${branchRef}^{tree}`], input.sourceGitRoot, {
    signal: input.signal,
  });
  const gitPath = await runGitCommand(
    ["rev-parse", "--path-format=absolute", "--git-path", "codex-synced-branch.json"],
    input.worktreeGitRoot,
    { signal: input.signal },
  );
  const configPath = resolveGitOutputPath(input.worktreeGitRoot, gitPath.stdout.trim());
  await runAbortChecked(input.signal, () => mkdir(path.dirname(configPath), { recursive: true }));
  await runAbortChecked(input.signal, () =>
    writeFile(
      configPath,
      `${JSON.stringify(
        {
          branch: branchRef,
          lastSyncedTreeRef: tree.stdout.trim(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  );
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

export type ManagedWorktreeStartingState =
  | {
      type: "branch";
      branchName: string;
      remoteRef?: string;
    }
  | {
      type: "working-tree";
    };

export interface CreateManagedWorktreeInput {
  repositoryPath: string;
  nodexHome: string;
  managedRoot?: string;
  projectId: string;
  targetId: string;
  threadTitle?: string | null;
  branchPrefix?: string | null;
  preferredBaseBranch?: string | null;
  mode: WorktreeStartMode;
  startingState?: ManagedWorktreeStartingState;
  localEnvironmentConfigPath?: string | null;
  setUpSyncedBranch?: boolean;
  /** Remote host adapters skip source-local ignored-file propagation. */
  propagateLocalWorkspaceFiles?: boolean;
  onLog?: (output: { stream: GitCommandOutputStream; data: string }) => void;
  onPathAllocated?: (paths: {
    readonly worktreeGitRoot: string;
    readonly worktreeWorkspaceRoot: string;
  }) => void;
  signal?: AbortSignal;
}

export interface CreateManagedWorktreeResult {
  worktreeGitRoot: string;
  worktreeWorkspaceRoot: string;
  baseRef: string;
  branchName: string | null;
}

/** Resolve the pending-create default on the host that owns the repository. */
export async function resolveManagedWorktreeDefaultStartingState(
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<Extract<ManagedWorktreeStartingState, { type: "branch" }>> {
  const sourceWorkspace = await resolveSourceWorkspace(repositoryPath, signal);
  return {
    type: "branch",
    branchName: await resolvePendingDefaultBranch(sourceWorkspace.sourceGitRoot, signal),
  };
}

export async function setManagedWorktreeOwnerThread(
  worktreeGitRoot: string,
  ownerThreadId: string,
  signal?: AbortSignal,
): Promise<void> {
  const resolvedRoot = await ensureDirectory(worktreeGitRoot, signal);
  await ensureGitRepository(resolvedRoot, signal);
  const normalizedOwnerThreadId = ownerThreadId.trim();
  if (!normalizedOwnerThreadId) throw new Error("Owner thread id is required");

  const gitPath = await runGitCommand(
    ["rev-parse", "--path-format=absolute", "--git-path", "codex-thread.json"],
    resolvedRoot,
    { signal },
  );
  const configPath = resolveGitOutputPath(resolvedRoot, gitPath.stdout.trim());
  await runAbortChecked(signal, () => mkdir(path.dirname(configPath), { recursive: true }));
  await runAbortChecked(signal, () =>
    writeFile(
      configPath,
      `${JSON.stringify({ version: 1, ownerThreadId: normalizedOwnerThreadId }, null, 2)}\n`,
      "utf8",
    ),
  );
}

export async function readManagedWorktreeOwnerThread(
  worktreeGitRoot: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const resolvedRoot = await ensureDirectory(worktreeGitRoot, signal);
  await ensureGitRepository(resolvedRoot, signal);
  const gitPath = await runGitCommand(
    ["rev-parse", "--path-format=absolute", "--git-path", "codex-thread.json"],
    resolvedRoot,
    { signal },
  );
  const configPath = resolveGitOutputPath(resolvedRoot, gitPath.stdout.trim());
  const raw = await runAbortChecked(
    signal,
    async () =>
      await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
  );
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Managed worktree owner metadata must be an object");
  }
  const ownerThreadId = (parsed as { readonly ownerThreadId?: unknown }).ownerThreadId;
  if (typeof ownerThreadId !== "string" || !ownerThreadId.trim()) {
    throw new Error("Managed worktree owner metadata is missing ownerThreadId");
  }
  return ownerThreadId.trim();
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
  )
    .then(() => true)
    .catch(() => false);

  if (!removedByGit) {
    await rm(resolvedPath, { recursive: true, force: true });
  }

  await runGitCommand(["worktree", "prune"], repositoryPath).catch(() => undefined);
  await cleanupEmptyWorktreeTokenDir(resolvedPath);
}

export async function createManagedWorktree(
  input: CreateManagedWorktreeInput,
): Promise<CreateManagedWorktreeResult> {
  const signal = input.signal;
  throwIfRequestAborted(signal);
  const sourceWorkspace = await resolveSourceWorkspace(input.repositoryPath, signal);
  const sourceGitRoot = sourceWorkspace.sourceGitRoot;
  const nodexHome = path.resolve(input.nodexHome.trim());
  await runAbortChecked(signal, () => mkdir(nodexHome, { recursive: true }));
  const detachedStartingState =
    input.mode === "detachedHead" && input.startingState
      ? await resolveDetachedStartingState({
          repositoryPath: sourceGitRoot,
          startingState: input.startingState,
          signal,
        })
      : null;
  const baseRef =
    detachedStartingState?.startingRef ??
    (await resolveDefaultBaseRef(sourceGitRoot, input.preferredBaseBranch, signal));
  const worktreePathLeaf = path.basename(sourceGitRoot);
  const worktreesRoot = input.managedRoot?.trim()
    ? path.resolve(input.managedRoot)
    : path.join(nodexHome, "worktrees");
  await runAbortChecked(signal, () => mkdir(worktreesRoot, { recursive: true }));
  if (process.platform === "darwin") {
    await runAbortChecked(signal, () =>
      writeFile(path.join(worktreesRoot, ".metadata_never_index"), "", { flag: "a" }),
    );
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    throwIfRequestAborted(signal);
    const token = randomUUID().slice(0, 4);
    const worktreeGitRoot = path.join(worktreesRoot, token, worktreePathLeaf);
    const worktreeWorkspaceRoot = resolveWorktreeWorkspaceRoot(
      worktreeGitRoot,
      sourceWorkspace.workspacePrefix,
    );
    const existing = await stat(worktreeGitRoot).catch(() => null);
    throwIfRequestAborted(signal);
    if (existing) continue;
    await runAbortChecked(signal, () => mkdir(path.dirname(worktreeGitRoot), { recursive: true }));

    let createdTrackingBranch: string | null = null;
    try {
      input.onPathAllocated?.({ worktreeGitRoot, worktreeWorkspaceRoot });
      throwIfRequestAborted(signal);
      if (input.mode === "autoBranch") {
        const branchName = await resolveAutoBranchName({
          repositoryPath: sourceGitRoot,
          threadTitle: input.threadTitle,
          branchPrefix: input.branchPrefix,
          signal,
        });
        await runGitCommand(
          ["worktree", "add", "-b", branchName, worktreeGitRoot, baseRef],
          sourceGitRoot,
          { onOutput: input.onLog, signal },
        );
        throwIfRequestAborted(signal);
        await finishManagedWorktreeCreation({
          sourceGitRoot,
          worktreeGitRoot,
          worktreeWorkspaceRoot,
          localEnvironmentConfigPath: input.localEnvironmentConfigPath ?? null,
          propagateLocalWorkspaceFiles: input.propagateLocalWorkspaceFiles ?? true,
          onLog: input.onLog,
          signal,
        });
        return {
          worktreeGitRoot,
          worktreeWorkspaceRoot,
          baseRef,
          branchName,
        };
      }

      await runGitCommand(
        ["worktree", "add", "--detach", worktreeGitRoot, baseRef],
        sourceGitRoot,
        { onOutput: input.onLog, signal },
      );
      throwIfRequestAborted(signal);
      if (detachedStartingState?.startingDiff) {
        await applyWorkingTreeDiff({
          worktreePath: worktreeGitRoot,
          unifiedDiff: detachedStartingState.startingDiff,
          onLog: input.onLog,
          signal,
        });
      }
      if (detachedStartingState) {
        await copyUntrackedWorkingTreeFiles({
          sourceGitRoot,
          worktreeGitRoot,
          relativePaths: detachedStartingState.untrackedPaths,
          onLog: input.onLog,
          signal,
        });
        createdTrackingBranch = await createMissingLocalTrackingBranch({
          repositoryPath: sourceGitRoot,
          startingRef: detachedStartingState.startingRef,
          signal,
        });
      }
      if ((input.setUpSyncedBranch ?? true) && detachedStartingState?.syncedBranch) {
        await persistSyncedBranchMetadata({
          sourceGitRoot,
          worktreeGitRoot,
          syncedBranch: detachedStartingState.syncedBranch,
          signal,
        });
      }
      await finishManagedWorktreeCreation({
        sourceGitRoot,
        worktreeGitRoot,
        worktreeWorkspaceRoot,
        localEnvironmentConfigPath: input.localEnvironmentConfigPath ?? null,
        propagateLocalWorkspaceFiles: input.propagateLocalWorkspaceFiles ?? true,
        onLog: input.onLog,
        signal,
      });
      return {
        worktreeGitRoot,
        worktreeWorkspaceRoot,
        baseRef,
        branchName: null,
      };
    } catch (error) {
      await removeManagedWorktree(worktreeGitRoot).catch(() => undefined);
      if (createdTrackingBranch) {
        await removeLocalTrackingBranch(sourceGitRoot, createdTrackingBranch);
      }
      throw error;
    }
  }

  throw new Error("Could not allocate a unique worktree path");
}

import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitWorkerMethodMap } from "../../shared/git-worker-protocol";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type {
  BranchDiffStatsRequest,
  BranchDiffStatsResult,
  GitBranchMetadataResult,
  GitApplyPatchInput,
  GitApplyPatchResult,
  GitReviewBlameInput,
  GitReviewBlameResult,
  GitReviewBaseBranchRequest,
  GitReviewBaseBranchResult,
  GitReviewBranchCommit,
  GitReviewBranchCommitsRequest,
  GitReviewBranchCommitsResult,
  GitCatFileResult,
  GitReviewCatFileInput,
  GitReviewCatFileOutput,
  GitMergeBaseRequest,
  GitMergeBaseResult,
  GitReviewPatchRequest,
  GitReviewPatchResult,
  GitReviewRepositoryMetadataRequest,
  GitReviewRepositoryMetadataResult,
  GitReviewSearchInput,
  GitReviewSearchMatch,
  GitReviewSearchResult,
  GitReviewFileStatus,
  GitReviewFileSummary,
  GitReviewSnapshot,
  GitReviewSnapshotRequest,
  GitReviewSource,
  GitReviewSummaryRequest,
  GitReviewSummaryResult,
  ReviewDiffEntry,
  ReviewDiffRequest,
  ReviewDiffResult,
  ReviewFileSafety,
} from "../../shared/types";
import {
  classifyReviewFileMetadata,
  classifyReviewTextPayload,
  REVIEW_GIT_DIFF_MAX_BYTES,
  REVIEW_RENDERABLE_TEXT_MAX_BYTES,
  REVIEW_UNTRACKED_DIFF_CONCURRENCY,
} from "../../shared/review-file-safety";
import {
  GIT_CAT_FILE_TIMEOUT_MS,
  type GitCommandOptions,
  type GitCommandResult as GitRunnerCommandResult,
  type GitCommandRunner,
  type GitRepositoryExecutionIdentity,
} from "./git-command-runner";

interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface GitCommandError extends Error {
  stderr?: string;
  exitCode?: number | null;
}

const GIT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const REVIEW_FILE_CHANGED_LINES_LIMIT = 15_000;
const REVIEW_CAT_FILE_MAX_BYTES = 5_242_880;
const REVIEW_GIT_STREAM_ERROR_MAX_BYTES = 64 * 1024;
export const GIT_REVIEW_LOCAL_HOST_ID = "local";

export interface GitReviewRepositoryIdentity {
  hostId: string;
  commonDir: string;
  root: string;
}

export interface GitReviewRepositoryPaths extends GitReviewRepositoryIdentity {
  gitDir: string;
}

export type GitReviewWorkingTreePathFilterResult =
  | { type: "filtered"; changedPaths: string[] }
  | { type: "full" };

interface GitReviewOperationContext {
  runtime: GitReviewRuntime;
  signal: AbortSignal;
  repository?: {
    runGit(args: readonly string[], options?: GitCommandOptions): Promise<GitRunnerCommandResult>;
  };
}

const gitReviewOperationContext = new AsyncLocalStorage<GitReviewOperationContext>();
interface GitReviewSnapshotGenerationProvider {
  advance(): number;
  current(): number;
}
const GIT_REVIEW_DIFF_BASE_ARGS = [
  "--no-ext-diff",
  "--no-textconv",
  "--color=never",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--find-renames",
];

interface GitReviewUntrackedPathsInput {
  precomputedUntrackedPaths?: readonly string[] | null;
  precomputedStageCounts?: {
    stagedFileCount: number;
    unstagedFileCount: number;
    untrackedFileCount: number;
  } | null;
  untrackedFilesOmitted?: number;
}

interface GitDiffFileMetadata {
  path: string;
  previousPath: string | null;
  status: GitReviewFileStatus;
  rawStatus: string | null;
  oldOid: string | null;
  newOid: string | null;
  revision: string | null;
  additions: number | null;
  deletions: number | null;
  safety: ReviewFileSafety;
  generated?: boolean | null;
}

interface GitDiffRawMetadata {
  path: string;
  previousPath: string | null;
  rawStatus: string | null;
  oldOid: string | null;
  newOid: string | null;
}

function normalizeGitReviewRepositoryPath(value: string): string {
  return path.resolve(value.trim());
}

function buildGitReviewRepositoryKey(identity: GitReviewRepositoryIdentity): string {
  return JSON.stringify([identity.hostId, identity.commonDir, identity.root]);
}

function buildGitReviewRepositoryCwdKey(hostId: string, cwd: string): string {
  return JSON.stringify([hostId, normalizeGitReviewRepositoryPath(cwd)]);
}

export class GitReviewRuntime {
  readonly #commandRunner: GitCommandRunner;
  readonly #fallbackSnapshotGenerations = new Map<string, number>();
  readonly #repositoryIdentitiesByKey = new Map<string, GitReviewRepositoryIdentity>();
  readonly #repositoryPathsByKey = new Map<string, GitReviewRepositoryPaths>();
  readonly #repositoryKeysByCwd = new Map<string, string>();
  readonly #repositoryPathReads = new Map<string, Promise<GitReviewRepositoryPaths | null>>();
  readonly #snapshotGenerationProviders = new Map<string, GitReviewSnapshotGenerationProvider>();

  constructor(options: { commandRunner: GitCommandRunner }) {
    this.#commandRunner = options.commandRunner;
  }

  get commandRunner(): GitCommandRunner {
    return this.#commandRunner;
  }

  registerRepositoryIdentity(
    cwd: string,
    identity: GitReviewRepositoryIdentity & { gitDir?: string },
  ): GitReviewRepositoryIdentity {
    const normalizedIdentity: GitReviewRepositoryIdentity = {
      hostId: identity.hostId.trim() || GIT_REVIEW_LOCAL_HOST_ID,
      commonDir: normalizeGitReviewRepositoryPath(identity.commonDir),
      root: normalizeGitReviewRepositoryPath(identity.root),
    };
    const key = buildGitReviewRepositoryKey(normalizedIdentity);
    this.#repositoryIdentitiesByKey.set(key, normalizedIdentity);
    this.#repositoryKeysByCwd.set(
      buildGitReviewRepositoryCwdKey(normalizedIdentity.hostId, cwd),
      key,
    );
    this.#repositoryKeysByCwd.set(
      buildGitReviewRepositoryCwdKey(normalizedIdentity.hostId, normalizedIdentity.root),
      key,
    );
    if (identity.gitDir) {
      this.#repositoryPathsByKey.set(key, {
        ...normalizedIdentity,
        gitDir: normalizeGitReviewRepositoryPath(identity.gitDir),
      });
    }
    return normalizedIdentity;
  }

  registerSnapshotGenerationProvider(
    identity: GitReviewRepositoryIdentity,
    provider: GitReviewSnapshotGenerationProvider,
  ): () => void {
    const normalizedIdentity = this.registerRepositoryIdentity(identity.root, identity);
    const key = buildGitReviewRepositoryKey(normalizedIdentity);
    this.#snapshotGenerationProviders.set(key, provider);
    return () => {
      if (this.#snapshotGenerationProviders.get(key) === provider) {
        this.#snapshotGenerationProviders.delete(key);
      }
    };
  }

  findRepository(
    cwd: string,
    hostId = GIT_REVIEW_LOCAL_HOST_ID,
  ): GitReviewRepositoryIdentity | null {
    const cwdKey = buildGitReviewRepositoryCwdKey(hostId, cwd);
    const registeredKey = this.#repositoryKeysByCwd.get(cwdKey);
    return registeredKey ? (this.#repositoryIdentitiesByKey.get(registeredKey) ?? null) : null;
  }

  findRepositoryPaths(identity: GitReviewRepositoryIdentity): GitReviewRepositoryPaths | null {
    return this.#repositoryPathsByKey.get(buildGitReviewRepositoryKey(identity)) ?? null;
  }

  findRepositoryPathRead(key: string): Promise<GitReviewRepositoryPaths | null> | undefined {
    return this.#repositoryPathReads.get(key);
  }

  registerRepositoryPathRead(key: string, read: Promise<GitReviewRepositoryPaths | null>): void {
    this.#repositoryPathReads.set(key, read);
  }

  completeRepositoryPathRead(key: string, read: Promise<GitReviewRepositoryPaths | null>): void {
    if (this.#repositoryPathReads.get(key) === read) {
      this.#repositoryPathReads.delete(key);
    }
  }

  readSnapshotGeneration(repository: GitReviewRepositoryIdentity): number {
    const key = buildGitReviewRepositoryKey(repository);
    return (
      this.#snapshotGenerationProviders.get(key)?.current() ??
      this.#fallbackSnapshotGenerations.get(key) ??
      1
    );
  }

  invalidateSnapshot(cwd: string, identity?: GitReviewRepositoryIdentity): void {
    const normalizedCwd = cwd.trim();
    if (!normalizedCwd) return;
    const repository = identity
      ? this.registerRepositoryIdentity(normalizedCwd, identity)
      : this.findRepository(normalizedCwd);
    if (!repository) return;
    const key = buildGitReviewRepositoryKey(repository);
    const provider = this.#snapshotGenerationProviders.get(key);
    if (provider) {
      provider.advance();
      return;
    }
    this.#fallbackSnapshotGenerations.set(
      key,
      (this.#fallbackSnapshotGenerations.get(key) ?? 1) + 1,
    );
  }

  run<Result>(
    signal: AbortSignal,
    operation: () => Promise<Result>,
    repository?: GitReviewOperationContext["repository"],
  ): Promise<Result> {
    return gitReviewOperationContext.run({ runtime: this, signal, repository }, operation);
  }
}

function currentGitReviewRuntime(): GitReviewRuntime {
  const runtime = gitReviewOperationContext.getStore()?.runtime;
  if (!runtime) throw new Error("Git review operation requires an explicit runtime context");
  return runtime;
}

function runGitRunnerCommand(
  args: readonly string[],
  cwd: string,
  options: GitCommandOptions = {},
): Promise<GitRunnerCommandResult> {
  const context = gitReviewOperationContext.getStore();
  const runtime = context?.runtime ?? currentGitReviewRuntime();
  const signal = options.signal ?? context?.signal;
  signal?.throwIfAborted();
  const normalizedCwd = normalizeGitReviewRepositoryPath(cwd);
  const registered = runtime.findRepository(normalizedCwd);
  const identity: GitRepositoryExecutionIdentity = {
    hostId: "local",
    root: registered?.root ?? normalizedCwd,
    commonDir: registered?.commonDir ?? normalizedCwd,
  };
  const commandOptions = { ...options, signal };
  return context?.repository
    ? context.repository.runGit(args, commandOptions)
    : runtime.commandRunner.run(identity, args, commandOptions);
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

function runGitCommand(
  args: string[],
  cwd: string,
  allowedExitCodes: number[] = [0],
  options?: { literalPathspecs?: boolean; signal?: AbortSignal },
): Promise<GitCommandResult> {
  const context = gitReviewOperationContext.getStore();
  const signal = options?.signal ?? context?.signal;
  const commandOptions = {
    allowedNonZeroExitCodes: allowedExitCodes.filter((code) => code !== 0),
    outputBytesCap: REVIEW_GIT_DIFF_MAX_BYTES,
    literalPathspecs: options?.literalPathspecs,
    signal,
  };
  return runGitRunnerCommand(args, cwd, commandOptions).then((result) => {
    if (result.success) {
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      };
    }
    signal?.throwIfAborted();
    const failure = new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `Git command failed: ${result.failureReason ?? "unknown"}`,
    ) as GitCommandError;
    failure.stderr = result.stderr;
    failure.exitCode = result.code;
    throw failure;
  });
}

async function readGitBranchState(
  cwd: string,
  signal?: AbortSignal,
): Promise<GitBranchMetadataResult> {
  const [current, branches, remoteDefault] = await Promise.all([
    runGitCommand(["branch", "--show-current"], cwd, [0], { signal }),
    runGitCommand(["branch", "--format=%(refname:short)"], cwd, [0], {
      signal,
    }),
    runGitCommand(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      cwd,
      [0, 1, 128],
      { signal },
    ),
  ]);
  const currentBranch = current.stdout.trim() || null;
  const branchNames = [
    ...new Set(
      branches.stdout
        .split(/\r?\n/)
        .map((branch) => branch.trim())
        .filter(Boolean),
    ),
  ];
  const remoteName = remoteDefault.stdout.trim();
  const defaultBranch = remoteName.startsWith("origin/")
    ? remoteName.slice("origin/".length)
    : remoteName ||
      (branchNames.includes("main")
        ? "main"
        : branchNames.includes("master")
          ? "master"
          : currentBranch);
  return {
    currentBranch,
    defaultBranch,
    branches: branchNames,
  };
}

export async function resolveGitReviewRepositoryPaths(
  cwd: string,
  hostId = GIT_REVIEW_LOCAL_HOST_ID,
): Promise<GitReviewRepositoryPaths | null> {
  const runtime = currentGitReviewRuntime();
  const normalizedCwd = await ensureDirectory(cwd);
  const normalizedHostId = hostId.trim() || GIT_REVIEW_LOCAL_HOST_ID;
  const registered = runtime.findRepository(normalizedCwd, normalizedHostId);
  if (registered) {
    const registeredPaths = runtime.findRepositoryPaths(registered);
    if (registeredPaths) return registeredPaths;
  }

  const readKey = buildGitReviewRepositoryCwdKey(normalizedHostId, normalizedCwd);
  const existing = runtime.findRepositoryPathRead(readKey);
  if (existing) return existing;

  const promise = runGitCommand(["rev-parse", "--show-toplevel"], normalizedCwd, [0, 128])
    .then(async (rootResult) => {
      const rawRoot = rootResult.stdout.trim();
      if (!rawRoot) return null;
      const root = await realpath(path.resolve(normalizedCwd, rawRoot));
      const [gitDirResult, commonDirResult] = await Promise.all([
        runGitCommand(["rev-parse", "--git-dir"], root, [0, 128]),
        runGitCommand(["rev-parse", "--git-common-dir"], root, [0, 128]),
      ]);
      const rawGitDir = gitDirResult.stdout.trim();
      const rawCommonDir = commonDirResult.stdout.trim();
      if (!rawGitDir || !rawCommonDir) return null;
      const resolvedGitDir = path.resolve(root, rawGitDir);
      const resolvedCommonDir = path.resolve(root, rawCommonDir);
      const [gitDir, commonDir] = await Promise.all([
        realpath(resolvedGitDir),
        realpath(resolvedCommonDir),
      ]);
      const paths: GitReviewRepositoryPaths = {
        hostId: normalizedHostId,
        root,
        gitDir,
        commonDir,
      };
      const identity = runtime.registerRepositoryIdentity(normalizedCwd, paths);
      return { ...paths, ...identity };
    })
    .catch(() => null);
  runtime.registerRepositoryPathRead(readKey, promise);
  try {
    return await promise;
  } finally {
    runtime.completeRepositoryPathRead(readKey, promise);
  }
}

async function resolveGitReviewRepositoryIdentity(
  cwd: string,
): Promise<GitReviewRepositoryIdentity> {
  const registered = currentGitReviewRuntime().findRepository(cwd, GIT_REVIEW_LOCAL_HOST_ID);
  if (registered) return registered;
  const paths = await resolveGitReviewRepositoryPaths(cwd);
  if (paths) return paths;
  const normalizedCwd = normalizeGitReviewRepositoryPath(cwd);
  return {
    hostId: GIT_REVIEW_LOCAL_HOST_ID,
    commonDir: normalizedCwd,
    root: normalizedCwd,
  };
}

class GitReviewStaleSnapshotError extends Error {
  constructor(
    readonly expectedGeneration: number,
    readonly actualGeneration: number,
  ) {
    super(`Git review snapshot changed (${expectedGeneration} -> ${actualGeneration}).`);
    this.name = "GitReviewStaleSnapshotError";
  }
}

export function isGitReviewStaleSnapshotError(error: unknown): error is Error & {
  expectedGeneration: number;
  actualGeneration: number;
} {
  return error instanceof GitReviewStaleSnapshotError;
}

function parseDirtyWorktreePaths(status: string): string[] {
  const records = status.split("\0").filter(Boolean);
  const paths: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const statusCode = record.slice(0, 2);
    const filePath = record.slice(3);
    if (filePath) paths.push(filePath);
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const previousPath = records[index + 1] ?? "";
      if (previousPath) paths.push(previousPath);
      index += 1;
    }
  }

  return paths;
}

function pathsOverlap(first: string, second: string): boolean {
  const firstToSecond = path.relative(first, second);
  if (
    firstToSecond === "" ||
    (!firstToSecond.startsWith("..") && !path.isAbsolute(firstToSecond))
  ) {
    return true;
  }

  const secondToFirst = path.relative(second, first);
  return (
    secondToFirst === "" || (!secondToFirst.startsWith("..") && !path.isAbsolute(secondToFirst))
  );
}

export async function filterGitReviewWorkingTreePaths(input: {
  root: string;
  changedPaths: readonly string[];
}): Promise<GitReviewWorkingTreePathFilterResult> {
  if (input.changedPaths.length === 0) return { type: "full" };

  const root = path.resolve(input.root);
  const changedPaths: string[] = [];
  const pathspecs: string[] = [];
  const seen = new Set<string>();
  for (const changedPath of input.changedPaths) {
    if (!path.isAbsolute(changedPath)) return { type: "full" };
    const normalizedPath = path.resolve(changedPath);
    const relativePath = path.relative(root, normalizedPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return { type: "full" };
    }
    if (seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    changedPaths.push(normalizedPath);
    pathspecs.push(relativePath || ".");
  }

  if (changedPaths.length === 0) return { type: "full" };
  const status = await runGitCommand(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...pathspecs],
    root,
    [0],
    { literalPathspecs: true },
  ).catch(() => null);
  if (!status) return { type: "full" };

  const dirtyPaths = parseDirtyWorktreePaths(status.stdout).map((filePath) =>
    path.resolve(root, filePath),
  );
  return {
    type: "filtered",
    changedPaths: changedPaths.filter((changedPath) =>
      dirtyPaths.some((dirtyPath) => pathsOverlap(changedPath, dirtyPath)),
    ),
  };
}

async function readGitReviewSnapshotGeneration(cwd: string, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const runtime = currentGitReviewRuntime();
  const repository = await resolveGitReviewRepositoryIdentity(cwd);
  return runtime.readSnapshotGeneration(repository);
}

export function invalidateGitReviewSnapshot(
  cwd: string,
  identity?: GitReviewRepositoryIdentity,
): void {
  currentGitReviewRuntime().invalidateSnapshot(cwd, identity);
}

async function assertGitReviewSnapshotGeneration(
  cwd: string,
  expectedGeneration: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const runtime = currentGitReviewRuntime();
  const repository = await resolveGitReviewRepositoryIdentity(cwd);
  const actualGeneration = runtime.readSnapshotGeneration(repository);
  if (actualGeneration === expectedGeneration) return;
  throw new GitReviewStaleSnapshotError(expectedGeneration, actualGeneration);
}

async function runGitReviewRequest<T>(
  _requestId: string | null | undefined,
  run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = gitReviewOperationContext.getStore()?.signal;
  signal?.throwIfAborted();
  return await run(signal);
}

export function runGitReviewOperationWithSignal<Result>(
  runtime: GitReviewRuntime,
  signal: AbortSignal,
  operation: () => Promise<Result>,
  repository?: GitReviewOperationContext["repository"],
): Promise<Result> {
  return runtime.run(signal, operation, repository);
}

function isNotGitRepositoryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const message = `${error.message}\n${stderr}`.toLowerCase();
  return message.includes("not a git repository");
}

function resolvePatchErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "gitApplyFailed";

  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const message = `${error.message}\n${stderr}`.toLowerCase();
  if (message.includes("patch does not apply")) return "patchDoesNotApply";
  if (message.includes("already exists in index")) return "alreadyApplied";
  if (message.includes("does not exist in index")) return "missingFromIndex";
  if (message.includes("corrupt patch")) return "corruptPatch";
  return "gitApplyFailed";
}

async function isGitRepository(cwd: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runGitCommand(["rev-parse", "--is-inside-work-tree"], cwd, [0], {
    signal,
  }).catch((error) => {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === "AbortError") throw error;
    return null;
  });
  return result?.stdout.trim() === "true";
}

function countNullableChangedLines(
  file: Pick<GitReviewFileSummary, "additions" | "deletions">,
): number {
  return (file.additions ?? 0) + (file.deletions ?? 0);
}

function summarizeFileDiff(
  fileDiff: FileDiffMetadata,
): Pick<GitReviewFileSummary, "additions" | "deletions"> {
  return fileDiff.hunks.reduce(
    (summary, hunk) => ({
      additions: summary.additions + hunk.additionLines,
      deletions: summary.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
}

function mapFileStatus(fileDiff: FileDiffMetadata): GitReviewFileStatus {
  if (fileDiff.type === "new") return "added";
  if (fileDiff.type === "deleted") return "deleted";
  if (fileDiff.type === "rename-pure" || fileDiff.type === "rename-changed") {
    return "renamed";
  }
  return "modified";
}

function splitNul(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

function mapNameStatusCode(statusToken: string): GitReviewFileStatus {
  const statusCode = statusToken.trim().charAt(0);
  if (statusCode === "A") return "added";
  if (statusCode === "C") return "copied";
  if (statusCode === "D") return "deleted";
  if (statusCode === "R") return "renamed";
  if (statusCode === "T") return "type-changed";
  if (statusCode === "U") return "unmerged";
  return "modified";
}

function parseNameStatusZ(
  stdout: string,
): Array<Pick<GitDiffFileMetadata, "path" | "previousPath" | "status">> {
  const tokens = splitNul(stdout);
  const rows: Array<Pick<GitDiffFileMetadata, "path" | "previousPath" | "status">> = [];
  let index = 0;

  while (index < tokens.length) {
    const statusToken = tokens[index++]?.trim() ?? "";
    if (!statusToken) continue;

    const status = mapNameStatusCode(statusToken);
    if (status === "renamed" || status === "copied") {
      const previousPath = tokens[index++]?.trim() ?? "";
      const nextPath = tokens[index++]?.trim() ?? "";
      if (!nextPath) continue;
      rows.push({
        path: nextPath,
        previousPath: previousPath || null,
        status,
      });
      continue;
    }

    const nextPath = tokens[index++]?.trim() ?? "";
    if (!nextPath) continue;
    rows.push({
      path: nextPath,
      previousPath: null,
      status,
    });
  }

  return rows;
}

function parseRawZ(stdout: string): GitDiffRawMetadata[] {
  const tokens = splitNul(stdout);
  const rows: GitDiffRawMetadata[] = [];
  let index = 0;

  while (index < tokens.length) {
    const header = tokens[index++]?.trim() ?? "";
    if (!header.startsWith(":")) continue;

    const parts = header.split(/\s+/);
    const oldOid = parts[2] ?? null;
    const newOid = parts[3] ?? null;
    const rawStatus = parts[4] ?? null;
    const status = rawStatus ? mapNameStatusCode(rawStatus) : "modified";

    if (status === "renamed" || status === "copied") {
      const previousPath = tokens[index++]?.trim() ?? "";
      const nextPath = tokens[index++]?.trim() ?? "";
      if (!nextPath) continue;
      rows.push({
        path: nextPath,
        previousPath: previousPath || null,
        rawStatus,
        oldOid,
        newOid,
      });
      continue;
    }

    const nextPath = tokens[index++]?.trim() ?? "";
    if (!nextPath) continue;
    rows.push({
      path: nextPath,
      previousPath: null,
      rawStatus,
      oldOid,
      newOid,
    });
  }

  return rows;
}

function parseNumstatCount(value: string | undefined): number | null {
  if (value === "-") return null;
  const count = Number(value ?? "");
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function parseNumstatZ(
  stdout: string,
): Array<Pick<GitDiffFileMetadata, "path" | "previousPath" | "additions" | "deletions">> {
  const tokens = splitNul(stdout);
  const rows: Array<
    Pick<GitDiffFileMetadata, "path" | "previousPath" | "additions" | "deletions">
  > = [];
  let index = 0;

  while (index < tokens.length) {
    const statsToken = tokens[index++] ?? "";
    const [rawAdditions, rawDeletions, rawPath = ""] = statsToken.split("\t");
    const additions = parseNumstatCount(rawAdditions);
    const deletions = parseNumstatCount(rawDeletions);

    if (rawPath.length > 0) {
      rows.push({
        path: rawPath,
        previousPath: null,
        additions,
        deletions,
      });
      continue;
    }

    const previousPath = tokens[index++]?.trim() ?? "";
    const nextPath = tokens[index++]?.trim() ?? "";
    if (!nextPath) continue;
    rows.push({
      path: nextPath,
      previousPath: previousPath || null,
      additions,
      deletions,
    });
  }

  return rows;
}

async function hashWorktreePaths(
  cwd: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const uniquePaths = Array.from(new Set(paths.filter((entry) => entry.trim().length > 0)));
  if (uniquePaths.length === 0) return new Map();

  const result = await runGitCommand(
    ["hash-object", "--no-filters", "--", ...uniquePaths],
    cwd,
    [0],
    { signal },
  ).catch(() => null);
  if (!result) return new Map();

  const hashes = result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return new Map(
    uniquePaths.flatMap((filePath, index) => {
      const hash = hashes[index];
      return hash ? [[filePath, hash] as const] : [];
    }),
  );
}

async function buildWorktreeStatRevisionPart(
  cwd: string,
  filePath: string,
): Promise<string | null> {
  const entry = await stat(path.resolve(cwd, filePath)).catch(() => null);
  if (!entry?.isFile()) return null;
  return `${entry.size}:${Math.trunc(entry.mtimeMs)}`;
}

async function buildGitFileRevision(input: {
  cwd: string;
  source: GitReviewSource;
  path: string;
  status: GitReviewFileStatus;
  oldOid: string | null;
  newOid: string | null;
  worktreeHash: string | null;
}): Promise<string | null> {
  if (input.status === "untracked") {
    if (input.worktreeHash) return `untracked:${input.worktreeHash}`;
    const statRevisionPart = await buildWorktreeStatRevisionPart(input.cwd, input.path);
    return statRevisionPart
      ? `untracked:${statRevisionPart}:${input.path}`
      : `untracked:${input.path}`;
  }

  if (input.source !== "unstaged" || input.status === "deleted") {
    return `${input.source}:${input.status}:${input.oldOid ?? ""}:${input.newOid ?? ""}`;
  }

  if (input.worktreeHash) {
    return `${input.source}:${input.status}:${input.oldOid ?? ""}:worktree:${input.worktreeHash}`;
  }

  const statRevisionPart = await buildWorktreeStatRevisionPart(input.cwd, input.path);
  if (statRevisionPart) {
    return `${input.source}:${input.status}:${input.oldOid ?? ""}:worktree:${statRevisionPart}`;
  }

  return `${input.source}:${input.status}:${input.oldOid ?? ""}:${input.newOid ?? ""}`;
}

async function mergeGitDiffMetadata(input: {
  cwd: string;
  source: GitReviewSource;
  nameStatusRows: Array<Pick<GitDiffFileMetadata, "path" | "previousPath" | "status">>;
  numstatRows: Array<
    Pick<GitDiffFileMetadata, "path" | "previousPath" | "additions" | "deletions">
  >;
  rawRows: GitDiffRawMetadata[];
  signal?: AbortSignal;
}): Promise<GitDiffFileMetadata[]> {
  const statsByPath = new Map(input.numstatRows.map((row) => [row.path, row]));
  const statusByPath = new Map(input.nameStatusRows.map((row) => [row.path, row]));
  const rawByPath = new Map(input.rawRows.map((row) => [row.path, row]));
  const orderedPaths =
    input.nameStatusRows.length > 0
      ? input.nameStatusRows.map((row) => row.path)
      : input.numstatRows.map((row) => row.path);
  const seen = new Set<string>();
  const worktreeHashByPath =
    input.source === "unstaged"
      ? await hashWorktreePaths(input.cwd, orderedPaths, input.signal)
      : new Map<string, string>();
  const rows = await Promise.all(
    orderedPaths.flatMap((filePath): Array<Promise<GitDiffFileMetadata | null>> => {
      if (seen.has(filePath)) return [];
      seen.add(filePath);
      const statusRow = statusByPath.get(filePath) ?? null;
      const statsRow = statsByPath.get(filePath) ?? null;
      const rawRow = rawByPath.get(filePath) ?? null;
      const pathName = statusRow?.path ?? statsRow?.path ?? rawRow?.path ?? filePath;
      const previousPath =
        statusRow?.previousPath ?? statsRow?.previousPath ?? rawRow?.previousPath ?? null;
      const status = statusRow?.status ?? mapNameStatusCode(rawRow?.rawStatus ?? "") ?? "modified";
      const additions = statsRow?.additions ?? 0;
      const deletions = statsRow?.deletions ?? 0;
      const safety = classifyReviewFileMetadata({
        path: pathName,
        additions,
        deletions,
      });

      return [
        buildGitFileRevision({
          cwd: input.cwd,
          source: input.source,
          path: pathName,
          status,
          oldOid: rawRow?.oldOid ?? null,
          newOid: rawRow?.newOid ?? null,
          worktreeHash: worktreeHashByPath.get(pathName) ?? null,
        }).then((revision) => ({
          path: pathName,
          previousPath,
          status,
          rawStatus: rawRow?.rawStatus ?? null,
          oldOid: rawRow?.oldOid ?? null,
          newOid: rawRow?.newOid ?? null,
          revision,
          additions: safety.binary ? null : additions,
          deletions: safety.binary ? null : deletions,
          safety,
        })),
      ];
    }),
  );

  return rows.filter((row): row is GitDiffFileMetadata => row !== null);
}

async function readGitDiffMetadata(
  cwd: string,
  source: GitReviewSource,
  diffArgs: string[],
  signal?: AbortSignal,
): Promise<GitDiffFileMetadata[]> {
  const [nameStatusResult, numstatResult, rawResult] = await Promise.all([
    runGitCommand(["diff", ...diffArgs, "--name-status", "-z"], cwd, [0], {
      signal,
    }),
    runGitCommand(["diff", ...diffArgs, "--numstat", "-z"], cwd, [0], {
      signal,
    }),
    runGitCommand(["diff", ...diffArgs, "--raw", "-z"], cwd, [0], {
      signal,
    }).catch(() => null),
  ]);

  return mergeGitDiffMetadata({
    cwd,
    source,
    nameStatusRows: parseNameStatusZ(nameStatusResult.stdout),
    numstatRows: parseNumstatZ(numstatResult.stdout),
    rawRows: parseRawZ(rawResult?.stdout ?? ""),
    signal,
  });
}

async function readGeneratedReviewPaths(
  cwd: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  if (paths.length === 0) return new Set();
  const generated = new Set<string>();

  try {
    for (let offset = 0; offset < paths.length; offset += 100) {
      const batch = paths.slice(offset, offset + 100);
      const result = await runGitCommand(
        ["check-attr", "-z", "linguist-generated", "--", ...batch],
        cwd,
        [0],
        { signal },
      );
      const records = result.stdout.split("\0");
      for (let index = 0; index + 2 < records.length; index += 3) {
        const filePath = records[index] ?? "";
        const attribute = records[index + 1] ?? "";
        const value = (records[index + 2] ?? "").toLowerCase();
        if (attribute === "linguist-generated" && (value === "set" || value === "true")) {
          generated.add(filePath);
        }
      }
    }
    return generated;
  } catch {
    return null;
  }
}

async function annotateGeneratedReviewFiles(
  cwd: string,
  files: GitDiffFileMetadata[],
  signal?: AbortSignal,
): Promise<GitDiffFileMetadata[]> {
  const generatedPaths = await readGeneratedReviewPaths(
    cwd,
    files.map((file) => file.path),
    signal,
  );
  return files.map((file) => ({
    ...file,
    generated: generatedPaths === null ? null : generatedPaths.has(file.path),
  }));
}

/** The host resolves attributes for both turn patches and repository reviews. */
export async function readGitReviewGeneratedPaths(
  input: GitWorkerMethodMap["review-generated-paths"]["params"],
): Promise<GitWorkerMethodMap["review-generated-paths"]["result"]> {
  return runGitReviewRequest(undefined, async (signal) => {
    const cwd = await ensureDirectory(input.cwd);
    const repository = await resolveGitReviewRepositoryPaths(cwd);
    if (!repository) return { paths: [], hasLinguistGeneratedAttributes: false };
    const canonicalCwd = await realpath(cwd);
    const files = input.paths
      .map((original) => {
        const absolute = path.resolve(cwd, original);
        const relativeToRoot = path.relative(repository.root, absolute);
        const alreadyCanonical =
          relativeToRoot !== ".." &&
          !relativeToRoot.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativeToRoot);
        const canonicalPath = alreadyCanonical
          ? absolute
          : path.resolve(canonicalCwd, path.relative(cwd, absolute));
        return { original, relative: path.relative(repository.root, canonicalPath) };
      })
      .filter(
        (file) =>
          file.relative !== ".." &&
          !file.relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(file.relative),
      );
    const attributeFiles = new Set([path.join(repository.root, ".gitattributes")]);
    for (const file of files) {
      let directory = path.dirname(path.resolve(repository.root, file.relative));
      while (directory !== repository.root) {
        attributeFiles.add(path.join(directory, ".gitattributes"));
        directory = path.dirname(directory);
      }
    }
    let hasLinguistGeneratedAttributes = false;
    for (const attributePath of attributeFiles) {
      signal?.throwIfAborted();
      const contents = await readFile(attributePath, { encoding: "utf8", signal }).catch(
        (error: unknown) => {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return "";
          throw error;
        },
      );
      if (
        contents.split(/\r?\n/).some((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[attr]")) return false;
          return trimmed
            .split(/\s+/)
            .slice(1)
            .some((token) =>
              /^(?:[!-]?linguist-generated|linguist-generated=(?:true|false))$/.test(token),
            );
        })
      )
        hasLinguistGeneratedAttributes = true;
    }
    const generated = await readGeneratedReviewPaths(
      repository.root,
      files.map((file) => file.relative),
      signal,
    );
    if (!generated) throw new Error("Unable to resolve generated file attributes");
    return {
      paths: files.filter((file) => generated.has(file.relative)).map((file) => file.original),
      hasLinguistGeneratedAttributes,
    };
  });
}

function toFileSummaries(patch: string): GitReviewFileSummary[] {
  if (!patch.trim()) return [];

  try {
    return parsePatchFiles(patch).flatMap((parsedPatch) =>
      parsedPatch.files.map((fileDiff) => {
        const summary = summarizeFileDiff(fileDiff);
        return {
          path: fileDiff.name,
          previousPath: fileDiff.prevName ?? null,
          status: mapFileStatus(fileDiff),
          rawStatus: null,
          oldOid: null,
          newOid: null,
          revision: null,
          additions: summary.additions,
          deletions: summary.deletions,
          safety: classifyReviewFileMetadata({
            path: fileDiff.name,
            additions: summary.additions,
            deletions: summary.deletions,
          }),
        } satisfies GitReviewFileSummary;
      }),
    );
  } catch {
    return [];
  }
}

function toPatchPaths(patch: string): string[] {
  return toFileSummaries(patch).map((file) => file.path);
}

function splitPatchFileDiffs(patch: string): string[] {
  if (!patch.trim()) return [];

  const matches = Array.from(patch.matchAll(/^diff --git .+$/gm));
  if (matches.length === 0) return [];

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? patch.length;
    return patch.slice(start, end).trimEnd();
  });
}

function parseDiffGitCurrentPath(filePatch: string): string | null {
  const header = filePatch.split(/\r?\n/, 1)[0] ?? "";
  return parseGitDiffHeaderPaths(header)?.newPath ?? null;
}

function splitPatchFileDiffsByPath(patch: string): Map<string, string> {
  const fileDiffs = splitPatchFileDiffs(patch);
  const byPath = new Map<string, string>();

  for (const fileDiff of fileDiffs) {
    const currentPath = parseDiffGitCurrentPath(fileDiff);
    if (!currentPath) continue;
    const existing = byPath.get(currentPath);
    byPath.set(currentPath, existing ? `${existing}\n${fileDiff}` : fileDiff);
  }

  return byPath;
}

function resolveDiffLoadStatus(input: {
  safety: ReviewFileSafety;
  changedLines: number;
}): ReviewDiffEntry["loadStatus"] {
  if (input.safety.skipReason === "binary") return "binary";
  if (input.safety.skipReason === "tooLarge") return "diff-too-large";
  if (input.safety.skipReason === "invalidText" || input.safety.skipReason === "unsupported")
    return "unsupported";
  if (input.changedLines > REVIEW_FILE_CHANGED_LINES_LIMIT) return "diff-too-large";
  return "loaded";
}

function toReviewDiffEntries(
  patch: string,
  summaries: GitReviewFileSummary[] = toFileSummaries(patch),
): ReviewDiffEntry[] {
  const diffsByPath = splitPatchFileDiffsByPath(patch);

  return summaries.map((file) => {
    const diff = file.safety.renderable ? (diffsByPath.get(file.path) ?? "") : "";
    const diffSafety =
      diff.trim().length > 0
        ? classifyReviewTextPayload({
            path: file.path,
            text: diff,
            maxBytes: REVIEW_RENDERABLE_TEXT_MAX_BYTES,
          })
        : file.safety;
    const safety = file.safety.renderable ? diffSafety : file.safety;
    const changedLines = countNullableChangedLines(file);
    const loadStatus = resolveDiffLoadStatus({ safety, changedLines });
    const tooLarge = loadStatus === "diff-too-large";
    return {
      ...file,
      diff,
      safety,
      loadStatus,
      renderKey: `${file.previousPath ?? ""}->${file.path}:${file.additions ?? "-"}:${file.deletions ?? "-"}:${diff.length}:${loadStatus}`,
      diffBytes: Buffer.byteLength(diff, "utf8"),
      diffError: null,
      canApplyPatchActions:
        file.safety.renderable && diff.trim().length > 0 && loadStatus === "loaded",
      changedBytes: Buffer.byteLength(diff, "utf8"),
      tooLarge,
      tooLargeReason: tooLarge
        ? safety.skipReason === "tooLarge"
          ? "File diff is above the review display limit."
          : `File changed ${changedLines} lines, above the ${REVIEW_FILE_CHANGED_LINES_LIMIT} line review limit.`
        : null,
    } satisfies ReviewDiffEntry;
  });
}

function buildDiffWhitespaceArgs(hideWhitespace?: boolean): string[] {
  return hideWhitespace ? ["--ignore-all-space"] : [];
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  mapper: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results: TOutput[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]!);
      }
    }),
  );

  return results;
}

function buildGitReviewDiffArgs(input?: {
  hideWhitespace?: boolean;
  cached?: boolean;
  revisions?: string[];
}): string[] {
  return [
    ...GIT_REVIEW_DIFF_BASE_ARGS,
    ...buildDiffWhitespaceArgs(input?.hideWhitespace),
    ...(input?.cached ? ["--cached"] : []),
    ...(input?.revisions ?? []),
  ];
}

async function buildGitReviewSourceDiffArgs(input: {
  cwd: string;
  source: GitReviewSource;
  hideWhitespace?: boolean;
  baseRef?: string | null;
  commitSha?: string | null;
  signal?: AbortSignal;
}): Promise<string[] | null> {
  if (input.source === "staged") {
    return buildGitReviewDiffArgs({
      hideWhitespace: input.hideWhitespace,
      cached: true,
    });
  }

  if (input.source === "unstaged") {
    return buildGitReviewDiffArgs({ hideWhitespace: input.hideWhitespace });
  }

  if (input.source === "commit") {
    const normalizedCommitSha = input.commitSha?.trim() ?? "";
    if (!normalizedCommitSha) {
      throw new Error("Commit SHA is required for commit review.");
    }
    const parentResult = await runGitCommand(
      ["rev-parse", "--verify", "--quiet", `${normalizedCommitSha}^`],
      input.cwd,
      [0, 1, 128],
      { signal: input.signal },
    ).catch(() => null);
    const parentSha = parentResult?.exitCode === 0 ? parentResult.stdout.trim() : "";
    return buildGitReviewDiffArgs({
      hideWhitespace: input.hideWhitespace,
      revisions: [parentSha || GIT_EMPTY_TREE_SHA, normalizedCommitSha],
    });
  }

  const baseRef = input.baseRef?.trim() ?? "";
  if (!baseRef) return null;
  return buildGitReviewDiffArgs({
    hideWhitespace: input.hideWhitespace,
    revisions: [`${baseRef}...HEAD`],
  });
}

async function listUntrackedFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const result = await runGitCommand(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    cwd,
    [0],
    { signal },
  );
  return result.stdout
    .split("\0")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function readUntrackedFilePatch(
  cwd: string,
  relativePath: string,
  hideWhitespace?: boolean,
  signal?: AbortSignal,
  binary = false,
): Promise<string> {
  const result = await runGitCommand(
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--color=never",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      ...(binary ? ["--binary"] : []),
      ...buildDiffWhitespaceArgs(hideWhitespace),
      "--no-index",
      "--",
      "/dev/null",
      relativePath,
    ],
    cwd,
    [0, 1],
    { signal },
  ).catch(() => null);
  return result?.stdout ?? "";
}

async function readUntrackedFileMetadata(
  cwd: string,
  relativePath: string,
  hideWhitespace?: boolean,
  signal?: AbortSignal,
): Promise<GitDiffFileMetadata> {
  const absolutePath = path.resolve(cwd, relativePath);
  const sizeBytes = (await stat(absolutePath).catch(() => null))?.size ?? null;
  const result = await runGitCommand(
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--color=never",
      ...buildDiffWhitespaceArgs(hideWhitespace),
      "--no-index",
      "--numstat",
      "-z",
      "--",
      "/dev/null",
      relativePath,
    ],
    cwd,
    [0, 1],
    { signal },
  ).catch(() => null);
  const stats = parseNumstatZ(result?.stdout ?? "")[0] ?? null;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const safety = classifyReviewFileMetadata({
    path: relativePath,
    additions,
    deletions,
    sizeBytes,
  });

  return {
    path: relativePath,
    previousPath: null,
    status: "untracked",
    rawStatus: null,
    oldOid: null,
    newOid: null,
    revision: await buildGitFileRevision({
      cwd,
      source: "unstaged",
      path: relativePath,
      status: "untracked",
      oldOid: null,
      newOid: null,
      worktreeHash:
        (await hashWorktreePaths(cwd, [relativePath], signal)).get(relativePath) ?? null,
    }),
    additions: safety.binary ? null : additions,
    deletions: safety.binary ? null : deletions,
    safety,
  };
}

async function readUntrackedMetadata(
  cwd: string,
  hideWhitespace?: boolean,
  signal?: AbortSignal,
  precomputedUntrackedPaths?: readonly string[] | null,
): Promise<GitDiffFileMetadata[]> {
  if (precomputedUntrackedPaths === null) {
    throw new Error("Could not read untracked Git paths.");
  }
  const untrackedFiles = precomputedUntrackedPaths ?? (await listUntrackedFiles(cwd, signal));
  if (untrackedFiles.length === 0) return [];

  return mapWithConcurrency(
    [...untrackedFiles],
    REVIEW_UNTRACKED_DIFF_CONCURRENCY,
    (relativePath) => readUntrackedFileMetadata(cwd, relativePath, hideWhitespace, signal),
  );
}

async function readGitReviewFiles(
  input: GitReviewSnapshotRequest & GitReviewUntrackedPathsInput,
  resolvedBaseRef: string | null,
  signal?: AbortSignal,
): Promise<GitReviewFileSummary[]> {
  if (input.source === "unstaged" || input.source === "branch") {
    const diffArgs = await buildGitReviewSourceDiffArgs({
      cwd: input.cwd,
      source: input.source,
      hideWhitespace: input.hideWhitespace,
      baseRef: resolvedBaseRef,
      commitSha: input.commitSha,
      signal,
    });
    if (!diffArgs) return [];
    const [trackedFiles, untrackedFiles] = await Promise.all([
      readGitDiffMetadata(input.cwd, input.source, diffArgs, signal),
      input.includeUntrackedFiles === false
        ? Promise.resolve([])
        : readUntrackedMetadata(
            input.cwd,
            input.hideWhitespace,
            signal,
            input.precomputedUntrackedPaths,
          ),
    ]);
    return annotateGeneratedReviewFiles(input.cwd, [...trackedFiles, ...untrackedFiles], signal);
  }

  const diffArgs = await buildGitReviewSourceDiffArgs({
    cwd: input.cwd,
    source: input.source,
    hideWhitespace: input.hideWhitespace,
    baseRef: resolvedBaseRef,
    commitSha: input.commitSha,
    signal,
  });
  if (!diffArgs) return [];
  const files = await readGitDiffMetadata(input.cwd, input.source, diffArgs, signal);
  return annotateGeneratedReviewFiles(input.cwd, files, signal);
}

async function resolveBaseRef(
  cwd: string,
  explicitBaseRef?: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const normalizedExplicitBaseRef = explicitBaseRef?.trim() || "";
  if (normalizedExplicitBaseRef) {
    return normalizedExplicitBaseRef;
  }

  const baseBranch = await readGitReviewBaseBranchWithSignal({ cwd }, signal);
  if (baseBranch.remote) return baseBranch.remote;
  if (baseBranch.local) return baseBranch.local;

  const branchState = await readGitBranchState(cwd, signal);
  if (branchState.defaultBranch) {
    return branchState.defaultBranch;
  }

  if (branchState.branches.includes("main")) {
    return "main";
  }

  if (branchState.branches.includes("master")) {
    return "master";
  }

  return branchState.currentBranch ?? null;
}

async function resolveBranchComparisonBase(
  cwd: string,
  explicitBaseBranch: string | null | undefined,
  signal?: AbortSignal,
): Promise<{ baseBranch: string | null; baseSha: string | null }> {
  const baseBranch = explicitBaseBranch?.trim() || (await resolveBaseRef(cwd, null, signal));
  if (!baseBranch) {
    return {
      baseBranch: null,
      baseSha: null,
    };
  }

  const mergeBase = await runGitCommand(["merge-base", "HEAD", baseBranch], cwd, [0, 1, 128], {
    signal,
  }).catch(() => null);
  const baseSha = mergeBase?.exitCode === 0 ? mergeBase.stdout.trim() : "";
  return {
    baseBranch,
    baseSha: baseSha || null,
  };
}

function parseBranchCommitLog(stdout: string): GitReviewBranchCommit[] {
  if (!stdout.trim()) return [];

  return stdout.split("\n").flatMap((line): GitReviewBranchCommit[] => {
    const [sha, committedAt, subject] = line.split("\0");
    if (!sha || !committedAt || subject === undefined) return [];
    return [
      {
        sha,
        committedAt,
        subject: subject || sha.slice(0, 12),
      },
    ];
  });
}

function splitGitObjectLines(contents: string): string[] {
  const lines = contents.split(/(?<=\n)/);
  if (lines.length === 1 && lines[0] === "") return [];
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function runGitCatFileBatch(cwd: string, objectSpecs: string[]): Promise<Buffer> {
  if (objectSpecs.length === 0) return Buffer.alloc(0);

  const context = gitReviewOperationContext.getStore();
  const signal = context?.signal;
  signal?.throwIfAborted();
  const outputChunks: Buffer[] = [];
  const stdoutBytesCap = objectSpecs.length * (REVIEW_CAT_FILE_MAX_BYTES + 512);
  const result = await runGitRunnerCommand(["cat-file", "--batch"], cwd, {
    outputBytesCap: REVIEW_GIT_STREAM_ERROR_MAX_BYTES,
    signal,
    stdin: `${objectSpecs.join("\n")}\n`,
    stdoutStream: {
      maxBytes: stdoutBytesCap,
      onChunk: (chunk) => outputChunks.push(Buffer.from(chunk)),
    },
    timeoutMs: GIT_CAT_FILE_TIMEOUT_MS,
  });
  signal?.throwIfAborted();
  if (result.success || (result.outputLimitExceeded && result.stdoutBytes > stdoutBytesCap)) {
    return Buffer.concat(outputChunks);
  }
  throw new Error(result.stderr.trim() || "Could not read Git objects.");
}

function parseGitCatFileBatch(
  output: Buffer,
  requestCount: number,
): { results: GitCatFileResult[]; processed: number } {
  const results: GitCatFileResult[] = [];
  let offset = 0;

  for (let index = 0; index < requestCount; index += 1) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) break;
    const header = output.subarray(offset, headerEnd).toString("utf8");
    offset = headerEnd + 1;

    if (header.endsWith(" missing")) {
      results.push({ type: "error", error: { type: "not-found" } });
      continue;
    }

    const match = /^\S+\s+\S+\s+(\d+)$/.exec(header);
    const sizeBytes = Number(match?.[1] ?? "NaN");
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      results.push({ type: "error", error: { type: "unknown" } });
      continue;
    }
    if (sizeBytes > REVIEW_CAT_FILE_MAX_BYTES) {
      results.push({
        type: "error",
        error: {
          type: "too-large",
          limitBytes: REVIEW_CAT_FILE_MAX_BYTES,
        },
      });
      if (offset + sizeBytes + 1 <= output.length) {
        offset += sizeBytes + 1;
        continue;
      }
      return { results, processed: index + 1 };
    }
    if (offset + sizeBytes > output.length) {
      results.push({ type: "error", error: { type: "unknown" } });
      return { results, processed: index + 1 };
    }

    const contents = output.subarray(offset, offset + sizeBytes).toString("utf8");
    offset += sizeBytes;
    if (output[offset] === 0x0a) offset += 1;
    results.push({ type: "success", lines: splitGitObjectLines(contents) });
  }

  return { results, processed: results.length };
}

async function readGitCatFileObjectBatch(
  cwd: string,
  objectSpecs: string[],
): Promise<GitCatFileResult[]> {
  if (objectSpecs.length === 0) return [];

  try {
    const output = await runGitCatFileBatch(cwd, objectSpecs);
    const parsed = parseGitCatFileBatch(output, objectSpecs.length);
    if (parsed.processed >= objectSpecs.length) return parsed.results;
    const remaining = await readGitCatFileObjectBatch(cwd, objectSpecs.slice(parsed.processed));
    return [...parsed.results, ...remaining];
  } catch {
    return objectSpecs.map(() => ({
      type: "error" as const,
      error: { type: "unknown" as const },
    }));
  }
}

async function readGitCatFileFallback(
  cwd: string,
  relativePath: string,
): Promise<GitCatFileResult> {
  const normalizedPath = relativePath.trim();
  if (!normalizedPath || normalizedPath === "/dev/null") {
    return { type: "error", error: { type: "not-found" } };
  }
  const absolutePath = path.resolve(cwd, normalizedPath);
  const fileStat = await stat(absolutePath).catch(() => null);
  if (!fileStat?.isFile()) {
    return { type: "error", error: { type: "not-found" } };
  }
  if (fileStat.size > REVIEW_CAT_FILE_MAX_BYTES) {
    return {
      type: "error",
      error: {
        type: "too-large",
        limitBytes: REVIEW_CAT_FILE_MAX_BYTES,
      },
    };
  }
  const contents = await readFile(absolutePath).catch(() => null);
  if (contents === null) {
    return { type: "error", error: { type: "unknown" } };
  }
  if (contents.byteLength > REVIEW_CAT_FILE_MAX_BYTES) {
    return {
      type: "error",
      error: {
        type: "too-large",
        limitBytes: REVIEW_CAT_FILE_MAX_BYTES,
      },
    };
  }
  const text = contents.toString("utf8");
  const safety = classifyReviewTextPayload({
    path: normalizedPath,
    text,
    maxBytes: REVIEW_CAT_FILE_MAX_BYTES,
  });
  if (!safety.renderable) {
    return { type: "error", error: { type: "unknown" } };
  }
  return { type: "success", lines: splitGitObjectLines(text) };
}

export async function readGitReviewCatFile(
  input: GitReviewCatFileInput,
): Promise<GitReviewCatFileOutput> {
  const cwd = await ensureDirectory(input.cwd);
  try {
    await assertGitReviewSnapshotGeneration(cwd, input.snapshotGeneration);
  } catch (error) {
    if (!(error instanceof GitReviewStaleSnapshotError)) throw error;
    return {
      snapshotGeneration: input.snapshotGeneration,
      results: input.requests.map(() => ({
        type: "error",
        error: { type: "unknown" },
      })),
    };
  }

  const results: GitCatFileResult[] = input.requests.map(() => ({
    type: "error",
    error: { type: "not-found" },
  }));
  const objectRequests = input.requests.flatMap((request, index) => {
    const objectSpec = request.oid?.trim() ?? "";
    if (!objectSpec || objectSpec.includes("\n") || objectSpec.includes("\r")) {
      return [];
    }
    return [{ index, objectSpec }];
  });

  for (let offset = 0; offset < objectRequests.length; offset += 4) {
    const batch = objectRequests.slice(offset, offset + 4);
    const batchResults = await readGitCatFileObjectBatch(
      cwd,
      batch.map((request) => request.objectSpec),
    );
    batch.forEach((request, index) => {
      results[request.index] = batchResults[index] ?? { type: "error", error: { type: "unknown" } };
    });
  }

  await Promise.all(
    input.requests.map(async (request, index) => {
      const result = results[index];
      if (
        result?.type !== "error" ||
        result.error.type !== "not-found" ||
        request.fallbackToDisk !== true
      ) {
        return;
      }
      results[index] = await readGitCatFileFallback(cwd, request.path);
    }),
  );
  try {
    await assertGitReviewSnapshotGeneration(cwd, input.snapshotGeneration);
    return { snapshotGeneration: input.snapshotGeneration, results };
  } catch (error) {
    if (!(error instanceof GitReviewStaleSnapshotError)) throw error;
    return {
      snapshotGeneration: input.snapshotGeneration,
      results: input.requests.map(() => ({
        type: "error",
        error: { type: "unknown" },
      })),
    };
  }
}

async function readGitReviewSnapshotWithSignal(
  input: GitReviewSnapshotRequest & GitReviewUntrackedPathsInput,
  signal?: AbortSignal,
): Promise<GitReviewSnapshot> {
  const cwd = await ensureDirectory(input.cwd);
  signal?.throwIfAborted();
  const gitRepository = await isGitRepository(cwd, signal);
  const branchState = gitRepository
    ? await readGitBranchState(cwd, signal)
    : { currentBranch: null, defaultBranch: null, branches: [] };
  const snapshotGeneration = gitRepository ? await readGitReviewSnapshotGeneration(cwd, signal) : 0;

  if (
    gitRepository &&
    input.snapshotGeneration !== undefined &&
    input.snapshotGeneration !== null
  ) {
    await assertGitReviewSnapshotGeneration(cwd, input.snapshotGeneration, signal);
  }

  if (!gitRepository) {
    return {
      cwd,
      source: input.source,
      patch: "",
      files: [],
      isGitRepository: false,
      baseRef: null,
      currentBranch: null,
      defaultBranch: null,
      errorMessage: null,
      snapshotGeneration,
    };
  }

  try {
    const baseRef =
      input.source === "branch" ? await resolveBaseRef(cwd, input.baseRef, signal) : null;
    const files = await readGitReviewFiles(
      {
        ...input,
        cwd,
      },
      baseRef,
      signal,
    );
    await assertGitReviewSnapshotGeneration(cwd, snapshotGeneration, signal);

    return {
      cwd,
      source: input.source,
      patch: "",
      files,
      isGitRepository: true,
      baseRef,
      currentBranch: branchState.currentBranch,
      defaultBranch: branchState.defaultBranch,
      errorMessage: null,
      snapshotGeneration,
    };
  } catch (error) {
    if (error instanceof GitReviewStaleSnapshotError) throw error;
    if (signal?.aborted) throw error;
    if (isNotGitRepositoryError(error)) {
      return {
        cwd,
        source: input.source,
        patch: "",
        files: [],
        isGitRepository: false,
        baseRef: null,
        currentBranch: null,
        defaultBranch: null,
        errorMessage: null,
        snapshotGeneration: 0,
      };
    }

    return {
      cwd,
      source: input.source,
      patch: "",
      files: [],
      isGitRepository: true,
      baseRef: input.baseRef?.trim() || null,
      currentBranch: branchState.currentBranch,
      defaultBranch: branchState.defaultBranch,
      errorMessage: error instanceof Error ? error.message : "Could not load Git review snapshot.",
      snapshotGeneration,
    };
  }
}

export async function readGitReviewSnapshot(
  input: GitReviewSnapshotRequest,
): Promise<GitReviewSnapshot> {
  return runGitReviewRequest(input.requestId, (signal) =>
    readGitReviewSnapshotWithSignal(input, signal),
  );
}

function buildRequestedGitReviewFileSummaries(
  requestedFiles: NonNullable<ReviewDiffRequest["files"]>,
): GitReviewFileSummary[] {
  return requestedFiles.flatMap((file): GitReviewFileSummary[] => {
    const pathName = file.path.trim();
    if (!pathName) return [];
    const previousPath = file.previousPath?.trim() || null;
    return [
      {
        path: pathName,
        previousPath,
        status: file.status,
        rawStatus: null,
        oldOid: null,
        newOid: null,
        revision: file.revision?.trim() || null,
        additions: null,
        deletions: null,
        safety: classifyReviewFileMetadata({ path: pathName }),
      },
    ];
  });
}

function shouldLoadReviewFilePatch(file: GitReviewFileSummary): boolean {
  return (
    file.safety.renderable && countNullableChangedLines(file) <= REVIEW_FILE_CHANGED_LINES_LIMIT
  );
}

function buildDiffPathspecs(files: GitReviewFileSummary[]): string[] {
  return Array.from(
    new Set(
      files.flatMap((file) => (file.previousPath ? [file.previousPath, file.path] : [file.path])),
    ),
  );
}

function isGitOutputLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes("maxbuffer");
}

function buildFailedReviewDiffEntries(
  files: GitReviewFileSummary[],
  input: {
    loadStatus: ReviewDiffEntry["loadStatus"];
    errorMessage: string | null;
  },
): ReviewDiffEntry[] {
  return toReviewDiffEntries("", files).map((entry) => {
    if (!shouldLoadReviewFilePatch(entry)) return entry;

    const tooLarge = input.loadStatus === "diff-too-large";
    return {
      ...entry,
      loadStatus: input.loadStatus,
      diffError: input.errorMessage,
      canApplyPatchActions: false,
      tooLarge,
      tooLargeReason: tooLarge
        ? "File diff is above the review display limit."
        : entry.tooLargeReason,
      renderKey: `${entry.renderKey}:error:${input.loadStatus}`,
    };
  });
}

async function readTrackedReviewPatchForFiles(input: {
  cwd: string;
  diffArgs: string[];
  files: GitReviewFileSummary[];
  signal?: AbortSignal;
}): Promise<string> {
  const pathspecs = buildDiffPathspecs(input.files);
  if (pathspecs.length === 0) return "";

  const result = await runGitCommand(
    ["diff", ...input.diffArgs, "--", ...pathspecs],
    input.cwd,
    [0, 1],
    { signal: input.signal },
  );
  return result.stdout;
}

async function readUntrackedReviewPatchForFiles(input: {
  cwd: string;
  files: GitReviewFileSummary[];
  hideWhitespace?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const patches = await mapWithConcurrency(input.files, REVIEW_UNTRACKED_DIFF_CONCURRENCY, (file) =>
    readUntrackedFilePatch(input.cwd, file.path, input.hideWhitespace, input.signal),
  );
  return patches.filter((patch) => patch.trim().length > 0).join("\n");
}

async function readReviewPatchForFileSummaries(input: {
  cwd: string;
  source: GitReviewSource;
  hideWhitespace?: boolean;
  baseRef: string | null;
  commitSha?: string | null;
  files: GitReviewFileSummary[];
  signal?: AbortSignal;
}): Promise<{
  patch: string;
  errorMessage: string | null;
  outputLimitExceeded: boolean;
}> {
  const loadableFiles = input.files.filter(shouldLoadReviewFilePatch);
  if (loadableFiles.length === 0) {
    return { patch: "", errorMessage: null, outputLimitExceeded: false };
  }

  const untrackedFiles =
    input.source === "unstaged" ? loadableFiles.filter((file) => file.status === "untracked") : [];
  const trackedFiles =
    input.source === "unstaged"
      ? loadableFiles.filter((file) => file.status !== "untracked")
      : loadableFiles;

  try {
    const diffArgs = await buildGitReviewSourceDiffArgs({
      cwd: input.cwd,
      source: input.source,
      hideWhitespace: input.hideWhitespace,
      baseRef: input.baseRef,
      commitSha: input.commitSha,
      signal: input.signal,
    });
    const [trackedPatch, untrackedPatch] = await Promise.all([
      diffArgs && trackedFiles.length > 0
        ? readTrackedReviewPatchForFiles({
            cwd: input.cwd,
            diffArgs,
            files: trackedFiles,
            signal: input.signal,
          })
        : Promise.resolve(""),
      untrackedFiles.length > 0
        ? readUntrackedReviewPatchForFiles({
            cwd: input.cwd,
            files: untrackedFiles,
            hideWhitespace: input.hideWhitespace,
            signal: input.signal,
          })
        : Promise.resolve(""),
    ]);
    return {
      patch: [trackedPatch, untrackedPatch].filter((patch) => patch.trim().length > 0).join("\n"),
      errorMessage: null,
      outputLimitExceeded: false,
    };
  } catch (error) {
    return {
      patch: "",
      errorMessage: error instanceof Error ? error.message : "Could not load review diff.",
      outputLimitExceeded: isGitOutputLimitError(error),
    };
  }
}

function buildFullReviewPatchFailure(input: {
  snapshot: GitReviewSnapshot;
  errorMessage: string | null;
  outputLimitExceeded: boolean;
}): GitReviewPatchResult {
  return {
    cwd: input.snapshot.cwd,
    source: input.snapshot.source,
    diff: {
      type: "error",
      errorMessage: input.errorMessage,
      outputLimitExceeded: input.outputLimitExceeded,
    },
    isGitRepository: input.snapshot.isGitRepository,
    baseRef: input.snapshot.baseRef,
    currentBranch: input.snapshot.currentBranch,
    defaultBranch: input.snapshot.defaultBranch,
    errorMessage: input.snapshot.errorMessage,
  };
}

async function readFullReviewPatch(input: {
  cwd: string;
  source: GitReviewSource;
  baseRef: string | null;
  commitSha?: string | null;
  files: GitReviewFileSummary[];
  signal?: AbortSignal;
}): Promise<{
  patch: string;
  errorMessage: string | null;
  outputLimitExceeded: boolean;
}> {
  const untrackedFiles =
    input.source === "unstaged" ? input.files.filter((file) => file.status === "untracked") : [];
  const trackedFiles =
    input.source === "unstaged"
      ? input.files.filter((file) => file.status !== "untracked")
      : input.files;

  try {
    const diffArgs = await buildGitReviewSourceDiffArgs({
      cwd: input.cwd,
      source: input.source,
      baseRef: input.baseRef,
      commitSha: input.commitSha,
      signal: input.signal,
    });
    const [trackedPatch, untrackedPatch] = await Promise.all([
      diffArgs && trackedFiles.length > 0
        ? runGitCommand(["diff", ...diffArgs], input.cwd, [0, 1], {
            signal: input.signal,
          }).then((result) => result.stdout)
        : Promise.resolve(""),
      untrackedFiles.length > 0
        ? readUntrackedReviewPatchForFiles({
            cwd: input.cwd,
            files: untrackedFiles,
            signal: input.signal,
          })
        : Promise.resolve(""),
    ]);
    const patch = [trackedPatch, untrackedPatch]
      .filter((entry) => entry.trim().length > 0)
      .join("\n");
    if (Buffer.byteLength(patch, "utf8") > REVIEW_GIT_DIFF_MAX_BYTES) {
      return {
        patch: "",
        errorMessage: "Review patch is above the output limit.",
        outputLimitExceeded: true,
      };
    }
    return {
      patch,
      errorMessage: null,
      outputLimitExceeded: false,
    };
  } catch (error) {
    return {
      patch: "",
      errorMessage: error instanceof Error ? error.message : "Could not load review patch.",
      outputLimitExceeded: isGitOutputLimitError(error),
    };
  }
}

export async function readGitReviewPatch(
  input: GitReviewPatchRequest,
): Promise<GitReviewPatchResult> {
  return runGitReviewRequest(input.requestId, async (signal) => {
    const baseRef = input.baseBranch?.trim() || input.baseRef?.trim() || null;
    const snapshot = await readGitReviewSnapshotWithSignal(
      {
        cwd: input.cwd,
        source: input.source,
        baseRef,
        commitSha: input.commitSha,
      },
      signal,
    );

    if (!snapshot.isGitRepository || snapshot.errorMessage) {
      return buildFullReviewPatchFailure({
        snapshot,
        errorMessage: snapshot.errorMessage,
        outputLimitExceeded: false,
      });
    }

    const patchResult = await readFullReviewPatch({
      cwd: snapshot.cwd,
      source: snapshot.source,
      baseRef: snapshot.baseRef,
      commitSha: input.commitSha,
      files: snapshot.files,
      signal,
    });
    if (patchResult.errorMessage || patchResult.outputLimitExceeded) {
      return buildFullReviewPatchFailure({
        snapshot,
        errorMessage: patchResult.errorMessage,
        outputLimitExceeded: patchResult.outputLimitExceeded,
      });
    }

    return {
      cwd: snapshot.cwd,
      source: snapshot.source,
      diff: {
        type: "success",
        unifiedDiff: patchResult.patch,
        unifiedDiffBytes: Buffer.byteLength(patchResult.patch, "utf8"),
      },
      isGitRepository: snapshot.isGitRepository,
      baseRef: snapshot.baseRef,
      currentBranch: snapshot.currentBranch,
      defaultBranch: snapshot.defaultBranch,
      errorMessage: snapshot.errorMessage,
    };
  });
}

export async function readGitReviewDiff(input: ReviewDiffRequest): Promise<ReviewDiffResult> {
  try {
    return await runGitReviewRequest(input.requestId, async (signal) => {
      const cwd = await ensureDirectory(input.cwd);
      const snapshotGeneration = input.snapshotGeneration;
      if (snapshotGeneration === undefined || snapshotGeneration === null) {
        throw new Error("Git review snapshot generation is required.");
      }
      if (!(await isGitRepository(cwd))) {
        return {
          type: "success",
          cwd,
          source: input.source,
          patch: "",
          files: [],
          isGitRepository: false,
          baseRef: null,
          currentBranch: null,
          defaultBranch: null,
          errorMessage: null,
          snapshotGeneration,
        };
      }

      await assertGitReviewSnapshotGeneration(cwd, snapshotGeneration, signal);
      const requestedFiles = buildRequestedGitReviewFileSummaries(input.files ?? []);
      const baseRef = input.baseBranch?.trim() || input.baseRef?.trim() || null;
      const patchResult = await readReviewPatchForFileSummaries({
        cwd,
        source: input.source,
        hideWhitespace: input.hideWhitespace,
        baseRef,
        commitSha: input.commitSha,
        files: requestedFiles,
        signal,
      });
      const filteredEntries = patchResult.errorMessage
        ? buildFailedReviewDiffEntries(requestedFiles, {
            loadStatus: patchResult.outputLimitExceeded ? "diff-too-large" : "load-failed",
            errorMessage: patchResult.errorMessage,
          })
        : toReviewDiffEntries(patchResult.patch, requestedFiles);
      const filteredPatch = filteredEntries
        .map((entry) => entry.diff)
        .filter((diff) => diff.trim().length > 0)
        .join("\n");
      await assertGitReviewSnapshotGeneration(cwd, snapshotGeneration, signal);

      return {
        type: "success",
        cwd,
        source: input.source,
        patch: filteredPatch,
        files: filteredEntries,
        isGitRepository: true,
        baseRef,
        currentBranch: null,
        defaultBranch: null,
        errorMessage: null,
        snapshotGeneration,
      };
    });
  } catch (error) {
    if (!(error instanceof GitReviewStaleSnapshotError)) throw error;
    return { type: "stale-snapshot", source: input.source };
  }
}

async function readGitReviewStageCounts(
  cwd: string,
  signal?: AbortSignal,
): Promise<{
  stagedFileCount: number;
  unstagedFileCount: number;
  untrackedFileCount: number;
}> {
  const result = await runGitCommand(
    ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    cwd,
    [0],
    { signal },
  );
  const records = result.stdout.split("\0").filter(Boolean);
  let stagedFileCount = 0;
  let unstagedFileCount = 0;
  const untrackedFileCount = 0;

  for (let index = 0; index < records.length; index += 1) {
    const statusCode = (records[index] ?? "").slice(0, 2);
    if (statusCode[0] && statusCode[0] !== " ") stagedFileCount += 1;
    if (statusCode[1] && statusCode[1] !== " ") unstagedFileCount += 1;
    if (statusCode.includes("R") || statusCode.includes("C")) index += 1;
  }

  return { stagedFileCount, unstagedFileCount, untrackedFileCount };
}

export async function readGitReviewSummary(
  input: GitReviewSummaryRequest & GitReviewUntrackedPathsInput,
): Promise<GitReviewSummaryResult> {
  return runGitReviewRequest(input.requestId, async (signal) => {
    try {
      const baseRef = input.baseBranch?.trim() || input.baseRef?.trim() || null;
      const snapshot = await readGitReviewSnapshotWithSignal(
        {
          cwd: input.cwd,
          source: input.source,
          baseRef,
          commitSha: input.commitSha,
          hideWhitespace: input.hideWhitespace,
          includeUntrackedFiles: input.includeUntrackedFiles,
          precomputedUntrackedPaths: input.precomputedUntrackedPaths,
        },
        signal,
      );
      if (snapshot.errorMessage) {
        return {
          type: "error",
          source: input.source,
          errorMessage: snapshot.errorMessage,
        };
      }
      if (snapshot.isGitRepository && input.precomputedStageCounts === null) {
        throw new Error("Could not read Git stage counts.");
      }
      const stageCounts = snapshot.isGitRepository
        ? (input.precomputedStageCounts ?? {
            ...(await readGitReviewStageCounts(snapshot.cwd, signal)),
            untrackedFileCount:
              snapshot.files.filter((file) => file.status === "untracked").length +
              (input.untrackedFilesOmitted ?? 0),
          })
        : {
            stagedFileCount: 0,
            unstagedFileCount: 0,
            untrackedFileCount: 0,
          };
      if (snapshot.isGitRepository) {
        await assertGitReviewSnapshotGeneration(snapshot.cwd, snapshot.snapshotGeneration, signal);
      }

      return {
        type: "success",
        source: snapshot.source,
        files: snapshot.files,
        snapshotGeneration: snapshot.snapshotGeneration,
        stageCounts,
        untrackedFilesOmitted: input.untrackedFilesOmitted ?? 0,
      };
    } catch (error) {
      if (error instanceof GitReviewStaleSnapshotError) throw error;
      if (signal?.aborted) throw error;
      return {
        type: "error",
        source: input.source,
        errorMessage:
          error instanceof Error ? error.message : "Could not load the Git review summary.",
      };
    }
  });
}

export async function readGitReviewRepositoryMetadata(
  input: GitReviewRepositoryMetadataRequest,
): Promise<GitReviewRepositoryMetadataResult> {
  return runGitReviewRequest(input.requestId, async (signal) => {
    try {
      const cwd = await ensureDirectory(input.cwd);
      signal?.throwIfAborted();
      const repository = await resolveGitReviewRepositoryPaths(cwd);
      signal?.throwIfAborted();
      if (!repository) {
        return {
          cwd,
          root: null,
          gitDir: null,
          commonDir: null,
          isGitRepository: false,
          currentBranch: null,
          defaultBranch: null,
          errorMessage: null,
        };
      }

      const branchState = await readGitBranchState(repository.root, signal);
      return {
        cwd,
        root: repository.root,
        gitDir: repository.gitDir,
        commonDir: repository.commonDir,
        isGitRepository: true,
        currentBranch: branchState.currentBranch,
        defaultBranch: branchState.defaultBranch,
        errorMessage: null,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        cwd: input.cwd,
        root: null,
        gitDir: null,
        commonDir: null,
        isGitRepository: false,
        currentBranch: null,
        defaultBranch: null,
        errorMessage:
          error instanceof Error ? error.message : "Could not read Git repository metadata.",
      };
    }
  });
}

async function readGitReviewBaseBranchWithSignal(
  input: GitReviewBaseBranchRequest,
  signal?: AbortSignal,
): Promise<GitReviewBaseBranchResult> {
  try {
    const cwd = await ensureDirectory(input.cwd);
    signal?.throwIfAborted();
    if (!(await isGitRepository(cwd, signal))) {
      return { cwd, local: null, remote: null, errorMessage: null };
    }

    const [branchState, remoteResult] = await Promise.all([
      readGitBranchState(cwd, signal),
      runGitCommand(
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        cwd,
        [0, 1, 128],
        { signal },
      ).catch((error) => {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        return null;
      }),
    ]);
    signal?.throwIfAborted();
    const remote = remoteResult?.stdout.trim() || null;
    const remoteLocal = remote?.includes("/") ? remote.slice(remote.indexOf("/") + 1) : null;
    const local =
      remoteLocal ??
      branchState.defaultBranch ??
      (branchState.branches.includes("main") ? "main" : null) ??
      (branchState.branches.includes("master") ? "master" : null) ??
      branchState.currentBranch;
    return { cwd, local, remote, errorMessage: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      cwd: input.cwd,
      local: null,
      remote: null,
      errorMessage: error instanceof Error ? error.message : "Could not resolve the base branch.",
    };
  }
}

export async function readGitReviewBaseBranch(
  input: GitReviewBaseBranchRequest,
): Promise<GitReviewBaseBranchResult> {
  return runGitReviewRequest(input.requestId, (signal) =>
    readGitReviewBaseBranchWithSignal(input, signal),
  );
}

export async function readBranchDiffStats(
  input: BranchDiffStatsRequest & GitReviewUntrackedPathsInput,
): Promise<BranchDiffStatsResult> {
  return runGitReviewRequest(input.requestId, async (signal) => {
    const baseRef = input.baseBranch?.trim() || input.baseRef?.trim() || null;
    const snapshot = await readGitReviewSnapshotWithSignal(
      {
        cwd: input.cwd,
        source: "branch",
        baseRef,
        hideWhitespace: input.hideWhitespace,
        includeUntrackedFiles: input.includeUntrackedFiles,
        precomputedUntrackedPaths: input.precomputedUntrackedPaths,
      },
      signal,
    );
    const additions = snapshot.files.reduce((total, file) => total + (file.additions ?? 0), 0);
    const deletions = snapshot.files.reduce((total, file) => total + (file.deletions ?? 0), 0);

    return {
      cwd: snapshot.cwd,
      baseRef: snapshot.baseRef,
      files: snapshot.files,
      fileCount: snapshot.files.length + (input.untrackedFilesOmitted ?? 0),
      additions,
      deletions,
      untrackedFilesOmitted: input.untrackedFilesOmitted ?? 0,
      isGitRepository: snapshot.isGitRepository,
      currentBranch: snapshot.currentBranch,
      defaultBranch: snapshot.defaultBranch,
      errorMessage: snapshot.errorMessage,
    };
  });
}

export async function readGitReviewBranchCommits(
  input: GitReviewBranchCommitsRequest,
): Promise<GitReviewBranchCommitsResult> {
  return runGitReviewRequest(input.requestId, async (signal) => {
    const cwd = await ensureDirectory(input.cwd);
    signal?.throwIfAborted();
    const gitRepository = await isGitRepository(cwd, signal);
    if (!gitRepository) {
      return {
        cwd,
        baseBranch: null,
        commits: [],
        errorMessage: "Git review is unavailable outside a Git repository.",
      };
    }

    const { baseBranch, baseSha } = await resolveBranchComparisonBase(
      cwd,
      input.baseBranch,
      signal,
    );
    if (!baseSha) {
      return {
        cwd,
        baseBranch,
        commits: [],
        errorMessage: baseBranch
          ? `Could not resolve a merge base for ${baseBranch}.`
          : "Could not resolve a base branch.",
      };
    }

    try {
      const result = await runGitCommand(
        ["log", "--format=%H%x00%cI%x00%s", `${baseSha}..HEAD`],
        cwd,
        [0],
        { signal },
      );
      return {
        cwd,
        baseBranch,
        commits: parseBranchCommitLog(result.stdout),
        errorMessage: null,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        cwd,
        baseBranch,
        commits: [],
        errorMessage: error instanceof Error ? error.message : "Could not load branch commits.",
      };
    }
  });
}

export async function resolveGitMergeBase(input: GitMergeBaseRequest): Promise<GitMergeBaseResult> {
  const cwd = await ensureDirectory(input.gitRoot?.trim() || input.cwd);
  const baseBranch = input.baseBranch.trim();
  if (!baseBranch) {
    return {
      cwd,
      baseBranch,
      mergeBaseSha: null,
      errorMessage: "Base branch is required.",
    };
  }

  const gitRepository = await isGitRepository(cwd);
  if (!gitRepository) {
    return {
      cwd,
      baseBranch,
      mergeBaseSha: null,
      errorMessage: "Git review is unavailable outside a Git repository.",
    };
  }

  try {
    const result = await runGitCommand(["merge-base", "HEAD", baseBranch], cwd);
    return {
      cwd,
      baseBranch,
      mergeBaseSha: result.stdout.trim() || null,
      errorMessage: null,
    };
  } catch (error) {
    return {
      cwd,
      baseBranch,
      mergeBaseSha: null,
      errorMessage: error instanceof Error ? error.message : "Could not resolve merge base.",
    };
  }
}

const GIT_REVIEW_SEARCH_MATCH_LIMIT = 250;
const GIT_REVIEW_SEARCH_SNIPPET_CONTEXT = 24;
const GIT_REVIEW_SEARCH_HUNK_HEADER =
  /^@@ -(?<deletionStart>\d+)(?:,(?<deletionCount>\d+))? \+(?<additionStart>\d+)(?:,(?<additionCount>\d+))? @@/;

interface GitReviewSearchAccumulator {
  query: string;
  normalizedQuery: string;
  matches: GitReviewSearchMatch[];
  totalMatches: number;
  isCapped: boolean;
}

interface GitReviewPatchSearchState {
  currentPath: string | null;
  currentHunkId: `${number}` | null;
  hunkIndex: number;
  hunkLineStart: number;
  hunkLineEnd: number;
  hunkOffset: number;
}

interface GitDiffHeaderPaths {
  oldPath: string;
  newPath: string;
}

function decodeQuotedGitPath(
  value: string,
  startIndex: number,
): { path: string; nextIndex: number } | null {
  if (value[startIndex] !== '"') return null;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let index = startIndex + 1;

  while (index < value.length) {
    const character = value[index];
    if (character === undefined) return null;
    if (character === '"') {
      return {
        path: decoder.decode(Uint8Array.from(bytes)),
        nextIndex: index + 1,
      };
    }
    if (character !== "\\") {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) return null;
      const segment = String.fromCodePoint(codePoint);
      bytes.push(...encoder.encode(segment));
      index += segment.length;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) return null;
    const simpleEscapes: Readonly<Record<string, string>> = {
      "\\": "\\",
      '"': '"',
      a: "\u0007",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    };
    const decoded = simpleEscapes[escaped];
    if (decoded !== undefined) {
      bytes.push(...encoder.encode(decoded));
      index += 2;
      continue;
    }

    const octal = value.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 4;
      continue;
    }

    bytes.push(...encoder.encode(escaped));
    index += 2;
  }

  return null;
}

function normalizeGitDiffHeaderPaths(oldPath: string, newPath: string): GitDiffHeaderPaths | null {
  if (!oldPath.startsWith("a/") || !newPath.startsWith("b/")) return null;
  return {
    oldPath: oldPath.slice(2),
    newPath: newPath.slice(2),
  };
}

function parseGitDiffHeaderPaths(line: string): GitDiffHeaderPaths | null {
  if (!line.startsWith("diff --git ")) return null;
  const header = line.slice("diff --git ".length);
  if (header.startsWith('"')) {
    const oldPath = decodeQuotedGitPath(header, 0);
    if (!oldPath || header[oldPath.nextIndex] !== " ") return null;
    const newPath = decodeQuotedGitPath(header, oldPath.nextIndex + 1);
    if (!newPath || newPath.nextIndex !== header.length) return null;
    return normalizeGitDiffHeaderPaths(oldPath.path, newPath.path);
  }

  const separatorIndex = header.lastIndexOf(" b/");
  if (separatorIndex < 0) return null;
  return normalizeGitDiffHeaderPaths(
    header.slice(0, separatorIndex),
    header.slice(separatorIndex + 1),
  );
}

function buildGitReviewSearchSnippet(
  value: string,
  start: number,
  end: number,
): GitReviewSearchMatch["snippet"] {
  const snippetStart = Math.max(0, start - GIT_REVIEW_SEARCH_SNIPPET_CONTEXT);
  const snippetEnd = Math.min(value.length, end + GIT_REVIEW_SEARCH_SNIPPET_CONTEXT);
  return {
    before: value.slice(snippetStart, start),
    match: value.slice(start, end),
    after: value.slice(end, snippetEnd),
  };
}

function addGitReviewSearchMatches(
  accumulator: GitReviewSearchAccumulator,
  input: {
    path: string;
    hunkId: GitReviewSearchMatch["hunkId"];
    lineStart: number;
    lineEnd: number;
    text: string;
    offset?: number;
  },
): void {
  const normalizedText = input.text.toLowerCase();
  let cursor = 0;
  while (cursor < normalizedText.length) {
    const start = normalizedText.indexOf(accumulator.normalizedQuery, cursor);
    if (start < 0) return;
    const end = start + accumulator.query.length;
    accumulator.totalMatches += 1;
    if (accumulator.matches.length < GIT_REVIEW_SEARCH_MATCH_LIMIT) {
      const offset = input.offset ?? 0;
      accumulator.matches.push({
        path: input.path,
        hunkId: input.hunkId,
        lineStart: input.lineStart,
        lineEnd: input.lineEnd,
        start: offset + start,
        end: offset + end,
        snippet: buildGitReviewSearchSnippet(input.text, start, end),
      });
    } else {
      accumulator.isCapped = true;
    }
    cursor = end;
  }
}

function createGitReviewPatchSearchState(): GitReviewPatchSearchState {
  return {
    currentPath: null,
    currentHunkId: null,
    hunkIndex: 0,
    hunkLineStart: 1,
    hunkLineEnd: 1,
    hunkOffset: 0,
  };
}

function scanGitReviewPatchLines(input: {
  lines: readonly string[];
  generatedPaths: ReadonlySet<string>;
  accumulator: GitReviewSearchAccumulator;
  state: GitReviewPatchSearchState;
  includePathMatches?: boolean;
}): void {
  for (const line of input.lines) {
    if (line.startsWith("diff --git ")) {
      input.state.hunkOffset = 0;
      input.state.currentHunkId = null;
      input.state.hunkIndex = 0;
      const paths = parseGitDiffHeaderPaths(line);
      const currentPath = paths?.newPath ?? null;
      input.state.currentPath = currentPath;
      if (!paths || !currentPath || input.generatedPaths.has(currentPath)) {
        continue;
      }
      if (input.includePathMatches !== false) {
        addGitReviewSearchMatches(input.accumulator, {
          path: currentPath,
          hunkId: "path",
          lineStart: 1,
          lineEnd: 1,
          text:
            paths.oldPath === paths.newPath
              ? paths.newPath
              : `${paths.oldPath} -> ${paths.newPath}`,
        });
      }
      continue;
    }
    const currentPath = input.state.currentPath;
    if (!currentPath || input.generatedPaths.has(currentPath)) continue;

    const hunkHeader = GIT_REVIEW_SEARCH_HUNK_HEADER.exec(line);
    if (hunkHeader?.groups) {
      input.state.hunkOffset = 0;
      input.state.currentHunkId = String(input.state.hunkIndex) as `${number}`;
      input.state.hunkIndex += 1;
      const additionStart = Number(hunkHeader.groups.additionStart);
      const deletionStart = Number(hunkHeader.groups.deletionStart);
      const additionCount = Number(hunkHeader.groups.additionCount ?? "1");
      const deletionCount = Number(hunkHeader.groups.deletionCount ?? "1");
      const lineStart = Math.max(1, Math.min(additionStart, deletionStart));
      const additionEnd = additionStart + Math.max(additionCount, 0) - 1;
      const deletionEnd = deletionStart + Math.max(deletionCount, 0) - 1;
      input.state.hunkLineStart = lineStart;
      input.state.hunkLineEnd = Math.max(lineStart, additionEnd, deletionEnd);
      continue;
    }
    if (input.state.currentHunkId === null || line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    const prefix = line.charAt(0);
    if (prefix !== "+" && prefix !== "-" && prefix !== " ") continue;
    const text = line.slice(1);
    addGitReviewSearchMatches(input.accumulator, {
      path: currentPath,
      hunkId: input.state.currentHunkId,
      lineStart: input.state.hunkLineStart,
      lineEnd: input.state.hunkLineEnd,
      text,
      offset: input.state.hunkOffset,
    });
    input.state.hunkOffset += text.length + 1;
  }
}

async function streamTrackedGitReviewSearch(input: {
  cwd: string;
  diffArgs: string[];
  generatedPaths: ReadonlySet<string>;
  accumulator: GitReviewSearchAccumulator;
  signal?: AbortSignal;
}): Promise<void> {
  const state = createGitReviewPatchSearchState();
  const decoder = new TextDecoder();
  let pending = "";
  const scanPendingLines = () => {
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    if (pending.length > REVIEW_GIT_DIFF_MAX_BYTES) {
      throw new Error("Git review diff contains a line above the safe search limit.");
    }
    scanGitReviewPatchLines({
      lines: lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)),
      generatedPaths: input.generatedPaths,
      accumulator: input.accumulator,
      state,
    });
  };
  const result = await runGitRunnerCommand(["diff", ...input.diffArgs, "--unified=3"], input.cwd, {
    outputBytesCap: REVIEW_GIT_STREAM_ERROR_MAX_BYTES,
    signal: input.signal,
    stdoutStream: {
      // The stream is not retained; the process deadline and bounded pending line own resource use.
      maxBytes: null,
      onChunk: (chunk) => {
        pending += decoder.decode(chunk, { stream: true });
        scanPendingLines();
      },
    },
    timeoutMs: 30_000,
  });
  input.signal?.throwIfAborted();
  if (!result.success) {
    throw new Error(result.stderr.trim() || "Could not search the Git review diff.");
  }
  pending += decoder.decode();
  scanPendingLines();
  if (pending) {
    scanGitReviewPatchLines({
      lines: [pending.endsWith("\r") ? pending.slice(0, -1) : pending],
      generatedPaths: input.generatedPaths,
      accumulator: input.accumulator,
      state,
    });
  }
}

export async function searchGitReview(input: GitReviewSearchInput): Promise<GitReviewSearchResult> {
  const query = input.query.trim();
  if (!query) {
    return {
      type: "success",
      source: input.source,
      query,
      matches: [],
      totalMatches: 0,
      isCapped: false,
    };
  }

  try {
    return await runGitReviewRequest(input.requestId, async (signal) => {
      const cwd = await ensureDirectory(input.cwd);
      if (!(await isGitRepository(cwd))) {
        return {
          type: "error" as const,
          source: input.source,
          query,
        };
      }
      const snapshotGeneration = await readGitReviewSnapshotGeneration(cwd, signal);

      const baseRef =
        input.source === "branch" ? await resolveBaseRef(cwd, input.baseBranch ?? null) : null;
      const diffArgs = await buildGitReviewSourceDiffArgs({
        cwd,
        source: input.source,
        baseRef,
        commitSha: input.commitSha,
        signal,
      });
      const trackedPaths = diffArgs
        ? (
            await runGitCommand(["diff", ...diffArgs, "--name-only", "-z"], cwd, [0, 1], { signal })
          ).stdout
            .split("\0")
            .filter(Boolean)
        : [];
      const untrackedPaths =
        input.source === "unstaged"
          ? (
              await runGitCommand(["ls-files", "--others", "--exclude-standard", "-z"], cwd, [0], {
                signal,
              })
            ).stdout
              .split("\0")
              .filter(Boolean)
          : [];
      const paths = Array.from(new Set([...trackedPaths, ...untrackedPaths]));
      const generatedPaths = await readGeneratedReviewPaths(cwd, paths, signal);
      if (generatedPaths === null) {
        throw new Error("Could not resolve generated-file attributes.");
      }

      const accumulator: GitReviewSearchAccumulator = {
        query,
        normalizedQuery: query.toLowerCase(),
        matches: [],
        totalMatches: 0,
        isCapped: false,
      };

      if (diffArgs && trackedPaths.length > 0) {
        await streamTrackedGitReviewSearch({
          cwd,
          diffArgs,
          generatedPaths,
          accumulator,
          signal,
        });
      }
      for (const filePath of untrackedPaths) {
        signal?.throwIfAborted();
        if (generatedPaths.has(filePath)) continue;
        addGitReviewSearchMatches(accumulator, {
          path: filePath,
          hunkId: "path",
          lineStart: 1,
          lineEnd: 1,
          text: filePath,
        });
        const patch = await readUntrackedFilePatch(cwd, filePath, false, signal);
        signal?.throwIfAborted();
        if (!patch) continue;
        scanGitReviewPatchLines({
          lines: patch.split(/\r?\n/),
          generatedPaths,
          accumulator,
          state: createGitReviewPatchSearchState(),
          includePathMatches: false,
        });
      }
      const committedGeneration = await readGitReviewSnapshotGeneration(cwd, signal);
      if (committedGeneration !== snapshotGeneration) {
        throw new GitReviewStaleSnapshotError(snapshotGeneration, committedGeneration);
      }

      return {
        type: "success" as const,
        source: input.source,
        query,
        matches: accumulator.matches,
        totalMatches: accumulator.totalMatches,
        isCapped: accumulator.isCapped,
      };
    });
  } catch {
    return {
      type: "error",
      source: input.source,
      query,
    };
  }
}

function parseBlamePorcelain(stdout: string): GitReviewBlameResult["lines"] {
  const lines: GitReviewBlameResult["lines"] = [];
  const chunks = stdout.split("\n");
  let current: {
    commitSha: string;
    line: number;
    author: string | null;
    authorTime: number | null;
    summary: string | null;
  } | null = null;

  for (const chunk of chunks) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(chunk);
    if (header) {
      if (current) lines.push(current);
      current = {
        commitSha: header[1] ?? "",
        line: Number(header[2] ?? "0"),
        author: null,
        authorTime: null,
        summary: null,
      };
      continue;
    }
    if (!current) continue;
    if (chunk.startsWith("author ")) {
      current.author = chunk.slice("author ".length) || null;
      continue;
    }
    if (chunk.startsWith("author-time ")) {
      const authorTime = Number(chunk.slice("author-time ".length));
      current.authorTime = Number.isFinite(authorTime) ? authorTime : null;
      continue;
    }
    if (chunk.startsWith("summary ")) {
      current.summary = chunk.slice("summary ".length) || null;
      continue;
    }
  }
  if (current) lines.push(current);
  return lines.filter((line) => line.line > 0 && line.commitSha.length > 0);
}

export async function readGitReviewBlameFile(
  input: GitReviewBlameInput,
): Promise<GitReviewBlameResult> {
  const cwd = await ensureDirectory(input.cwd);
  const normalizedPath = input.path.trim();
  const ref = input.ref?.trim() || null;

  if (!normalizedPath) {
    return {
      cwd,
      path: normalizedPath,
      ref,
      lines: [],
      errorMessage: "File path is required.",
    };
  }

  try {
    const args = ["blame", "--line-porcelain", ...(ref ? [ref] : []), "--", normalizedPath];
    const result = await runGitCommand(args, cwd);
    return {
      cwd,
      path: normalizedPath,
      ref,
      lines: parseBlamePorcelain(result.stdout),
      errorMessage: null,
    };
  } catch (error) {
    return {
      cwd,
      path: normalizedPath,
      ref,
      lines: [],
      errorMessage: error instanceof Error ? error.message : "Could not load Git blame.",
    };
  }
}

export async function initializeGitRepositoryAndReadReviewSnapshot(
  cwd: string,
): Promise<GitReviewSnapshot> {
  const normalizedCwd = await ensureDirectory(cwd);
  const alreadyRepository = await isGitRepository(normalizedCwd);
  if (!alreadyRepository) {
    await runGitCommand(["init", "-b", "main"], normalizedCwd).catch(async () => {
      await runGitCommand(["init"], normalizedCwd);
      const branchState = await readGitBranchState(normalizedCwd);
      if (!branchState.currentBranch) {
        await runGitCommand(["checkout", "-b", "main"], normalizedCwd).catch(() => undefined);
      }
    });
    invalidateGitReviewSnapshot(normalizedCwd);
  }

  return readGitReviewSnapshot({
    cwd: normalizedCwd,
    source: "unstaged",
  });
}

export async function applyGitReviewPatch(input: GitApplyPatchInput): Promise<GitApplyPatchResult> {
  const cwd = await ensureDirectory(input.cwd);
  const diff = input.diff.trim();
  if (!diff) {
    return {
      status: "error",
      appliedPaths: [],
      skippedPaths: [],
      conflictedPaths: [],
      errorCode: "missingDiff",
      errorMessage: "Patch diff is required.",
    };
  }

  const args = [
    "apply",
    "--binary",
    "--3way",
    "--recount",
    "--whitespace=nowarn",
    ...(input.target === "staged" ? ["--cached"] : []),
    ...(input.revert ? ["-R"] : []),
  ];
  const patchFilePath = path.join(
    tmpdir(),
    `nodex-git-apply-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`,
  );
  const patchText = input.diff.endsWith("\n") ? input.diff : `${input.diff}\n`;

  try {
    await writeFile(patchFilePath, patchText, "utf8");
    await runGitCommand([...args, patchFilePath], cwd);
    invalidateGitReviewSnapshot(cwd);
    return {
      status: "success",
      appliedPaths: toPatchPaths(input.diff),
      skippedPaths: [],
      conflictedPaths: [],
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    return {
      status: "error",
      appliedPaths: [],
      skippedPaths: [],
      conflictedPaths: [],
      errorCode: resolvePatchErrorCode(error),
      errorMessage: error instanceof Error ? error.message : "Could not apply patch.",
    };
  } finally {
    await rm(patchFilePath, { force: true }).catch(() => undefined);
  }
}

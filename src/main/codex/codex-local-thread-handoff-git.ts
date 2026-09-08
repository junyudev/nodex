import type { CodexThreadHandoffBranches } from "../../shared/codex-thread-handoff";
import { buildWorktreeThreadSlug } from "../../shared/worktree-auto-branch";
import { createManagedWorktree, removeManagedWorktree } from "./git-worktree-service";
import { runCodexGitCommand, throwIfCodexRequestAborted } from "./codex-git-command";
import type {
  CodexWorktreeHandoffStep,
  CodexWorktreeHandoffStepStatus,
  CodexWorktreeWorkerCleanupHandoffResult,
  CodexWorktreeWorkerPrepareHandoffInput,
  CodexWorktreeWorkerPreparedHandoff,
  CodexWorktreeWorkerRollbackHandoffInput,
  CodexWorktreeWorkerRollbackHandoffResult,
} from "./codex-worktree-worker-protocol";

interface HandoffGitOptions {
  readonly signal: AbortSignal;
  readonly onPathAllocated?: (paths: {
    readonly worktreeGitRoot: string;
    readonly worktreeWorkspaceRoot: string;
  }) => void;
  readonly onProgress: (
    step: CodexWorktreeHandoffStep,
    status: CodexWorktreeHandoffStepStatus,
    branchContext?: CodexThreadHandoffBranches,
  ) => void;
}

const withHandoffBranches = (
  options: HandoffGitOptions,
  branchContext: CodexThreadHandoffBranches,
): HandoffGitOptions => ({
  ...options,
  onProgress: (step, status) => options.onProgress(step, status, branchContext),
});

interface StashCheckoutResult {
  readonly previousBranch: string | null;
  readonly stashRef: string | null;
}

interface MoveToWorktreeInput {
  readonly createdWorktree: boolean;
  readonly localCheckoutBranch: string;
  readonly localCwd: string;
  readonly sourceBranch: string;
  readonly stashTargetWorktree: boolean;
  readonly worktreeCheckoutBranch: string;
  readonly worktreeGitRoot: string;
  readonly worktreeWorkspaceRoot: string;
}

interface MoveToCheckoutInput {
  readonly localGitRoot: string;
  readonly sourceBranch: string;
  readonly sourceWorktreeCwd: string;
  readonly sourceWorktreeRoot: string;
}

const STASH_MESSAGE_PREFIX = "Nodex thread handoff";
const MAX_BRANCH_ATTEMPTS = 100;

async function readOptionalRef(
  cwd: string,
  ref: string,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await runCodexGitCommand(["rev-parse", "--verify", "--quiet", ref], cwd, {
    allowedExitCodes: [0, 1, 128],
    signal,
  });
  return result.stdout.trim() || null;
}

async function readHead(cwd: string, signal: AbortSignal): Promise<string> {
  return (
    await runCodexGitCommand(["rev-parse", "--verify", "HEAD^{commit}"], cwd, { signal })
  ).stdout.trim();
}

async function readCurrentBranch(cwd: string, signal: AbortSignal): Promise<string | null> {
  const result = await runCodexGitCommand(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd, {
    allowedExitCodes: [0, 1, 128],
    signal,
  });
  return result.stdout.trim() || null;
}

async function branchExists(cwd: string, branch: string, signal: AbortSignal): Promise<boolean> {
  const result = await runCodexGitCommand(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    cwd,
    { allowedExitCodes: [0, 1, 128], signal },
  );
  return (
    result.stdout.length > 0 ||
    (await readOptionalRef(cwd, `refs/heads/${branch}`, signal)) !== null
  );
}

async function resolveDefaultBranch(
  cwd: string,
  currentBranch: string,
  signal: AbortSignal,
): Promise<string | null> {
  const remoteHead = await runCodexGitCommand(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    cwd,
    { allowedExitCodes: [0, 1, 128], signal },
  );
  const remoteDefault = remoteHead.stdout.trim().split("/").at(-1) ?? "";
  if (remoteDefault && (await branchExists(cwd, remoteDefault, signal))) {
    return remoteDefault;
  }
  for (const candidate of ["main", "master"]) {
    if (await branchExists(cwd, candidate, signal)) return candidate;
  }
  return currentBranch;
}

async function allocateHandoffBranch(
  cwd: string,
  title: string,
  signal: AbortSignal,
): Promise<string> {
  const base = `codex/${buildWorktreeThreadSlug(title)}`;
  for (let attempt = 1; attempt <= MAX_BRANCH_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    await runCodexGitCommand(["check-ref-format", "--branch", candidate], cwd, {
      signal,
    });
    if (!(await branchExists(cwd, candidate, signal))) return candidate;
  }
  throw new Error("Could not allocate a branch for thread handoff");
}

async function resolveStashSelector(
  cwd: string,
  stashRef: string,
  signal: AbortSignal,
): Promise<string> {
  const list = await runCodexGitCommand(["stash", "list", "--format=%H %gd"], cwd, { signal });
  for (const line of list.stdout.split(/\r?\n/u)) {
    const [sha, selector] = line.trim().split(/\s+/u, 2);
    if (sha === stashRef && selector) return selector;
  }
  return stashRef;
}

async function applyStash(
  cwd: string,
  stashRef: string,
  mode: "apply" | "drop" | "pop",
  signal: AbortSignal,
): Promise<void> {
  const selector = await resolveStashSelector(cwd, stashRef, signal);
  await runCodexGitCommand(["stash", mode, selector], cwd, { signal });
}

async function stashWorkingTree(
  cwd: string,
  operationId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const before = await readOptionalRef(cwd, "refs/stash", signal);
  await runCodexGitCommand(
    ["stash", "push", "--include-untracked", "-m", `${STASH_MESSAGE_PREFIX} ${operationId}`],
    cwd,
    { signal },
  );
  const after = await readOptionalRef(cwd, "refs/stash", signal);
  return after !== null && after !== before ? after : null;
}

async function checkoutBranchOrCommit(
  cwd: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  if (await branchExists(cwd, target, signal)) {
    await runCodexGitCommand(["checkout", target], cwd, { signal });
    return;
  }
  const commit = await readOptionalRef(cwd, `${target}^{commit}`, signal);
  if (!commit) throw new Error(`Branch or ref '${target}' was not found`);
  await runCodexGitCommand(["checkout", "--detach", commit], cwd, { signal });
}

async function stashAndCheckout(
  input: {
    readonly cwd: string;
    readonly operationId: string;
    readonly stash: boolean;
    readonly stashStep: CodexWorktreeHandoffStep;
    readonly target: string;
    readonly checkoutStep: CodexWorktreeHandoffStep;
  },
  options: HandoffGitOptions,
): Promise<StashCheckoutResult> {
  const previousBranch = await readCurrentBranch(input.cwd, options.signal);
  let stashRef: string | null = null;
  if (input.stash) {
    options.onProgress(input.stashStep, "started");
    try {
      stashRef = await stashWorkingTree(input.cwd, input.operationId, options.signal);
      options.onProgress(input.stashStep, stashRef ? "completed" : "skipped");
    } catch (error) {
      options.onProgress(input.stashStep, "failed");
      throw error;
    }
  } else {
    options.onProgress(input.stashStep, "skipped");
  }

  options.onProgress(input.checkoutStep, "started");
  try {
    await checkoutBranchOrCommit(input.cwd, input.target, options.signal);
    options.onProgress(input.checkoutStep, "completed");
    return { previousBranch, stashRef };
  } catch (error) {
    options.onProgress(input.checkoutStep, "failed");
    if (stashRef) {
      await applyStash(input.cwd, stashRef, "pop", options.signal).catch(() => undefined);
    }
    throw error;
  }
}

async function restoreCheckout(input: {
  readonly cwd: string;
  readonly previousBranch: string | null;
  readonly stashRef: string | null;
  readonly signal: AbortSignal;
}): Promise<string[]> {
  const warnings: string[] = [];
  if (input.previousBranch) {
    await checkoutBranchOrCommit(input.cwd, input.previousBranch, input.signal).catch(() =>
      warnings.push("restore-branch-failed"),
    );
  }
  if (input.stashRef) {
    await applyStash(input.cwd, input.stashRef, "pop", input.signal).catch(() =>
      warnings.push("restore-stash-failed"),
    );
  }
  return warnings;
}

async function ensureBranchAtCommit(input: {
  readonly branch: string;
  readonly commit: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const existing = await readOptionalRef(input.cwd, `refs/heads/${input.branch}`, input.signal);
  if (existing === input.commit) return;
  if (existing) {
    throw new Error(`Branch ${input.branch} already exists at a different commit`);
  }
  await runCodexGitCommand(["branch", input.branch, input.commit], input.cwd, {
    signal: input.signal,
  });
}

async function assertCheckoutClean(cwd: string, signal: AbortSignal): Promise<void> {
  const status = await runCodexGitCommand(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    cwd,
    { signal },
  );
  if (status.stdout.length > 0) {
    throw new Error("Stash or commit your local changes to hand off.");
  }
}

async function moveToWorktree(
  input: MoveToWorktreeInput,
  operationId: string,
  options: HandoffGitOptions,
): Promise<readonly string[]> {
  const warnings: string[] = [];
  let source: StashCheckoutResult | null = null;
  let target: StashCheckoutResult | null = null;
  let sourceApplied = false;
  try {
    source = await stashAndCheckout(
      {
        cwd: input.localCwd,
        operationId,
        stash: true,
        stashStep: "stash-source-changes",
        target: input.localCheckoutBranch,
        checkoutStep: "checkout-local-branch",
      },
      options,
    );
    target = await stashAndCheckout(
      {
        cwd: input.worktreeWorkspaceRoot,
        operationId,
        stash: input.stashTargetWorktree,
        stashStep: "stash-source-changes",
        target: input.worktreeCheckoutBranch,
        checkoutStep: "checkout-worktree-branch",
      },
      options,
    );

    if (source.stashRef) {
      options.onProgress("apply-changes-to-worktree", "started");
      await applyStash(input.worktreeWorkspaceRoot, source.stashRef, "apply", options.signal);
      sourceApplied = true;
      options.onProgress("apply-changes-to-worktree", "completed");
    } else {
      options.onProgress("apply-changes-to-worktree", "skipped");
    }

    if (target.stashRef) {
      await applyStash(input.worktreeWorkspaceRoot, target.stashRef, "drop", options.signal).catch(
        () => warnings.push("drop-target-stash-failed"),
      );
    }
    if (source.stashRef) {
      await applyStash(input.localCwd, source.stashRef, "drop", options.signal).catch(() =>
        warnings.push("drop-source-stash-failed"),
      );
    }
    return warnings;
  } catch (error) {
    options.onProgress("apply-changes-to-worktree", "failed");
    if (!sourceApplied && target?.stashRef) {
      await applyStash(input.worktreeWorkspaceRoot, target.stashRef, "pop", options.signal).catch(
        () => warnings.push("restore-target-stash-failed"),
      );
    }
    if (source) {
      warnings.push(
        ...(await restoreCheckout({
          cwd: input.localCwd,
          previousBranch: source.previousBranch,
          stashRef: sourceApplied ? null : source.stashRef,
          signal: options.signal,
        })),
      );
    }
    if (input.createdWorktree && !sourceApplied) {
      await removeManagedWorktree(input.worktreeGitRoot).catch(() =>
        warnings.push("cleanup-created-worktree-failed"),
      );
    }
    const suffix = warnings.length > 0 ? ` Rollback issues: ${warnings.join(", ")}.` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`, {
      cause: error,
    });
  }
}

async function moveToCheckout(
  input: MoveToCheckoutInput,
  operationId: string,
  options: HandoffGitOptions,
): Promise<{
  readonly localCheckoutPreviousBranch: string | null;
  readonly warnings: readonly string[];
}> {
  const warnings: string[] = [];
  const sourcePreviousBranch = await readCurrentBranch(input.sourceWorktreeCwd, options.signal);
  const sourceHead = await readHead(input.sourceWorktreeCwd, options.signal);
  let source: StashCheckoutResult | null = null;
  let localPreviousBranch: string | null = null;
  let localCheckedOut = false;
  let sourceApplied = false;
  try {
    source = await stashAndCheckout(
      {
        cwd: input.sourceWorktreeCwd,
        operationId,
        stash: true,
        stashStep: "stash-source-changes",
        target: sourceHead,
        checkoutStep: "detach-worktree-branch",
      },
      options,
    );
    await assertCheckoutClean(input.localGitRoot, options.signal);
    localPreviousBranch = await readCurrentBranch(input.localGitRoot, options.signal);
    await ensureBranchAtCommit({
      branch: input.sourceBranch,
      commit: sourceHead,
      cwd: input.localGitRoot,
      signal: options.signal,
    });
    options.onProgress("checkout-local-branch", "started");
    await checkoutBranchOrCommit(input.localGitRoot, input.sourceBranch, options.signal);
    localCheckedOut = true;
    options.onProgress("checkout-local-branch", "completed");

    if (source.stashRef) {
      options.onProgress("apply-changes-to-local", "started");
      await applyStash(input.localGitRoot, source.stashRef, "apply", options.signal);
      sourceApplied = true;
      options.onProgress("apply-changes-to-local", "completed");
      await applyStash(input.sourceWorktreeCwd, source.stashRef, "drop", options.signal).catch(() =>
        warnings.push("drop-source-stash-failed"),
      );
    } else {
      options.onProgress("apply-changes-to-local", "skipped");
    }
    return { localCheckoutPreviousBranch: localPreviousBranch, warnings };
  } catch (error) {
    options.onProgress("apply-changes-to-local", "failed");
    if (localCheckedOut && localPreviousBranch) {
      await checkoutBranchOrCommit(input.localGitRoot, localPreviousBranch, options.signal).catch(
        () => warnings.push("restore-local-branch-failed"),
      );
    }
    if (source) {
      warnings.push(
        ...(await restoreCheckout({
          cwd: input.sourceWorktreeCwd,
          previousBranch: sourcePreviousBranch,
          stashRef: sourceApplied ? null : source.stashRef,
          signal: options.signal,
        })),
      );
    }
    const suffix = warnings.length > 0 ? ` Rollback issues: ${warnings.join(", ")}.` : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`, {
      cause: error,
    });
  }
}

/** Host-owned local Git transaction used before Main switches runtime/Core location. */
export async function prepareLocalThreadHandoff(
  input: CodexWorktreeWorkerPrepareHandoffInput,
  options: HandoffGitOptions,
): Promise<CodexWorktreeWorkerPreparedHandoff> {
  throwIfCodexRequestAborted(options.signal);
  const sourceBranch = await readCurrentBranch(input.sourceCwd, options.signal);
  if (!sourceBranch) {
    throw new Error("The task must be on a branch before it can be handed off.");
  }

  if (input.sourceManagedWorktreePath) {
    if (!input.destinationCheckoutRoot) {
      throw new Error("The task has no local Project checkout destination.");
    }
    const moved = await moveToCheckout(
      {
        localGitRoot: input.destinationCheckoutRoot,
        sourceBranch,
        sourceWorktreeCwd: input.sourceCwd,
        sourceWorktreeRoot: input.sourceManagedWorktreePath,
      },
      input.requestId,
      withHandoffBranches(options, {
        sourceBranch,
        localBranch: sourceBranch,
        worktreeBranch: sourceBranch,
      }),
    );
    return {
      direction: "to-checkout",
      sourceBranch,
      localCheckoutPreviousBranch: moved.localCheckoutPreviousBranch,
      sourceWorkspaceRoot: input.sourceWorkspaceRoot,
      destinationWorkspaceRoot: input.destinationCheckoutRoot,
      destinationGitRoot: input.destinationCheckoutRoot,
      managedWorktreePath: input.sourceManagedWorktreePath,
      createdWorktree: false,
      warnings: moved.warnings,
    };
  }

  const defaultBranch = await resolveDefaultBranch(input.sourceCwd, sourceBranch, options.signal);
  const destinationBranch =
    defaultBranch === sourceBranch
      ? await allocateHandoffBranch(input.sourceCwd, input.threadTitle, options.signal)
      : sourceBranch;
  const localCheckoutBranch = destinationBranch === sourceBranch ? defaultBranch : sourceBranch;
  if (!localCheckoutBranch) {
    throw new Error("No safe local checkout branch is available for this handoff.");
  }

  const progressOptions = withHandoffBranches(options, {
    sourceBranch,
    localBranch: localCheckoutBranch,
    worktreeBranch: destinationBranch,
  });
  progressOptions.onProgress("create-new-worktree", "started");
  const created = await createManagedWorktree({
    repositoryPath: input.sourceWorkspaceRoot,
    nodexHome: input.nodexHome,
    managedRoot: input.managedRoot,
    projectId: input.projectId,
    targetId: input.threadId,
    threadTitle: input.threadTitle,
    mode: "detachedHead",
    startingState: { type: "branch", branchName: sourceBranch },
    localEnvironmentConfigPath: null,
    setUpSyncedBranch: false,
    propagateLocalWorkspaceFiles: true,
    signal: options.signal,
    onPathAllocated: options.onPathAllocated,
  });
  progressOptions.onProgress("create-new-worktree", "completed");
  try {
    await ensureBranchAtCommit({
      branch: destinationBranch,
      commit: await readHead(input.sourceCwd, options.signal),
      cwd: created.worktreeWorkspaceRoot,
      signal: options.signal,
    });
    const warnings = await moveToWorktree(
      {
        createdWorktree: true,
        localCheckoutBranch,
        localCwd: input.sourceCwd,
        sourceBranch,
        stashTargetWorktree: false,
        worktreeCheckoutBranch: destinationBranch,
        worktreeGitRoot: created.worktreeGitRoot,
        worktreeWorkspaceRoot: created.worktreeWorkspaceRoot,
      },
      input.requestId,
      progressOptions,
    );
    return {
      direction: "to-worktree",
      sourceBranch,
      localCheckoutBranch,
      destinationBranch,
      sourceWorkspaceRoot: input.sourceWorkspaceRoot,
      destinationWorkspaceRoot: created.worktreeWorkspaceRoot,
      destinationGitRoot: created.worktreeGitRoot,
      managedWorktreePath: created.worktreeGitRoot,
      createdWorktree: true,
      warnings,
    };
  } catch (error) {
    await removeManagedWorktree(created.worktreeGitRoot).catch(() => undefined);
    throw error;
  }
}

export async function rollbackLocalThreadHandoff(
  input: CodexWorktreeWorkerRollbackHandoffInput,
  options: HandoffGitOptions,
): Promise<CodexWorktreeWorkerRollbackHandoffResult> {
  const prepared = input.prepared;
  if (prepared.direction === "to-worktree") {
    const moved = await moveToCheckout(
      {
        localGitRoot: prepared.sourceWorkspaceRoot,
        sourceBranch: prepared.sourceBranch,
        sourceWorktreeCwd: prepared.destinationWorkspaceRoot,
        sourceWorktreeRoot: prepared.destinationGitRoot,
      },
      input.requestId,
      options,
    );
    await removeManagedWorktree(prepared.destinationGitRoot);
    return { rolledBack: true, warnings: moved.warnings };
  }

  const localCheckoutBranch = prepared.localCheckoutPreviousBranch ?? prepared.sourceBranch;
  const warnings = await moveToWorktree(
    {
      createdWorktree: false,
      localCheckoutBranch,
      localCwd: prepared.destinationWorkspaceRoot,
      sourceBranch: prepared.sourceBranch,
      stashTargetWorktree: false,
      worktreeCheckoutBranch: prepared.sourceBranch,
      worktreeGitRoot: prepared.managedWorktreePath,
      worktreeWorkspaceRoot: prepared.sourceWorkspaceRoot,
    },
    input.requestId,
    options,
  );
  return { rolledBack: true, warnings };
}

export async function cleanupLocalThreadHandoff(): Promise<CodexWorktreeWorkerCleanupHandoffResult> {
  // Both checkouts are intentionally retained. Lifecycle/retention owns later removal.
  // A rolled-back newly-created worktree is removed by rollbackLocalThreadHandoff.
  return { cleaned: true, warnings: [] };
}

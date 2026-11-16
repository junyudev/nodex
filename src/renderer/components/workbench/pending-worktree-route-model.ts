import { getIntl, type IntlShape } from "@/lib/i18n";
import type {
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeThreadResolution,
} from "../../../shared/codex-pending-worktree";
import { canCreateCodexPendingWorktreeSetupRepair } from "../../../shared/codex-pending-worktree";

export interface PendingWorktreeRouteActions {
  canAutoFix: boolean;
  canCancel: boolean;
  canContinue: boolean;
  canEditEnvironment: boolean;
  canRetry: boolean;
  canWorkLocally: boolean;
}

export type PendingWorktreeProgressStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed";

export interface PendingWorktreeProgressStep {
  readonly kind: "workspace" | "checkout" | "setup";
  readonly status: PendingWorktreeProgressStatus;
  readonly progressPercentage: number | null;
}

export interface PendingWorktreeProgressModel {
  readonly title: string;
  readonly titleIsRunning: boolean;
  readonly cardVisible: boolean;
  readonly detailsInitiallyExpanded: boolean;
  readonly outputText: string;
  readonly steps: readonly PendingWorktreeProgressStep[];
  readonly startingTask: boolean;
}

function hasCreatedWorktree(entry: CodexPendingWorktreeEntry): boolean {
  return entry.worktreeGitRoot !== null && entry.worktreeWorkspaceRoot !== null;
}

function worktreeLifecycleStatus(
  entry: CodexPendingWorktreeEntry,
): "running" | "completed" | "failed" {
  if (entry.phase === "queued" || entry.phase === "creating") return "running";
  if (entry.phase === "setting-up" || entry.phase === "worktree-ready") return "completed";
  return hasCreatedWorktree(entry) ? "completed" : "failed";
}

function checkoutProgressPercentage(output: string): number | null {
  let result: number | null = null;
  for (const match of output.matchAll(/(?:^|[\r\n])Updating files:\s+(\d{1,3})%\s+\(\d+\/\d+\)/g)) {
    const value = Number(match[1]);
    if (value >= 0 && value <= 100) result = value;
  }
  return result;
}

function setupStatus(entry: CodexPendingWorktreeEntry): PendingWorktreeProgressStatus {
  if (entry.phase === "queued" || entry.phase === "creating") return "pending";
  if (entry.phase === "setting-up") return "running";
  if (entry.phase === "worktree-ready") {
    return entry.errorMessage === null ? "completed" : "skipped";
  }
  return hasCreatedWorktree(entry) ? "failed" : "pending";
}

function progressSteps(entry: CodexPendingWorktreeEntry): readonly PendingWorktreeProgressStep[] {
  const lifecycleStatus = worktreeLifecycleStatus(entry);
  const progressPercentage = checkoutProgressPercentage(entry.worktreeOutputText);
  const checkoutStarted =
    progressPercentage !== null ||
    /(?:^|[\r\n])(?:Preparing worktree|Updating index flags:)/.test(entry.worktreeOutputText);
  const creationDone = lifecycleStatus === "completed";
  const workspaceStatus =
    creationDone || checkoutStarted
      ? "completed"
      : lifecycleStatus === "failed"
        ? "failed"
        : "running";
  const checkoutStatus = creationDone
    ? "completed"
    : checkoutStarted
      ? lifecycleStatus === "failed"
        ? "failed"
        : "running"
      : "pending";
  const steps: PendingWorktreeProgressStep[] = [
    { kind: "workspace", status: workspaceStatus, progressPercentage: null },
    {
      kind: "checkout",
      status: checkoutStatus,
      progressPercentage: checkoutStatus === "running" ? progressPercentage : null,
    },
  ];

  if (entry.localEnvironmentConfigPath != null) {
    steps.push({
      kind: "setup",
      status: setupStatus(entry),
      progressPercentage: null,
    });
  }
  return steps;
}

function combinedOutput(entry: CodexPendingWorktreeEntry): string {
  const output = [entry.worktreeOutputText, entry.setupOutputText]
    .filter((value) => value.length > 0)
    .join("\n");
  const error = entry.errorMessage?.trim();
  if (!error || output.includes(error)) return output;
  return [output, error].filter(Boolean).join("\n");
}

export function resolvePendingWorktreeProgressModel(
  entry: CodexPendingWorktreeEntry,
  resolution: CodexPendingWorktreeThreadResolution | null,
  intl: IntlShape = getIntl(),
): PendingWorktreeProgressModel {
  const worktreeFailed = entry.phase === "failed";
  const conversationFailed = resolution?.state === "failed" && !worktreeFailed;
  const ready = entry.phase === "worktree-ready";
  const title = worktreeFailed
    ? intl.formatMessage({
        id: "workbench.pendingWorktreeRouteModel.setupFailed",
        defaultMessage: "Worktree setup failed",
      })
    : conversationFailed
      ? intl.formatMessage({
          id: "workbench.pendingWorktreeRouteModel.taskFailed",
          defaultMessage: "Task failed to start",
        })
      : ready
        ? intl.formatMessage({
            id: "workbench.pendingWorktreeRouteModel.created",
            defaultMessage: "Worktree created",
          })
        : intl.formatMessage({
            id: "workbench.pendingWorktreeRouteModel.creating",
            defaultMessage: "Creating a worktree",
          });

  return {
    title,
    titleIsRunning: !worktreeFailed && !conversationFailed && !ready,
    cardVisible: !ready || conversationFailed,
    detailsInitiallyExpanded: worktreeFailed,
    outputText: combinedOutput(entry),
    steps: progressSteps(entry),
    startingTask: ready && resolution?.state === "starting",
  };
}

export function resolvePendingWorktreeRouteActions(
  entry: CodexPendingWorktreeEntry,
  resolution: CodexPendingWorktreeThreadResolution | null,
): PendingWorktreeRouteActions {
  const worktreeIsActive =
    entry.phase === "queued" || entry.phase === "creating" || entry.phase === "setting-up";
  const worktreeFailed = entry.phase === "failed";
  const conversationFailed = resolution?.state === "failed";

  return {
    canAutoFix: canCreateCodexPendingWorktreeSetupRepair(entry),
    canCancel: worktreeIsActive,
    canContinue: worktreeFailed && hasCreatedWorktree(entry),
    canEditEnvironment: worktreeFailed,
    canRetry: worktreeFailed || conversationFailed,
    canWorkLocally: worktreeIsActive,
  };
}

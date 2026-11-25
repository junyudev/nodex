import { defineMessages } from "./i18n/messages";

export const CONFIRM_SOURCE_MISSING_STEP = "confirm-source-missing";

const CODEX_HANDOFF_STEP_LABEL_MESSAGES = defineMessages({
  [CONFIRM_SOURCE_MISSING_STEP]: {
    id: "shared.codexThreadHandoff.confirmSourceMissing",
    defaultMessage: "Checking the worktree",
  },
  "rolling-back-changes": {
    id: "shared.codexThreadHandoff.rollingBackChanges",
    defaultMessage: "Rolling back changes",
  },
  "prepare-host-transfer": {
    id: "shared.codexThreadHandoff.prepareHostTransfer",
    defaultMessage: "Preparing files for transfer",
  },
  "transfer-host-artifacts": {
    id: "shared.codexThreadHandoff.transferHostArtifacts",
    defaultMessage: "Copying files to the destination host",
  },
  "create-new-worktree": {
    id: "shared.codexThreadHandoff.createNewWorktree",
    defaultMessage: "Creating a new worktree",
  },
  "reuse-existing-worktree": {
    id: "shared.codexThreadHandoff.reuseExistingWorktree",
    defaultMessage: "Reusing the existing worktree",
  },
  "stash-source-changes": {
    id: "shared.codexThreadHandoff.stashSourceChanges",
    defaultMessage: "Stashing uncommitted changes",
  },
  "checkout-local-branch": {
    id: "shared.codexThreadHandoff.checkoutLocalBranch",
    defaultMessage: "Checking out {branch} locally",
  },
  "stash-target-worktree-changes": {
    id: "shared.codexThreadHandoff.stashTargetWorktreeChanges",
    defaultMessage: "Stashing worktree changes",
  },
  "checkout-worktree-branch": {
    id: "shared.codexThreadHandoff.checkoutWorktreeBranch",
    defaultMessage: "Checking out {branch} in worktree",
  },
  "detach-worktree-branch": {
    id: "shared.codexThreadHandoff.detachWorktreeBranch",
    defaultMessage: "Detaching branch from worktree",
  },
  "apply-changes-to-worktree": {
    id: "shared.codexThreadHandoff.applyChangesToWorktree",
    defaultMessage: "Applying uncommitted changes to worktree",
  },
  "apply-changes-to-local": {
    id: "shared.codexThreadHandoff.applyChangesToLocal",
    defaultMessage: "Applying uncommitted changes locally",
  },
  movingToWorktree: {
    id: "shared.codexThreadHandoff.movingToWorktree",
    defaultMessage: "Moving chat to worktree",
  },
  movingCrossHost: {
    id: "shared.codexThreadHandoff.movingCrossHost",
    defaultMessage: "Moving chat to the destination worktree",
  },
  movingToLocal: {
    id: "shared.codexThreadHandoff.movingToLocal",
    defaultMessage: "Moving chat to local",
  },
});

/** Profile-owned handoff progress projected into conversation tool activity. */
export type CodexAppHandoffStatusType = "running" | "success" | "warning" | "error";

export type ThreadHandoffSource = "present" | "missing";
export type ThreadHandoffStrategy = "transfer" | "relocate";

export const STALE_THREAD_HANDOFF_LOCATION =
  "Chat execution location changed. Reopen the location menu.";

export interface ThreadExecutionHandoffInput {
  readonly threadId: string;
  readonly operationId: string;
  readonly destination: "local" | "worktree";
  readonly expectedSource: ThreadHandoffSource;
}

/** The canonical execution location that handoff admission compares a move against. */
export interface ThreadExecutionLocationView {
  readonly hostId: string;
  readonly cwd: string;
  readonly managedWorktreePath: string | null;
}

export interface CodexAppHandoffStep {
  readonly id: string;
  readonly label: string;
  readonly status: CodexAppHandoffStatusType;
  readonly message: string | null;
  readonly updatedAt: number;
}

export interface CodexAppHandoffOperation {
  readonly operationId: string;
  readonly revision: number;
  readonly status: CodexAppHandoffStatusType;
  readonly recoveryRequired: boolean;
  readonly threadId: string;
  readonly sourceThreadId: string;
  readonly requestThreadId: string | null;
  readonly projectId: string | null;
  readonly sourceHostId: string | null;
  readonly threadTitle: string | null;
  readonly strategy: ThreadHandoffStrategy;
  readonly expectedSource?: ThreadHandoffSource;
  readonly direction: "local-to-worktree" | "worktree-to-local" | "cross-host" | null;
  readonly localBranch: string | null;
  readonly sourceBranch: string | null;
  readonly worktreeBranch: string | null;
  readonly destinationHostId: string;
  readonly destinationHostDisplayName: string | null;
  readonly message: string | null;
  readonly steps: readonly CodexAppHandoffStep[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export type CodexThreadHandoffBranches = Pick<
  CodexAppHandoffOperation,
  "sourceBranch" | "localBranch" | "worktreeBranch"
>;

export interface CodexThreadHandoffSnapshot {
  readonly revision: number;
  readonly operations: readonly CodexAppHandoffOperation[];
}

type HandoffStepContext = Pick<
  CodexAppHandoffOperation,
  "direction" | "localBranch" | "sourceBranch" | "worktreeBranch"
>;

/** Branch-aware labels shared by the protocol result and compact progress rows. */
export function resolveCodexThreadHandoffStepLabel(
  stepId: string,
  context: HandoffStepContext,
): string | null {
  const label = codexThreadHandoffStepLabelMessage(stepId, context);
  if (!label) return null;
  const { message, values } = label;
  return values
    ? message.defaultMessage.replace("{branch}", () => values.branch)
    : message.defaultMessage;
}

export function codexThreadHandoffStepLabelMessage(stepId: string, context: HandoffStepContext) {
  const messages = CODEX_HANDOFF_STEP_LABEL_MESSAGES;
  switch (stepId) {
    case CONFIRM_SOURCE_MISSING_STEP:
    case "rolling-back-changes":
    case "prepare-host-transfer":
    case "transfer-host-artifacts":
    case "create-new-worktree":
    case "reuse-existing-worktree":
    case "stash-source-changes":
    case "stash-target-worktree-changes":
    case "detach-worktree-branch":
    case "apply-changes-to-worktree":
    case "apply-changes-to-local":
      return { message: messages[stepId] };
    case "checkout-local-branch":
      return {
        message: messages[stepId],
        values: { branch: context.localBranch ?? context.sourceBranch ?? "" },
      };
    case "checkout-worktree-branch":
      return {
        message: messages[stepId],
        values: { branch: context.worktreeBranch ?? context.sourceBranch ?? "" },
      };
    case "switching-thread":
      if (context.direction === "local-to-worktree") return { message: messages.movingToWorktree };
      if (context.direction === "cross-host") return { message: messages.movingCrossHost };
      return { message: messages.movingToLocal };
    default:
      return null;
  }
}

/** Stable identity for a handoff admitted by one originating dynamic tool call. */
export function createCodexThreadHandoffOperationId(
  requestThreadId: string,
  callId: string,
): string {
  return `codex-app:handoff:${requestThreadId}:${callId}`;
}

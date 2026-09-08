/** Profile-owned handoff progress projected into conversation tool activity. */
export type CodexAppHandoffStatusType = "running" | "success" | "warning" | "error";

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
  readonly threadId: string;
  readonly sourceThreadId: string;
  readonly requestThreadId: string | null;
  readonly projectId: string | null;
  readonly sourceHostId: string | null;
  readonly threadTitle: string | null;
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

/** Branch-aware labels shared by the protocol result and compact progress rows. */
export function resolveCodexThreadHandoffStepLabel(
  stepId: string,
  context: Pick<
    CodexAppHandoffOperation,
    "direction" | "localBranch" | "sourceBranch" | "worktreeBranch"
  >,
): string | null {
  switch (stepId) {
    case "rolling-back-changes":
      return "Rolling back changes";
    case "prepare-host-transfer":
      return "Preparing files for transfer";
    case "transfer-host-artifacts":
      return "Copying files to the destination host";
    case "create-new-worktree":
      return "Creating a new worktree";
    case "reuse-existing-worktree":
      return "Reusing the existing worktree";
    case "stash-source-changes":
      return "Stashing uncommitted changes";
    case "checkout-local-branch":
      return `Checking out ${context.localBranch ?? context.sourceBranch ?? ""} locally`;
    case "stash-target-worktree-changes":
      return "Stashing worktree changes";
    case "checkout-worktree-branch":
      return `Checking out ${context.worktreeBranch ?? context.sourceBranch ?? ""} in worktree`;
    case "detach-worktree-branch":
      return "Detaching branch from worktree";
    case "apply-changes-to-worktree":
      return "Applying uncommitted changes to worktree";
    case "apply-changes-to-local":
      return "Applying uncommitted changes locally";
    case "switching-thread":
      if (context.direction === "local-to-worktree") return "Moving chat to worktree";
      if (context.direction === "cross-host") return "Moving chat to the destination worktree";
      return "Moving chat to local";
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

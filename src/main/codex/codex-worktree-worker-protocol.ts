import type { CodexStoredShellEnvironment } from "./codex-worktree-shell-environment";
import type { CodexPendingWorktreeStartingState } from "../../shared/codex-pending-worktree";
import type { WorktreeStartMode } from "../../shared/types";
import type { CodexExecutionHostFileDescriptor } from "./codex-execution-host-file-transfer";

export const CODEX_WORKTREE_WORKER_OPERATIONS = [
  "create",
  "list",
  "inspect",
  "snapshot",
  "remove",
  "restore",
  "set-owner",
  "prepare-handoff",
  "rollback-handoff",
  "cleanup-handoff",
  "export-handoff",
  "import-handoff",
  "cleanup-transfer-handoff",
] as const;

export type CodexWorktreeWorkerOperation = (typeof CODEX_WORKTREE_WORKER_OPERATIONS)[number];

export type CodexManagedWorktreeRemovalReason =
  | "archive"
  | "automatic-retention"
  | "automation-archive"
  | "handoff"
  | "settings-delete"
  | "failed-create"
  | "retry"
  | "cancel";

export const CODEX_WORKTREE_HANDOFF_STEPS = [
  "create-new-worktree",
  "stash-source-changes",
  "detach-worktree-branch",
  "checkout-local-branch",
  "checkout-worktree-branch",
  "apply-changes-to-worktree",
  "apply-changes-to-local",
  "snapshot-source",
  "bundle-source",
  "import-bundle",
] as const;

export type CodexWorktreeHandoffStep = (typeof CODEX_WORKTREE_HANDOFF_STEPS)[number];

export type CodexWorktreeHandoffStepStatus = "started" | "completed" | "skipped" | "failed";

export type CodexManagedWorktreeSnapshotPolicy = "required" | "best-effort" | "ephemeral";

interface CodexWorktreeWorkerRequestIdentity {
  readonly requestId: string;
  readonly hostId: string;
}

export interface CodexWorktreeWorkerCreateInput extends CodexWorktreeWorkerRequestIdentity {
  readonly repositoryPath: string;
  readonly nodexHome: string;
  readonly managedRoot: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly threadTitle: string;
  readonly branchPrefix?: string | null;
  readonly mode?: WorktreeStartMode;
  readonly startingState: CodexPendingWorktreeStartingState | null;
  /** Portable path relative to `repositoryPath`, under `.codex/environments`. */
  readonly localEnvironmentConfigPath: string | null;
  readonly setUpSyncedBranch: boolean;
  readonly propagateLocalWorkspaceFiles: boolean;
}

export type CodexWorktreeWorkerEvent =
  | {
      readonly operation: CodexWorktreeWorkerOperation;
      readonly type: "output";
      readonly phase: "worktree" | "setup" | "snapshot" | "cleanup" | "restore";
      readonly stream: "stdout" | "stderr" | "info";
      readonly data: string;
    }
  | {
      readonly operation: "create" | "prepare-handoff" | "import-handoff";
      readonly type: "path-allocated";
      readonly worktreeGitRoot: string;
      readonly worktreeWorkspaceRoot: string;
    }
  | { readonly operation: "create"; readonly type: "setup-started" }
  | {
      readonly operation: "snapshot" | "remove";
      readonly type: "snapshot-started";
    }
  | { readonly operation: "remove"; readonly type: "cleanup-started" }
  | { readonly operation: "restore"; readonly type: "restore-started" }
  | {
      readonly operation:
        | "prepare-handoff"
        | "rollback-handoff"
        | "export-handoff"
        | "import-handoff";
      readonly type: "handoff-progress";
      readonly step: CodexWorktreeHandoffStep;
      readonly status: CodexWorktreeHandoffStepStatus;
    };

export interface CodexWorktreeWorkerCreateResult {
  readonly worktreeGitRoot: string;
  readonly worktreeWorkspaceRoot: string;
  readonly setupError: string | null;
  readonly shellEnvironment: CodexStoredShellEnvironment | null;
}

export interface CodexWorktreeWorkerTargetInput extends CodexWorktreeWorkerRequestIdentity {
  readonly worktreeGitRoot: string;
}

export type CodexWorktreeWorkerPathInput = CodexWorktreeWorkerTargetInput;

export interface CodexWorktreeWorkerListInput extends CodexWorktreeWorkerRequestIdentity {
  readonly managedRoot: string;
}

export interface CodexWorktreeWorkerListEntry {
  readonly worktreeGitRoot: string;
  /** Null means a named managed residue exists but its Git identity cannot be resolved. */
  readonly repositoryPath: string | null;
  readonly createdAtMs: number | null;
  readonly ownerThreadId: string | null;
  readonly ownerReadFailed: boolean;
}

export interface CodexWorktreeWorkerListResult {
  readonly entries: readonly CodexWorktreeWorkerListEntry[];
}

export interface CodexWorktreeWorkerInspectInput extends CodexWorktreeWorkerPathInput {
  readonly cwd: string;
  readonly candidateRepositoryPaths: readonly string[];
}

export type CodexWorktreeWorkerAvailability =
  | { readonly state: "available" }
  | {
      readonly state: "restorable";
      readonly repositoryPath: string;
      readonly snapshotRef: string;
    }
  | { readonly state: "gone" }
  | {
      readonly state: "unavailable";
      readonly reason: "inspection-failed" | "no-candidate-roots";
      readonly message: string;
    };

export interface CodexWorktreeWorkerInspectResult {
  readonly availability: CodexWorktreeWorkerAvailability;
}

export interface CodexWorktreeWorkerSnapshotInput extends CodexWorktreeWorkerPathInput {
  readonly reason: CodexManagedWorktreeRemovalReason;
}

export interface CodexWorktreeWorkerSnapshotResult {
  readonly worktreeId: string;
  readonly repositoryPath: string;
  readonly snapshotRef: string;
  readonly commitId: string;
  readonly changed: boolean;
}

export interface CodexWorktreeWorkerRemoveInput extends CodexWorktreeWorkerPathInput {
  readonly reason: CodexManagedWorktreeRemovalReason;
  readonly snapshotPolicy: CodexManagedWorktreeSnapshotPolicy;
}

export interface CodexWorktreeWorkerRemoveResult {
  readonly removed: boolean;
  readonly alreadyMissing: boolean;
  readonly snapshot: CodexWorktreeWorkerSnapshotResult | null;
  readonly warnings: readonly string[];
}

export interface CodexWorktreeWorkerRestoreInput extends CodexWorktreeWorkerInspectInput {
  readonly ownerThreadId: string | null;
}

export interface CodexWorktreeWorkerRestoreResult {
  readonly worktreeGitRoot: string;
  readonly cwd: string;
  readonly repositoryPath: string;
  readonly snapshotRef: string;
  readonly ownerWarning: string | null;
}

export interface CodexWorktreeWorkerSetOwnerInput extends CodexWorktreeWorkerPathInput {
  readonly ownerThreadId: string;
}

export interface CodexWorktreeWorkerSetOwnerResult {
  readonly ownerThreadId: string;
}

export interface CodexWorktreeWorkerPrepareHandoffInput extends CodexWorktreeWorkerRequestIdentity {
  readonly managedRoot: string;
  readonly nodexHome: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly sourceCwd: string;
  readonly sourceWorkspaceRoot: string;
  readonly sourceManagedWorktreePath: string | null;
  readonly destinationCheckoutRoot: string | null;
}

export type CodexWorktreeWorkerPreparedHandoff =
  | {
      readonly direction: "to-worktree";
      readonly sourceBranch: string;
      readonly localCheckoutBranch: string;
      readonly destinationBranch: string;
      readonly sourceWorkspaceRoot: string;
      readonly destinationWorkspaceRoot: string;
      readonly destinationGitRoot: string;
      readonly managedWorktreePath: string;
      readonly createdWorktree: true;
      readonly warnings: readonly string[];
    }
  | {
      readonly direction: "to-checkout";
      readonly sourceBranch: string;
      readonly localCheckoutPreviousBranch: string | null;
      readonly sourceWorkspaceRoot: string;
      readonly destinationWorkspaceRoot: string;
      readonly destinationGitRoot: string;
      readonly managedWorktreePath: string;
      readonly createdWorktree: false;
      readonly warnings: readonly string[];
    };

export interface CodexWorktreeWorkerRollbackHandoffInput extends CodexWorktreeWorkerRequestIdentity {
  readonly prepared: CodexWorktreeWorkerPreparedHandoff;
}

export interface CodexWorktreeWorkerRollbackHandoffResult {
  readonly rolledBack: boolean;
  readonly warnings: readonly string[];
}

export interface CodexWorktreeWorkerCleanupHandoffInput extends CodexWorktreeWorkerRequestIdentity {
  readonly prepared: CodexWorktreeWorkerPreparedHandoff;
  readonly outcome: "committed" | "rolled-back";
}

export interface CodexWorktreeWorkerCleanupHandoffResult {
  readonly cleaned: boolean;
  readonly warnings: readonly string[];
}

export interface CodexRepositoryIdentity {
  readonly displayName: string;
  readonly keys: readonly string[];
}

export interface CodexWorktreeWorkerExportHandoffInput extends CodexWorktreeWorkerRequestIdentity {
  readonly transferId: string;
  readonly sourceCwd: string;
  readonly sourceWorkspaceRoot: string;
  readonly stagingRoot: string;
}

export interface CodexWorktreeWorkerExportHandoffResult {
  readonly sourceRepositoryPath: string;
  readonly sourceBranch: string;
  readonly sourceCommit: string;
  readonly temporaryRef: string;
  readonly repositoryIdentity: CodexRepositoryIdentity;
  readonly bundle: CodexExecutionHostFileDescriptor;
}

export interface CodexWorktreeWorkerImportHandoffInput extends CodexWorktreeWorkerRequestIdentity {
  readonly transferId: string;
  readonly bundlePath: string;
  readonly rolloutPath: string;
  readonly rolloutRelativePath: string;
  readonly destinationCodexHome: string;
  readonly sourceCommit: string;
  readonly repositoryIdentity: CodexRepositoryIdentity;
  readonly candidateRepositoryPaths: readonly string[];
  readonly managedRoot: string;
  readonly nodexHome: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly threadTitle: string;
}

export interface CodexWorktreeWorkerImportHandoffResult {
  readonly destinationRepositoryPath: string;
  readonly destinationWorkspaceRoot: string;
  readonly destinationGitRoot: string;
  readonly managedWorktreePath: string;
  readonly temporaryRef: string;
  readonly destinationRolloutPath: string;
  readonly destinationRolloutCreated: boolean;
}

export interface CodexWorktreeWorkerCleanupTransferHandoffInput extends CodexWorktreeWorkerRequestIdentity {
  readonly transferId: string;
  readonly stagingRoot: string;
  readonly repositoryPath: string;
  readonly temporaryRef: string;
  readonly managedRoot: string | null;
  readonly createdWorktreePath: string | null;
  readonly createdRolloutPath: string | null;
  readonly destinationCodexHome: string | null;
  readonly outcome: "committed" | "rolled-back";
}

export interface CodexWorktreeWorkerCleanupTransferHandoffResult {
  readonly cleaned: boolean;
  readonly warnings: readonly string[];
}

export type CodexWorktreeWorkerRequest =
  | {
      readonly operation: "create";
      readonly input: CodexWorktreeWorkerCreateInput;
    }
  | { readonly operation: "list"; readonly input: CodexWorktreeWorkerListInput }
  | { readonly operation: "inspect"; readonly input: CodexWorktreeWorkerInspectInput }
  | { readonly operation: "snapshot"; readonly input: CodexWorktreeWorkerSnapshotInput }
  | { readonly operation: "remove"; readonly input: CodexWorktreeWorkerRemoveInput }
  | { readonly operation: "restore"; readonly input: CodexWorktreeWorkerRestoreInput }
  | { readonly operation: "set-owner"; readonly input: CodexWorktreeWorkerSetOwnerInput }
  | {
      readonly operation: "prepare-handoff";
      readonly input: CodexWorktreeWorkerPrepareHandoffInput;
    }
  | {
      readonly operation: "rollback-handoff";
      readonly input: CodexWorktreeWorkerRollbackHandoffInput;
    }
  | {
      readonly operation: "cleanup-handoff";
      readonly input: CodexWorktreeWorkerCleanupHandoffInput;
    }
  | {
      readonly operation: "export-handoff";
      readonly input: CodexWorktreeWorkerExportHandoffInput;
    }
  | {
      readonly operation: "import-handoff";
      readonly input: CodexWorktreeWorkerImportHandoffInput;
    }
  | {
      readonly operation: "cleanup-transfer-handoff";
      readonly input: CodexWorktreeWorkerCleanupTransferHandoffInput;
    };

export type CodexWorktreeWorkerSuccess =
  | { readonly operation: "create"; readonly value: CodexWorktreeWorkerCreateResult }
  | { readonly operation: "list"; readonly value: CodexWorktreeWorkerListResult }
  | { readonly operation: "inspect"; readonly value: CodexWorktreeWorkerInspectResult }
  | { readonly operation: "snapshot"; readonly value: CodexWorktreeWorkerSnapshotResult }
  | { readonly operation: "remove"; readonly value: CodexWorktreeWorkerRemoveResult }
  | { readonly operation: "restore"; readonly value: CodexWorktreeWorkerRestoreResult }
  | { readonly operation: "set-owner"; readonly value: CodexWorktreeWorkerSetOwnerResult }
  | { readonly operation: "prepare-handoff"; readonly value: CodexWorktreeWorkerPreparedHandoff }
  | {
      readonly operation: "rollback-handoff";
      readonly value: CodexWorktreeWorkerRollbackHandoffResult;
    }
  | {
      readonly operation: "cleanup-handoff";
      readonly value: CodexWorktreeWorkerCleanupHandoffResult;
    }
  | { readonly operation: "export-handoff"; readonly value: CodexWorktreeWorkerExportHandoffResult }
  | { readonly operation: "import-handoff"; readonly value: CodexWorktreeWorkerImportHandoffResult }
  | {
      readonly operation: "cleanup-transfer-handoff";
      readonly value: CodexWorktreeWorkerCleanupTransferHandoffResult;
    };

export interface CodexWorktreeWorkerOperationOptions {
  readonly signal?: AbortSignal;
  readonly onEvent: (event: CodexWorktreeWorkerEvent) => void;
}

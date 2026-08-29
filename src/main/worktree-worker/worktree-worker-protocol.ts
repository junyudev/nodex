import path from "node:path";
import { isCodexWorktreeEnvironmentConfigPath } from "../../shared/codex-worktree-environment-path";
import type {
  CodexWorktreeWorkerAvailability,
  CodexWorktreeWorkerCleanupHandoffInput,
  CodexWorktreeWorkerCreateInput,
  CodexWorktreeWorkerCreateResult,
  CodexWorktreeWorkerEvent,
  CodexWorktreeWorkerInspectInput,
  CodexWorktreeWorkerListInput,
  CodexWorktreeWorkerOperation,
  CodexWorktreeWorkerPathInput,
  CodexWorktreeWorkerRemoveInput,
  CodexWorktreeWorkerRequest,
  CodexWorktreeWorkerRestoreInput,
  CodexWorktreeWorkerSetOwnerInput,
  CodexWorktreeWorkerSnapshotInput,
  CodexWorktreeWorkerSnapshotResult,
  CodexWorktreeWorkerSuccess,
  CodexWorktreeWorkerPrepareHandoffInput,
  CodexWorktreeWorkerPreparedHandoff,
  CodexWorktreeWorkerRollbackHandoffInput,
  CodexWorktreeWorkerExportHandoffInput,
  CodexWorktreeWorkerImportHandoffInput,
  CodexWorktreeWorkerCleanupTransferHandoffInput,
} from "../codex/codex-worktree-worker-protocol";
import {
  CODEX_WORKTREE_HANDOFF_STEPS,
  CODEX_WORKTREE_WORKER_OPERATIONS,
} from "../codex/codex-worktree-worker-protocol";

export const CODEX_WORKTREE_WORKER_PROTOCOL_VERSION = 6 as const;

export type CodexWorktreeWorkerHostMessage =
  | {
      readonly type: "request";
      readonly protocolVersion: typeof CODEX_WORKTREE_WORKER_PROTOCOL_VERSION;
      readonly id: string;
      readonly request: CodexWorktreeWorkerRequest;
    }
  | {
      readonly type: "cancel";
      readonly protocolVersion: typeof CODEX_WORKTREE_WORKER_PROTOCOL_VERSION;
      readonly id: string;
      readonly operation: CodexWorktreeWorkerOperation;
    }
  | {
      readonly type: "shutdown";
      readonly protocolVersion: typeof CODEX_WORKTREE_WORKER_PROTOCOL_VERSION;
    };

export type CodexWorktreeWorkerThreadMessage =
  | {
      readonly type: "ready";
      readonly epoch: number;
      readonly hostId: string;
      readonly protocolVersion: typeof CODEX_WORKTREE_WORKER_PROTOCOL_VERSION;
    }
  | {
      readonly type: "event";
      readonly id: string;
      readonly operation: CodexWorktreeWorkerOperation;
      readonly event: CodexWorktreeWorkerEvent;
    }
  | {
      readonly type: "result";
      readonly id: string;
      readonly operation: CodexWorktreeWorkerOperation;
      readonly result:
        | { readonly type: "ok"; readonly success: CodexWorktreeWorkerSuccess }
        | {
            readonly type: "error";
            readonly code: "canceled" | "invalid-request" | "operation-failed";
            readonly message: string;
            readonly retryable: boolean;
          };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown, maxLength = 8_192): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maxLength
  );
}

function isNullableString(value: unknown, maxLength = 8_192): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maxLength);
}

function isOperation(value: unknown): value is CodexWorktreeWorkerOperation {
  return (
    typeof value === "string" &&
    (CODEX_WORKTREE_WORKER_OPERATIONS as readonly string[]).includes(value)
  );
}

function isAbsolutePath(value: unknown): value is string {
  return isNonEmptyString(value) && path.isAbsolute(value);
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isIdentity(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.requestId, 1_024) && isNonEmptyString(value.hostId, 512);
}

function isStartingState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "working-tree") return hasOnlyKeys(value, ["type"]);
  return (
    value.type === "branch" &&
    hasOnlyKeys(value, ["type", "branchName", "remoteRef"]) &&
    isNonEmptyString(value.branchName, 1_024) &&
    (value.remoteRef === undefined || isNonEmptyString(value.remoteRef, 2_048))
  );
}

function isCreateInput(value: unknown): value is CodexWorktreeWorkerCreateInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "requestId",
      "hostId",
      "repositoryPath",
      "nodexHome",
      "managedRoot",
      "projectId",
      "targetId",
      "threadTitle",
      "branchPrefix",
      "mode",
      "startingState",
      "localEnvironmentConfigPath",
      "setUpSyncedBranch",
      "propagateLocalWorkspaceFiles",
    ]) &&
    isIdentity(value) &&
    isAbsolutePath(value.repositoryPath) &&
    isAbsolutePath(value.nodexHome) &&
    isAbsolutePath(value.managedRoot) &&
    isNonEmptyString(value.projectId, 1_024) &&
    isNonEmptyString(value.targetId, 1_024) &&
    isNonEmptyString(value.threadTitle, 4_096) &&
    (value.branchPrefix === undefined ||
      value.branchPrefix === null ||
      typeof value.branchPrefix === "string") &&
    (value.mode === undefined || value.mode === "autoBranch" || value.mode === "detachedHead") &&
    (value.startingState === null || isStartingState(value.startingState)) &&
    (value.localEnvironmentConfigPath === null ||
      isCodexWorktreeEnvironmentConfigPath(value.localEnvironmentConfigPath)) &&
    typeof value.setUpSyncedBranch === "boolean" &&
    typeof value.propagateLocalWorkspaceFiles === "boolean"
  );
}

function isPathInput(
  value: unknown,
): value is Record<string, unknown> & CodexWorktreeWorkerPathInput {
  return isRecord(value) && isIdentity(value) && isAbsolutePath(value.worktreeGitRoot);
}

function isListInput(value: unknown): value is CodexWorktreeWorkerListInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["requestId", "hostId", "managedRoot"]) &&
    isIdentity(value) &&
    isAbsolutePath(value.managedRoot)
  );
}

function isCandidateRepositoryPaths(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 128 && value.every(isAbsolutePath);
}

function isInspectInput(value: unknown): value is CodexWorktreeWorkerInspectInput {
  return (
    isPathInput(value) &&
    hasOnlyKeys(value, [
      "requestId",
      "hostId",
      "worktreeGitRoot",
      "cwd",
      "candidateRepositoryPaths",
    ]) &&
    isAbsolutePath(value.cwd) &&
    isPathWithin(value.worktreeGitRoot, value.cwd) &&
    isCandidateRepositoryPaths(value.candidateRepositoryPaths)
  );
}

function isRemovalReason(value: unknown): boolean {
  return (
    value === "archive" ||
    value === "automatic-retention" ||
    value === "automation-archive" ||
    value === "handoff" ||
    value === "settings-delete" ||
    value === "failed-create" ||
    value === "retry" ||
    value === "cancel"
  );
}

function isSnapshotInput(value: unknown): value is CodexWorktreeWorkerSnapshotInput {
  return (
    isPathInput(value) &&
    hasOnlyKeys(value, ["requestId", "hostId", "worktreeGitRoot", "reason"]) &&
    isRemovalReason(value.reason)
  );
}

function isRemoveInput(value: unknown): value is CodexWorktreeWorkerRemoveInput {
  return (
    isPathInput(value) &&
    hasOnlyKeys(value, ["requestId", "hostId", "worktreeGitRoot", "reason", "snapshotPolicy"]) &&
    isRemovalReason(value.reason) &&
    (value.snapshotPolicy === "required" ||
      value.snapshotPolicy === "best-effort" ||
      value.snapshotPolicy === "ephemeral")
  );
}

function isRestoreInput(value: unknown): value is CodexWorktreeWorkerRestoreInput {
  if (!isRecord(value)) return false;
  const inspectShape = { ...value };
  delete inspectShape.ownerThreadId;
  return (
    isInspectInput(inspectShape) &&
    hasOnlyKeys(value, [
      "requestId",
      "hostId",
      "worktreeGitRoot",
      "cwd",
      "candidateRepositoryPaths",
      "ownerThreadId",
    ]) &&
    (value.ownerThreadId === null || isNonEmptyString(value.ownerThreadId, 1_024))
  );
}

function isSetOwnerInput(value: unknown): value is CodexWorktreeWorkerSetOwnerInput {
  return (
    isPathInput(value) &&
    hasOnlyKeys(value, ["requestId", "hostId", "worktreeGitRoot", "ownerThreadId"]) &&
    isNonEmptyString(value.ownerThreadId, 1_024)
  );
}

function isWarnings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every((warning) => typeof warning === "string" && warning.length <= 64_000)
  );
}

function isPreparedHandoff(value: unknown): value is CodexWorktreeWorkerPreparedHandoff {
  if (!isRecord(value)) return false;
  const common =
    isNonEmptyString(value.sourceBranch, 1_024) &&
    isAbsolutePath(value.sourceWorkspaceRoot) &&
    isAbsolutePath(value.destinationWorkspaceRoot) &&
    isAbsolutePath(value.destinationGitRoot) &&
    isAbsolutePath(value.managedWorktreePath) &&
    typeof value.createdWorktree === "boolean" &&
    isWarnings(value.warnings);
  if (!common) return false;
  if (value.direction === "to-worktree") {
    return (
      value.createdWorktree === true &&
      isNonEmptyString(value.localCheckoutBranch, 1_024) &&
      isNonEmptyString(value.destinationBranch, 1_024)
    );
  }
  return (
    value.direction === "to-checkout" &&
    value.createdWorktree === false &&
    (value.localCheckoutPreviousBranch === null ||
      isNonEmptyString(value.localCheckoutPreviousBranch, 1_024))
  );
}

function isPrepareHandoffInput(value: unknown): value is CodexWorktreeWorkerPrepareHandoffInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "requestId",
      "hostId",
      "managedRoot",
      "nodexHome",
      "projectId",
      "threadId",
      "threadTitle",
      "sourceCwd",
      "sourceWorkspaceRoot",
      "sourceManagedWorktreePath",
      "destinationCheckoutRoot",
    ]) &&
    isIdentity(value) &&
    isAbsolutePath(value.managedRoot) &&
    isAbsolutePath(value.nodexHome) &&
    isNonEmptyString(value.projectId, 1_024) &&
    isNonEmptyString(value.threadId, 1_024) &&
    isNonEmptyString(value.threadTitle, 4_096) &&
    isAbsolutePath(value.sourceCwd) &&
    isAbsolutePath(value.sourceWorkspaceRoot) &&
    isPathWithin(value.sourceWorkspaceRoot, value.sourceCwd) &&
    (value.sourceManagedWorktreePath === null || isAbsolutePath(value.sourceManagedWorktreePath)) &&
    (value.destinationCheckoutRoot === null || isAbsolutePath(value.destinationCheckoutRoot))
  );
}

function isRollbackHandoffInput(value: unknown): value is CodexWorktreeWorkerRollbackHandoffInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["requestId", "hostId", "prepared"]) &&
    isIdentity(value) &&
    isPreparedHandoff(value.prepared)
  );
}

function isCleanupHandoffInput(value: unknown): value is CodexWorktreeWorkerCleanupHandoffInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["requestId", "hostId", "prepared", "outcome"]) &&
    isIdentity(value) &&
    isPreparedHandoff(value.prepared) &&
    (value.outcome === "committed" || value.outcome === "rolled-back")
  );
}

function isTransferId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._-]{1,200}$/u.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function isRepositoryIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["displayName", "keys"]) &&
    isNonEmptyString(value.displayName, 512) &&
    Array.isArray(value.keys) &&
    value.keys.length > 0 &&
    value.keys.length <= 128 &&
    value.keys.every((key) => typeof key === "string" && /^[a-f0-9]{64}$/u.test(key))
  );
}

function isExportHandoffInput(value: unknown): value is CodexWorktreeWorkerExportHandoffInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "requestId",
      "hostId",
      "transferId",
      "sourceCwd",
      "sourceWorkspaceRoot",
      "stagingRoot",
    ]) &&
    isIdentity(value) &&
    isTransferId(value.transferId) &&
    isAbsolutePath(value.sourceCwd) &&
    isAbsolutePath(value.sourceWorkspaceRoot) &&
    isPathWithin(value.sourceWorkspaceRoot, value.sourceCwd) &&
    isAbsolutePath(value.stagingRoot)
  );
}

function isImportHandoffInput(value: unknown): value is CodexWorktreeWorkerImportHandoffInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "requestId",
      "hostId",
      "transferId",
      "bundlePath",
      "rolloutPath",
      "rolloutRelativePath",
      "destinationCodexHome",
      "sourceCommit",
      "repositoryIdentity",
      "candidateRepositoryPaths",
      "managedRoot",
      "nodexHome",
      "projectId",
      "threadId",
      "threadTitle",
    ]) &&
    isIdentity(value) &&
    isTransferId(value.transferId) &&
    isAbsolutePath(value.bundlePath) &&
    isAbsolutePath(value.rolloutPath) &&
    isNonEmptyString(value.rolloutRelativePath, 8_192) &&
    !path.isAbsolute(value.rolloutRelativePath) &&
    !value.rolloutRelativePath.split(/[\\/]/u).includes("..") &&
    isAbsolutePath(value.destinationCodexHome) &&
    isNonEmptyString(value.sourceCommit, 256) &&
    isRepositoryIdentity(value.repositoryIdentity) &&
    isCandidateRepositoryPaths(value.candidateRepositoryPaths) &&
    value.candidateRepositoryPaths.length > 0 &&
    isAbsolutePath(value.managedRoot) &&
    isAbsolutePath(value.nodexHome) &&
    isNonEmptyString(value.projectId, 1_024) &&
    isNonEmptyString(value.threadId, 1_024) &&
    isNonEmptyString(value.threadTitle, 4_096)
  );
}

function isCleanupTransferHandoffInput(
  value: unknown,
): value is CodexWorktreeWorkerCleanupTransferHandoffInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "requestId",
      "hostId",
      "transferId",
      "stagingRoot",
      "repositoryPath",
      "temporaryRef",
      "managedRoot",
      "createdWorktreePath",
      "createdRolloutPath",
      "destinationCodexHome",
      "outcome",
    ]) &&
    isIdentity(value) &&
    isTransferId(value.transferId) &&
    isAbsolutePath(value.stagingRoot) &&
    isAbsolutePath(value.repositoryPath) &&
    isNonEmptyString(value.temporaryRef, 1_024) &&
    (value.managedRoot === null || isAbsolutePath(value.managedRoot)) &&
    (value.createdWorktreePath === null || isAbsolutePath(value.createdWorktreePath)) &&
    (value.createdRolloutPath === null || isAbsolutePath(value.createdRolloutPath)) &&
    (value.destinationCodexHome === null || isAbsolutePath(value.destinationCodexHome)) &&
    (value.createdWorktreePath === null ||
      (typeof value.managedRoot === "string" &&
        isPathWithin(value.managedRoot, value.createdWorktreePath))) &&
    (value.createdRolloutPath === null ||
      (typeof value.destinationCodexHome === "string" &&
        isPathWithin(value.destinationCodexHome, value.createdRolloutPath))) &&
    (value.outcome === "committed" || value.outcome === "rolled-back")
  );
}

function isRequest(value: unknown): value is CodexWorktreeWorkerRequest {
  if (!isRecord(value) || !isOperation(value.operation)) return false;
  if (!hasOnlyKeys(value, ["operation", "input"])) return false;
  switch (value.operation) {
    case "create":
      return isCreateInput(value.input);
    case "list":
      return isListInput(value.input);
    case "inspect":
      return isInspectInput(value.input);
    case "snapshot":
      return isSnapshotInput(value.input);
    case "remove":
      return isRemoveInput(value.input);
    case "restore":
      return isRestoreInput(value.input);
    case "set-owner":
      return isSetOwnerInput(value.input);
    case "prepare-handoff":
      return isPrepareHandoffInput(value.input);
    case "rollback-handoff":
      return isRollbackHandoffInput(value.input);
    case "cleanup-handoff":
      return isCleanupHandoffInput(value.input);
    case "export-handoff":
      return isExportHandoffInput(value.input);
    case "import-handoff":
      return isImportHandoffInput(value.input);
    case "cleanup-transfer-handoff":
      return isCleanupTransferHandoffInput(value.input);
  }
}

export function isCodexWorktreeWorkerHostMessage(
  value: unknown,
): value is CodexWorktreeWorkerHostMessage {
  if (!isRecord(value)) return false;
  if (value.protocolVersion !== CODEX_WORKTREE_WORKER_PROTOCOL_VERSION) return false;
  if (value.type === "shutdown") {
    return hasOnlyKeys(value, ["type", "protocolVersion"]);
  }
  if (value.type === "cancel") {
    return (
      hasOnlyKeys(value, ["type", "protocolVersion", "id", "operation"]) &&
      isNonEmptyString(value.id, 1_024) &&
      isOperation(value.operation)
    );
  }
  return (
    value.type === "request" &&
    hasOnlyKeys(value, ["type", "protocolVersion", "id", "request"]) &&
    isNonEmptyString(value.id, 1_024) &&
    isRequest(value.request)
  );
}

export function assertCodexWorktreeWorkerHostMessage(
  value: unknown,
): asserts value is CodexWorktreeWorkerHostMessage {
  if (isCodexWorktreeWorkerHostMessage(value)) return;
  throw new Error(
    `Worktree worker host message violates protocol version ${String(CODEX_WORKTREE_WORKER_PROTOCOL_VERSION)}`,
  );
}

export function createCodexWorktreeWorkerRequestMessage(input: {
  readonly id: string;
  readonly request: CodexWorktreeWorkerRequest;
}): CodexWorktreeWorkerHostMessage {
  const message = {
    type: "request",
    protocolVersion: CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
    id: input.id,
    request: input.request,
  } satisfies CodexWorktreeWorkerHostMessage;
  assertCodexWorktreeWorkerHostMessage(message);
  return message;
}

function isWorkerEvent(value: unknown): value is CodexWorktreeWorkerEvent {
  if (!isRecord(value) || !isOperation(value.operation)) return false;
  if (value.type === "setup-started") return value.operation === "create";
  if (value.type === "snapshot-started") {
    return value.operation === "snapshot" || value.operation === "remove";
  }
  if (value.type === "cleanup-started") return value.operation === "remove";
  if (value.type === "restore-started") return value.operation === "restore";
  if (value.type === "handoff-progress") {
    return (
      (value.operation === "prepare-handoff" ||
        value.operation === "rollback-handoff" ||
        value.operation === "export-handoff" ||
        value.operation === "import-handoff") &&
      typeof value.step === "string" &&
      (CODEX_WORKTREE_HANDOFF_STEPS as readonly string[]).includes(value.step) &&
      (value.status === "started" ||
        value.status === "completed" ||
        value.status === "skipped" ||
        value.status === "failed")
    );
  }
  if (value.type === "path-allocated") {
    return (
      (value.operation === "create" ||
        value.operation === "prepare-handoff" ||
        value.operation === "import-handoff") &&
      isAbsolutePath(value.worktreeGitRoot) &&
      isAbsolutePath(value.worktreeWorkspaceRoot)
    );
  }
  return (
    value.type === "output" &&
    (value.phase === "worktree" ||
      value.phase === "setup" ||
      value.phase === "snapshot" ||
      value.phase === "cleanup" ||
      value.phase === "restore") &&
    (value.stream === "stdout" || value.stream === "stderr" || value.stream === "info") &&
    typeof value.data === "string"
  );
}

function isCreateResult(value: unknown): value is CodexWorktreeWorkerCreateResult {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "worktreeGitRoot",
      "worktreeWorkspaceRoot",
      "setupError",
      "shellEnvironment",
    ]) &&
    isAbsolutePath(value.worktreeGitRoot) &&
    isAbsolutePath(value.worktreeWorkspaceRoot) &&
    isNullableString(value.setupError, 64_000) &&
    (value.shellEnvironment === null || isRecord(value.shellEnvironment))
  );
}

function isSnapshotResult(value: unknown): value is CodexWorktreeWorkerSnapshotResult {
  return (
    isRecord(value) &&
    isNonEmptyString(value.worktreeId, 128) &&
    isAbsolutePath(value.repositoryPath) &&
    isNonEmptyString(value.snapshotRef, 1_024) &&
    isNonEmptyString(value.commitId, 256) &&
    typeof value.changed === "boolean"
  );
}

function isAvailability(value: unknown): value is CodexWorktreeWorkerAvailability {
  if (!isRecord(value)) return false;
  if (value.state === "available" || value.state === "gone") return true;
  if (value.state === "restorable") {
    return isAbsolutePath(value.repositoryPath) && isNonEmptyString(value.snapshotRef, 1_024);
  }
  return (
    value.state === "unavailable" &&
    (value.reason === "inspection-failed" || value.reason === "no-candidate-roots") &&
    isNonEmptyString(value.message, 64_000)
  );
}

function isSuccess(
  value: unknown,
  operation: CodexWorktreeWorkerOperation,
): value is CodexWorktreeWorkerSuccess {
  if (!isRecord(value) || value.operation !== operation || !("value" in value)) return false;
  const result = value.value;
  switch (operation) {
    case "create":
      return isCreateResult(result);
    case "list":
      return (
        isRecord(result) &&
        Array.isArray(result.entries) &&
        result.entries.length <= 100_000 &&
        result.entries.every(
          (entry) =>
            isRecord(entry) &&
            isAbsolutePath(entry.worktreeGitRoot) &&
            (entry.repositoryPath === null || isAbsolutePath(entry.repositoryPath)) &&
            (entry.createdAtMs === null ||
              (typeof entry.createdAtMs === "number" &&
                Number.isFinite(entry.createdAtMs) &&
                entry.createdAtMs >= 0 &&
                entry.createdAtMs <= Number.MAX_SAFE_INTEGER)) &&
            (entry.ownerThreadId === null || isNonEmptyString(entry.ownerThreadId, 1_024)) &&
            typeof entry.ownerReadFailed === "boolean",
        )
      );
    case "inspect":
      return isRecord(result) && isAvailability(result.availability);
    case "snapshot":
      return isSnapshotResult(result);
    case "remove":
      return (
        isRecord(result) &&
        typeof result.removed === "boolean" &&
        typeof result.alreadyMissing === "boolean" &&
        (result.snapshot === null || isSnapshotResult(result.snapshot)) &&
        Array.isArray(result.warnings) &&
        result.warnings.length <= 128 &&
        result.warnings.every((warning) => typeof warning === "string")
      );
    case "restore":
      return (
        isRecord(result) &&
        isAbsolutePath(result.worktreeGitRoot) &&
        isAbsolutePath(result.cwd) &&
        isAbsolutePath(result.repositoryPath) &&
        isNonEmptyString(result.snapshotRef, 1_024) &&
        isNullableString(result.ownerWarning, 64_000)
      );
    case "set-owner":
      return isRecord(result) && isNonEmptyString(result.ownerThreadId, 1_024);
    case "prepare-handoff":
      return isPreparedHandoff(result);
    case "rollback-handoff":
      return (
        isRecord(result) && typeof result.rolledBack === "boolean" && isWarnings(result.warnings)
      );
    case "cleanup-handoff":
      return isRecord(result) && typeof result.cleaned === "boolean" && isWarnings(result.warnings);
    case "export-handoff":
      return (
        isRecord(result) &&
        isAbsolutePath(result.sourceRepositoryPath) &&
        isNonEmptyString(result.sourceBranch, 1_024) &&
        isNonEmptyString(result.sourceCommit, 256) &&
        isNonEmptyString(result.temporaryRef, 1_024) &&
        isRepositoryIdentity(result.repositoryIdentity) &&
        isRecord(result.bundle) &&
        isAbsolutePath(result.bundle.path) &&
        typeof result.bundle.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(result.bundle.sha256) &&
        Number.isSafeInteger(result.bundle.size) &&
        Number(result.bundle.size) >= 0
      );
    case "import-handoff":
      return (
        isRecord(result) &&
        isAbsolutePath(result.destinationRepositoryPath) &&
        isAbsolutePath(result.destinationWorkspaceRoot) &&
        isAbsolutePath(result.destinationGitRoot) &&
        isAbsolutePath(result.managedWorktreePath) &&
        isNonEmptyString(result.temporaryRef, 1_024) &&
        isAbsolutePath(result.destinationRolloutPath) &&
        typeof result.destinationRolloutCreated === "boolean"
      );
    case "cleanup-transfer-handoff":
      return isRecord(result) && typeof result.cleaned === "boolean" && isWarnings(result.warnings);
  }
}

export function isCodexWorktreeWorkerThreadMessage(
  value: unknown,
): value is CodexWorktreeWorkerThreadMessage {
  if (!isRecord(value)) return false;
  if (value.type === "ready") {
    return (
      hasOnlyKeys(value, ["type", "epoch", "hostId", "protocolVersion"]) &&
      Number.isSafeInteger(value.epoch) &&
      isNonEmptyString(value.hostId, 512) &&
      value.protocolVersion === CODEX_WORKTREE_WORKER_PROTOCOL_VERSION
    );
  }
  if (!isNonEmptyString(value.id, 1_024) || !isOperation(value.operation)) return false;
  if (value.type === "event") {
    return isWorkerEvent(value.event) && value.event.operation === value.operation;
  }
  if (value.type !== "result" || !isRecord(value.result)) return false;
  if (value.result.type === "error") {
    return (
      (value.result.code === "canceled" ||
        value.result.code === "invalid-request" ||
        value.result.code === "operation-failed") &&
      typeof value.result.message === "string" &&
      typeof value.result.retryable === "boolean"
    );
  }
  return value.result.type === "ok" && isSuccess(value.result.success, value.operation);
}

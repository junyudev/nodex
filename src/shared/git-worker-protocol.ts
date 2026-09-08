export const GIT_WORKER_PROTOCOL_VERSION = 2 as const;

export const GIT_WORKER_MESSAGE_FROM_VIEW_CHANNEL = "git-worker:message-from-view" as const;
export const GIT_WORKER_MESSAGE_FOR_VIEW_CHANNEL = "git-worker:message-for-view" as const;

const MAX_GIT_WORKER_ID_LENGTH = 256;
const MAX_GIT_WORKER_PROBE_NONCE_LENGTH = 1_024;

export interface GitWorkerMethodMap {
  "stable-metadata": {
    params: import("./types").GitReviewRepositoryMetadataRequest;
    result: import("./types").GitReviewRepositoryMetadataResult;
  };
  "branch-metadata": {
    params: import("./types").GitBranchMetadataRequest;
    result: import("./types").GitBranchMetadataResult;
  };
  "status-summary": {
    params: import("./git-review").GitStatusSummaryRequest;
    result: import("./git-review").GitStatusSummaryResult;
  };
  "action-status": {
    params: import("./types").GitActionStatusRequest;
    result: import("./types").GitActionStatusResult;
  };
  "review-summary": {
    params: import("./types").GitReviewSummaryRequest;
    result: import("./git-review").GitWorkerReviewSummaryResult;
  };
  "branch-diff-stats": {
    params: import("./types").BranchDiffStatsRequest;
    result: import("./git-review").GitWorkerSnapshotResult<import("./types").BranchDiffStatsResult>;
  };
  "review-diff": {
    params: import("./types").ReviewDiffRequest;
    result: import("./types").ReviewDiffResult;
  };
  "review-cat-file": {
    params: import("./types").GitReviewCatFileInput;
    result: import("./git-review").GitWorkerCatFileResult;
  };
  "review-generated-paths": {
    params: { cwd: string; paths: string[] };
    result: { paths: string[]; hasLinguistGeneratedAttributes: boolean };
  };
  "review-search": {
    params: import("./types").GitReviewSearchInput;
    result: import("./git-review").GitWorkerSnapshotResult<import("./types").GitReviewSearchResult>;
  };
  "review-patch": {
    params: import("./types").GitReviewPatchRequest;
    result: import("./git-review").GitWorkerSnapshotResult<import("./types").GitReviewPatchResult>;
  };
  "blame-file": {
    params: import("./types").GitReviewBlameInput;
    result: import("./types").GitReviewBlameResult;
  };
  "base-branch": {
    params: import("./types").GitReviewBaseBranchRequest;
    result: import("./types").GitReviewBaseBranchResult;
  };
  "branch-commits": {
    params: import("./types").GitReviewBranchCommitsRequest;
    result: import("./types").GitReviewBranchCommitsResult;
  };
  "merge-base": {
    params: import("./types").GitMergeBaseRequest;
    result: import("./types").GitMergeBaseResult;
  };
  "refresh-repository": {
    params: import("./git-review").GitRefreshRepositoryRequest;
    result: import("./git-review").GitRefreshRepositoryResult;
  };
  "git-init-repo": {
    params: { cwd: string };
    result: import("./types").GitReviewSnapshot;
  };
  "apply-patch": {
    params: import("./types").GitApplyPatchInput;
    result: import("./types").GitApplyPatchResult;
  };
  "checkout-branch": {
    params: import("./types").GitBranchMutationInput;
    result: import("./git-review").GitWorkerBranchMutationResult;
  };
  "create-branch": {
    params: import("./types").GitBranchMutationInput;
    result: import("./git-review").GitWorkerBranchMutationResult;
  };
  commit: {
    params: import("./types").GitCommitInput;
    result: import("./types").GitActionMutationResult;
  };
  push: {
    params: import("./types").GitPushInput;
    result: import("./types").GitActionMutationResult;
  };
  "subscribe-live-query": {
    params: import("./types").GitReviewLiveSubscriptionInput;
    result: { subscribed: true };
  };
  "unsubscribe-live-query": {
    params: import("./types").GitReviewLiveSubscriptionStopInput;
    result: { unsubscribed: boolean };
  };
  "recover-live-query": {
    params: import("./types").GitReviewLiveSubscriptionStopInput;
    result: { recovered: boolean };
  };
  "refresh-live-query": {
    params: import("./types").GitReviewLiveSubscriptionStopInput;
    result: { refreshed: boolean };
  };
  probe: {
    params: {
      nonce: string;
    };
    result: {
      nonce: string;
      protocolVersion: typeof GIT_WORKER_PROTOCOL_VERSION;
    };
  };
}

export type GitWorkerMethod = keyof GitWorkerMethodMap;

export type GitWorkerRequest = {
  [Method in GitWorkerMethod]: {
    type: "worker-request";
    workerId: "git";
    request: {
      id: string;
      method: Method;
      params: GitWorkerMethodMap[Method]["params"];
      enqueuedAtMs: number;
    };
  };
}[GitWorkerMethod];

export interface GitWorkerRequestCancel {
  type: "worker-request-cancel";
  workerId: "git";
  id: string;
}

export type GitWorkerMessageFromView = GitWorkerRequest | GitWorkerRequestCancel;

export interface GitWorkerInfrastructureError {
  code: "protocol-error" | "worker-unavailable";
  message: string;
}

export type GitWorkerResponse = {
  [Method in GitWorkerMethod]: {
    type: "worker-response";
    workerId: "git";
    id: string;
    method: Method;
    result:
      | {
          type: "ok";
          value: GitWorkerMethodMap[Method]["result"];
        }
      | {
          type: "error";
          error: GitWorkerInfrastructureError;
        };
  };
}[GitWorkerMethod];

export interface GitWorkerRestartedEvent {
  type: "worker-restarted";
  workerId: "git";
  epoch: number;
}

export interface GitWorkerLiveQueryEvent {
  type: "git-live-query-event";
  workerId: "git";
  event: import("./types").GitReviewLiveEvent;
}

export type GitPerformanceOperationTrigger = "direct" | "live" | "mutation";
export type GitPerformanceOperationOutcome =
  | "success"
  | "stale"
  | "canceled"
  | "timed-out"
  | "operational-error"
  | "infrastructure-error";

export interface GitPerformanceOperationMetric {
  operation: string;
  trigger: GitPerformanceOperationTrigger;
  outcome: GitPerformanceOperationOutcome;
  durationMs: number;
  firstResultMs: number;
  queueDurationMs: number;
  commandCount: number;
  peakConcurrency: number;
  statusCommandCount: number;
  fullUntrackedScanCount: number;
  unscopedAllStatusCount: number;
  cacheHits: number;
  cacheMisses: number;
  coalescedQueries: number;
  timedOut: boolean;
  canceled: boolean;
  outputLimitExceeded: boolean;
  repoIndexSizeBucket: "unknown" | "small" | "medium" | "large";
}

export interface GitWorkerPerformanceOperationEvent {
  type: "git-performance-operation";
  workerId: "git";
  metric: GitPerformanceOperationMetric;
}

export type GitWorkerMessageForView =
  | GitWorkerResponse
  | GitWorkerRestartedEvent
  | GitWorkerLiveQueryEvent;

export interface GitWorkerReadyMessage {
  type: "worker-ready";
  workerId: "git";
  epoch: number;
  protocolVersion: typeof GIT_WORKER_PROTOCOL_VERSION;
}

export interface GitWorkerShutdownMessage {
  type: "worker-shutdown";
  workerId: "git";
}

export type GitWorkerMessageFromHost = GitWorkerMessageFromView | GitWorkerShutdownMessage;

export type GitWorkerMessageFromThread =
  | GitWorkerReadyMessage
  | GitWorkerResponse
  | GitWorkerLiveQueryEvent
  | GitWorkerPerformanceOperationEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isRequestId(value: unknown): value is string {
  return isBoundedString(value, MAX_GIT_WORKER_ID_LENGTH);
}

function isProbeParams(value: unknown): value is GitWorkerMethodMap["probe"]["params"] {
  return isRecord(value) && isBoundedString(value.nonce, MAX_GIT_WORKER_PROBE_NONCE_LENGTH);
}

function isCwdParams(value: unknown): value is Record<string, unknown> & { cwd: string } {
  return isRecord(value) && isBoundedString(value.cwd, 4_096) && value.cwd.trim() === value.cwd;
}

function isOptionalBoundedString(value: unknown, maxLength = 4_096): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.length <= maxLength)
  );
}

function isGitReviewSource(value: unknown): boolean {
  return value === "unstaged" || value === "staged" || value === "branch" || value === "commit";
}

function hasValidReviewSourceParams(value: unknown): value is {
  cwd: string;
  source: import("./types").GitReviewSource;
} & Record<string, unknown> {
  return (
    isCwdParams(value) &&
    isGitReviewSource(value.source) &&
    isOptionalBoundedString(value.baseRef) &&
    isOptionalBoundedString(value.baseBranch) &&
    isOptionalBoundedString(value.commitSha, 256) &&
    isOptionalBoundedString(value.requestId, MAX_GIT_WORKER_ID_LENGTH)
  );
}

function hasValidBranchComparisonParams(value: unknown): boolean {
  return (
    isCwdParams(value) &&
    isOptionalBoundedString(value.baseRef) &&
    isOptionalBoundedString(value.baseBranch) &&
    isOptionalBoundedString(value.commitSha, 256) &&
    isOptionalBoundedString(value.requestId, MAX_GIT_WORKER_ID_LENGTH)
  );
}

function isReviewDiffParams(value: unknown): boolean {
  if (!hasValidReviewSourceParams(value)) return false;
  if (!Number.isSafeInteger(value.snapshotGeneration)) return false;
  if (value.files === undefined) return true;
  if (!Array.isArray(value.files) || value.files.length > 512) return false;
  return value.files.every(
    (file) =>
      isRecord(file) &&
      isBoundedString(file.path, 4_096) &&
      isGitReviewFileStatus(file.status) &&
      isOptionalBoundedString(file.previousPath) &&
      isOptionalBoundedString(file.revision, 512),
  );
}

function isGitReviewFileStatus(value: unknown): boolean {
  return (
    value === "modified" ||
    value === "added" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "copied" ||
    value === "type-changed" ||
    value === "unmerged" ||
    value === "untracked"
  );
}

function isCatFileParams(value: unknown): boolean {
  return (
    isCwdParams(value) &&
    Number.isSafeInteger(value.snapshotGeneration) &&
    Array.isArray(value.requests) &&
    value.requests.length <= 256 &&
    value.requests.every(
      (request) =>
        isRecord(request) &&
        isOptionalBoundedString(request.oid, 256) &&
        isBoundedString(request.path, 4_096) &&
        (request.fallbackToDisk === undefined || typeof request.fallbackToDisk === "boolean"),
    )
  );
}

function isSubscriptionIdParams(value: unknown): value is {
  subscriptionId: string;
} & Record<string, unknown> {
  return isRecord(value) && isBoundedString(value.subscriptionId, MAX_GIT_WORKER_ID_LENGTH);
}

function isLiveQueryParams(value: unknown): boolean {
  if (!isSubscriptionIdParams(value) || !isRecord(value.query)) return false;
  const query = value.query;
  if (
    query.method !== "stable-metadata" &&
    query.method !== "status-summary" &&
    query.method !== "review-summary" &&
    query.method !== "branch-diff-stats" &&
    query.method !== "branch-commits" &&
    query.method !== "base-branch" &&
    query.method !== "branch-metadata"
  ) {
    return false;
  }
  return isMethodParams(query.method, query.params);
}

function isMethodParams(method: unknown, params: unknown): method is GitWorkerMethod {
  if (method === "probe") return isProbeParams(params);
  if (
    method === "stable-metadata" ||
    method === "branch-metadata" ||
    method === "action-status" ||
    method === "status-summary"
  ) {
    return isCwdParams(params);
  }
  if (method === "review-summary" || method === "review-patch") {
    return hasValidReviewSourceParams(params);
  }
  if (method === "branch-diff-stats") {
    return hasValidBranchComparisonParams(params);
  }
  if (method === "review-diff") return isReviewDiffParams(params);
  if (method === "review-cat-file") return isCatFileParams(params);
  if (method === "review-generated-paths") {
    return (
      isCwdParams(params) &&
      Array.isArray(params.paths) &&
      params.paths.length <= 100_000 &&
      params.paths.every((path) => isBoundedString(path, 4_096))
    );
  }
  if (method === "review-search") {
    return hasValidReviewSourceParams(params) && isBoundedString(params.query, 4_096);
  }
  if (method === "blame-file") {
    return (
      isCwdParams(params) &&
      isBoundedString(params.path, 4_096) &&
      isOptionalBoundedString(params.ref, 512)
    );
  }
  if (method === "base-branch") {
    return isCwdParams(params);
  }
  if (method === "branch-commits") {
    return isCwdParams(params) && isOptionalBoundedString(params.baseBranch, 512);
  }
  if (method === "merge-base") {
    return (
      isCwdParams(params) &&
      isBoundedString(params.baseBranch, 512) &&
      isOptionalBoundedString(params.gitRoot)
    );
  }
  if (method === "refresh-repository" || method === "git-init-repo") {
    return isCwdParams(params);
  }
  if (method === "checkout-branch" || method === "create-branch") {
    return isCwdParams(params) && isBoundedString(params.branch, 512);
  }
  if (method === "apply-patch") {
    return (
      isCwdParams(params) &&
      typeof params.diff === "string" &&
      params.diff.length <= 32 * 1024 * 1024 &&
      (params.target === "staged" || params.target === "unstaged") &&
      (params.revert === undefined || typeof params.revert === "boolean")
    );
  }
  if (method === "commit") {
    return (
      isCwdParams(params) &&
      isBoundedString(params.message, 1_000_000) &&
      (params.includeUnstaged === undefined || typeof params.includeUnstaged === "boolean") &&
      (params.nextStep === undefined ||
        params.nextStep === "commit" ||
        params.nextStep === "commit-and-push")
    );
  }
  if (method === "push") {
    return isCwdParams(params) && (params.force === undefined || typeof params.force === "boolean");
  }
  if (method === "subscribe-live-query") return isLiveQueryParams(params);
  if (
    method === "unsubscribe-live-query" ||
    method === "recover-live-query" ||
    method === "refresh-live-query"
  ) {
    return isSubscriptionIdParams(params);
  }
  return false;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStableMetadataResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.cwd === "string" &&
    isNullableString(value.root) &&
    isNullableString(value.gitDir) &&
    isNullableString(value.commonDir) &&
    typeof value.isGitRepository === "boolean" &&
    isNullableString(value.currentBranch) &&
    isNullableString(value.defaultBranch) &&
    isNullableString(value.errorMessage)
  );
}

function isStatusSummaryResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "error") {
    return (
      (value.failureReason === "canceled" ||
        value.failureReason === "not-a-repository" ||
        value.failureReason === "status-config" ||
        value.failureReason === "status-command" ||
        value.failureReason === "untracked-paths" ||
        value.failureReason === "timed-out") &&
      isNullableString(value.errorMessage)
    );
  }
  return (
    value.type === "success" &&
    Number.isSafeInteger(value.stagedCount) &&
    Number.isSafeInteger(value.unstagedCount) &&
    (value.untrackedCount === null || Number.isSafeInteger(value.untrackedCount)) &&
    Number.isSafeInteger(value.snapshotGeneration)
  );
}

function isReviewSummaryResult(value: unknown): boolean {
  if (!isRecord(value) || !isGitReviewSource(value.source)) return false;
  if (value.type === "stale-snapshot") return true;
  if (value.type === "error") return isNullableString(value.errorMessage);
  return (
    value.type === "success" &&
    Array.isArray(value.files) &&
    Number.isSafeInteger(value.snapshotGeneration) &&
    isRecord(value.stageCounts) &&
    Number.isSafeInteger(value.untrackedFilesOmitted)
  );
}

function isReviewDiffResult(value: unknown): boolean {
  if (!isRecord(value) || !isGitReviewSource(value.source)) return false;
  return (
    value.type === "stale-snapshot" ||
    (value.type === "success" &&
      Array.isArray(value.files) &&
      Number.isSafeInteger(value.snapshotGeneration))
  );
}

function isCatFileResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "stale-snapshot") return true;
  return (
    value.type === "success" &&
    isRecord(value.value) &&
    Number.isSafeInteger(value.value.snapshotGeneration) &&
    Array.isArray(value.value.results)
  );
}

function hasResultShape(value: unknown): boolean {
  return isRecord(value);
}

function isMethodResult(method: GitWorkerMethod, value: unknown): boolean {
  if (method === "stable-metadata") return isStableMetadataResult(value);
  if (method === "status-summary") return isStatusSummaryResult(value);
  if (method === "review-summary") return isReviewSummaryResult(value);
  if (method === "review-diff") return isReviewDiffResult(value);
  if (method === "review-cat-file") return isCatFileResult(value);
  if (method === "review-generated-paths") {
    return (
      isRecord(value) &&
      Array.isArray(value.paths) &&
      value.paths.every((path) => typeof path === "string") &&
      typeof value.hasLinguistGeneratedAttributes === "boolean"
    );
  }
  if (method === "subscribe-live-query") {
    return isRecord(value) && value.subscribed === true;
  }
  if (method === "unsubscribe-live-query") {
    return isRecord(value) && typeof value.unsubscribed === "boolean";
  }
  if (method === "recover-live-query") {
    return isRecord(value) && typeof value.recovered === "boolean";
  }
  if (method === "refresh-live-query") {
    return isRecord(value) && typeof value.refreshed === "boolean";
  }
  if (method !== "probe") return hasResultShape(value);
  return (
    isRecord(value) &&
    isBoundedString(value.nonce, MAX_GIT_WORKER_PROBE_NONCE_LENGTH) &&
    value.protocolVersion === GIT_WORKER_PROTOCOL_VERSION
  );
}

function isInfrastructureError(value: unknown): value is GitWorkerInfrastructureError {
  if (!isRecord(value) || typeof value.message !== "string") return false;
  return value.code === "protocol-error" || value.code === "worker-unavailable";
}

function isPerformanceOperationMetric(value: unknown): value is GitPerformanceOperationMetric {
  if (!isRecord(value)) return false;
  const durationFields = ["durationMs", "firstResultMs", "queueDurationMs"] as const;
  const countFields = [
    "commandCount",
    "peakConcurrency",
    "statusCommandCount",
    "fullUntrackedScanCount",
    "unscopedAllStatusCount",
    "cacheHits",
    "cacheMisses",
    "coalescedQueries",
  ] as const;
  return (
    isBoundedString(value.operation, 128) &&
    (value.trigger === "direct" || value.trigger === "live" || value.trigger === "mutation") &&
    (value.outcome === "success" ||
      value.outcome === "stale" ||
      value.outcome === "canceled" ||
      value.outcome === "timed-out" ||
      value.outcome === "operational-error" ||
      value.outcome === "infrastructure-error") &&
    durationFields.every(
      (field) =>
        typeof value[field] === "number" && Number.isFinite(value[field]) && value[field] >= 0,
    ) &&
    countFields.every(
      (field) =>
        typeof value[field] === "number" && Number.isSafeInteger(value[field]) && value[field] >= 0,
    ) &&
    typeof value.timedOut === "boolean" &&
    typeof value.canceled === "boolean" &&
    typeof value.outputLimitExceeded === "boolean" &&
    (value.repoIndexSizeBucket === "unknown" ||
      value.repoIndexSizeBucket === "small" ||
      value.repoIndexSizeBucket === "medium" ||
      value.repoIndexSizeBucket === "large")
  );
}

export function isGitWorkerMessageFromView(value: unknown): value is GitWorkerMessageFromView {
  if (!isRecord(value) || value.workerId !== "git") return false;
  if (value.type === "worker-request-cancel") {
    return isRequestId(value.id);
  }
  if (value.type !== "worker-request" || !isRecord(value.request)) return false;
  const request = value.request;
  return (
    isRequestId(request.id) &&
    isMethodParams(request.method, request.params) &&
    typeof request.enqueuedAtMs === "number" &&
    Number.isFinite(request.enqueuedAtMs)
  );
}

export function isGitWorkerMessageFromHost(value: unknown): value is GitWorkerMessageFromHost {
  if (isRecord(value) && value.type === "worker-shutdown" && value.workerId === "git") {
    return true;
  }
  return isGitWorkerMessageFromView(value);
}

export function isGitWorkerMessageFromThread(value: unknown): value is GitWorkerMessageFromThread {
  if (!isRecord(value) || value.workerId !== "git") return false;
  if (value.type === "worker-ready") {
    return (
      typeof value.epoch === "number" &&
      Number.isInteger(value.epoch) &&
      value.epoch >= 1 &&
      value.protocolVersion === GIT_WORKER_PROTOCOL_VERSION
    );
  }
  if (value.type === "git-live-query-event") {
    return isLiveQueryEvent(value.event);
  }
  if (value.type === "git-performance-operation") {
    return isPerformanceOperationMetric(value.metric);
  }
  if (
    value.type !== "worker-response" ||
    !isRequestId(value.id) ||
    !isGitWorkerMethod(value.method) ||
    !isRecord(value.result)
  ) {
    return false;
  }
  if (value.result.type === "error") {
    return isInfrastructureError(value.result.error);
  }
  if (value.result.type !== "ok") return false;
  return isMethodResult(value.method, value.result.value);
}

const GIT_WORKER_METHODS: Record<GitWorkerMethod, true> = {
  "action-status": true,
  "base-branch": true,
  "blame-file": true,
  "apply-patch": true,
  "branch-metadata": true,
  "branch-commits": true,
  "branch-diff-stats": true,
  "checkout-branch": true,
  commit: true,
  "create-branch": true,
  "git-init-repo": true,
  "merge-base": true,
  "review-cat-file": true,
  "review-generated-paths": true,
  "review-diff": true,
  "review-patch": true,
  "review-search": true,
  "review-summary": true,
  "subscribe-live-query": true,
  "stable-metadata": true,
  "status-summary": true,
  "recover-live-query": true,
  "refresh-repository": true,
  "refresh-live-query": true,
  "unsubscribe-live-query": true,
  probe: true,
  push: true,
};

function isGitWorkerMethod(value: unknown): value is GitWorkerMethod {
  return typeof value === "string" && value in GIT_WORKER_METHODS;
}

export function isGitWorkerMessageForView(value: unknown): value is GitWorkerMessageForView {
  if (isRecord(value) && value.type === "worker-restarted" && value.workerId === "git") {
    return typeof value.epoch === "number" && Number.isInteger(value.epoch) && value.epoch >= 2;
  }
  return isGitWorkerMessageFromThread(value) && value.type !== "worker-ready";
}

function isLiveQueryEvent(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isSubscriptionIdParams(value) ||
    !Number.isSafeInteger(value.generation) ||
    typeof value.requiresRecovery !== "boolean"
  ) {
    return false;
  }
  if (value.type === "git-live-query-failed") {
    return typeof value.errorMessage === "string" && typeof value.method === "string";
  }
  return (
    value.type === "git-live-query-updated" &&
    (value.phase === "tracked" || value.phase === "complete") &&
    typeof value.method === "string" &&
    isRecord(value.result)
  );
}

export function createGitWorkerInfrastructureErrorResponse(
  request: Pick<GitWorkerRequest["request"], "id" | "method">,
  error: GitWorkerInfrastructureError,
): GitWorkerResponse {
  return {
    type: "worker-response",
    workerId: "git",
    id: request.id,
    method: request.method,
    result: {
      type: "error",
      error,
    },
  } as GitWorkerResponse;
}

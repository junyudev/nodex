import { normalizeWorktreePathForIdentity } from "./codex-managed-worktree-effects";

export const CODEX_OWNERLESS_WORKTREE_GRACE_MS = 60 * 60 * 1_000;
export const CODEX_OWNER_METADATA_MIGRATION_CUTOFF_MS = Date.parse("2026-02-21T00:00:00.000Z");

export type CodexManagedWorktreeProtectionReason =
  | "permanent"
  | "pinned"
  | "pending"
  | "newborn"
  | "handoff"
  | "in-progress"
  | "automation"
  | "young-ownerless"
  | "pre-migration-ownerless";

export interface CodexManagedWorktreeRetentionRecord {
  readonly hostId: string;
  readonly worktreeGitRoot: string;
  readonly createdAtMs: number | null;
  readonly ownerThreadId: string | null;
  readonly ownerReadFailed: boolean;
}

export interface CodexManagedWorktreeRetentionThreadMetadata {
  readonly threadId: string;
  readonly updatedAtMs: number;
  readonly pinned: boolean;
  readonly inProgress: boolean;
  readonly automationProtected: boolean;
}

export interface CodexManagedWorktreeRetentionPathProtection {
  readonly hostId: string;
  readonly worktreeGitRoot: string;
  readonly reason: CodexManagedWorktreeProtectionReason;
}

export interface CodexManagedWorktreeRetentionPlanInput {
  readonly enabled: boolean;
  readonly keepCount: number;
  readonly metadataComplete: boolean;
  readonly records: readonly CodexManagedWorktreeRetentionRecord[];
  readonly threadMetadata: readonly CodexManagedWorktreeRetentionThreadMetadata[];
  readonly pathProtections: readonly CodexManagedWorktreeRetentionPathProtection[];
  readonly protectPreMigrationOwnerlessWorktrees: boolean;
  readonly nowMs: number;
}

export interface CodexManagedWorktreeRetentionPlanItem extends CodexManagedWorktreeRetentionRecord {
  readonly key: string;
  readonly ownerUpdatedAtMs: number | null;
  readonly protectionReasons: readonly CodexManagedWorktreeProtectionReason[];
}

export type CodexManagedWorktreeRetentionPlan =
  | {
      readonly status: "skipped";
      readonly reason: "disabled" | "metadata-incomplete" | "invalid-keep-count";
      readonly items: readonly CodexManagedWorktreeRetentionPlanItem[];
      readonly orderedCandidates: readonly CodexManagedWorktreeRetentionPlanItem[];
      readonly keep: readonly CodexManagedWorktreeRetentionPlanItem[];
      readonly delete: readonly CodexManagedWorktreeRetentionPlanItem[];
    }
  | {
      readonly status: "planned";
      readonly items: readonly CodexManagedWorktreeRetentionPlanItem[];
      readonly orderedCandidates: readonly CodexManagedWorktreeRetentionPlanItem[];
      readonly keep: readonly CodexManagedWorktreeRetentionPlanItem[];
      readonly delete: readonly CodexManagedWorktreeRetentionPlanItem[];
    };

function retentionKey(hostId: string, worktreeGitRoot: string): string {
  return `${hostId.trim()}\0${normalizeWorktreePathForIdentity(worktreeGitRoot)}`;
}

function comparePath(
  left: CodexManagedWorktreeRetentionPlanItem,
  right: CodexManagedWorktreeRetentionPlanItem,
): number {
  return left.key.localeCompare(right.key);
}

function compareOwnerless(
  left: CodexManagedWorktreeRetentionPlanItem,
  right: CodexManagedWorktreeRetentionPlanItem,
): number {
  const leftCreated = left.createdAtMs ?? Number.MAX_SAFE_INTEGER;
  const rightCreated = right.createdAtMs ?? Number.MAX_SAFE_INTEGER;
  return leftCreated - rightCreated || comparePath(left, right);
}

function compareOwned(
  left: CodexManagedWorktreeRetentionPlanItem,
  right: CodexManagedWorktreeRetentionPlanItem,
): number {
  return (left.ownerUpdatedAtMs ?? 0) - (right.ownerUpdatedAtMs ?? 0) || comparePath(left, right);
}

function emptySkipped(
  reason: Extract<CodexManagedWorktreeRetentionPlan, { status: "skipped" }>["reason"],
): CodexManagedWorktreeRetentionPlan {
  return {
    status: "skipped",
    reason,
    items: [],
    orderedCandidates: [],
    keep: [],
    delete: [],
  };
}

/**
 * Computes cleanup from one immutable metadata cut. Filesystem reads and
 * removal deliberately live outside this function so a partial refresh can
 * never be mistaken for an empty protection set.
 */
export function planManagedWorktreeRetention(
  input: CodexManagedWorktreeRetentionPlanInput,
): CodexManagedWorktreeRetentionPlan {
  if (!input.enabled) return emptySkipped("disabled");
  if (!Number.isSafeInteger(input.keepCount) || input.keepCount < 1) {
    return emptySkipped("invalid-keep-count");
  }
  if (!input.metadataComplete) return emptySkipped("metadata-incomplete");

  const threadById = new Map(input.threadMetadata.map((thread) => [thread.threadId, thread]));
  const pathReasons = new Map<string, Set<CodexManagedWorktreeProtectionReason>>();
  for (const protection of input.pathProtections) {
    const key = retentionKey(protection.hostId, protection.worktreeGitRoot);
    const reasons = pathReasons.get(key) ?? new Set();
    reasons.add(protection.reason);
    pathReasons.set(key, reasons);
  }

  const items = input.records.map((record): CodexManagedWorktreeRetentionPlanItem => {
    const key = retentionKey(record.hostId, record.worktreeGitRoot);
    const reasons = new Set(pathReasons.get(key) ?? []);
    const owner =
      record.ownerThreadId === null ? null : (threadById.get(record.ownerThreadId) ?? null);
    if (owner?.pinned) reasons.add("pinned");
    if (owner?.inProgress) reasons.add("in-progress");
    if (owner?.automationProtected) reasons.add("automation");
    if (record.ownerThreadId === null && record.createdAtMs !== null) {
      if (input.nowMs - record.createdAtMs < CODEX_OWNERLESS_WORKTREE_GRACE_MS) {
        reasons.add("young-ownerless");
      }
      if (
        input.protectPreMigrationOwnerlessWorktrees &&
        record.createdAtMs < CODEX_OWNER_METADATA_MIGRATION_CUTOFF_MS
      ) {
        reasons.add("pre-migration-ownerless");
      }
    }
    return {
      ...record,
      key,
      ownerUpdatedAtMs: owner?.updatedAtMs ?? null,
      protectionReasons: [...reasons].sort(),
    };
  });

  const eligible = items.filter((item) => item.protectionReasons.length === 0);
  const orderedCandidates = [
    ...eligible.filter((item) => item.ownerThreadId === null).sort(compareOwnerless),
    ...eligible.filter((item) => item.ownerThreadId !== null).sort(compareOwned),
  ];
  const deleteCount =
    input.records.length <= input.keepCount
      ? 0
      : Math.max(0, orderedCandidates.length - input.keepCount);
  const deleting = orderedCandidates.slice(0, deleteCount);
  const deletingKeys = new Set(deleting.map((item) => item.key));
  return {
    status: "planned",
    items,
    orderedCandidates,
    keep: items.filter((item) => !deletingKeys.has(item.key)),
    delete: deleting,
  };
}

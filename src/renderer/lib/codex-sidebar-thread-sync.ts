import type {
  CodexSidebarSnapshot,
  CodexSidebarThreadItem,
  Project,
  ProjectSessionSummary,
} from "./types";
import type { CodexPendingWorktreeEntry } from "../../shared/codex-pending-worktree";
import {
  codexSidebarProjectThreadContainerId,
  type CodexSidebarThreadContainerId,
} from "../../shared/codex-sidebar-thread-move";
import { CODEX_AGENT_BACKEND_BINDING } from "../../shared/agent-backend";

export interface CodexSidebarProjectGroup {
  project: Project;
  pinnedThreadKeys: string[];
  threadKeys: string[];
}

export interface CodexSidebarThreadSyncModel {
  snapshot: CodexSidebarSnapshot;
  threadItemsByKey: Map<string, CodexSidebarThreadItem>;
  pinnedThreadKeys: string[];
  projectGroups: CodexSidebarProjectGroup[];
  projectlessThreadKeys: string[];
}

export function isCodexSidebarRootThread(
  thread: { readonly parentThreadId?: string | null } | null | undefined,
): boolean {
  return thread?.parentThreadId == null;
}

export function isCodexSidebarThreadItemVisible(item: CodexSidebarThreadItem): boolean {
  return item.kind === "remote" || isCodexSidebarRootThread(item);
}

export function codexSidebarLocalThreadKey(threadIdentity: string): string {
  return `local:${threadIdentity}`;
}

export function resolveCodexSidebarThreadHomeContainerId(input: {
  kind: CodexSidebarThreadItem["kind"];
  pinned: boolean;
  projectId: string | null;
  projectless: boolean;
  knownProjectIds: ReadonlySet<string>;
}): CodexSidebarThreadContainerId | null {
  if (input.projectId !== null) {
    if (input.knownProjectIds.has(input.projectId)) {
      return codexSidebarProjectThreadContainerId(input.projectId, input.pinned);
    }
    return input.pinned ? "pinned" : null;
  }
  if (input.projectless) return input.pinned ? "pinned" : "chats";
  if (input.kind === "remote") return "cloud";
  return null;
}

function pendingWorktreeProjectId(entry: CodexPendingWorktreeEntry): string | null {
  if (entry.launchMode === "start-conversation") {
    return entry.startConversationParamsInput.projectAssignment?.projectId ?? null;
  }
  if (entry.launchMode === "fork-conversation") {
    return entry.projectAssignment?.projectId ?? null;
  }
  return null;
}

function pendingWorktreeStatusType(
  entry: CodexPendingWorktreeEntry,
): CodexSidebarThreadItem["statusType"] {
  if (entry.phase === "failed") return "systemError";
  if (entry.phase === "queued" || entry.phase === "creating") return "active";
  return "idle";
}

export function mergePendingWorktreesIntoSidebarSnapshot(
  snapshot: CodexSidebarSnapshot,
  entries: readonly CodexPendingWorktreeEntry[],
): CodexSidebarSnapshot {
  const pendingItems = entries.flatMap((entry): CodexSidebarThreadItem[] => {
    if (entry.launchMode === "create-stable-worktree") return [];
    const projectId = pendingWorktreeProjectId(entry);
    const isLocalHost = entry.hostId === "local";
    const worktreePath = entry.worktreeWorkspaceRoot ?? entry.worktreeGitRoot;
    const phase = worktreePath === null ? "pending" : "ready";
    return [
      {
        key: codexSidebarLocalThreadKey(entry.clientThreadId),
        kind: "pending-worktree",
        backendBinding: CODEX_AGENT_BACKEND_BINDING,
        runLocation: isLocalHost
          ? { kind: "local-worktree", path: worktreePath, phase }
          : { kind: "remote-worktree", hostId: entry.hostId, path: worktreePath, phase },
        pendingWorktreeId: entry.id,
        clientThreadId: entry.clientThreadId,
        hostId: entry.hostId,
        threadId: entry.clientThreadId,
        parentThreadId: null,
        sessionId: null,
        projectId,
        title: entry.label,
        preview: entry.prompt,
        cwd: entry.sourceWorkspaceRoot,
        updatedAt: entry.createdAt,
        recencyAt: null,
        createdAt: entry.createdAt,
        pinned: entry.isPinned,
        pinnedOrder: null,
        unread: entry.needsAttention,
        snoozedUntil: null,
        snoozedAt: null,
        wokeAt: null,
        needsAttention: entry.needsAttention,
        archived: false,
        statusType: pendingWorktreeStatusType(entry),
        statusActiveFlags: [],
        projectless: projectId === null,
        disabled: false,
      },
    ];
  });
  const items: CodexSidebarThreadItem[] = [];
  const seenKeys = new Set<string>();
  for (const item of [...snapshot.items, ...pendingItems]) {
    if (seenKeys.has(item.key)) continue;
    seenKeys.add(item.key);
    items.push(item);
  }
  return {
    ...snapshot,
    items,
  };
}

/** Show pending pins in snapshot order after the realized pins. */
export function orderCodexSidebarPinnedThreadKeys(input: {
  threadKeys: readonly string[];
  pinnedThreadIds: readonly string[];
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
}): string[] {
  const realThreadKeyById = new Map<string, string>();
  const pendingKeys: string[] = [];

  for (const threadKey of input.threadKeys) {
    const item = input.itemsByKey.get(threadKey);
    if (!item?.pinned) continue;
    if (item.pendingWorktreeId) {
      pendingKeys.push(threadKey);
      continue;
    }
    realThreadKeyById.set(item.threadId, threadKey);
  }

  const orderedKeys: string[] = [];
  for (const threadId of input.pinnedThreadIds) {
    const threadKey = realThreadKeyById.get(threadId);
    if (threadKey) orderedKeys.push(threadKey);
  }
  return [...orderedKeys, ...pendingKeys];
}

function listRealThreadIdsForSidebarKeys(
  threadKeys: readonly string[],
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>,
): string[] {
  return threadKeys.flatMap((threadKey) => {
    const item = itemsByKey.get(threadKey);
    return item && !item.pendingWorktreeId ? [item.threadId] : [];
  });
}

function sameUniqueStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  if (leftSet.size !== left.length) return false;
  const rightSet = new Set(right);
  if (rightSet.size !== right.length) return false;
  return left.every((value) => rightSet.has(value));
}

/** Replace only the visible slots inside a complete precomputed sidebar order. */
export function replaceVisibleCodexSidebarThreadKeyOrder(input: {
  threadKeysInDisplayOrder: readonly string[];
  visibleThreadKeys: readonly string[];
  nextVisibleThreadKeys: readonly string[];
}): string[] {
  if (!sameUniqueStringSet(input.visibleThreadKeys, input.nextVisibleThreadKeys)) {
    return [...input.threadKeysInDisplayOrder];
  }

  const fullThreadKeySet = new Set(input.threadKeysInDisplayOrder);
  if (input.visibleThreadKeys.some((threadKey) => !fullThreadKeySet.has(threadKey))) {
    return [...input.threadKeysInDisplayOrder];
  }

  const visibleThreadKeySet = new Set(input.visibleThreadKeys);
  let nextVisibleIndex = 0;
  return input.threadKeysInDisplayOrder.map((threadKey) => {
    if (!visibleThreadKeySet.has(threadKey)) return threadKey;
    const replacement = input.nextVisibleThreadKeys[nextVisibleIndex];
    nextVisibleIndex += 1;
    return replacement ?? threadKey;
  });
}

type SidebarThreadSortSession = Pick<
  ProjectSessionSummary,
  "id" | "activityAt" | "pinned" | "pinnedOrder" | "createdAt" | "updatedAt" | "thread"
>;

interface SidebarThreadSortEntry {
  key: string;
  item: CodexSidebarThreadItem;
  session: SidebarThreadSortSession | null;
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveItemPinned(entry: SidebarThreadSortEntry): boolean {
  return entry.session?.pinned ?? entry.item.pinned;
}

function resolveItemPinnedOrder(entry: SidebarThreadSortEntry): number {
  return entry.session?.pinnedOrder ?? entry.item.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
}

function resolveItemActivityAt(entry: SidebarThreadSortEntry): number {
  return (
    entry.session?.activityAt ??
    finiteNumberOrNull(entry.item.recencyAt) ??
    finiteNumberOrNull(entry.item.createdAt) ??
    parseDateMs(entry.session?.createdAt) ??
    Number.NEGATIVE_INFINITY
  );
}

function compareSidebarThreadSortEntries(
  left: SidebarThreadSortEntry,
  right: SidebarThreadSortEntry,
): number {
  const leftPinned = resolveItemPinned(left);
  const rightPinned = resolveItemPinned(right);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

  if (leftPinned && rightPinned) {
    const pinnedOrderDelta = resolveItemPinnedOrder(left) - resolveItemPinnedOrder(right);
    if (pinnedOrderDelta !== 0) return pinnedOrderDelta;
  }

  const leftActivity = resolveItemActivityAt(left);
  const rightActivity = resolveItemActivityAt(right);
  if (leftActivity !== rightActivity) return leftActivity > rightActivity ? -1 : 1;
  const leftId = left.session?.id ?? left.key;
  const rightId = right.session?.id ?? right.key;
  return leftId.localeCompare(rightId);
}

export function sortSidebarThreadKeysForDisplay(input: {
  threadKeys: readonly string[];
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
  sessionsById: ReadonlyMap<string, SidebarThreadSortSession>;
}): string[] {
  return input.threadKeys
    .flatMap((key): SidebarThreadSortEntry[] => {
      const item = input.itemsByKey.get(key);
      if (!item) return [];
      const session = item.sessionId ? (input.sessionsById.get(item.sessionId) ?? null) : null;
      return [{ key, item, session }];
    })
    .sort(compareSidebarThreadSortEntries)
    .map((entry) => entry.key);
}

/** Sort realized pins by Session order and append pending pins. */
export function orderSidebarPinnedSessionKeys(input: {
  threadKeys: readonly string[];
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
  sessionsById: ReadonlyMap<string, SidebarThreadSortSession>;
}): string[] {
  const durableKeys = sortSidebarThreadKeysForDisplay({
    ...input,
    threadKeys: input.threadKeys.filter((key) => !input.itemsByKey.get(key)?.pendingWorktreeId),
  });
  return orderCodexSidebarPinnedThreadKeys({
    threadKeys: input.threadKeys,
    pinnedThreadIds: listRealThreadIdsForSidebarKeys(durableKeys, input.itemsByKey),
    itemsByKey: input.itemsByKey,
  });
}

export function buildSidebarThreadSyncModel(input: {
  snapshot: CodexSidebarSnapshot;
  projects: readonly Project[];
}): CodexSidebarThreadSyncModel {
  const visibleItems = input.snapshot.items.filter(isCodexSidebarThreadItemVisible);
  const snapshot = {
    ...input.snapshot,
    items: visibleItems,
  };
  const threadItemsByKey = new Map<string, CodexSidebarThreadItem>();
  for (const item of visibleItems) {
    threadItemsByKey.set(item.key, item);
  }

  const pinnedThreadKeys = orderCodexSidebarPinnedThreadKeys({
    threadKeys: visibleItems.map((item) => item.key),
    pinnedThreadIds: input.snapshot.pinnedThreadIds,
    itemsByKey: threadItemsByKey,
  });

  const projectGroups = input.projects.map((project) => ({
    project,
    pinnedThreadKeys: pinnedThreadKeys.filter(
      (threadKey) => threadItemsByKey.get(threadKey)?.projectId === project.id,
    ),
    threadKeys: visibleItems
      .filter((item) => item.projectId === project.id && !item.pinned)
      .map((item) => item.key),
  }));

  const projectlessThreadKeys = visibleItems
    .filter((item) => item.projectless && !item.pinned)
    .map((item) => item.key);

  return {
    snapshot,
    threadItemsByKey,
    pinnedThreadKeys,
    projectGroups,
    projectlessThreadKeys,
  };
}

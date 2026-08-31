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
import {
  CODEX_AGENT_BACKEND_BINDING,
  isCodexAgentBackendBinding,
} from "../../shared/agent-backend";

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

export interface CodexPendingPinnedBeforeThreadUpdate {
  pendingWorktreeId: string;
  beforeThreadId: string | null;
}

export function isCodexSidebarRootThread(
  thread: { readonly parentThreadId?: string | null } | null | undefined,
): boolean {
  return thread?.parentThreadId == null;
}

export function isCodexSidebarThreadItemVisible(item: CodexSidebarThreadItem): boolean {
  return item.kind === "remote" || isCodexSidebarRootThread(item);
}

/** Cross-container and canonical-order mutation remains owned by the Codex backend. */
export function isCodexSidebarThreadItemReorderable(item: CodexSidebarThreadItem): boolean {
  return isCodexAgentBackendBinding(item.backendBinding);
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
        pinnedBeforeThreadId: entry.pinnedBeforeThreadId,
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

/** Exact `we`: insert pending pinned rows into the persisted real-thread order. */
export function orderCodexSidebarPinnedThreadKeys(input: {
  threadKeys: readonly string[];
  pinnedThreadIds: readonly string[];
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
}): string[] {
  const pinnedThreadIds = new Set(input.pinnedThreadIds);
  const realThreadKeyById = new Map<string, string>();
  const pendingKeysByBeforeThreadId = new Map<string | null, string[]>();

  for (const threadKey of input.threadKeys) {
    const item = input.itemsByKey.get(threadKey);
    if (!item?.pinned) continue;
    if (item.pendingWorktreeId) {
      const beforeThreadId = item.pinnedBeforeThreadId ?? null;
      const pendingKeys = pendingKeysByBeforeThreadId.get(beforeThreadId) ?? [];
      pendingKeys.push(threadKey);
      pendingKeysByBeforeThreadId.set(beforeThreadId, pendingKeys);
      continue;
    }
    if (pinnedThreadIds.has(item.threadId)) {
      realThreadKeyById.set(item.threadId, threadKey);
    }
  }

  const orderedKeys: string[] = [];
  const appendPendingBefore = (threadId: string | null) => {
    const keys = pendingKeysByBeforeThreadId.get(threadId);
    if (!keys) return;
    orderedKeys.push(...keys);
    pendingKeysByBeforeThreadId.delete(threadId);
  };
  for (const threadId of input.pinnedThreadIds) {
    appendPendingBefore(threadId);
    const threadKey = realThreadKeyById.get(threadId);
    if (threadKey) orderedKeys.push(threadKey);
  }
  appendPendingBefore(null);
  for (const keys of pendingKeysByBeforeThreadId.values()) orderedKeys.push(...keys);
  return orderedKeys;
}

/** Exact `X`: pending rows do not enter the persisted real pinned-thread array. */
export function listRealThreadIdsForSidebarKeys(
  threadKeys: readonly string[],
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>,
): string[] {
  return threadKeys.flatMap((threadKey) => {
    const item = itemsByKey.get(threadKey);
    return item && !item.pendingWorktreeId ? [item.threadId] : [];
  });
}

/** Exact `Z`/`Te`: each pending row points to the next realized thread after reorder. */
export function listPendingPinnedBeforeThreadUpdates(input: {
  sortablePinnedThreadKeys: readonly string[];
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
}): CodexPendingPinnedBeforeThreadUpdate[] {
  const updates: CodexPendingPinnedBeforeThreadUpdate[] = [];
  for (const [index, threadKey] of input.sortablePinnedThreadKeys.entries()) {
    const item = input.itemsByKey.get(threadKey);
    if (!item?.pendingWorktreeId) continue;
    let beforeThreadId: string | null = null;
    for (
      let nextIndex = index + 1;
      nextIndex < input.sortablePinnedThreadKeys.length;
      nextIndex += 1
    ) {
      const nextKey = input.sortablePinnedThreadKeys[nextIndex];
      if (!nextKey) continue;
      const nextItem = input.itemsByKey.get(nextKey);
      if (!nextItem || nextItem.pendingWorktreeId) continue;
      beforeThreadId = nextItem.threadId;
      break;
    }
    if ((item.pinnedBeforeThreadId ?? null) === beforeThreadId) continue;
    updates.push({
      pendingWorktreeId: item.pendingWorktreeId,
      beforeThreadId,
    });
  }
  return updates;
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

export function listReorderableCodexSidebarChatKeys(input: {
  visibleThreadKeys: readonly string[];
  getSessionId: (threadKey: string) => string | null;
}): string[] {
  return input.visibleThreadKeys.filter((threadKey) => input.getSessionId(threadKey) !== null);
}

/** Exact visible-slot replacement used before persisting the real pinned IDs. */
export function mergeVisibleCodexPinnedThreadOrder(input: {
  pinnedThreadIds: readonly string[];
  visibleThreadKeys: readonly string[];
  nextVisibleThreadKeys: readonly string[];
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
}): string[] {
  const pinnedThreadIdSet = new Set(input.pinnedThreadIds);
  const visibleThreadIds = listRealThreadIdsForSidebarKeys(
    input.visibleThreadKeys,
    input.itemsByKey,
  ).filter((threadId) => pinnedThreadIdSet.has(threadId));
  const nextVisibleThreadIds = listRealThreadIdsForSidebarKeys(
    input.nextVisibleThreadKeys,
    input.itemsByKey,
  ).filter((threadId) => pinnedThreadIdSet.has(threadId));
  const visibleThreadIdSet = new Set(visibleThreadIds);
  let nextIndex = 0;
  return input.pinnedThreadIds.flatMap((threadId) => {
    if (!visibleThreadIdSet.has(threadId)) return [threadId];
    const replacement = nextVisibleThreadIds[nextIndex];
    nextIndex += 1;
    return replacement ? [replacement] : [];
  });
}

export function buildCodexSidebarPinnedReorderMutation(input: {
  pinnedThreadIds: readonly string[];
  visibleThreadKeys: readonly string[];
  nextVisibleThreadKeys: readonly string[];
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
}): {
  pendingUpdates: CodexPendingPinnedBeforeThreadUpdate[];
  pinnedThreadIds: string[];
} {
  const pendingUpdates = listPendingPinnedBeforeThreadUpdates({
    sortablePinnedThreadKeys: input.nextVisibleThreadKeys,
    itemsByKey: input.itemsByKey,
  });
  const pinnedThreadIds = mergeVisibleCodexPinnedThreadOrder(input);
  return { pendingUpdates, pinnedThreadIds };
}

type SidebarThreadSortSession = Pick<
  ProjectSessionSummary,
  "id" | "order" | "pinned" | "pinnedOrder" | "createdAt" | "updatedAt" | "thread"
>;

interface SidebarThreadSortEntry {
  key: string;
  item: CodexSidebarThreadItem;
  session: SidebarThreadSortSession | null;
  sourceIndex: number;
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
  return entry.item.pinnedOrder ?? entry.session?.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
}

function resolveItemRecencyAt(entry: SidebarThreadSortEntry): number {
  return finiteNumberOrNull(entry.item.recencyAt) ?? 0;
}

function resolveItemCreatedAt(entry: SidebarThreadSortEntry): number {
  return finiteNumberOrNull(entry.item.createdAt) ?? parseDateMs(entry.session?.createdAt) ?? 0;
}

function resolveItemSessionOrder(entry: SidebarThreadSortEntry): number {
  return entry.session ? entry.session.order : Number.MAX_SAFE_INTEGER;
}

function isLocalNoThreadSessionEntry(entry: SidebarThreadSortEntry): boolean {
  return entry.session !== null && entry.session.thread === null;
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

  if (isLocalNoThreadSessionEntry(left) || isLocalNoThreadSessionEntry(right)) {
    const sessionOrderDelta = resolveItemSessionOrder(left) - resolveItemSessionOrder(right);
    if (sessionOrderDelta !== 0) return sessionOrderDelta;
  }

  const recencyAtDelta = resolveItemRecencyAt(right) - resolveItemRecencyAt(left);
  if (recencyAtDelta !== 0) return recencyAtDelta;

  const createdAtDelta = resolveItemCreatedAt(right) - resolveItemCreatedAt(left);
  if (createdAtDelta !== 0) return createdAtDelta;

  if (left.sourceIndex !== right.sourceIndex) return left.sourceIndex - right.sourceIndex;
  return left.key.localeCompare(right.key);
}

export function sortSidebarThreadKeysForDisplay(input: {
  threadKeys: readonly string[];
  itemsByKey: ReadonlyMap<string, CodexSidebarThreadItem>;
  sessionsById: ReadonlyMap<string, SidebarThreadSortSession>;
}): string[] {
  return input.threadKeys
    .flatMap((key, sourceIndex): SidebarThreadSortEntry[] => {
      const item = input.itemsByKey.get(key);
      if (!item) return [];
      const session = item.sessionId ? (input.sessionsById.get(item.sessionId) ?? null) : null;
      return [{ key, item, session, sourceIndex }];
    })
    .sort(compareSidebarThreadSortEntries)
    .map((entry) => entry.key);
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

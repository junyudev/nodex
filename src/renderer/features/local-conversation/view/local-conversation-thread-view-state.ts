import { useCallback, useLayoutEffect, useMemo } from "react";
import {
  appScope,
  scopedAtom,
  scopedAtomFamily,
  useScopeHandle,
  useScopedAtomValue,
  type ScopeHandle,
} from "@/lib/maitai";
import {
  THREAD_NEAR_BOTTOM_THRESHOLD_PX,
  type VirtualizedLatestTurnRestoreState,
  type VirtualizedTurnListRestoreState,
} from "./local-conversation-turn-virtualization";

export interface LocalConversationThreadRestoreSnapshot {
  readonly distanceFromBottomPx: number;
  readonly latestTurn: VirtualizedLatestTurnRestoreState | null;
  readonly virtualizedTurnList: VirtualizedTurnListRestoreState | null;
}

interface ConversationTurnCollapseKey {
  readonly conversationId: string;
  readonly turnSearchKey: string;
}

interface UserTurnEditDraftKey {
  readonly conversationId: string;
  readonly turnId: string;
}

interface LatestTurnCollapseTransitionEntry {
  readonly hasMcpApp: boolean;
  readonly turnSearchKey: string;
}

const EMPTY_COLLAPSE_KEY_INDEX: Readonly<Record<string, readonly string[]>> = Object.freeze({});

export const EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT: LocalConversationThreadRestoreSnapshot =
  Object.freeze({
    distanceFromBottomPx: 0,
    latestTurn: null,
    virtualizedTurnList: null,
  });

export const localConversationThreadRestoreSnapshotFamily = scopedAtomFamily({
  scope: appScope,
  debugLabel: "local-conversation-thread-restore-snapshot",
  create: () =>
    scopedAtom(appScope, EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT, {
      debugLabel: "snapshot",
    }),
});

export const localConversationTurnCollapseOverrideFamily = scopedAtomFamily({
  scope: appScope,
  debugLabel: "local-conversation-turn-collapse-override",
  key: ({ conversationId, turnSearchKey }: ConversationTurnCollapseKey) => ({
    conversationId,
    turnSearchKey,
  }),
  create: () => scopedAtom<boolean | null>(appScope, null, { debugLabel: "override" }),
});

const collapseKeysByConversationIdAtom = scopedAtom<Readonly<Record<string, readonly string[]>>>(
  appScope,
  EMPTY_COLLAPSE_KEY_INDEX,
  { debugLabel: "local-conversation-collapse-key-index" },
);

/** An open message edit keeps its draft while its Turn scrolls out of the virtualized window. */
export const localConversationUserTurnEditDraftFamily = scopedAtomFamily({
  scope: appScope,
  debugLabel: "local-conversation-user-turn-edit-draft",
  key: ({ conversationId, turnId }: UserTurnEditDraftKey) => ({ conversationId, turnId }),
  create: () => scopedAtom<string | null>(appScope, null, { debugLabel: "draft" }),
});

const editDraftTurnIdsByConversationIdAtom = scopedAtom<
  Readonly<Record<string, readonly string[]>>
>(appScope, EMPTY_COLLAPSE_KEY_INDEX, { debugLabel: "local-conversation-edit-draft-key-index" });

const deletedConversationIdsAtom = scopedAtom<Readonly<Record<string, true>>>(
  appScope,
  Object.freeze({}),
  { debugLabel: "local-conversation-deleted-view-state-ids" },
);

export function normalizeThreadRestoreDistanceFromBottomPx(distanceFromBottomPx: number): number {
  if (!Number.isFinite(distanceFromBottomPx)) return 0;
  const normalizedDistance = Math.max(0, distanceFromBottomPx);
  return normalizedDistance <= THREAD_NEAR_BOTTOM_THRESHOLD_PX ? 0 : normalizedDistance;
}

export function resolveLatestTurnCollapseTransition(input: {
  readonly entries: readonly LatestTurnCollapseTransitionEntry[];
  readonly latestTurnSearchKey: string | null;
  readonly previousLatestTurnSearchKey: string | null;
}): readonly string[] {
  const { entries, latestTurnSearchKey, previousLatestTurnSearchKey } = input;
  if (previousLatestTurnSearchKey === null || previousLatestTurnSearchKey === latestTurnSearchKey) {
    return [];
  }

  const turnSearchKeys = new Set<string>();
  const previousLatestTurn = entries.find(
    (entry) => entry.turnSearchKey === previousLatestTurnSearchKey,
  );
  if (previousLatestTurn?.hasMcpApp !== true) {
    turnSearchKeys.add(previousLatestTurnSearchKey);
  }

  const oldestMcpAppException = entries.at(-4);
  if (oldestMcpAppException?.hasMcpApp === true) {
    turnSearchKeys.add(oldestMcpAppException.turnSearchKey);
  }
  return [...turnSearchKeys];
}

function indexConversationKey(
  handle: ScopeHandle,
  index: typeof collapseKeysByConversationIdAtom,
  conversationId: string,
  key: string,
): void {
  if (handle.get(deletedConversationIdsAtom)[conversationId] === true) return;
  handle.set(index, (current) => {
    const currentKeys = current[conversationId] ?? [];
    if (currentKeys.includes(key)) return current;
    return {
      ...current,
      [conversationId]: [...currentKeys, key],
    };
  });
}

function removeConversationKeyIndex(
  handle: ScopeHandle,
  index: typeof collapseKeysByConversationIdAtom,
  conversationId: string,
): readonly string[] {
  const keys = handle.get(index)[conversationId] ?? [];
  if (keys.length === 0) return keys;
  handle.set(index, (current) => {
    if (!(conversationId in current)) return current;
    const next = { ...current };
    delete next[conversationId];
    return Object.keys(next).length === 0 ? EMPTY_COLLAPSE_KEY_INDEX : next;
  });
  return keys;
}

function indexCollapseKey(
  handle: ScopeHandle,
  { conversationId, turnSearchKey }: ConversationTurnCollapseKey,
): void {
  indexConversationKey(handle, collapseKeysByConversationIdAtom, conversationId, turnSearchKey);
}

export function setLocalConversationTurnCollapseOverride(
  handle: ScopeHandle,
  key: ConversationTurnCollapseKey,
  collapsed: boolean,
): void {
  if (handle.get(deletedConversationIdsAtom)[key.conversationId] === true) return;
  indexCollapseKey(handle, key);
  handle.set(localConversationTurnCollapseOverrideFamily(key), collapsed);
}

export function updateLocalConversationThreadRestoreSnapshot(
  handle: ScopeHandle,
  conversationId: string,
  update: (
    current: LocalConversationThreadRestoreSnapshot,
  ) => LocalConversationThreadRestoreSnapshot,
): boolean {
  if (handle.get(deletedConversationIdsAtom)[conversationId] === true) return false;
  handle.set(localConversationThreadRestoreSnapshotFamily(conversationId), update);
  return true;
}

export function removeLocalConversationViewState(
  handle: ScopeHandle,
  rawConversationId: string,
): boolean {
  const conversationId = rawConversationId.trim();
  if (!conversationId) return false;

  const deletedConversationIds = handle.get(deletedConversationIdsAtom);
  if (deletedConversationIds[conversationId] !== true) {
    handle.set(deletedConversationIdsAtom, {
      ...deletedConversationIds,
      [conversationId]: true,
    });
  }
  let removed = localConversationThreadRestoreSnapshotFamily.remove(handle, conversationId);
  const collapseKeys = removeConversationKeyIndex(
    handle,
    collapseKeysByConversationIdAtom,
    conversationId,
  );
  for (const turnSearchKey of collapseKeys) {
    removed =
      localConversationTurnCollapseOverrideFamily.remove(handle, {
        conversationId,
        turnSearchKey,
      }) || removed;
  }
  const draftTurnIds = removeConversationKeyIndex(
    handle,
    editDraftTurnIdsByConversationIdAtom,
    conversationId,
  );
  for (const turnId of draftTurnIds) {
    removed =
      localConversationUserTurnEditDraftFamily.remove(handle, { conversationId, turnId }) ||
      removed;
  }
  return removed || collapseKeys.length > 0 || draftTurnIds.length > 0;
}

export function useLocalConversationTurnCollapseOverride({
  conversationId,
  initialOverride,
  turnSearchKey,
}: ConversationTurnCollapseKey & {
  readonly initialOverride?: boolean;
}): readonly [boolean | null, (collapsed: boolean) => void] {
  const handle = useScopeHandle(appScope);
  const key = useMemo(() => ({ conversationId, turnSearchKey }), [conversationId, turnSearchKey]);
  const member = localConversationTurnCollapseOverrideFamily(key);
  const override = useScopedAtomValue(member);

  useLayoutEffect(() => {
    indexCollapseKey(handle, key);
    if (initialOverride === undefined || handle.get(member) !== null) return;
    setLocalConversationTurnCollapseOverride(handle, key, initialOverride);
  }, [handle, initialOverride, key, member]);

  const setOverride = useCallback(
    (collapsed: boolean) => {
      setLocalConversationTurnCollapseOverride(handle, key, collapsed);
    },
    [handle, key],
  );

  return [override, setOverride] as const;
}

/**
 * The open edit draft of one sent user message, or null while the message is not being edited.
 * Without a Turn identity the message cannot be edited, so the draft stays closed.
 */
export function useLocalConversationUserTurnEditDraft(
  conversationId: string,
  turnId: string | null,
): readonly [string | null, (draft: string | null) => void] {
  const handle = useScopeHandle(appScope);
  const key = useMemo(() => ({ conversationId, turnId: turnId ?? "" }), [conversationId, turnId]);
  const draft = useScopedAtomValue(localConversationUserTurnEditDraftFamily(key));

  const setDraft = useCallback(
    (next: string | null) => {
      if (turnId === null || handle.get(deletedConversationIdsAtom)[conversationId] === true)
        return;
      if (next !== null)
        indexConversationKey(handle, editDraftTurnIdsByConversationIdAtom, conversationId, turnId);
      handle.set(localConversationUserTurnEditDraftFamily(key), next);
    },
    [conversationId, handle, key, turnId],
  );

  return [turnId === null ? null : draft, setDraft] as const;
}

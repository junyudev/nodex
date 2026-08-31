import type { ThreadItem, Turn, TurnItemsView } from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCanonicalConversationState,
  CodexConversationItem,
  CodexConversationSnapshot,
} from "../../shared/types";
import type { CodexHistoryTurnItemsPagination } from "../../shared/codex-conversation-state/codex-history-topology";
import type { CodexCanonicalItem } from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  createCodexCanonicalHydratedConversationState,
  createCodexCanonicalProtocolItem,
  mergeCodexCanonicalOlderTurnStates,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import { projectCodexConversationTurn } from "./CodexConversationSnapshotProjection";
import {
  createCodexHistoryItemWindow,
  DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS,
  type CodexHistoryItemSegment,
} from "../../shared/codex-conversation-state/codex-history-item-window";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import {
  snapshotCodexConversationHistoryItemWindow,
  type CodexConversationHistoryItemWindowSnapshot,
} from "../../shared/codex-conversation-history-page";
import type { CodexHydratedHistoryItemSegment } from "./CodexHistoryPageAdapter";

export interface CodexProjectedConversationItemPage {
  readonly itemIds: readonly string[];
  readonly canonicalItems: readonly CodexCanonicalItem[];
  readonly rendererItems: readonly CodexConversationItem[];
}

const approximateProjectedItemSegmentBytes = (value: unknown): number =>
  cappedApproximateValueBytes(value, DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes);

/**
 * Installs exact physical-page cursor metadata at the first bounded materialization. Flat legacy
 * Turns intentionally skip this seam and later seed an opaque window instead of inventing cursors.
 */
export const projectCodexConversationHistoryItemWindows = (input: {
  readonly canonical: CodexCanonicalConversationState;
  readonly snapshot: CodexConversationSnapshot;
  readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
  readonly itemSegmentsByTurnId: Readonly<
    Record<string, readonly CodexHydratedHistoryItemSegment[]>
  >;
}): Readonly<Record<string, CodexConversationHistoryItemWindowSnapshot>> => {
  const result: Record<string, CodexConversationHistoryItemWindowSnapshot> = {};
  for (const [turnId, physicalSegments] of Object.entries(input.itemSegmentsByTurnId)) {
    if (physicalSegments.length === 0) continue;
    const canonicalTurn = input.canonical.turns.find((turn) => turn.protocol.id === turnId);
    const rendererTurn = input.snapshot.turns.find((turn) => turn.turnId === turnId);
    const pagination = input.itemsPaginationByTurnId[turnId];
    if (!canonicalTurn || !rendererTurn || !pagination) {
      throw new Error(`Cannot install physical item pages for unknown Turn '${turnId}'`);
    }
    const canonicalById = new Map(canonicalTurn.items.map((item) => [item.id, item] as const));
    const segments: CodexHistoryItemSegment<CodexCanonicalItem, CodexConversationItem>[] = [];
    for (let index = 0; index < physicalSegments.length; index += 1) {
      const physical = physicalSegments[index]!;
      const canonicalItems = physical.itemIds.map((itemId) => canonicalById.get(itemId));
      if (canonicalItems.some((item) => item === undefined)) {
        throw new Error(`Physical item page for Turn '${turnId}' has a foreign item`);
      }
      const itemIds = [...physical.itemIds];
      const ids = new Set(itemIds);
      const rendererItems = rendererTurn.items.filter((item) => ids.has(item.itemId));
      const projectedBytes = approximateProjectedItemSegmentBytes({
        canonicalItems,
        rendererItems,
      });
      if (projectedBytes > DEFAULT_CODEX_HISTORY_ITEM_WINDOW_LIMITS.maxApproximateBytes) {
        throw new Error(`Projected item page for Turn '${turnId}' exceeds its resident byte limit`);
      }
      segments.push({
        segmentId: `physical:${turnId}:${index}:${itemIds[0] ?? "empty"}:${itemIds.at(-1) ?? "empty"}`,
        turnId,
        olderCursor: physical.olderCursor,
        newerCursor: physical.newerCursor,
        items: {
          itemIds,
          canonicalItems: canonicalItems as readonly CodexCanonicalItem[],
          rendererItems,
        },
        approximateBytes: Math.max(physical.approximateBytes, projectedBytes),
      });
    }
    const created = createCodexHistoryItemWindow({
      turnId,
      olderBoundary: pagination.hasLoadedOldest
        ? { status: "exhausted" }
        : { status: "available", cursor: pagination.olderCursor },
      newerBoundary: { status: "exhausted" },
      seedSegments: segments,
    });
    if (!created.ok) {
      throw new Error(
        `${created.error.message}: ${segments.length} segments / ${segments.reduce((bytes, segment) => bytes + segment.approximateBytes, 0)} bytes (${segments.map((segment) => segment.approximateBytes).join(",")}); descriptors ${physicalSegments.map((segment) => segment.approximateBytes).join(",")}`,
      );
    }
    result[turnId] = snapshotCodexConversationHistoryItemWindow(created.window);
  }
  return result;
};

/** Projects only one physical item page; resident items never enter this page-local value. */
export const projectCodexConversationTurnItemPage = (input: {
  readonly current: CodexCanonicalConversationState;
  readonly turnId: string;
  readonly items: readonly ThreadItem[];
  readonly itemsView: TurnItemsView;
  readonly observedAtMs: number;
}): CodexProjectedConversationItemPage => {
  const turnIndex = input.current.turns.findIndex((turn) => turn.protocol.id === input.turnId);
  if (turnIndex === -1) {
    throw new Error(`Cannot project items for unknown turn '${input.turnId}'`);
  }
  const residentIds = new Set(input.current.turns[turnIndex]!.items.map((item) => item.id));
  const pageIds = new Set<string>();
  const canonicalItems = input.items.flatMap((item) => {
    if (residentIds.has(item.id) || pageIds.has(item.id)) return [];
    pageIds.add(item.id);
    return [createCodexCanonicalProtocolItem(item) as CodexCanonicalItem];
  });
  const currentTurn = input.current.turns[turnIndex]!;
  const projected = projectCodexConversationTurn({
    threadId: input.current.protocol.id,
    turnIndex,
    beforeTurn: null,
    afterTurn: {
      ...currentTurn,
      protocol: { ...currentTurn.protocol, itemsView: input.itemsView },
      items: canonicalItems,
    },
    current: null,
    observedAtMs: input.observedAtMs,
  });
  return {
    itemIds: canonicalItems.map((item) => item.id),
    canonicalItems,
    rendererItems: projected.items.filter((item) => pageIds.has(item.itemId)),
  };
};

/** Pure history materialization from raw app-server Turns into the canonical aggregate. */
export const projectCodexConversationOlderTurns = (input: {
  readonly current: CodexCanonicalConversationState;
  readonly olderTurns: readonly Turn[];
  readonly oldestLoadedTurnId: string | null;
  readonly itemsPaginationByTurnId?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
}): CodexCanonicalConversationState => {
  const hydration = input.current.sidecar.hydrationContext;
  if (!hydration) {
    throw new Error(
      `Cannot merge canonical history for '${input.current.protocol.id}' without hydration context`,
    );
  }

  const latestParams = input.current.turns.at(-1)?.sidecar.params ?? null;
  const latestSettings = hydration.latestThreadSettings;
  const currentPermissions = hydration.currentPermissions;
  const cwd = latestSettings?.cwd ?? hydration.cwd ?? latestParams?.cwd ?? "/";
  const page = createCodexCanonicalHydratedConversationState(
    { ...input.current.protocol, turns: [...input.olderTurns] },
    {
      model: input.current.sidecar.latestThreadSettings?.model ?? hydration.latestModel,
      reasoningEffort:
        input.current.sidecar.latestThreadSettings?.effort ?? hydration.latestReasoningEffort,
      cwd,
      approvalPolicy:
        latestSettings?.approvalPolicy ??
        latestParams?.approvalPolicy ??
        currentPermissions.approvalPolicy,
      approvalsReviewer:
        latestSettings?.approvalsReviewer ??
        latestParams?.approvalsReviewer ??
        currentPermissions.approvalsReviewer,
      sandboxPolicy:
        latestSettings?.sandboxPolicy ??
        latestParams?.sandboxPolicy ??
        currentPermissions.sandboxPolicy,
      activePermissionProfile: currentPermissions.activePermissionProfile,
      runtimeWorkspaceRoots: [...currentPermissions.runtimeWorkspaceRoots],
      pendingRequests: input.current.requests,
      hasUnreadTurn: input.current.sidecar.hasUnreadTurn,
      turnItemsPaginationById: input.itemsPaginationByTurnId,
    },
  );

  return {
    ...input.current,
    turns: mergeCodexCanonicalOlderTurnStates({
      olderTurns: page.turns,
      currentTurns: input.current.turns,
      oldestLoadedTurnId: input.oldestLoadedTurnId,
    }),
  };
};

/** Prepends one bounded raw item page without replacing newer live/synthetic items. */
export const projectCodexConversationOlderTurnItems = (input: {
  readonly current: CodexCanonicalConversationState;
  readonly turnId: string;
  readonly olderItems: readonly ThreadItem[];
  readonly itemsView: TurnItemsView;
}): CodexCanonicalConversationState => {
  const turnIndex = input.current.turns.findIndex((turn) => turn.protocol.id === input.turnId);
  if (turnIndex === -1) {
    throw new Error(`Cannot merge items for unknown turn '${input.turnId}'`);
  }
  const currentTurn = input.current.turns[turnIndex]!;
  const residentIds = new Set(currentTurn.items.map((item) => item.id));
  const pageIds = new Set<string>();
  const olderItems = input.olderItems
    .filter((item) => {
      if (residentIds.has(item.id) || pageIds.has(item.id)) return false;
      pageIds.add(item.id);
      return true;
    })
    .map((item) => createCodexCanonicalProtocolItem(item) as CodexCanonicalItem);
  const turns = [...input.current.turns];
  turns[turnIndex] = {
    ...currentTurn,
    protocol: { ...currentTurn.protocol, itemsView: input.itemsView },
    items: [...olderItems, ...currentTurn.items],
  };
  return { ...input.current, turns };
};

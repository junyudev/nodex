import type { CodexItemStatus, CodexItemView, CodexTranscriptEntry } from "../types";
import {
  areCodexCanonicalTurnParamsEqual,
  isCodexCanonicalTurnPromptBlocked,
  collectCodexCanonicalUserMessageVisibilityChangedOwnerIds,
  doesCodexCanonicalItemProjectionChangeWithTurnStatus,
  projectCodexCanonicalTurnViews,
  projectCodexCanonicalVisibleTurnItemViews,
} from "../codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "../codex-transcript-entry-projection";
import type { CodexCanonicalItem, CodexCanonicalTurnState } from "./codex-conversation-state";

export interface ApplyCodexLifecycleProjectionDiffInput {
  readonly threadId: string;
  readonly turnKey?: string;
  readonly beforeTurn: CodexCanonicalTurnState | null;
  readonly afterTurn: CodexCanonicalTurnState;
  readonly currentViews: readonly CodexItemView[];
  readonly currentTranscript: readonly CodexTranscriptEntry[];
  readonly observedAtMs: number;
  readonly lifecycleStatus?: CodexItemStatus;
  readonly isBackgroundSubagentsEnabled?: boolean;
  readonly preserveExistingUpdatedAt?: boolean;
}

export interface CodexLifecycleProjectionDiffResult {
  readonly changedRawOwnerIds: readonly string[];
  readonly itemIds: readonly string[];
  readonly views: readonly CodexItemView[];
  readonly transcript: readonly CodexTranscriptEntry[];
}

/**
 * Lifecycle status is canonical sidecar state, so a status transition can
 * affect a projected transcript even when the protocol item payload is the
 * same object. Keep this comparison value-based for snapshot/replay merges.
 */
export function collectCodexLifecycleStatusChangedItemIds(
  before: CodexCanonicalTurnState | null,
  after: CodexCanonicalTurnState,
): ReadonlySet<string> {
  const beforeStatuses = before?.sidecar.lifecycleStatusByItemId ?? {};
  const afterStatuses = after.sidecar.lifecycleStatusByItemId ?? {};
  const changed = new Set<string>();
  const itemIds = new Set([...Object.keys(beforeStatuses), ...Object.keys(afterStatuses)]);

  for (const itemId of itemIds) {
    if (beforeStatuses[itemId] !== afterStatuses[itemId]) changed.add(itemId);
  }

  return changed;
}

type ProjectionOwner = Pick<CodexItemView, "itemId" | "rawItem" | "rawItemId" | "rawItemType">;

function countItemReferences(
  items: readonly CodexCanonicalItem[],
): ReadonlyMap<CodexCanonicalItem, number> {
  const counts = new Map<CodexCanonicalItem, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return counts;
}

function collectSharedItemReferences(
  items: readonly CodexCanonicalItem[],
  sharedCounts: ReadonlyMap<CodexCanonicalItem, number>,
): readonly CodexCanonicalItem[] {
  const usedCounts = new Map<CodexCanonicalItem, number>();
  return items.filter((item) => {
    const used = usedCounts.get(item) ?? 0;
    if (used >= (sharedCounts.get(item) ?? 0)) return false;
    usedCounts.set(item, used + 1);
    return true;
  });
}

/**
 * Lifecycle replacement is reference-based in the exact raw store. Convert
 * that reference delta to raw owner IDs so temporary view caches can update
 * only the affected owners without replaying unrelated streaming state.
 */
export function collectCodexLifecycleChangedRawOwnerIds(
  beforeItems: readonly CodexCanonicalItem[],
  afterItems: readonly CodexCanonicalItem[],
): readonly string[] {
  const beforeCounts = countItemReferences(beforeItems);
  const afterCounts = countItemReferences(afterItems);
  const changed = new Set<string>();

  for (const item of beforeItems) {
    if ((beforeCounts.get(item) ?? 0) === (afterCounts.get(item) ?? 0)) continue;
    changed.add(item.id);
  }
  for (const item of afterItems) {
    if ((beforeCounts.get(item) ?? 0) === (afterCounts.get(item) ?? 0)) continue;
    changed.add(item.id);
  }

  const sharedCounts = new Map<CodexCanonicalItem, number>();
  for (const item of beforeItems) {
    const sharedCount = Math.min(beforeCounts.get(item) ?? 0, afterCounts.get(item) ?? 0);
    if (sharedCount > 0) sharedCounts.set(item, sharedCount);
  }
  const beforeShared = collectSharedItemReferences(beforeItems, sharedCounts);
  const afterShared = collectSharedItemReferences(afterItems, sharedCounts);
  beforeShared.forEach((item, index) => {
    const afterItem = afterShared[index];
    if (item === afterItem) return;
    changed.add(item.id);
    if (afterItem) changed.add(afterItem.id);
  });

  return [...changed];
}

function lastNonUserWorkItem(items: readonly CodexCanonicalItem[]): CodexCanonicalItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const type = item?.type;
    if (
      type !== "userMessage" &&
      type !== "hookPrompt" &&
      type !== "steeringUserMessage" &&
      type !== "steered"
    ) {
      return item ?? null;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function projectionIdentity(item: ProjectionOwner & Pick<CodexItemView, "type">): string {
  return [item.rawItemType ?? item.type, item.rawItemId ?? "app-owned", item.itemId].join(":");
}

function stabilizeProjectedView(
  projected: CodexItemView,
  currentViews: readonly CodexItemView[],
  observedAtMs: number,
  preserveExistingUpdatedAt: boolean,
): CodexItemView {
  const existing = currentViews.find(
    (candidate) => projectionIdentity(candidate) === projectionIdentity(projected),
  );
  if (!existing) return projected;

  return stabilizeProjectedViewWithExisting(
    projected,
    existing,
    observedAtMs,
    preserveExistingUpdatedAt,
  );
}

function stabilizeProjectedViewWithExisting(
  projected: CodexItemView,
  existing: CodexItemView,
  observedAtMs: number,
  preserveExistingUpdatedAt: boolean,
): CodexItemView {
  return {
    ...projected,
    approvalRequestId: projected.approvalRequestId ?? existing.approvalRequestId,
    approvalReason: projected.approvalReason ?? existing.approvalReason,
    networkApprovalContext: projected.networkApprovalContext ?? existing.networkApprovalContext,
    proposedExecpolicyAmendment:
      projected.proposedExecpolicyAmendment ?? existing.proposedExecpolicyAmendment,
    proposedNetworkPolicyAmendments:
      projected.proposedNetworkPolicyAmendments ?? existing.proposedNetworkPolicyAmendments,
    grantRoot: projected.grantRoot ?? existing.grantRoot,
    status: projected.status ?? existing.status,
    createdAt: existing.createdAt,
    updatedAt: preserveExistingUpdatedAt ? existing.updatedAt : observedAtMs,
  };
}

function readProjectionClientUserMessageId(item: ProjectionOwner): string | null {
  const rawItem = asRecord(item.rawItem);
  const clientId = rawItem?.clientUserMessageId ?? rawItem?.clientId;
  return typeof clientId === "string" && clientId.trim().length > 0 ? clientId.trim() : null;
}

function isAppOwnedTurnParamsEntry(input: {
  readonly entry: ProjectionOwner & Pick<CodexItemView, "itemId" | "semanticKind">;
  readonly paramsItemId: string;
  readonly paramsClientId: string | null;
  readonly canonicalRawOwnerIds: ReadonlySet<string>;
}): boolean {
  if (input.entry.itemId === input.paramsItemId) return true;
  if (!input.paramsClientId || input.entry.semanticKind !== "userMessage") {
    return false;
  }
  if (input.entry.rawItemId && input.canonicalRawOwnerIds.has(input.entry.rawItemId)) {
    return false;
  }
  return readProjectionClientUserMessageId(input.entry) === input.paramsClientId;
}

function collectCodexProjectionAffectedOwnerIds(
  input: ApplyCodexLifecycleProjectionDiffInput,
  changedRawOwnerIds: readonly string[],
  visibilityChangedOwnerIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const affected = new Set([...changedRawOwnerIds, ...visibilityChangedOwnerIds]);
  for (const itemId of collectCodexLifecycleStatusChangedItemIds(
    input.beforeTurn,
    input.afterTurn,
  )) {
    affected.add(itemId);
  }
  const beforeItems = input.beforeTurn?.items ?? [];
  const beforeLastWork = lastNonUserWorkItem(beforeItems);
  const afterLastWork = lastNonUserWorkItem(input.afterTurn.items);
  if (
    beforeLastWork !== afterLastWork ||
    input.beforeTurn?.protocol.status !== input.afterTurn.protocol.status
  ) {
    if (beforeLastWork) affected.add(beforeLastWork.id);
    if (afterLastWork) affected.add(afterLastWork.id);
  }

  const beforeTurnStatus = input.beforeTurn?.protocol.status;
  if (beforeTurnStatus && beforeTurnStatus !== input.afterTurn.protocol.status) {
    for (const item of [...beforeItems, ...input.afterTurn.items]) {
      if (
        doesCodexCanonicalItemProjectionChangeWithTurnStatus(
          item,
          beforeTurnStatus,
          input.afterTurn.protocol.status,
        )
      ) {
        affected.add(item.id);
      }
    }
  }

  const beforeStartedAt = input.beforeTurn?.sidecar.commandExecutionStartedAtMsById;
  const afterStartedAt = input.afterTurn.sidecar.commandExecutionStartedAtMsById;
  const commandIds = new Set([
    ...Object.keys(beforeStartedAt ?? {}),
    ...Object.keys(afterStartedAt ?? {}),
  ]);
  for (const commandId of commandIds) {
    if (beforeStartedAt?.[commandId] !== afterStartedAt?.[commandId]) {
      affected.add(commandId);
    }
  }

  const beforeInterrupted = new Set(
    input.beforeTurn?.sidecar.interruptedCommandExecutionItemIds ?? [],
  );
  const afterInterrupted = new Set(
    input.afterTurn.sidecar.interruptedCommandExecutionItemIds ?? [],
  );
  for (const commandId of new Set([...beforeInterrupted, ...afterInterrupted])) {
    if (beforeInterrupted.has(commandId) !== afterInterrupted.has(commandId)) {
      affected.add(commandId);
    }
  }

  const rawTypeOrderChanged =
    beforeItems.length !== input.afterTurn.items.length ||
    beforeItems.some((item, index) => item.type !== input.afterTurn.items[index]?.type);
  const changedImageView = [...beforeItems, ...input.afterTurn.items].some(
    (item) => item.type === "imageView" && affected.has(item.id),
  );
  if (rawTypeOrderChanged || changedImageView) {
    for (const item of [...beforeItems, ...input.afterTurn.items]) {
      if (item.type === "imageView") affected.add(item.id);
    }
  }

  return affected;
}

function projectAffectedRawItems(
  input: ApplyCodexLifecycleProjectionDiffInput,
  affectedOwnerIds: ReadonlySet<string>,
  changedOwnerIds: ReadonlySet<string>,
): ReadonlyMap<string, readonly CodexItemView[]> {
  const projectedByOwnerId = new Map<string, CodexItemView[]>();
  const turnId = input.afterTurn.protocol.id;
  const projectedViews = projectCodexCanonicalVisibleTurnItemViews({
    threadId: input.threadId,
    turnId,
    items: input.afterTurn.items,
    params: input.afterTurn.sidecar.params,
    observedAtMs: input.observedAtMs,
    turnStatus: input.afterTurn.protocol.status,
    lifecycleStatusByItemId: input.afterTurn.sidecar.lifecycleStatusByItemId,
    commandExecutionStartedAtMsById: input.afterTurn.sidecar.commandExecutionStartedAtMsById,
    interruptedCommandExecutionItemIds: input.afterTurn.sidecar.interruptedCommandExecutionItemIds,
    isBackgroundSubagentsEnabled: input.isBackgroundSubagentsEnabled ?? true,
  });
  for (const view of projectedViews) {
    const ownerId = view.rawItemId;
    if (!ownerId) continue;
    if (!affectedOwnerIds.has(ownerId)) continue;
    const lifecycleView =
      view.status !== undefined ||
      input.lifecycleStatus === undefined ||
      !changedOwnerIds.has(ownerId)
        ? view
        : {
            ...view,
            status: input.lifecycleStatus,
          };
    const stabilized = stabilizeProjectedView(
      lifecycleView,
      input.currentViews,
      input.observedAtMs,
      input.preserveExistingUpdatedAt ?? false,
    );
    const existing = projectedByOwnerId.get(ownerId);
    if (existing) {
      existing.push(stabilized);
    } else {
      projectedByOwnerId.set(ownerId, [stabilized]);
    }
  }
  return projectedByOwnerId;
}

function orderScopedEntries<T extends ProjectionOwner & { readonly turnId: string | null }>(
  beforeItems: readonly CodexCanonicalItem[],
  afterItems: readonly CodexCanonicalItem[],
  currentEntries: readonly T[],
  affectedOwnerIds: ReadonlySet<string>,
  projectedByOwnerId: ReadonlyMap<string, readonly T[]>,
  targetTurnId: string | null,
): readonly T[] {
  const rawOwnerIds = new Set([
    ...beforeItems.map((item) => item.id),
    ...afterItems.map((item) => item.id),
  ]);
  const currentByOwnerId = new Map<string, T[]>();
  const overlaysByAnchor = new Map<string | null, T[]>();
  let currentAnchor: string | null = null;
  for (const entry of currentEntries) {
    const ownerId = entry.rawItemId;
    const rebound = entry.turnId === targetTurnId ? entry : { ...entry, turnId: targetTurnId };
    if (ownerId && rawOwnerIds.has(ownerId)) {
      const ownerEntries = currentByOwnerId.get(ownerId);
      if (ownerEntries) ownerEntries.push(rebound);
      else currentByOwnerId.set(ownerId, [rebound]);
      currentAnchor = ownerId;
      continue;
    }
    const overlays = overlaysByAnchor.get(currentAnchor);
    if (overlays) overlays.push(rebound);
    else overlaysByAnchor.set(currentAnchor, [rebound]);
  }

  const afterOwnerIds = new Set(afterItems.map((item) => item.id));
  const resolvedOverlaysByAnchor = new Map<string | null, T[]>();
  const appendOverlays = (anchor: string | null, overlays: readonly T[]): void => {
    const existing = resolvedOverlaysByAnchor.get(anchor);
    if (existing) existing.push(...overlays);
    else resolvedOverlaysByAnchor.set(anchor, [...overlays]);
  };
  for (const [anchor, overlays] of overlaysByAnchor) {
    if (anchor === null || afterOwnerIds.has(anchor)) {
      appendOverlays(anchor, overlays);
      continue;
    }

    const beforeIndex = beforeItems.findIndex((item) => item.id === anchor);
    const replacementAtSameSlot =
      beforeItems.length === afterItems.length ? (afterItems[beforeIndex]?.id ?? null) : null;
    const precedingSurvivor =
      beforeItems
        .slice(0, Math.max(0, beforeIndex))
        .toReversed()
        .find((item) => afterOwnerIds.has(item.id))?.id ?? null;
    appendOverlays(replacementAtSameSlot ?? precedingSurvivor, overlays);
  }

  const ordered: T[] = [...(resolvedOverlaysByAnchor.get(null) ?? [])];
  const emittedOwners = new Set<string>();
  for (const item of afterItems) {
    if (emittedOwners.has(item.id)) continue;
    ordered.push(
      ...(affectedOwnerIds.has(item.id)
        ? (projectedByOwnerId.get(item.id) ?? [])
        : (currentByOwnerId.get(item.id) ?? [])),
    );
    ordered.push(...(resolvedOverlaysByAnchor.get(item.id) ?? []));
    emittedOwners.add(item.id);
  }

  return ordered;
}

function projectChangedTranscriptEntries(
  views: readonly CodexItemView[],
  currentTranscript: readonly CodexTranscriptEntry[],
): readonly CodexTranscriptEntry[] {
  return views.map((view, index) => {
    const projected = projectCodexItemViewToTranscriptEntry(view, "live", index);
    const existing = currentTranscript.find(
      (entry) =>
        entry.type === projected.type &&
        (entry.entryId ?? entry.itemId) === (projected.entryId ?? projected.itemId),
    );
    if (!existing) return projected;
    return {
      ...projected,
      source: existing.source,
      sequence: existing.sequence,
      createdAt: existing.createdAt,
    };
  });
}

function projectCompleteCanonicalTurnViews(
  input: ApplyCodexLifecycleProjectionDiffInput,
): readonly CodexItemView[] {
  const targetTurnId = input.afterTurn.protocol.id;
  const turnKey = input.turnKey ?? targetTurnId;
  if (turnKey === null) {
    throw new Error("A null-id canonical turn requires its occurrence key");
  }
  const paramsItemId = `${turnKey}:input`;
  const canonicalRawOwnerIds = new Set(input.afterTurn.items.map((item) => item.id));
  const rawParamsClientId = input.afterTurn.sidecar.params.clientUserMessageId;
  const paramsClientId =
    typeof rawParamsClientId === "string" && rawParamsClientId.trim().length > 0
      ? rawParamsClientId.trim()
      : null;
  const existingParamsView = input.currentViews.find((entry) =>
    isAppOwnedTurnParamsEntry({
      entry,
      paramsItemId,
      paramsClientId,
      canonicalRawOwnerIds,
    }),
  );
  const projected = projectCodexCanonicalTurnViews({
    threadId: input.threadId,
    turn: input.afterTurn,
    turnKey,
    observedAtMs: input.observedAtMs,
    isBackgroundSubagentsEnabled: input.isBackgroundSubagentsEnabled ?? true,
  }).map((view) =>
    view.itemId === paramsItemId && existingParamsView
      ? stabilizeProjectedViewWithExisting(
          view,
          existingParamsView,
          input.observedAtMs,
          input.preserveExistingUpdatedAt ?? false,
        )
      : stabilizeProjectedView(
          view,
          input.currentViews,
          input.observedAtMs,
          input.preserveExistingUpdatedAt ?? false,
        ),
  );
  const paramsView = projected.find((view) => view.itemId === paramsItemId) ?? null;
  const projectedByOwnerId = new Map<string, CodexItemView[]>();
  for (const view of projected) {
    if (view === paramsView) continue;
    const ownerId = view.rawItemId;
    if (!ownerId) continue;
    const existing = projectedByOwnerId.get(ownerId);
    if (existing) existing.push(view);
    else projectedByOwnerId.set(ownerId, [view]);
  }

  const currentWithoutAppOwnedRows = input.currentViews.filter(
    (view) =>
      !isAppOwnedTurnParamsEntry({
        entry: view,
        paramsItemId,
        paramsClientId,
        canonicalRawOwnerIds,
      }) && view.semanticKind !== "hook",
  );
  const orderedRawAndOverlays = orderScopedEntries(
    [],
    input.afterTurn.items,
    currentWithoutAppOwnedRows,
    canonicalRawOwnerIds,
    projectedByOwnerId,
    targetTurnId,
  );

  return paramsView ? [paramsView, ...orderedRawAndOverlays] : orderedRawAndOverlays;
}

function projectCompleteCanonicalTurnTranscript(
  input: ApplyCodexLifecycleProjectionDiffInput,
  views: readonly CodexItemView[],
): readonly CodexTranscriptEntry[] {
  const targetTurnId = input.afterTurn.protocol.id;
  const turnKey = input.turnKey ?? targetTurnId;
  if (turnKey === null) {
    throw new Error("A null-id canonical turn requires its occurrence key");
  }
  const paramsItemId = `${turnKey}:input`;
  const canonicalRawOwnerIds = new Set(input.afterTurn.items.map((item) => item.id));
  const rawParamsClientId = input.afterTurn.sidecar.params.clientUserMessageId;
  const paramsClientId =
    typeof rawParamsClientId === "string" && rawParamsClientId.trim().length > 0
      ? rawParamsClientId.trim()
      : null;
  return views.map((view, sequence) => {
    const projected = projectCodexItemViewToTranscriptEntry(view, "bootstrap", sequence);
    const existing = input.currentTranscript.find((entry) =>
      view.itemId === paramsItemId
        ? isAppOwnedTurnParamsEntry({
            entry,
            paramsItemId,
            paramsClientId,
            canonicalRawOwnerIds,
          })
        : entry.type === projected.type &&
          (entry.entryId ?? entry.itemId) === (projected.entryId ?? projected.itemId),
    );
    if (!existing) return projected;
    return {
      ...projected,
      source: existing.source,
      createdAt: existing.createdAt,
      sequence,
    };
  });
}

function orderScopedTranscript(
  input: ApplyCodexLifecycleProjectionDiffInput,
  views: readonly CodexItemView[],
  affectedOwnerIds: ReadonlySet<string>,
): readonly CodexTranscriptEntry[] {
  const projectedByOwnerId = new Map<string, CodexTranscriptEntry[]>();
  for (const entry of projectChangedTranscriptEntries(views, input.currentTranscript)) {
    const ownerId = entry.rawItemId;
    if (!ownerId) continue;
    if (!affectedOwnerIds.has(ownerId)) continue;
    const existing = projectedByOwnerId.get(ownerId);
    if (existing) {
      existing.push(entry);
    } else {
      projectedByOwnerId.set(ownerId, [entry]);
    }
  }

  return orderScopedEntries(
    input.beforeTurn?.items ?? [],
    input.afterTurn.items,
    input.currentTranscript,
    affectedOwnerIds,
    projectedByOwnerId,
    input.afterTurn.protocol.id,
  );
}

/**
 * Canonical raw turns decide what changed. One exhaustive typed turn
 * projection supplies affected owners, while scoped publication preserves
 * unrelated streaming state and request/review overlays during migration.
 */
export function applyCodexLifecycleProjectionDiff(
  input: ApplyCodexLifecycleProjectionDiffInput,
): CodexLifecycleProjectionDiffResult {
  const changedRawOwnerIds = collectCodexLifecycleChangedRawOwnerIds(
    input.beforeTurn?.items ?? [],
    input.afterTurn.items,
  );
  const visibilityChangedOwnerIds = input.beforeTurn
    ? collectCodexCanonicalUserMessageVisibilityChangedOwnerIds({
        beforeItems: input.beforeTurn.items,
        beforeParams: input.beforeTurn.sidecar.params,
        afterItems: input.afterTurn.items,
        afterParams: input.afterTurn.sidecar.params,
      })
    : new Set<string>();
  const changedOwnerIds = new Set(changedRawOwnerIds);
  const affectedOwnerIds = collectCodexProjectionAffectedOwnerIds(
    input,
    changedRawOwnerIds,
    visibilityChangedOwnerIds,
  );
  const isTurnIdentityRebind =
    input.beforeTurn !== null && input.beforeTurn.protocol.id !== input.afterTurn.protocol.id;
  const didTurnParamsChange =
    input.beforeTurn !== null &&
    !areCodexCanonicalTurnParamsEqual(
      input.beforeTurn.sidecar.params,
      input.afterTurn.sidecar.params,
    );
  const isCompleteCanonicalTurnRebuild =
    input.beforeTurn === null ||
    isTurnIdentityRebind ||
    didTurnParamsChange ||
    isCodexCanonicalTurnPromptBlocked(input.beforeTurn) !==
      isCodexCanonicalTurnPromptBlocked(input.afterTurn);
  const views = isCompleteCanonicalTurnRebuild
    ? projectCompleteCanonicalTurnViews(input)
    : orderScopedEntries(
        input.beforeTurn?.items ?? [],
        input.afterTurn.items,
        input.currentViews,
        affectedOwnerIds,
        projectAffectedRawItems(input, affectedOwnerIds, changedOwnerIds),
        input.afterTurn.protocol.id,
      );
  // Hook runs remain in the Turn sidecar; only canonical items own transcript identities.
  const transcript = isCompleteCanonicalTurnRebuild
    ? projectCompleteCanonicalTurnTranscript(input, views)
    : orderScopedTranscript(input, views, affectedOwnerIds);

  return {
    changedRawOwnerIds,
    itemIds: input.afterTurn.items.map((item) => item.id),
    views,
    transcript,
  };
}

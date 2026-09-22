import type {
  CodexConversationItem,
  CodexConversationTurn,
  ProtocolAppInfo,
  ProtocolListMcpServerStatusResponse,
} from "../../../lib/types";
import type { CodexTurnScopedConversationRequest } from "../conversation-request-helpers";
import {
  areVisibleConversationTurnRenderRevisionsEqual,
  buildVisibleConversationTurnRenderRevision,
  type VisibleConversationTurnEntry,
  type VisibleConversationTurnRenderRevision,
} from "../selectors";
import { bucketizeTurnItems } from "./bucketize-turn-items";
import {
  buildRendererItemStream,
  buildRendererItemStreamProjection,
} from "./build-renderer-item-stream";
import {
  filterTurnDiffPayload,
  hasTurnDiffPayloadChanges,
  normalizeTurnDiffPatchBatches,
  shouldSuppressTurnDiffByEndResources,
  type ProjectlessOutputScope,
  type TurnDiffPayload,
} from "./projectless-output-scope";
import { collectTurnEndResourcePaths } from "./thread-summary-panel-output-model";
import { buildTurnViewModel } from "./build-turn-view-model";
import type {
  ThreadRendererItemModel,
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadTranscriptBlockModel,
  ThreadTurnModel,
  ThreadWorkedForBlockModel,
} from "../thread-stage-types";

export interface BuildTurnRenderModelInput {
  turn: CodexConversationTurn;
  requests: CodexTurnScopedConversationRequest[];
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  surface?: TurnRenderSurface;
  canEditTurnUserPrefix?: boolean;
  canForkTurn?: boolean;
  canRateTurn?: boolean;
  goalTimeUsedSeconds?: number;
  timestampHoverOnly?: boolean;
  backgroundAgents?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  turnKey?: string;
  cwd?: string | null;
  hostId?: string;
  projectlessOutputDirectory?: string | null;
  mcpApps?: readonly ProtocolAppInfo[];
  mcpServerStatuses?: ProtocolListMcpServerStatusResponse | null;
}

export type TurnRenderSurface = "main" | "preview";

export interface SelectTurnRenderModelInput {
  entry: VisibleConversationTurnEntry;
  surface?: TurnRenderSurface;
  canEditTurnUserPrefix?: boolean;
  canForkTurn?: boolean;
  canRateTurn?: boolean;
  goalTimeUsedSeconds?: number;
  timestampHoverOnly?: boolean;
  backgroundAgents?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  cwd?: string | null;
  hostId?: string;
  projectlessOutputDirectory?: string | null;
  mcpApps?: readonly ProtocolAppInfo[];
  mcpServerStatuses?: ProtocolListMcpServerStatusResponse | null;
}

type TurnRenderModelBuilder = (input: BuildTurnRenderModelInput) => ThreadTurnModel;
type TurnRenderModelSelector = (input: SelectTurnRenderModelInput) => ThreadTurnModel;

function hasIncompleteElicitation(items: ReturnType<typeof buildRendererItemStream>): boolean {
  return items.some((item) => item.type === "mcpServerElicitation" && item.status !== "completed");
}

function isTranscriptTurnDiffItem(entry: CodexConversationItem): boolean {
  if (entry.semanticKind === "diff") return true;
  if (entry.type === "turn_diff" || entry.type === "turn-diff") return true;
  if (entry.rawItem && typeof entry.rawItem === "object") {
    return (entry.rawItem as { type?: unknown }).type === "turn-diff";
  }
  return false;
}

function readTurnDiffPayload(entry: CodexConversationItem): TurnDiffPayload | null {
  if (!isTranscriptTurnDiffItem(entry)) return null;
  if (typeof entry.rawItem !== "object" || entry.rawItem === null) return null;
  const rawItem = entry.rawItem as {
    unifiedDiff?: unknown;
    cwd?: unknown;
    showRevertButton?: unknown;
    patchBatches?: unknown;
  };
  const patchBatches = normalizeTurnDiffPatchBatches(rawItem.patchBatches);
  return filterTurnDiffPayload(
    {
      unifiedDiff: typeof rawItem.unifiedDiff === "string" ? rawItem.unifiedDiff : "",
      cwd:
        typeof rawItem.cwd === "string" && rawItem.cwd.trim().length > 0 ? rawItem.cwd : undefined,
      showRevertButton: rawItem.showRevertButton === true,
      patchBatches,
    },
    {},
  );
}

function buildDerivedTurnDiffEntry(
  turn: CodexConversationTurn,
  entries: readonly CodexConversationItem[],
  scope: ProjectlessOutputScope,
): CodexConversationItem | null {
  const payload = filterTurnDiffPayload(
    {
      unifiedDiff: turn.diff ?? "",
      cwd: scope.cwd ?? undefined,
      patchBatches: [],
      showRevertButton: true,
    },
    scope,
  );
  if (!payload || !hasTurnDiffPayloadChanges(payload)) return null;
  if (entries.some(isTranscriptTurnDiffItem)) return null;

  const timestamp = turn.completedAt ?? turn.startedAt ?? turn.turnStartedAtMs ?? Date.now();
  const itemId = `turn-diff:${turn.turnId}`;
  return {
    threadId: turn.threadId,
    turnId: turn.turnId,
    itemId,
    entryId: itemId,
    type: "turn_diff",
    kind: "systemEvent",
    semanticKind: "diff",
    status: turn.status,
    rawItem: {
      type: "turn-diff",
      unifiedDiff: payload.unifiedDiff,
      ...(payload.patchBatches === undefined ? {} : { patchBatches: payload.patchBatches }),
      showRevertButton: payload.showRevertButton === true,
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function appendDerivedTurnDiffEntry(
  turn: CodexConversationTurn,
  scope: ProjectlessOutputScope,
  endResourcePaths: readonly string[],
): CodexConversationItem[] {
  const renderableEntries = turn.items.flatMap((entry) => {
    if (!isTranscriptTurnDiffItem(entry)) return [entry];
    const payload = readTurnDiffPayload(entry);
    if (!payload || !hasTurnDiffPayloadChanges(payload)) return [];
    const filtered = filterTurnDiffPayload(payload, scope);
    if (!filtered || !hasTurnDiffPayloadChanges(filtered)) return [];
    return [
      {
        ...entry,
        rawItem: {
          ...(entry.rawItem as Record<string, unknown>),
          unifiedDiff: filtered.unifiedDiff,
          ...(filtered.patchBatches === undefined ? {} : { patchBatches: filtered.patchBatches }),
          ...(filtered.cwd ? { cwd: filtered.cwd } : {}),
        },
      },
    ];
  });
  const derived = buildDerivedTurnDiffEntry(turn, renderableEntries, scope);
  const turnDiffEntries = [
    ...renderableEntries.filter(isTranscriptTurnDiffItem),
    ...(derived ? [derived] : []),
  ];
  const suppressDuplicate =
    turnDiffEntries.length > 0 &&
    turnDiffEntries.every((entry) => {
      const payload = readTurnDiffPayload(entry);
      return (
        payload !== null &&
        shouldSuppressTurnDiffByEndResources({
          payload,
          endResourcePaths,
          scope,
        })
      );
    });
  const visibleEntries = suppressDuplicate
    ? renderableEntries.filter((entry) => !isTranscriptTurnDiffItem(entry))
    : renderableEntries;
  if (!derived || suppressDuplicate) return visibleEntries;
  return [...visibleEntries, derived];
}

function resolveFiniteTimestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isTranscriptItem(item: ThreadRendererItemModel): item is ThreadTranscriptBlockModel {
  return "entry" in item;
}

function isUserItem(item: ThreadRendererItemModel): boolean {
  return item.type === "userMessage";
}

function findFirstNonUserIndex(items: ThreadRendererItemModel[]): number {
  return items.findIndex((item) => !isUserItem(item));
}

function findFirstFinalAnswerAssistantIndex(items: ThreadRendererItemModel[]): number {
  return items.findIndex(
    (item) =>
      isTranscriptItem(item) &&
      item.type === "assistantMessage" &&
      item.entry.assistantPhase === "final_answer",
  );
}

function findLastAssistantIndex(items: ThreadRendererItemModel[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.type === "assistantMessage") return index;
  }
  return -1;
}

function hasNonUserItemBefore(items: ThreadRendererItemModel[], boundaryIndex: number): boolean {
  return items.slice(0, Math.max(boundaryIndex, 0)).some((item) => !isUserItem(item));
}

function hasRenderableFinalAssistantContent(item: ThreadRendererItemModel | undefined): boolean {
  if (!item || !isTranscriptItem(item) || item.type !== "assistantMessage") return false;
  if (item.entry.assistantPhase !== "final_answer") return false;
  if ((item.entry.markdownText?.trim().length ?? 0) > 0) return true;
  return item.status === "completed";
}

function resolveWorkedForBoundaryIndex(
  turn: CodexConversationTurn,
  items: ThreadRendererItemModel[],
): number {
  if (turn.status === "interrupted") return -1;
  if (turn.status === "inProgress") {
    const finalAnswerIndex = findFirstFinalAnswerAssistantIndex(items);
    return finalAnswerIndex >= 0 ? finalAnswerIndex : items.length;
  }
  return findLastAssistantIndex(items);
}

function resolveWorkedForCompletedAtMs(
  turn: CodexConversationTurn,
  items: ThreadRendererItemModel[],
  boundaryIndex: number,
): number | null {
  const finalAssistantStartedAtMs = resolveFiniteTimestamp(turn.finalAssistantStartedAtMs);
  if (finalAssistantStartedAtMs === null) return null;

  return hasRenderableFinalAssistantContent(items[boundaryIndex])
    ? finalAssistantStartedAtMs
    : null;
}

function buildWorkedForItem(
  turn: CodexConversationTurn,
  items: ThreadRendererItemModel[],
  turnKey: string,
): ThreadWorkedForBlockModel | null {
  const startedAtMs = resolveFiniteTimestamp(turn.firstTurnWorkItemStartedAtMs);
  if (startedAtMs === null) return null;

  const boundaryIndex = resolveWorkedForBoundaryIndex(turn, items);
  if (boundaryIndex < 0) return null;
  if (!hasNonUserItemBefore(items, boundaryIndex)) return null;

  const completedAtMs = resolveWorkedForCompletedAtMs(turn, items, boundaryIndex);
  if (turn.status !== "inProgress" && completedAtMs === null) return null;

  return {
    id: `${turnKey}:worked-for`,
    turnId: turn.turnId,
    createdAt: startedAtMs,
    updatedAt: completedAtMs ?? startedAtMs,
    searchableText: "",
    type: "workedFor",
    status: completedAtMs === null ? "working" : "worked",
    startedAtMs,
    completedAtMs,
  };
}

function insertWorkedForItem(
  turn: CodexConversationTurn,
  items: ThreadRendererItemModel[],
  workedForItem: ThreadWorkedForBlockModel | null,
): ThreadRendererItemModel[] {
  if (!workedForItem) return items;

  const boundaryIndex =
    turn.status === "inProgress"
      ? findFirstNonUserIndex(items)
      : resolveWorkedForBoundaryIndex(turn, items);
  if (boundaryIndex < 0) return items;

  return [...items.slice(0, boundaryIndex), workedForItem, ...items.slice(boundaryIndex)];
}

function startAfterTurnIntro(items: ThreadRendererItemModel[]): ThreadRendererItemModel[] {
  const workedForIndex = items.findIndex((item) => item.type === "workedFor");
  if (workedForIndex >= 0) return items.slice(workedForIndex + 1);

  const firstNonUserIndex = findFirstNonUserIndex(items);
  if (firstNonUserIndex < 0) return [];
  if (firstNonUserIndex === 0) return items;
  return items.slice(firstNonUserIndex);
}

export function buildTurnRenderModel(input: BuildTurnRenderModelInput): ThreadTurnModel {
  const turnKey = input.turnKey ?? input.turn.turnId;
  if (turnKey === null) {
    throw new Error("A nullable local turn requires its occurrence key");
  }
  const scope: ProjectlessOutputScope = {
    cwd: input.cwd,
    projectlessOutputDirectory: input.projectlessOutputDirectory,
  };
  const endResourcePaths = collectTurnEndResourcePaths(input.turn, {
    cwd: input.cwd,
    projectlessOutputDirectory: input.projectlessOutputDirectory,
  });
  const entries = appendDerivedTurnDiffEntry(input.turn, scope, endResourcePaths);
  const rendererProjection = buildRendererItemStreamProjection({
    entries,
    requests: input.requests,
    turnStatus: input.turn.status,
    isLatestTurn: input.isLatestTurn,
    backgroundAgents: input.backgroundAgents,
    turnKey,
  });
  const baseItems = rendererProjection.items;
  const workedForItem = buildWorkedForItem(input.turn, baseItems, turnKey);
  const workedForTiming = workedForItem
    ? {
        status: workedForItem.status,
        startedAtMs: workedForItem.startedAtMs,
        completedAtMs: workedForItem.completedAtMs,
      }
    : null;
  const itemsWithTurnIntro = insertWorkedForItem(input.turn, baseItems, workedForItem);
  const items =
    input.surface === "preview" ? startAfterTurnIntro(itemsWithTurnIntro) : itemsWithTurnIntro;
  const buckets = bucketizeTurnItems({
    items,
    turnStatus: input.turn.status,
  });
  const isBlocked =
    buckets.approvalItem !== null ||
    buckets.userInputItem !== null ||
    buckets.interactiveRequestItem !== null ||
    buckets.permissionRequestItems.length > 0 ||
    hasIncompleteElicitation(items);

  return buildTurnViewModel({
    turnId: input.turn.turnId,
    turnKey,
    turn: input.turn,
    buckets,
    workedForItem,
    workedForTiming,
    workedDurationMs: resolveFiniteTimestamp(input.turn.durationMs),
    isLatestTurn: input.isLatestTurn,
    isStreamingTurn: input.isStreamingTurn,
    isBlocked,
    subagentActivityState: rendererProjection.subagentActivityState,
    canEditTurnUserPrefix: input.turn.turnId !== null && input.canEditTurnUserPrefix,
    canForkTurn: input.turn.turnId !== null && input.canForkTurn,
    canRateTurn: input.canRateTurn,
    allowCopyWhileStreaming: input.surface === "preview",
    showTimestampWithoutActions: input.surface === "preview",
    timestampHoverOnly: input.timestampHoverOnly ?? false,
    goalTimeUsedSeconds: input.goalTimeUsedSeconds,
    cwd: input.cwd,
    hostId: input.hostId,
    endResourcePaths,
    mcpApps: input.mcpApps,
    mcpServerStatuses: input.mcpServerStatuses,
  });
}

const selectorIdentityByObject = new WeakMap<object, number>();
let nextSelectorIdentity = 1;

function resolveSelectorIdentity(value: object | null | undefined): number {
  if (value == null) return 0;
  const existing = selectorIdentityByObject.get(value);
  if (existing != null) return existing;
  const identity = nextSelectorIdentity;
  nextSelectorIdentity += 1;
  selectorIdentityByObject.set(value, identity);
  return identity;
}

export function createTurnRenderModelSelector(
  build: TurnRenderModelBuilder = buildTurnRenderModel,
): TurnRenderModelSelector {
  const cacheByEntry = new WeakMap<
    VisibleConversationTurnEntry,
    {
      revision: VisibleConversationTurnRenderRevision;
      modelsByVariant: Map<string, ThreadTurnModel>;
    }
  >();

  return (input) => {
    const surface = input.surface ?? "main";
    const canEditTurnUserPrefix = input.canEditTurnUserPrefix === true;
    const canForkTurn = input.canForkTurn === true;
    const revision = buildVisibleConversationTurnRenderRevision(
      input.entry.turn,
      input.entry.requests,
    );
    const cacheKey = JSON.stringify([
      surface,
      input.canRateTurn,
      input.goalTimeUsedSeconds,
      input.timestampHoverOnly,
      canEditTurnUserPrefix,
      canForkTurn,
      input.entry.isMostRecentTurn,
      input.cwd,
      input.hostId,
      input.projectlessOutputDirectory,
      resolveSelectorIdentity(input.mcpApps),
      resolveSelectorIdentity(input.mcpServerStatuses),
      input.entry.turnKey,
      (input.backgroundAgents ?? []).map((row) => [
        row.conversationId,
        row.parentTurnKey,
        row.displayName,
        row.status,
        row.statusSummary,
        row.showInlineActivity,
      ]),
    ]);
    const cachedEntry = cacheByEntry.get(input.entry);
    const isSameRevision =
      cachedEntry !== undefined &&
      areVisibleConversationTurnRenderRevisionsEqual(cachedEntry.revision, revision);
    const cached = isSameRevision ? cachedEntry.modelsByVariant.get(cacheKey) : undefined;
    if (cached) return cached;

    const model = build({
      turn: input.entry.turn,
      requests: input.entry.requests,
      isLatestTurn: input.entry.isMostRecentTurn,
      isStreamingTurn: input.entry.turn.status === "inProgress",
      surface,
      canRateTurn: input.canRateTurn,
      goalTimeUsedSeconds: input.goalTimeUsedSeconds,
      timestampHoverOnly: input.timestampHoverOnly,
      canEditTurnUserPrefix,
      canForkTurn,
      backgroundAgents: input.backgroundAgents,
      turnKey: input.entry.turnKey,
      cwd: input.cwd,
      hostId: input.hostId,
      projectlessOutputDirectory: input.projectlessOutputDirectory,
      mcpApps: input.mcpApps,
      mcpServerStatuses: input.mcpServerStatuses,
    });
    const nextModels = isSameRevision
      ? cachedEntry.modelsByVariant
      : new Map<string, ThreadTurnModel>();
    nextModels.set(cacheKey, model);
    cacheByEntry.set(input.entry, {
      revision,
      modelsByVariant: nextModels,
    });
    return model;
  };
}

export const selectTurnRenderModel = createTurnRenderModelSelector();

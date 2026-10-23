import { normalizeMessageCopyText } from "../message-copy-text";
import { projectCodexMarkdownToPlainText } from "../../../../shared/codex-markdown-text";
import { buildTurnFooterMetadata, type TurnFooterMetadata } from "./turn-footer-metadata";
import { buildHookStats, type HookStats } from "./hook-stats";
import type {
  CodexConversationTurn,
  ProtocolAppInfo,
  ProtocolListMcpServerStatusResponse,
} from "../../../lib/types";
import { materializeAgentRenderUnits } from "./agent-activity-group";
import { resolveGeneratedImageOutputState } from "./generated-image-output";
import { collectHookFeedbackSources } from "./hook-feedback-settings";
import type {
  ThreadAssistantActionsBlockModel,
  ThreadAssistantMessageActionsModel,
  ThreadAgentItemModel,
  ThreadAgentRenderUnit,
  ThreadBlockModel,
  ThreadGeneratedImageGalleryBlockModel,
  ThreadLiveActivityPresentation,
  ThreadSearchUnitModel,
  ThreadTranscriptBlockModel,
  ThreadTurnModel,
  ThreadTurnRenderBuckets,
  ThreadTurnSubagentActivityState,
  ThreadWorkedForBlockModel,
} from "../thread-stage-types";
import { projectThreadActivityPresentation } from "./thread-activity-presentation";
import {
  countAgentBodyUnits,
  projectAgentBodyCollapsePresentation,
} from "./agent-body-collapse-presentation";
import type { ThreadWorkedForTiming } from "../thread-worked-for-time";

interface BuildTurnViewModelInput {
  voiceWorkActivity?: "active" | "terminal";
  includeGeneratedImages?: boolean;
  turnId: string | null;
  turnKey?: string;
  turnSearchKey?: string;
  turn: CodexConversationTurn | null;
  buckets: ThreadTurnRenderBuckets;
  workedForItem?: ThreadWorkedForBlockModel | null;
  workedForTiming?: ThreadWorkedForTiming | null;
  workedDurationMs?: number | null;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  isBlocked: boolean;
  canEditTurnUserPrefix?: boolean;
  canForkTurn?: boolean;
  allowCopyWhileStreaming?: boolean;
  showTimestampWithoutActions?: boolean;
  timestampHoverOnly?: boolean;
  cwd?: string | null;
  hostId?: string;
  goalTimeUsedSeconds?: number;
  mcpApps?: readonly ProtocolAppInfo[];
  mcpServerStatuses?: ProtocolListMcpServerStatusResponse | null;
  endResourcePaths?: readonly string[];
  subagentActivityState?: ThreadTurnSubagentActivityState;
}

type TurnActionInput = Pick<
  BuildTurnViewModelInput,
  | "canForkTurn"
  | "allowCopyWhileStreaming"
  | "showTimestampWithoutActions"
  | "timestampHoverOnly"
  | "isStreamingTurn"
  | "turn"
> & {
  hookStats: HookStats | null;
  metadata?: TurnFooterMetadata;
};

const EMPTY_SUBAGENT_ACTIVITY_STATE: ThreadTurnSubagentActivityState = {
  hasActivity: false,
  hasActiveActivity: false,
};

function flattenBlocks(
  leadingBlocks: ThreadBlockModel[],
  agentBodyUnits: ThreadAgentRenderUnit[],
  trailingBlocks: ThreadBlockModel[],
): ThreadBlockModel[] {
  return [...leadingBlocks, ...materializeAgentRenderUnits(agentBodyUnits), ...trailingBlocks];
}

function resolveAboveComposerBlocks(
  buckets: ThreadTurnRenderBuckets,
  input: Pick<BuildTurnViewModelInput, "isLatestTurn" | "isStreamingTurn" | "isBlocked">,
): ThreadBlockModel[] {
  if (!input.isLatestTurn || !input.isStreamingTurn || input.isBlocked) return [];

  return [
    ...(buckets.todoListItem ? [buckets.todoListItem] : []),
    ...(buckets.unifiedDiffItem ? [buckets.unifiedDiffItem] : []),
  ];
}

function resolveTurnOwnerHiddenBlockIds(
  buckets: ThreadTurnRenderBuckets,
  isStreamingTurn: boolean,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (buckets.todoListItem) ids.add(buckets.todoListItem.id);
  if (isStreamingTurn && buckets.unifiedDiffItem) ids.add(buckets.unifiedDiffItem.id);
  return ids;
}

function hasBlockingTurnRequest(buckets: ThreadTurnRenderBuckets): boolean {
  if (buckets.approvalItem || buckets.userInputItem || buckets.interactiveRequestItem) return true;
  if (buckets.permissionRequestItems.length > 0) return true;
  return buckets.mcpServerElicitationItems.some((item) => item.status !== "completed");
}

function collectSearchableText(blocks: ThreadBlockModel[]): string {
  return blocks
    .flatMap((block) => {
      const nestedAssistantAfter =
        block.type === "assistantMessage" && block.assistantAfterBlocks
          ? collectSearchableText(block.assistantAfterBlocks)
          : "";
      if (block.type === "agentActivityGroup") {
        return [block.searchableText, nestedAssistantAfter];
      }
      if ("entry" in block) {
        return [block.searchableText, nestedAssistantAfter];
      }
      return [block.searchableText, nestedAssistantAfter];
    })
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("\n");
}

function withSearchUnitKey<TBlock extends ThreadBlockModel | null>(
  block: TBlock,
  searchUnitKey: string,
): TBlock {
  if (!block) return block;
  if (block.type === "agentActivityGroup" || block.type === "assistantActions") return block;
  if (block.type !== "userMessage" && block.type !== "assistantMessage") return block;

  const nextBlock = {
    ...block,
    searchUnitKey,
  } satisfies ThreadTranscriptBlockModel;

  return nextBlock as TBlock;
}

function isUserMessageBlock(
  block: ThreadAgentItemModel | ThreadTranscriptBlockModel,
): block is ThreadTranscriptBlockModel {
  return block.type === "userMessage";
}

function collectUserMessageSearchBlocks(
  buckets: ThreadTurnRenderBuckets,
): ThreadTranscriptBlockModel[] {
  const seenBlockIds = new Set<string>();
  const blocks: ThreadTranscriptBlockModel[] = [];
  const candidates = [...buckets.userItems, ...buckets.agentItems.filter(isUserMessageBlock)];

  for (const block of candidates) {
    if (seenBlockIds.has(block.id)) continue;
    seenBlockIds.add(block.id);
    blocks.push(block);
  }

  return blocks;
}

function resolveTimestampMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveUserMessageSentAt(
  turn: CodexConversationTurn | null,
  index: number,
): number | null {
  if (index !== 0) return null;
  return resolveTimestampMs(turn?.turnStartedAtMs);
}

function resolveAssistantMessageSentAt(turn: CodexConversationTurn | null): number | null {
  return resolveTimestampMs(turn?.finalAssistantStartedAtMs);
}

function applyUserMessageActions(
  userItems: ThreadTranscriptBlockModel[],
  input: Pick<BuildTurnViewModelInput, "canEditTurnUserPrefix" | "turn"> & {
    hookStats: HookStats | null;
    fallbackHookStats: HookStats | null;
    isTurnPrefix?: boolean;
  },
): ThreadTranscriptBlockModel[] {
  if (userItems.length === 0) return userItems;

  return userItems.map((block, index) => ({
    ...block,
    ...(block.entry.hookFeedback === true
      ? {
          hookFeedbackSources: collectHookFeedbackSources(
            input.turn?.hookRuns,
            block.entry.markdownText ?? "",
          ),
        }
      : {}),
    userMessageActions: {
      hookStats: block.entry.deliveryStatus === "not-sent" ? input.fallbackHookStats : null,
      canEdit:
        Boolean(input.canEditTurnUserPrefix) &&
        block.entry.hookFeedback !== true &&
        index === userItems.length - 1,
      sentAtMs:
        block.entry.deliveryStatus === "not-sent" || input.isTurnPrefix === false
          ? null
          : resolveUserMessageSentAt(input.turn, index),
    },
  }));
}

function buildGeneratedImageGalleryBlock(
  turnId: string | null,
  turnKey: string,
  buckets: ThreadTurnRenderBuckets,
  input: Pick<BuildTurnViewModelInput, "endResourcePaths" | "isStreamingTurn">,
): ThreadGeneratedImageGalleryBlockModel | null {
  const output = resolveGeneratedImageOutputState({
    items: buckets.toolOutputItems.map((block) => block.entry),
    endResourcePaths: input.endResourcePaths ?? [],
    isTurnInProgress: input.isStreamingTurn,
  });
  if (!output.shouldRender) return null;

  const images = output.visibleCompletedItems.flatMap((item) => {
    const src = item.generatedImage?.src;
    return src == null ? [] : [{ id: item.itemId, src }];
  });
  const timestamps = buckets.toolOutputItems.flatMap((item) => [item.createdAt, item.updatedAt]);
  const createdAt = timestamps.length === 0 ? Date.now() : Math.min(...timestamps);
  const updatedAt = timestamps.length === 0 ? createdAt : Math.max(...timestamps);

  return {
    id: `${turnKey}:generated-image-gallery`,
    turnId,
    createdAt,
    updatedAt,
    // Generated image sources can be data URIs or signed asset URLs. They are
    // transport details, not user-authored searchable transcript content.
    searchableText: "",
    type: "generatedImageGallery",
    images,
    pendingImageCount: output.pendingImageCount,
  };
}

function buildAssistantMessageActionsModel(
  assistantItem: ThreadTranscriptBlockModel | null,
  input: TurnActionInput,
): ThreadAssistantMessageActionsModel | null {
  if (!assistantItem || assistantItem.type !== "assistantMessage") return null;
  if (assistantItem.entry.assistantPhase === "commentary") return null;

  const copyText = normalizeMessageCopyText(assistantItem.entry.markdownText ?? "");
  const hasCopyableContent = copyText.trim().length > 0;
  const isCompleted = !input.isStreamingTurn && assistantItem.status !== "inProgress";
  const canFork = isCompleted && Boolean(input.canForkTurn);
  const canCopy = hasCopyableContent && (isCompleted || input.allowCopyWhileStreaming === true);

  const hookStats = isCompleted ? input.hookStats : null;
  if (!canFork && !canCopy && !hookStats && !input.metadata && !input.showTimestampWithoutActions)
    return null;

  return {
    ...(hookStats ? { hookStats } : {}),
    copyText: canCopy ? copyText : null,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    sentAtMs: resolveAssistantMessageSentAt(input.turn),
    canFork,
    ...(input.showTimestampWithoutActions ? { showTimestampWithoutActions: true } : {}),
    ...(input.timestampHoverOnly ? { timestampHoverOnly: true } : {}),
  };
}

function applyAssistantMessageActions(
  assistantItem: ThreadTranscriptBlockModel | null,
  input: TurnActionInput,
): ThreadTranscriptBlockModel | null {
  if (!assistantItem || assistantItem.type !== "assistantMessage") return assistantItem;

  const assistantMessageActions = buildAssistantMessageActionsModel(assistantItem, input);
  if (!assistantMessageActions) return assistantItem;

  return {
    ...assistantItem,
    assistantMessageActions,
  };
}

function applyAssistantAfterBlocks(
  assistantItem: ThreadTranscriptBlockModel | null,
  assistantAfterBlocks: ThreadBlockModel[],
): ThreadTranscriptBlockModel | null {
  if (!assistantItem || assistantItem.type !== "assistantMessage") return assistantItem;
  if (assistantAfterBlocks.length === 0) return assistantItem;

  return {
    ...assistantItem,
    assistantAfterBlocks,
  };
}

function buildDeferredAssistantActionsBlock(
  assistantItem: ThreadTranscriptBlockModel | null,
  input: TurnActionInput,
): ThreadAssistantActionsBlockModel | null {
  if (!assistantItem || assistantItem.type !== "assistantMessage") return null;

  const actions = buildAssistantMessageActionsModel(assistantItem, input);
  if (!actions) return null;

  return {
    id: `${assistantItem.id}:actions`,
    turnId: assistantItem.turnId,
    createdAt: assistantItem.createdAt,
    updatedAt: assistantItem.updatedAt,
    searchableText: "",
    type: "assistantActions",
    entry: assistantItem.entry,
    actions,
  };
}

function buildGeneratedImageActionsBlock(
  source: ThreadTranscriptBlockModel | undefined,
  input: TurnActionInput,
): ThreadAssistantActionsBlockModel | null {
  if (!source || input.isStreamingTurn) return null;
  const canFork = Boolean(input.canForkTurn);
  if (!input.hookStats && !canFork && !input.metadata && !input.showTimestampWithoutActions)
    return null;
  return {
    id: `${source.id}:actions`,
    turnId: source.turnId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    searchableText: "",
    type: "assistantActions",
    entry: source.entry,
    actions: {
      copyText: null,
      sentAtMs: resolveAssistantMessageSentAt(input.turn),
      ...(input.showTimestampWithoutActions ? { showTimestampWithoutActions: true } : {}),
      ...(input.timestampHoverOnly ? { timestampHoverOnly: true } : {}),
      canFork,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.hookStats ? { hookStats: input.hookStats } : {}),
    },
  };
}

function buildSearchUnits(input: {
  isStreamingTurn: boolean;
  buckets: ThreadTurnRenderBuckets;
  turn: CodexConversationTurn | null;
  turnId: string | null;
  turnKey: string;
  turnSearchKey: string;
  userMessageBlocks: ThreadTranscriptBlockModel[];
}): ThreadSearchUnitModel[] {
  const userUnits = input.userMessageBlocks.map((block, index) => ({
    key: `${input.turnSearchKey}:user:${index}`,
    itemId: block.entry.rawItemId ?? block.entry.itemId,
    turnId: input.turnId,
    turnKey: input.turnKey,
    text: projectCodexMarkdownToPlainText(block.entry.markdownText ?? block.searchableText),
    blockType: "userMessage" as const,
  }));

  const assistantUnits = new Map<string, ThreadSearchUnitModel>();
  for (const block of [
    ...input.buckets.preUserItems,
    ...input.buckets.agentItems,
    ...(input.buckets.assistantItem ? [input.buckets.assistantItem] : []),
    ...input.buckets.postAssistantItems,
  ]) {
    if (block.type !== "assistantMessage") continue;
    const text = projectCodexMarkdownToPlainText(block.entry.markdownText ?? block.searchableText);
    if (!text) continue;
    const key = assistantSearchUnitKey(input.turnSearchKey, block);
    assistantUnits.set(key, {
      key,
      itemId: block.entry.rawItemId ?? block.entry.itemId,
      turnId: input.turnId,
      turnKey: input.turnKey,
      text,
      blockType: "assistantMessage",
    });
  }

  const units = [...userUnits, ...assistantUnits.values()];
  if (!input.turn) return units;
  const order = new Map<string, number>();
  for (const [index, item] of input.turn.items.entries()) {
    const identity = item.rawItemId ?? item.itemId;
    if (!order.has(identity)) order.set(identity, index);
  }
  return units.sort(
    (left, right) =>
      (order.get(left.itemId ?? "") ?? Infinity) - (order.get(right.itemId ?? "") ?? Infinity),
  );
}

const assistantSearchUnitKey = (turnKey: string, block: ThreadTranscriptBlockModel): string =>
  `${turnKey}:assistant:${block.entry.rawItemId ?? block.entry.itemId}`;

function hasRenderableAssistantContent(block: ThreadTranscriptBlockModel | null): boolean {
  if (!block || block.type !== "assistantMessage") return false;
  return block.status === "completed" || (block.entry.markdownText ?? "").trim().length > 0;
}

function applySubagentCommentaryOwnership(
  buckets: ThreadTurnRenderBuckets,
  subagentActivityState: ThreadTurnSubagentActivityState,
): ThreadTurnRenderBuckets {
  if (!subagentActivityState.hasActivity) return buckets;

  const assistantItem = buckets.assistantItem;
  if (!assistantItem || assistantItem.type !== "assistantMessage") return buckets;
  if (assistantItem.entry.assistantPhase !== "commentary") return buckets;
  if (!hasRenderableAssistantContent(assistantItem)) return buckets;

  return {
    ...buckets,
    assistantItem: null,
    agentItems: [
      ...buckets.agentItems.filter(
        (item) =>
          item.type !== "subagentActivityInlineGroup" || item.subagentActivityAnchorItemId !== null,
      ),
      assistantItem,
      ...buckets.agentItems.filter(
        (item) =>
          item.type === "subagentActivityInlineGroup" && item.subagentActivityAnchorItemId === null,
      ),
    ],
  };
}

function decorateAssistantBlock(
  block: ThreadTranscriptBlockModel,
  latestAssistantId: string | null,
  assistantSearchUnitKey: string,
  input: TurnActionInput & {
    includeActions: boolean;
    assistantAfterBlocks?: ThreadBlockModel[];
  },
): ThreadTranscriptBlockModel {
  if (block.type !== "assistantMessage") return block;
  const blockWithSearchKey = withSearchUnitKey(block, assistantSearchUnitKey);
  if (latestAssistantId === null || block.id !== latestAssistantId) return blockWithSearchKey;
  const blockWithAfter =
    applyAssistantAfterBlocks(blockWithSearchKey, input.assistantAfterBlocks ?? []) ??
    blockWithSearchKey;
  if (!input.includeActions) return blockWithSearchKey;

  return applyAssistantMessageActions(blockWithAfter, input) ?? blockWithAfter;
}

export function buildTurnViewModel(input: BuildTurnViewModelInput): ThreadTurnModel {
  const turnKey = input.turnKey ?? input.turnId;
  if (turnKey === null) {
    throw new Error("A nullable local turn requires its occurrence key");
  }
  const turnSearchKey = input.turnSearchKey ?? turnKey;
  const metadata = buildTurnFooterMetadata(input.turn, input.cwd, input.hostId);
  const completedMetadata =
    !input.isStreamingTurn && input.goalTimeUsedSeconds != null
      ? {
          skills: [],
          reviews: [],
          memories: [],
          ...metadata,
          goalTimeUsedSeconds: input.goalTimeUsedSeconds,
        }
      : metadata;
  const actionInput: TurnActionInput = {
    ...input,
    metadata: completedMetadata,
    hookStats: input.isStreamingTurn ? null : buildHookStats(input.turn?.hookRuns),
  };
  const workedForItem = input.workedForItem ?? null;
  const workedForTiming = input.workedForTiming ?? null;
  const workedDurationMs = input.workedDurationMs ?? null;
  const subagentActivityState = input.subagentActivityState ?? EMPTY_SUBAGENT_ACTIVITY_STATE;
  const initialBuckets = applySubagentCommentaryOwnership(input.buckets, subagentActivityState);
  const isCancelledTurn = input.turn?.status === "interrupted";
  const shouldRenderWorkedForInAgentBody = input.turn?.status === "inProgress";
  const searchableAssistant = (block: ThreadTranscriptBlockModel): ThreadTranscriptBlockModel =>
    block.type === "assistantMessage"
      ? withSearchUnitKey(block, assistantSearchUnitKey(turnSearchKey, block))
      : block;
  let buckets: ThreadTurnRenderBuckets = {
    ...initialBuckets,
    preUserItems: initialBuckets.preUserItems.map(searchableAssistant),
    postAssistantItems: initialBuckets.postAssistantItems.map(searchableAssistant),
  };

  const userMessageSearchBlocks = collectUserMessageSearchBlocks(buckets);
  const searchUnits = buildSearchUnits({
    isStreamingTurn: input.isStreamingTurn,
    buckets,
    turn: input.turn,
    turnId: input.turnId,
    turnKey,
    turnSearchKey,
    userMessageBlocks: userMessageSearchBlocks,
  });
  const userSearchUnitKeyByBlockId = new Map(
    userMessageSearchBlocks.map(
      (block, index) => [block.id, `${turnSearchKey}:user:${index}`] as const,
    ),
  );
  const latestAssistantId = buckets.latestAssistantMessage?.id ?? null;
  const aboveComposerBlocks = resolveAboveComposerBlocks(buckets, input);
  const turnOwnerHiddenBlockIds = resolveTurnOwnerHiddenBlockIds(buckets, input.isStreamingTurn);
  const generatedImageGalleryBlock =
    input.includeGeneratedImages === false
      ? null
      : buildGeneratedImageGalleryBlock(input.turnId, turnKey, buckets, input);
  const nextAssistantItem =
    buckets.assistantItem === null
      ? null
      : decorateAssistantBlock(
          buckets.assistantItem,
          latestAssistantId,
          assistantSearchUnitKey(turnSearchKey, buckets.assistantItem),
          {
            ...actionInput,
            includeActions: input.voiceWorkActivity === undefined,
            assistantAfterBlocks: [
              ...(generatedImageGalleryBlock ? [generatedImageGalleryBlock] : []),
              ...buckets.postAssistantItems,
              ...(buckets.unifiedDiffItem ? [buckets.unifiedDiffItem] : []),
            ].filter((block) => !turnOwnerHiddenBlockIds.has(block.id)),
          },
        );
  const nextAgentItems = buckets.agentItems.map((block): ThreadAgentItemModel => {
    if (block.type === "assistantMessage") {
      return decorateAssistantBlock(
        block,
        latestAssistantId,
        assistantSearchUnitKey(turnSearchKey, block),
        {
          ...actionInput,
          includeActions: false,
        },
      );
    }
    if (block.type === "userMessage") {
      const [userBlock] = applyUserMessageActions([block], {
        turn: input.turn,
        canEditTurnUserPrefix: false,
        hookStats: actionInput.hookStats,
        fallbackHookStats: null,
        isTurnPrefix: false,
      });
      return withSearchUnitKey(
        userBlock ?? block,
        userSearchUnitKeyByBlockId.get(block.id) ?? `${turnSearchKey}:user:0`,
      );
    }
    return block;
  });
  const nextLatestAssistantMessage =
    nextAssistantItem?.id === latestAssistantId
      ? nextAssistantItem
      : (nextAgentItems.find(
          (block): block is ThreadTranscriptBlockModel =>
            block.type === "assistantMessage" && block.id === latestAssistantId,
        ) ?? buckets.latestAssistantMessage);
  const deferredAssistantActionsBlock =
    nextAssistantItem === null && input.voiceWorkActivity === undefined
      ? (buildDeferredAssistantActionsBlock(nextLatestAssistantMessage, actionInput) ??
        (generatedImageGalleryBlock
          ? buildGeneratedImageActionsBlock(buckets.toolOutputItems[0], actionInput)
          : null))
      : null;

  buckets = {
    ...buckets,
    userItems: applyUserMessageActions(
      buckets.userItems.map((block, index) =>
        withSearchUnitKey(
          block,
          userSearchUnitKeyByBlockId.get(block.id) ?? `${turnSearchKey}:user:${index}`,
        ),
      ),
      {
        ...input,
        hookStats: actionInput.hookStats,
        fallbackHookStats:
          !nextAssistantItem && !generatedImageGalleryBlock ? actionInput.hookStats : null,
      },
    ),
    assistantItem: nextAssistantItem,
    agentItems: nextAgentItems,
    latestAssistantMessage: nextLatestAssistantMessage,
  };
  const visibleAgentItems = shouldRenderWorkedForInAgentBody
    ? buckets.agentItems
    : buckets.agentItems.filter((item) => item.type !== "workedFor");
  const activityPresentation = projectThreadActivityPresentation({
    agentItems: visibleAgentItems,
    assistantItem: buckets.assistantItem,
    proposedPlanItem: buckets.proposedPlanItem,
    isLatestTurn: input.isLatestTurn,
    isTurnInProgress: input.isStreamingTurn,
    isTurnCancelled: isCancelledTurn,
    isBlocked: input.isBlocked,
    showSafetyBufferingUi: input.turn?.safetyBuffering?.showBufferingUi === true,
    hasBlockingRequest: hasBlockingTurnRequest(buckets),
    hasPendingGeneratedOutput: (generatedImageGalleryBlock?.pendingImageCount ?? 0) > 0,
    hasPostAssistantUnits: buckets.postAssistantItems.length > 0,
    mcpApps: input.mcpApps,
    mcpServerStatuses: input.mcpServerStatuses ?? null,
  });
  const agentBodyUnits = activityPresentation.units;
  const agentBodyCollapsePresentation = projectAgentBodyCollapsePresentation(agentBodyUnits);
  const liveActivity: ThreadLiveActivityPresentation = activityPresentation.liveActivity;

  const leadingBlocks: ThreadBlockModel[] = [
    ...(input.voiceWorkActivity && workedForItem ? [workedForItem] : []),
    ...buckets.modelChangedItems,
    ...buckets.preUserItems,
    ...buckets.userItems,
    ...buckets.modelReroutedItems,
  ];
  const assistantAfterBlockIds = new Set(
    nextAssistantItem?.assistantAfterBlocks?.map((block) => block.id) ?? [],
  );
  const trailingBlocks: ThreadBlockModel[] = [
    ...(buckets.systemEventItem ? [buckets.systemEventItem] : []),
    ...(buckets.assistantItem ? [buckets.assistantItem] : []),
    ...(!buckets.assistantItem && generatedImageGalleryBlock ? [generatedImageGalleryBlock] : []),
    ...(deferredAssistantActionsBlock ? [deferredAssistantActionsBlock] : []),
    ...buckets.postAssistantItems,
    ...buckets.mcpServerElicitationItems,
    ...(buckets.proposedPlanItem ? [buckets.proposedPlanItem] : []),
    ...(buckets.unifiedDiffItem ? [buckets.unifiedDiffItem] : []),
    ...buckets.remoteTaskCreatedItems,
    ...buckets.personalityChangedItems,
    ...buckets.forkedFromConversationItems,
  ].filter(
    (block) => !turnOwnerHiddenBlockIds.has(block.id) && !assistantAfterBlockIds.has(block.id),
  );
  const resolvedBlocks = flattenBlocks(leadingBlocks, agentBodyUnits, trailingBlocks);
  const hasFinalAssistantStarted =
    (buckets.assistantItem?.type === "assistantMessage" &&
      buckets.assistantItem.entry.assistantPhase === "final_answer" &&
      hasRenderableAssistantContent(buckets.assistantItem)) ||
    (!input.isStreamingTurn && subagentActivityState.hasActivity);
  const hasRenderableAgentBodyUnits =
    hasFinalAssistantStarted &&
    !isCancelledTurn &&
    (agentBodyUnits.length > 0 || subagentActivityState.hasActivity);

  return {
    turnId: input.turnId,
    ...(input.voiceWorkActivity ? { voiceWorkActivity: input.voiceWorkActivity } : {}),
    turnKey,
    turn: input.turn,
    buckets,
    leadingBlocks,
    agentBodyUnits,
    trailingBlocks,
    blocks: resolvedBlocks,
    aboveComposerBlocks,
    workedForItem,
    workedForTiming,
    workedDurationMs,
    isLatestTurn: input.isLatestTurn,
    isStreamingTurn: input.isStreamingTurn,
    isBlocked: input.isBlocked,
    liveActivity,
    searchableText: collectSearchableText(resolvedBlocks),
    searchUnits,
    hasRenderableAgentBodyUnits,
    defaultAgentBodyCollapsed:
      !input.voiceWorkActivity &&
      hasRenderableAgentBodyUnits &&
      !subagentActivityState.hasActiveActivity,
    collapsedMessageCount: countAgentBodyUnits(agentBodyCollapsePresentation.collapsibleUnits),
  };
}

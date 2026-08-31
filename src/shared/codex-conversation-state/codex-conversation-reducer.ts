import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { Thread, ThreadItem, UserInput } from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationReplayEvent } from "./codex-conversation-replay";
import type { CodexItemStatus } from "../types";
import {
  isCodexFrameTextDeltaNotification,
  isCodexReasoningSummaryPartAddedNotification,
  reduceCodexConversationFrameTextDeltas,
  toCodexFrameTextDelta,
  toCodexReasoningSummaryPartAddedDelta,
} from "./codex-frame-text-delta";
import {
  isCodexCommandOutputNotification,
  reduceCodexConversationCommandOutput,
  toCodexCommandOutputUpdate,
} from "./codex-command-execution-stream";
import {
  isCodexFileChangeOutputDeltaNotification,
  isCodexFileChangePatchUpdatedNotification,
  isCodexMcpToolCallProgressNotification,
  reduceCodexConversationFileChangePatch,
  reduceCodexConversationMcpToolCallProgress,
  toCodexFileChangePatchUpdate,
  toCodexMcpToolCallProgressUpdate,
} from "./codex-file-change-stream";
import { materializeCodexCanonicalProtocolItem } from "./codex-conversation-state";
import { buildCodexSteeringCompareKey } from "./codex-steering-compare";
import type {
  CodexCanonicalContextCompactionItem,
  CodexCanonicalConversationState,
  CodexCanonicalItem,
  CodexCanonicalSteeredItem,
  CodexCanonicalSteeringUserMessageItem,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";
import {
  ensureCodexCanonicalTurnCollections,
  replaceCodexCanonicalTurnAt,
  upsertCodexCanonicalItemById,
} from "./codex-turn-mutation";
import {
  reduceCodexConversationServerRequest,
  reduceCodexConversationServerRequestResolved,
  type CodexServerRequestLifecycleEffect,
} from "./codex-server-request-lifecycle";
import {
  reduceCodexConversationTurnLifecycle,
  type CodexTurnLifecycleEffect,
} from "./codex-turn-lifecycle";
import {
  reduceCodexConversationThreadGoalCleared,
  reduceCodexConversationThreadGoalUpdated,
  reduceCodexConversationThreadName,
  reduceCodexConversationThreadSettings,
  reduceCodexConversationThreadStarted,
  reduceCodexConversationThreadStatus,
  reduceCodexConversationThreadTokenUsage,
  type CodexThreadMetadataEffect,
} from "./codex-thread-metadata";
import {
  reduceCodexConversationAutomaticApprovalReview,
  reduceCodexConversationError,
  reduceCodexConversationGuardianWarning,
  reduceCodexConversationHookRun,
  reduceCodexConversationModelRerouted,
  reduceCodexConversationSafetyBuffering,
  reduceCodexConversationTurnDiff,
  reduceCodexConversationTurnPlan,
  type CodexTurnMetadataEffect,
} from "./codex-turn-metadata";

export type CodexItemLifecycleNotification = Extract<
  ServerNotification,
  { method: "item/started" | "item/completed" }
>;

export interface CodexConversationReducerContext {
  /**
   * Injected wall clock for the exact bundle's independent `Date.now()` sites.
   * The protocol lifecycle timestamp is intentionally not a substitute.
   */
  readonly now: () => number;
  /** Required only for exact app-local notification rows with opaque IDs. */
  readonly createId?: () => string;
  /** Deterministic source override for replay/tests; live callers use the consumer. */
  readonly contextCompactionSource?: "automatic" | "manual";
  /** Exact stateful consume site; invoked only after an accepted compaction start. */
  readonly consumeContextCompactionSource?: () => "automatic" | "manual";
  /** Pure lookup used by the bundle's collaboration-item enrichment. */
  readonly resolveCollabReceiverThread?: (threadId: string) => Thread | null;
  /** Runtime feature gate read only at OpenAI-form request ingress. */
  readonly isOpenAIFormElicitationsEnabled?: boolean;
}

export interface CodexMarkConversationStreamingEffect {
  readonly type: "markConversationStreaming";
  readonly threadId: string;
}

export interface CodexHydrateCollabThreadsEffect {
  readonly type: "hydrateCollabThreads";
  readonly receiverThreadIds: readonly string[];
}

export type CodexConversationReducerEffect =
  | CodexMarkConversationStreamingEffect
  | CodexHydrateCollabThreadsEffect
  | CodexServerRequestLifecycleEffect
  | CodexThreadMetadataEffect
  | CodexTurnMetadataEffect
  | CodexTurnLifecycleEffect;

export interface CodexConversationReducerResult {
  readonly state: CodexCanonicalConversationState;
  readonly effects: readonly CodexConversationReducerEffect[];
}

export interface CodexItemLifecycleIdentity {
  readonly id: string;
  readonly type: string;
}

export interface CodexItemLifecycleMetadataState {
  readonly items: readonly CodexItemLifecycleIdentity[];
  readonly firstTurnWorkItemStartedAtMs?: number | null;
  readonly finalAssistantStartedAtMs?: number | null;
  readonly lifecycleStatusByItemId?: Readonly<Record<string, CodexItemStatus>>;
  readonly commandExecutionStartedAtMsById?: Readonly<Record<string, number>>;
}

export interface CodexItemLifecycleMetadataResult {
  readonly shouldUpsertItem: boolean;
  readonly upsertIndex: number;
  readonly firstTurnWorkItemStartedAtMs?: number | null;
  readonly finalAssistantStartedAtMs?: number | null;
  readonly lifecycleStatusByItemId?: Readonly<Record<string, CodexItemStatus>>;
  readonly commandExecutionStartedAtMsById?: Readonly<Record<string, number>>;
}

export interface ReduceCodexItemLifecycleMetadataOptions {
  readonly hasMatchingPendingSteer?: boolean;
}

interface ResolvedTurn {
  readonly turns: readonly CodexCanonicalTurnState[];
  readonly turnIndex: number;
}

export interface CodexItemLifecycleTurnResolutionInput {
  readonly turnId: string | null;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly hasError: boolean;
  readonly itemCount: number;
  /** Present only on a client-created placeholder awaiting its server turn id. */
  readonly clientUserMessageId?: string | null;
}

export type CodexItemLifecycleTurnResolution =
  | { readonly kind: "ignore" }
  | { readonly kind: "existing"; readonly turnIndex: number }
  | {
      readonly kind: "rebindInProgressPlaceholder";
      readonly turnIndex: number;
    }
  | {
      readonly kind: "rebindCompletedEmptyPlaceholder";
      readonly turnIndex: number;
    }
  | { readonly kind: "synthesize"; readonly latestTurnIndex: number };

export interface ResolveCodexItemLifecycleTurnOptions {
  /** Defensive compatibility override; generated v2 notifications use string IDs. */
  readonly turnId?: string | null;
}

export const CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID = "pending-manual-context-compaction";

function findLastResolutionTurnIndex(
  turns: readonly CodexItemLifecycleTurnResolutionInput[],
  turnId: string,
): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.turnId === turnId) return index;
  }
  return -1;
}

/** Exact `_Q` / completion turn-selection decision shared by transport adapters. */
export function resolveCodexItemLifecycleTurn(
  turns: readonly CodexItemLifecycleTurnResolutionInput[],
  notification: CodexItemLifecycleNotification,
  options: ResolveCodexItemLifecycleTurnOptions = {},
): CodexItemLifecycleTurnResolution {
  const latestTurnIndex = turns.length - 1;
  const latestTurn = turns[latestTurnIndex];
  if (!latestTurn) return { kind: "ignore" };

  const turnId = options.turnId === undefined ? notification.params.turnId : options.turnId;
  const { item } = notification.params;
  if (notification.method === "item/completed" && item.type !== "userMessage") {
    if (turnId == null) {
      return { kind: "existing", turnIndex: latestTurnIndex };
    }

    const exactIndex = findLastResolutionTurnIndex(turns, turnId);
    return exactIndex < 0 ? { kind: "ignore" } : { kind: "existing", turnIndex: exactIndex };
  }

  if (!turnId) {
    return { kind: "existing", turnIndex: latestTurnIndex };
  }

  const exactIndex = findLastResolutionTurnIndex(turns, turnId);
  if (exactIndex >= 0) {
    return { kind: "existing", turnIndex: exactIndex };
  }

  if (
    notification.method === "item/started" &&
    latestTurn.turnId === null &&
    latestTurn.status === "inProgress" &&
    (item.type === "contextCompaction" || latestTurn.clientUserMessageId != null)
  ) {
    return {
      kind: "rebindInProgressPlaceholder",
      turnIndex: latestTurnIndex,
    };
  }

  if (
    turns.length === 1 &&
    latestTurn.turnId === null &&
    latestTurn.status === "completed" &&
    !latestTurn.hasError &&
    latestTurn.itemCount === 0
  ) {
    return {
      kind: "rebindCompletedEmptyPlaceholder",
      turnIndex: latestTurnIndex,
    };
  }

  return notification.method === "item/started"
    ? { kind: "synthesize", latestTurnIndex }
    : { kind: "ignore" };
}

function rebindTurn(
  turn: CodexCanonicalTurnState,
  turnId: string,
  context: CodexConversationReducerContext,
  status?: "inProgress",
): CodexCanonicalTurnState {
  return {
    ...turn,
    protocol: {
      ...turn.protocol,
      id: turnId,
      ...(status ? { status } : {}),
    },
    sidecar: {
      ...turn.sidecar,
      turnStartedAtMs: turn.sidecar.turnStartedAtMs ?? context.now(),
    },
  };
}

function synthesizeMissingTurn(
  latestTurn: CodexCanonicalTurnState,
  turnId: string,
  context: CodexConversationReducerContext,
): CodexCanonicalTurnState {
  return {
    ...latestTurn,
    protocol: {
      ...latestTurn.protocol,
      id: turnId,
      status: "inProgress",
      error: null,
      durationMs: null,
    },
    items: [],
    sidecar: {
      ...latestTurn.sidecar,
      params: {
        ...latestTurn.sidecar.params,
        input: [],
        personality: null,
        outputSchema: null,
        collaborationMode: null,
        attachments: [],
      },
      turnStartedAtMs: context.now(),
      firstTurnWorkItemStartedAtMs: null,
      finalAssistantStartedAtMs: null,
      diff: null,
    },
  };
}

function applyCanonicalTurnResolution(
  turns: readonly CodexCanonicalTurnState[],
  resolution: CodexItemLifecycleTurnResolution,
  turnId: string,
  context: CodexConversationReducerContext,
): ResolvedTurn | null {
  if (resolution.kind === "ignore") return null;
  if (resolution.kind === "existing") {
    return { turns, turnIndex: resolution.turnIndex };
  }
  if (resolution.kind === "rebindInProgressPlaceholder") {
    const turn = turns[resolution.turnIndex];
    if (!turn) return null;
    return {
      turns: replaceCodexCanonicalTurnAt(
        turns,
        resolution.turnIndex,
        rebindTurn(turn, turnId, context),
      ),
      turnIndex: resolution.turnIndex,
    };
  }
  if (resolution.kind === "rebindCompletedEmptyPlaceholder") {
    const turn = turns[resolution.turnIndex];
    if (!turn) return null;
    return {
      turns: replaceCodexCanonicalTurnAt(
        turns,
        resolution.turnIndex,
        rebindTurn(turn, turnId, context, "inProgress"),
      ),
      turnIndex: resolution.turnIndex,
    };
  }
  const latestTurn = turns[resolution.latestTurnIndex];
  if (!latestTurn) return null;
  return {
    turns: [...turns, synthesizeMissingTurn(latestTurn, turnId, context)],
    turnIndex: turns.length,
  };
}

function materializeCanonicalLifecycleItem(
  item: ThreadItem,
  context: CodexConversationReducerContext,
): CodexCanonicalItem {
  return materializeCodexCanonicalProtocolItem(item, context.resolveCollabReceiverThread);
}

function enqueueCollabHydrationEffect(
  item: ThreadItem,
  effects: CodexConversationReducerEffect[],
): void {
  if (item.type !== "collabAgentToolCall") return;
  effects.push({
    type: "hydrateCollabThreads",
    receiverThreadIds: item.receiverThreadIds,
  });
}

function isMatchingPendingSteer(
  item: CodexCanonicalItem,
  clientUserMessageId: string | null,
  content: readonly UserInput[],
  turn: CodexCanonicalTurnState,
): item is CodexCanonicalSteeringUserMessageItem {
  if (item.type !== "steeringUserMessage" || item.status !== "pending") {
    return false;
  }

  const matchesTurn =
    item.targetTurnId === null
      ? item.targetTurnStartedAtMs !== null &&
        item.targetTurnStartedAtMs === turn.sidecar.turnStartedAtMs
      : item.targetTurnId === turn.protocol.id;
  if (!matchesTurn) {
    return false;
  }

  if (clientUserMessageId) {
    return item.clientUserMessageId === clientUserMessageId;
  }

  const compareKey = buildCodexSteeringCompareKey(
    content,
    item.restoreMessage.context.commentAttachments,
  );
  return (
    item.compareKey.rawText === compareKey.rawText &&
    item.compareKey.imageCount === compareKey.imageCount
  );
}

function findMatchingPendingSteerIndex(
  items: readonly CodexCanonicalItem[],
  clientUserMessageId: string | null,
  content: readonly UserInput[],
  turn: CodexCanonicalTurnState,
): number {
  return items.findIndex((item) =>
    isMatchingPendingSteer(item, clientUserMessageId, content, turn),
  );
}

function getHeartbeatField(text: string, field: string): string | null {
  return (
    new RegExp(`<${field}>\\s*([\\s\\S]*?)\\s*<\\/${field}>`, "i").exec(text)?.[1]?.trim() ?? null
  );
}

function isHeartbeatUserMessage(content: readonly UserInput[]): boolean {
  const text = content
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n")
    .trim();
  if (!text.startsWith("<heartbeat>") || !text.endsWith("</heartbeat>")) {
    return false;
  }

  return (
    getHeartbeatField(text, "current_time_iso") !== null &&
    getHeartbeatField(text, "instructions") !== null
  );
}

export function isCodexLifecycleFirstTurnWorkItem(item: ThreadItem): boolean {
  return item.type !== "userMessage" && item.type !== "hookPrompt";
}

function findExactItemTypeIndex(
  items: readonly CodexItemLifecycleIdentity[],
  item: ThreadItem,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index];
    if (candidate?.id === item.id && candidate.type === item.type) {
      return index;
    }
  }

  return -1;
}

function isCodexItemStatus(value: unknown): value is CodexItemStatus {
  return (
    value === "inProgress" ||
    value === "completed" ||
    value === "failed" ||
    value === "declined" ||
    value === "interrupted"
  );
}

function resolveCompletedLifecycleStatus(item: ThreadItem): CodexItemStatus {
  if ("status" in item && isCodexItemStatus(item.status) && item.status !== "inProgress") {
    return item.status;
  }
  return "completed";
}

function resolveLifecycleStatus(
  previous: CodexItemStatus | undefined,
  notification: CodexItemLifecycleNotification,
): CodexItemStatus {
  if (notification.method === "item/started") {
    // Item IDs are occurrence identities. Once an occurrence is terminal, a
    // duplicate or delayed started event cannot reopen it.
    return previous !== undefined && previous !== "inProgress" ? previous : "inProgress";
  }

  const completedStatus = resolveCompletedLifecycleStatus(notification.params.item);
  return previous !== undefined && previous !== "inProgress" ? previous : completedStatus;
}

/**
 * Shared C-03 lifecycle decision kernel. Raw canonical state and temporary
 * legacy projection adapters both consume this result; only the canonical
 * reducer owns raw item replacement.
 */
export function reduceCodexItemLifecycleMetadata(
  state: CodexItemLifecycleMetadataState,
  notification: CodexItemLifecycleNotification,
  context: Pick<CodexConversationReducerContext, "now">,
  options: ReduceCodexItemLifecycleMetadataOptions = {},
): CodexItemLifecycleMetadataResult {
  const { item } = notification.params;
  const sameIdIndex = state.items.findIndex((candidate) => candidate.id === item.id);
  const upsertIndex = sameIdIndex >= 0 ? sameIdIndex : state.items.length;
  const sameOccurrence = state.items[sameIdIndex]?.type === item.type;
  let firstTurnWorkItemStartedAtMs = state.firstTurnWorkItemStartedAtMs;
  let finalAssistantStartedAtMs = state.finalAssistantStartedAtMs;
  const previousLifecycleStatus = sameOccurrence
    ? state.lifecycleStatusByItemId?.[item.id]
    : undefined;
  const lifecycleStatusByItemId = {
    ...(state.lifecycleStatusByItemId ?? {}),
    [item.id]: resolveLifecycleStatus(previousLifecycleStatus, notification),
  } satisfies Record<string, CodexItemStatus>;
  let commandExecutionStartedAtMsById = state.commandExecutionStartedAtMsById;

  if (notification.method === "item/started") {
    if (previousLifecycleStatus && previousLifecycleStatus !== "inProgress") {
      return {
        shouldUpsertItem: false,
        upsertIndex,
        firstTurnWorkItemStartedAtMs,
        finalAssistantStartedAtMs,
        lifecycleStatusByItemId,
        commandExecutionStartedAtMsById,
      };
    }
    if (
      item.type === "userMessage" &&
      (options.hasMatchingPendingSteer === true || !isHeartbeatUserMessage(item.content))
    ) {
      return {
        shouldUpsertItem: false,
        upsertIndex,
        firstTurnWorkItemStartedAtMs,
        finalAssistantStartedAtMs,
        lifecycleStatusByItemId,
        commandExecutionStartedAtMsById,
      };
    }

    if (item.type === "agentMessage") {
      finalAssistantStartedAtMs = context.now();
    }
    if (isCodexLifecycleFirstTurnWorkItem(item) && firstTurnWorkItemStartedAtMs == null) {
      firstTurnWorkItemStartedAtMs = context.now();
    }
    if (item.type === "commandExecution") {
      commandExecutionStartedAtMsById = {
        ...(commandExecutionStartedAtMsById ?? {}),
        [item.id]: notification.params.startedAtMs,
      };
    }

    return {
      shouldUpsertItem: true,
      upsertIndex,
      firstTurnWorkItemStartedAtMs,
      finalAssistantStartedAtMs,
      lifecycleStatusByItemId,
      commandExecutionStartedAtMsById,
    };
  }

  if (item.type === "commandExecution" && item.durationMs != null) {
    const inferredStartedAtMs = notification.params.completedAtMs - item.durationMs;
    if (commandExecutionStartedAtMsById?.[item.id] === undefined) {
      commandExecutionStartedAtMsById = {
        ...(commandExecutionStartedAtMsById ?? {}),
        [item.id]: inferredStartedAtMs,
      };
    }
  }

  if (item.type === "userMessage" || item.type === "hookPrompt") {
    return {
      shouldUpsertItem: true,
      upsertIndex,
      firstTurnWorkItemStartedAtMs,
      finalAssistantStartedAtMs,
      lifecycleStatusByItemId,
      commandExecutionStartedAtMsById,
    };
  }

  if (firstTurnWorkItemStartedAtMs == null) {
    firstTurnWorkItemStartedAtMs = context.now();
  }

  return {
    shouldUpsertItem:
      item.type === "subAgentActivity" || findExactItemTypeIndex(state.items, item) >= 0,
    upsertIndex,
    firstTurnWorkItemStartedAtMs,
    finalAssistantStartedAtMs,
    lifecycleStatusByItemId,
    commandExecutionStartedAtMsById,
  };
}

function applyLifecycleMetadata(
  turn: CodexCanonicalTurnState,
  metadata: CodexItemLifecycleMetadataResult,
): CodexCanonicalTurnState {
  return {
    ...turn,
    sidecar: {
      ...turn.sidecar,
      ...(metadata.firstTurnWorkItemStartedAtMs === undefined
        ? {}
        : {
            firstTurnWorkItemStartedAtMs: metadata.firstTurnWorkItemStartedAtMs,
          }),
      finalAssistantStartedAtMs: metadata.finalAssistantStartedAtMs ?? null,
      ...(metadata.lifecycleStatusByItemId === undefined
        ? {}
        : {
            lifecycleStatusByItemId: metadata.lifecycleStatusByItemId,
          }),
      ...(metadata.commandExecutionStartedAtMsById === undefined
        ? {}
        : {
            commandExecutionStartedAtMsById: metadata.commandExecutionStartedAtMsById,
          }),
    },
  };
}

function reduceItemStarted(
  state: CodexCanonicalConversationState,
  notification: Extract<CodexItemLifecycleNotification, { method: "item/started" }>,
  context: CodexConversationReducerContext,
  effects: CodexConversationReducerEffect[],
): CodexCanonicalConversationState {
  const { item, threadId, turnId } = notification.params;
  if (state.protocol.id !== threadId) {
    return state;
  }

  const resolution = resolveCodexItemLifecycleTurn(
    state.turns.map((turn) => ({
      turnId: turn.protocol.id,
      status: turn.protocol.status,
      hasError: turn.protocol.error !== null,
      itemCount: turn.items.length,
      clientUserMessageId: turn.sidecar.params.clientUserMessageId ?? null,
    })),
    notification,
  );
  const resolved = applyCanonicalTurnResolution(state.turns, resolution, turnId, context);
  if (!resolved) {
    return state;
  }

  let turn = ensureCodexCanonicalTurnCollections(resolved.turns[resolved.turnIndex]!);
  const hasMatchingPendingSteer =
    item.type === "userMessage" &&
    findMatchingPendingSteerIndex(turn.items, item.clientId, item.content, turn) >= 0;
  const metadata = reduceCodexItemLifecycleMetadata(
    {
      items: turn.items,
      firstTurnWorkItemStartedAtMs: turn.sidecar.firstTurnWorkItemStartedAtMs,
      finalAssistantStartedAtMs: turn.sidecar.finalAssistantStartedAtMs,
      lifecycleStatusByItemId: turn.sidecar.lifecycleStatusByItemId,
      commandExecutionStartedAtMsById: turn.sidecar.commandExecutionStartedAtMsById,
    },
    notification,
    context,
    { hasMatchingPendingSteer },
  );
  turn = applyLifecycleMetadata(turn, metadata);
  if (!metadata.shouldUpsertItem) {
    const turns = replaceCodexCanonicalTurnAt(resolved.turns, resolved.turnIndex, turn);
    return turns === state.turns ? state : { ...state, turns };
  }

  enqueueCollabHydrationEffect(item, effects);
  let nextItem = materializeCanonicalLifecycleItem(item, context);
  let items = turn.items;
  if (item.type === "contextCompaction") {
    nextItem = {
      ...item,
      completed: false,
      source:
        context.consumeContextCompactionSource?.() ??
        context.contextCompactionSource ??
        "automatic",
    } satisfies CodexCanonicalContextCompactionItem;
    items = items.filter(
      (candidate) => candidate.id !== CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID,
    );
  }

  turn = {
    ...turn,
    items: upsertCodexCanonicalItemById(items, nextItem),
  };
  const turns = replaceCodexCanonicalTurnAt(resolved.turns, resolved.turnIndex, turn);
  return { ...state, turns };
}

function buildCompletedContextCompaction(
  item: Extract<ThreadItem, { type: "contextCompaction" }>,
  items: readonly CodexCanonicalItem[],
): CodexCanonicalContextCompactionItem {
  const existing = items.find(
    (candidate) => candidate.type === "contextCompaction" && candidate.id === item.id,
  );
  const source =
    existing &&
    "source" in existing &&
    (existing.source === "automatic" || existing.source === "manual")
      ? existing.source
      : "automatic";

  return {
    ...item,
    completed: true,
    source,
  };
}

function acceptPendingSteer(
  turn: CodexCanonicalTurnState,
  pendingIndex: number,
  completedItemId: string,
): CodexCanonicalTurnState {
  const pending = turn.items[pendingIndex];
  if (pending?.type !== "steeringUserMessage") {
    return turn;
  }

  const itemsWithAcceptedSteer = [...turn.items];
  itemsWithAcceptedSteer[pendingIndex] = {
    ...pending,
    status: "accepted",
  } satisfies CodexCanonicalSteeringUserMessageItem;
  const steeredItem = {
    type: "steered",
    id: completedItemId,
  } satisfies CodexCanonicalSteeredItem;

  return {
    ...turn,
    items: upsertCodexCanonicalItemById(itemsWithAcceptedSteer, steeredItem),
  };
}

function reduceItemCompleted(
  state: CodexCanonicalConversationState,
  notification: Extract<CodexItemLifecycleNotification, { method: "item/completed" }>,
  context: CodexConversationReducerContext,
  effects: CodexConversationReducerEffect[],
): CodexCanonicalConversationState {
  const { item, threadId, turnId } = notification.params;
  if (state.protocol.id !== threadId) {
    return state;
  }

  const resolution = resolveCodexItemLifecycleTurn(
    state.turns.map((turn) => ({
      turnId: turn.protocol.id,
      status: turn.protocol.status,
      hasError: turn.protocol.error !== null,
      itemCount: turn.items.length,
      clientUserMessageId: turn.sidecar.params.clientUserMessageId ?? null,
    })),
    notification,
    { turnId: turnId as string | null },
  );
  const resolved = applyCanonicalTurnResolution(state.turns, resolution, turnId, context);
  if (!resolved) {
    return state;
  }

  let turn = ensureCodexCanonicalTurnCollections(resolved.turns[resolved.turnIndex]!);
  enqueueCollabHydrationEffect(item, effects);
  const completedItem: CodexCanonicalItem =
    item.type === "contextCompaction"
      ? buildCompletedContextCompaction(item, turn.items)
      : materializeCanonicalLifecycleItem(item, context);
  const pendingIndex =
    item.type === "userMessage"
      ? findMatchingPendingSteerIndex(turn.items, item.clientId, item.content, turn)
      : -1;
  const metadata = reduceCodexItemLifecycleMetadata(
    {
      items: turn.items,
      firstTurnWorkItemStartedAtMs: turn.sidecar.firstTurnWorkItemStartedAtMs,
      finalAssistantStartedAtMs: turn.sidecar.finalAssistantStartedAtMs,
      lifecycleStatusByItemId: turn.sidecar.lifecycleStatusByItemId,
      commandExecutionStartedAtMsById: turn.sidecar.commandExecutionStartedAtMsById,
    },
    notification,
    context,
    { hasMatchingPendingSteer: pendingIndex >= 0 },
  );
  turn = applyLifecycleMetadata(turn, metadata);

  if (item.type === "userMessage") {
    turn =
      pendingIndex >= 0
        ? acceptPendingSteer(turn, pendingIndex, item.id)
        : { ...turn, items: upsertCodexCanonicalItemById(turn.items, completedItem) };
    const turns = replaceCodexCanonicalTurnAt(resolved.turns, resolved.turnIndex, turn);
    return { ...state, turns };
  }

  if (item.type === "hookPrompt") {
    turn = { ...turn, items: upsertCodexCanonicalItemById(turn.items, completedItem) };
    const turns = replaceCodexCanonicalTurnAt(resolved.turns, resolved.turnIndex, turn);
    return { ...state, turns };
  }

  if (!metadata.shouldUpsertItem) {
    const turns = replaceCodexCanonicalTurnAt(resolved.turns, resolved.turnIndex, turn);
    return turns === state.turns ? state : { ...state, turns };
  }

  turn = { ...turn, items: upsertCodexCanonicalItemById(turn.items, completedItem) };
  const turns = replaceCodexCanonicalTurnAt(resolved.turns, resolved.turnIndex, turn);
  return { ...state, turns };
}

export function reduceCodexConversationEventWithEffects(
  state: CodexCanonicalConversationState,
  event: CodexConversationReplayEvent,
  context: CodexConversationReducerContext,
): CodexConversationReducerResult {
  const effects: CodexConversationReducerEffect[] = [];
  if (event.type === "request") {
    return reduceCodexConversationServerRequest(state, event.request, context);
  }

  if (event.notification.method === "serverRequest/resolved") {
    return reduceCodexConversationServerRequestResolved(state, event.notification, context);
  }

  if (isCodexFrameTextDeltaNotification(event.notification)) {
    return {
      state: reduceCodexConversationFrameTextDeltas(
        state,
        [toCodexFrameTextDelta(event.notification)],
        context,
      ).state,
      effects,
    };
  }

  if (isCodexReasoningSummaryPartAddedNotification(event.notification)) {
    return {
      state: reduceCodexConversationFrameTextDeltas(
        state,
        [toCodexReasoningSummaryPartAddedDelta(event.notification)],
        context,
      ).state,
      effects,
    };
  }

  if (isCodexCommandOutputNotification(event.notification)) {
    return {
      state: reduceCodexConversationCommandOutput(
        state,
        toCodexCommandOutputUpdate(event.notification),
      ).state,
      effects,
    };
  }

  if (isCodexFileChangePatchUpdatedNotification(event.notification)) {
    return {
      state: reduceCodexConversationFileChangePatch(
        state,
        toCodexFileChangePatchUpdate(event.notification),
        context,
      ).state,
      effects,
    };
  }

  if (isCodexMcpToolCallProgressNotification(event.notification)) {
    return {
      state: reduceCodexConversationMcpToolCallProgress(
        state,
        toCodexMcpToolCallProgressUpdate(event.notification),
        context,
      ).state,
      effects,
    };
  }

  if (isCodexFileChangeOutputDeltaNotification(event.notification)) {
    return { state, effects };
  }

  if (event.notification.method === "thread/started") {
    return {
      state: reduceCodexConversationThreadStarted(state, event.notification.params.thread),
      effects,
    };
  }

  if (event.notification.method === "thread/name/updated") {
    return {
      state: reduceCodexConversationThreadName(
        state,
        event.notification.params.threadId,
        event.notification.params.threadName,
      ),
      effects,
    };
  }

  if (event.notification.method === "thread/settings/updated") {
    return {
      state: reduceCodexConversationThreadSettings(
        state,
        event.notification.params.threadId,
        event.notification.params.threadSettings,
      ),
      effects,
    };
  }

  if (event.notification.method === "thread/status/changed") {
    return reduceCodexConversationThreadStatus(
      state,
      event.notification.params.threadId,
      event.notification.params.status,
    );
  }

  if (event.notification.method === "thread/goal/updated") {
    return reduceCodexConversationThreadGoalUpdated(
      state,
      event.notification.params.threadId,
      event.notification.params.goal,
    );
  }

  if (event.notification.method === "thread/goal/cleared") {
    return {
      state: reduceCodexConversationThreadGoalCleared(state, event.notification.params.threadId),
      effects,
    };
  }

  if (event.notification.method === "thread/tokenUsage/updated") {
    return {
      state: reduceCodexConversationThreadTokenUsage(state, {
        conversationId: event.notification.params.threadId,
        tokenUsage: event.notification.params.tokenUsage,
      }),
      effects,
    };
  }

  if (event.notification.method === "turn/diff/updated") {
    const { threadId, turnId, diff } = event.notification.params;
    const reduced = reduceCodexConversationTurnDiff(state, threadId, turnId, diff, context.now());
    return { state: reduced.state, effects: reduced.effects };
  }

  if (event.notification.method === "model/safetyBuffering/updated") {
    const { threadId, turnId, useCases, reasons, showBufferingUi, fasterModel } =
      event.notification.params;
    const reduced = reduceCodexConversationSafetyBuffering(
      state,
      threadId,
      turnId,
      { useCases, reasons, showBufferingUi, fasterModel },
      context.now(),
    );
    return { state: reduced.state, effects: reduced.effects };
  }

  if (
    event.notification.method === "hook/started" ||
    event.notification.method === "hook/completed"
  ) {
    const { threadId, turnId, run } = event.notification.params;
    const reduced = reduceCodexConversationHookRun(
      state,
      threadId,
      turnId,
      event.notification.method,
      run,
      context.now(),
    );
    return { state: reduced.state, effects: reduced.effects };
  }

  if (event.notification.method === "turn/plan/updated") {
    if (!context.createId) throw new Error("turn/plan/updated requires createId");
    const reduced = reduceCodexConversationTurnPlan(
      state,
      event.notification,
      context.createId(),
      context.now(),
    );
    return { state: reduced.state, effects: reduced.effects };
  }

  if (event.notification.method === "model/rerouted") {
    if (!context.createId) throw new Error("model/rerouted requires createId");
    const reduced = reduceCodexConversationModelRerouted(
      state,
      event.notification,
      context.createId(),
      context.now(),
    );
    return { state: reduced.state, effects: reduced.effects };
  }

  if (event.notification.method === "error") {
    if (!context.createId) throw new Error("error notification requires createId");
    const reduced = reduceCodexConversationError(
      state,
      event.notification,
      context.createId(),
      context.now(),
    );
    return { state: reduced.state, effects: reduced.effects };
  }

  if (
    event.notification.method === "item/autoApprovalReview/started" ||
    event.notification.method === "item/autoApprovalReview/completed"
  ) {
    const reduced = reduceCodexConversationAutomaticApprovalReview(
      state,
      event.notification,
      context.now(),
    );
    return { state: reduced.state, effects: reduced.effects };
  }

  if (event.notification.method === "guardianWarning") {
    const params = event.notification.params as typeof event.notification.params & {
      readonly kind?: string;
    };
    const accepted =
      params.kind === "tooManyDenials" ||
      params.message.startsWith(
        "Automatic approval review rejected too many approval requests for this turn",
      );
    if (!accepted) return { state, effects };
    if (!context.createId) throw new Error("guardianWarning requires createId");
    const reduced = reduceCodexConversationGuardianWarning(
      state,
      params.threadId,
      context.createId(),
    );
    return { state: reduced.state, effects: reduced.effects };
  }

  if (
    event.notification.method === "turn/started" ||
    event.notification.method === "turn/completed"
  ) {
    const lifecycle = reduceCodexConversationTurnLifecycle(state, {
      conversationId: event.notification.params.threadId,
      method: event.notification.method,
      turn: event.notification.params.turn,
      observedAtMs: context.now(),
    });
    effects.push(...lifecycle.effects);
    return {
      state: lifecycle.state,
      effects,
    };
  }

  if (event.notification.method === "item/started") {
    if (state.protocol.id === event.notification.params.threadId) {
      effects.push({
        type: "markConversationStreaming",
        threadId: event.notification.params.threadId,
      });
    }
    return {
      state: reduceItemStarted(state, event.notification, context, effects),
      effects,
    };
  }

  if (event.notification.method === "item/completed") {
    return {
      state: reduceItemCompleted(state, event.notification, context, effects),
      effects,
    };
  }

  return { state, effects };
}

export function reduceCodexConversationEvent(
  state: CodexCanonicalConversationState,
  event: CodexConversationReplayEvent,
  context: CodexConversationReducerContext,
): CodexCanonicalConversationState {
  return reduceCodexConversationEventWithEffects(state, event, context).state;
}

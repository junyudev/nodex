import { enablePatches, produceWithPatches, type Draft, type Patch } from "immer";
import {
  residentConversationTurnEntries,
  conversationTurnDraft,
  appendConversationTurnDraft,
} from "./codex-turn-mutation";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { Thread, ThreadItem, UserInput } from "@nodex/codex-app-server-protocol/v2";
import type { CodexConversationReplayEvent } from "./codex-conversation-replay";
import type { CodexItemStatus } from "../types";
import {
  isCodexFrameTextDeltaNotification,
  isCodexReasoningSummaryPartAddedNotification,
  mutateCodexConversationFrameTextDeltas,
  toCodexFrameTextDelta,
  toCodexReasoningSummaryPartAddedDelta,
} from "./codex-frame-text-delta";
import {
  isCodexCommandOutputNotification,
  mutateCodexConversationCommandOutput,
  toCodexCommandOutputUpdate,
} from "./codex-command-execution-stream";
import {
  isCodexFileChangeOutputDeltaNotification,
  isCodexFileChangePatchUpdatedNotification,
  isCodexMcpToolCallProgressNotification,
  mutateCodexConversationFileChangePatch,
  mutateCodexConversationMcpToolCallProgress,
  toCodexFileChangePatchUpdate,
  toCodexMcpToolCallProgressUpdate,
} from "./codex-file-change-stream";
import { materializeCodexCanonicalProtocolItem } from "./codex-conversation-state";
import { findMatchingPendingSteerIndex } from "./codex-steering-reconciliation";
import type {
  CodexCanonicalContextCompactionItem,
  CodexCanonicalConversationState,
  CodexCanonicalItem,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";
import {
  mutateCodexConversationServerRequest,
  mutateCodexConversationServerRequestResolved,
  type CodexServerRequestLifecycleEffect,
} from "./codex-server-request-lifecycle";
import {
  mutateCodexConversationTurnLifecycle,
  type CodexTurnLifecycleEffect,
} from "./codex-turn-lifecycle";
import {
  mutateCodexConversationThreadGoalCleared,
  mutateCodexConversationThreadGoalUpdated,
  mutateCodexConversationThreadName,
  mutateCodexConversationThreadSettings,
  mutateCodexConversationThreadStarted,
  mutateCodexConversationThreadStatus,
  mutateCodexConversationThreadTokenUsage,
  type CodexThreadMetadataEffect,
} from "./codex-thread-metadata";
import {
  mutateCodexConversationAutomaticApprovalReview,
  mutateCodexConversationError,
  mutateCodexConversationGuardianWarning,
  mutateCodexConversationHookRun,
  mutateCodexConversationModelRerouted,
  mutateCodexConversationSafetyBuffering,
  mutateCodexConversationTurnDiff,
  mutateCodexConversationTurnPlan,
  type CodexTurnMetadataEffect,
} from "./codex-turn-metadata";

enablePatches();

export type CodexItemLifecycleNotification = Extract<
  ServerNotification,
  {
    method: "item/started" | "item/completed";
  }
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
  readonly patches?: readonly Patch[];
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
  readonly assistantMessageStartedAtMsById?: Readonly<Record<string, number>>;
  readonly lifecycleStatusByItemId?: Readonly<Record<string, CodexItemStatus>>;
  readonly commandExecutionStartedAtMsById?: Readonly<Record<string, number>>;
}

export interface CodexItemLifecycleMetadataResult {
  readonly shouldUpsertItem: boolean;
  readonly upsertIndex: number;
  readonly firstTurnWorkItemStartedAtMs?: number | null;
  readonly finalAssistantStartedAtMs?: number | null;
  readonly assistantMessageStartedAtMsById?: Readonly<Record<string, number>>;
  readonly lifecycleStatusByItemId?: Readonly<Record<string, CodexItemStatus>>;
  readonly commandExecutionStartedAtMsById?: Readonly<Record<string, number>>;
}

export interface ReduceCodexItemLifecycleMetadataOptions {
  readonly hasMatchingPendingSteer?: boolean;
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
  | {
      readonly kind: "ignore";
    }
  | {
      readonly kind: "existing";
      readonly turnIndex: number;
    }
  | {
      readonly kind: "rebindInProgressPlaceholder";
      readonly turnIndex: number;
    }
  | {
      readonly kind: "rebindCompletedEmptyPlaceholder";
      readonly turnIndex: number;
    }
  | {
      readonly kind: "synthesize";
      readonly latestTurnIndex: number;
    };
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

function synthesizeMissingTurn(
  latestTurn: CodexCanonicalTurnState,
  turnId: string,
  context: CodexConversationReducerContext,
): CodexCanonicalTurnState {
  return {
    ...latestTurn,
    turnId: turnId,
    status: "inProgress",
    error: null,
    durationMs: null,
    items: [],
    params: {
      ...latestTurn.params,
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
  };
}

function resolveLifecycleTurnDraft(
  state: Draft<CodexCanonicalConversationState>,
  notification: CodexItemLifecycleNotification,
  context: CodexConversationReducerContext,
): Draft<CodexCanonicalTurnState> | null {
  const entries = residentConversationTurnEntries(state);
  const resolution = resolveCodexItemLifecycleTurn(
    entries.map(({ turn }) => ({
      turnId: turn.turnId,
      status: turn.status,
      hasError: turn.error !== null,
      itemCount: turn.items.length,
      clientUserMessageId: turn.params.clientUserMessageId ?? null,
    })),
    notification,
  );
  if (resolution.kind === "ignore") return null;
  if (resolution.kind === "synthesize") {
    const latest = entries[resolution.latestTurnIndex]?.turn;
    if (!latest || !context.createId) return null;
    return appendConversationTurnDraft(
      state,
      synthesizeMissingTurn(latest, notification.params.turnId, context),
      context.createId,
    );
  }
  const entry = entries[resolution.turnIndex];
  const turn = entry ? conversationTurnDraft(state, entry.address) : null;
  if (!turn) return null;
  if (resolution.kind !== "existing") {
    turn.turnId = notification.params.turnId;
    turn.turnStartedAtMs ??= context.now();
    if (resolution.kind === "rebindCompletedEmptyPlaceholder") {
      turn.status = "inProgress";
      turn.params.input = [];
    }
  }
  return turn;
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
  let assistantMessageStartedAtMsById = state.assistantMessageStartedAtMsById;
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
        assistantMessageStartedAtMsById,
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
        assistantMessageStartedAtMsById,
        lifecycleStatusByItemId,
        commandExecutionStartedAtMsById,
      };
    }

    if (item.type === "agentMessage") {
      assistantMessageStartedAtMsById = {
        ...(assistantMessageStartedAtMsById ?? {}),
        [item.id]: sameOccurrence
          ? (assistantMessageStartedAtMsById?.[item.id] ?? notification.params.startedAtMs)
          : notification.params.startedAtMs,
      };
    }
    if (item.type === "agentMessage" && item.delivery !== "async") {
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
      assistantMessageStartedAtMsById,
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
      assistantMessageStartedAtMsById,
      lifecycleStatusByItemId,
      commandExecutionStartedAtMsById,
    };
  }

  if (firstTurnWorkItemStartedAtMs == null) {
    firstTurnWorkItemStartedAtMs = context.now();
  }

  return {
    shouldUpsertItem:
      item.type === "commandExecution" ||
      item.type === "subAgentActivity" ||
      findExactItemTypeIndex(state.items, item) >= 0,
    upsertIndex,
    firstTurnWorkItemStartedAtMs,
    finalAssistantStartedAtMs,
    assistantMessageStartedAtMsById,
    lifecycleStatusByItemId,
    commandExecutionStartedAtMsById,
  };
}

function applyLifecycleMetadataDraft(
  turn: Draft<CodexCanonicalTurnState>,
  metadata: CodexItemLifecycleMetadataResult,
): void {
  if (metadata.firstTurnWorkItemStartedAtMs !== undefined)
    turn.firstTurnWorkItemStartedAtMs = metadata.firstTurnWorkItemStartedAtMs;
  turn.finalAssistantStartedAtMs = metadata.finalAssistantStartedAtMs ?? null;
  if (metadata.assistantMessageStartedAtMsById !== undefined) {
    turn.assistantMessageStartedAtMsById ??= {};
    Object.assign(turn.assistantMessageStartedAtMsById, metadata.assistantMessageStartedAtMsById);
  }
  if (metadata.lifecycleStatusByItemId !== undefined) {
    turn.lifecycleStatusByItemId ??= {};
    Object.assign(turn.lifecycleStatusByItemId, metadata.lifecycleStatusByItemId);
  }
  if (metadata.commandExecutionStartedAtMsById !== undefined) {
    turn.commandExecutionStartedAtMsById ??= {};
    Object.assign(turn.commandExecutionStartedAtMsById, metadata.commandExecutionStartedAtMsById);
  }
}
function upsertLifecycleItem(turn: Draft<CodexCanonicalTurnState>, item: CodexCanonicalItem): void {
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) turn.items.push(item as Draft<CodexCanonicalItem>);
  else turn.items[index] = item as Draft<CodexCanonicalItem>;
}
function mutateItemStarted(
  state: Draft<CodexCanonicalConversationState>,
  notification: Extract<CodexItemLifecycleNotification, { method: "item/started" }>,
  context: CodexConversationReducerContext,
  effects: CodexConversationReducerEffect[],
): void {
  const { item, threadId } = notification.params;
  if (state.id !== threadId) return;
  const turn = resolveLifecycleTurnDraft(state, notification, context);
  if (!turn) return;
  turn.hookRuns ??= [];
  const hasMatchingPendingSteer =
    item.type === "userMessage" &&
    findMatchingPendingSteerIndex(turn.items, item.clientId, item.content, turn) >= 0;
  const metadata = reduceCodexItemLifecycleMetadata(turn, notification, context, {
    hasMatchingPendingSteer,
  });
  applyLifecycleMetadataDraft(turn, metadata);
  if (!metadata.shouldUpsertItem) return;
  enqueueCollabHydrationEffect(item, effects);
  let nextItem = materializeCanonicalLifecycleItem(item, context);
  if (item.type === "contextCompaction") {
    nextItem = {
      ...item,
      completed: false,
      source:
        context.consumeContextCompactionSource?.() ??
        context.contextCompactionSource ??
        "automatic",
    };
    turn.items = turn.items.filter(
      (candidate) => candidate.id !== CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID,
    );
  }
  upsertLifecycleItem(turn, nextItem);
}

function buildCompletedContextCompaction(
  item: Extract<
    ThreadItem,
    {
      type: "contextCompaction";
    }
  >,
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

function mutateItemCompleted(
  state: Draft<CodexCanonicalConversationState>,
  notification: Extract<CodexItemLifecycleNotification, { method: "item/completed" }>,
  context: CodexConversationReducerContext,
  effects: CodexConversationReducerEffect[],
): void {
  const { item, threadId } = notification.params;
  if (state.id !== threadId) return;
  const turn = resolveLifecycleTurnDraft(state, notification, context);
  if (!turn) return;
  turn.hookRuns ??= [];
  enqueueCollabHydrationEffect(item, effects);
  const completedItem =
    item.type === "contextCompaction"
      ? buildCompletedContextCompaction(item, turn.items)
      : materializeCanonicalLifecycleItem(item, context);
  const pendingIndex =
    item.type === "userMessage"
      ? findMatchingPendingSteerIndex(turn.items, item.clientId, item.content, turn)
      : -1;
  const metadata = reduceCodexItemLifecycleMetadata(turn, notification, context, {
    hasMatchingPendingSteer: pendingIndex >= 0,
  });
  applyLifecycleMetadataDraft(turn, metadata);
  if (item.type === "userMessage" && pendingIndex >= 0) {
    const pending = turn.items[pendingIndex];
    if (pending?.type === "steeringUserMessage") {
      pending.status = "accepted";
      pending.serverUserMessageId = item.id;
      const echoIndex = turn.items.findIndex((candidate) => candidate.id === item.id);
      if (echoIndex >= 0 && pendingIndex > echoIndex)
        turn.items.splice(echoIndex, 0, ...turn.items.splice(pendingIndex, 1));
      upsertLifecycleItem(turn, { type: "steered", id: item.id });
    }
    return;
  }
  if (item.type === "userMessage" || item.type === "hookPrompt" || metadata.shouldUpsertItem)
    upsertLifecycleItem(turn, completedItem);
}

export function mutateCodexConversationEvent(
  state: Draft<CodexCanonicalConversationState>,
  event: CodexConversationReplayEvent,
  context: CodexConversationReducerContext,
): readonly CodexConversationReducerEffect[] {
  const effects: CodexConversationReducerEffect[] = [];
  if (event.type === "request") {
    return mutateCodexConversationServerRequest(state, event.request, context).effects;
  }

  if (event.notification.method === "serverRequest/resolved") {
    return mutateCodexConversationServerRequestResolved(state, event.notification, context).effects;
  }

  if (isCodexFrameTextDeltaNotification(event.notification)) {
    mutateCodexConversationFrameTextDeltas(
      state,
      [toCodexFrameTextDelta(event.notification)],
      context,
    );
    return effects;
  }

  if (isCodexReasoningSummaryPartAddedNotification(event.notification)) {
    mutateCodexConversationFrameTextDeltas(
      state,
      [toCodexReasoningSummaryPartAddedDelta(event.notification)],
      context,
    );
    return effects;
  }

  if (isCodexCommandOutputNotification(event.notification)) {
    mutateCodexConversationCommandOutput(state, toCodexCommandOutputUpdate(event.notification));
    return effects;
  }

  if (isCodexFileChangePatchUpdatedNotification(event.notification)) {
    mutateCodexConversationFileChangePatch(
      state,
      toCodexFileChangePatchUpdate(event.notification),
      context,
    );
    return effects;
  }

  if (isCodexMcpToolCallProgressNotification(event.notification)) {
    mutateCodexConversationMcpToolCallProgress(
      state,
      toCodexMcpToolCallProgressUpdate(event.notification),
      context,
    );
    return effects;
  }

  if (isCodexFileChangeOutputDeltaNotification(event.notification)) {
    return effects;
  }

  if (
    event.notification.method === "thread/environment/connected" ||
    event.notification.method === "thread/environment/disconnected"
  ) {
    const { threadId, environmentId } = event.notification.params;
    if (threadId !== state.id || environmentId === "managed") return effects;
    if (event.notification.method === "thread/environment/disconnected") {
      state.connectedEnvironmentIds = state.connectedEnvironmentIds?.filter(
        (id) => id !== environmentId,
      );
      return effects;
    }
    if (!state.connectedEnvironmentIds?.includes(environmentId))
      state.connectedEnvironmentIds = [...(state.connectedEnvironmentIds ?? []), environmentId];
    return effects;
  }

  if (event.notification.method === "thread/started") {
    mutateCodexConversationThreadStarted(state, event.notification.params.thread);
    return effects;
  }

  if (event.notification.method === "thread/name/updated") {
    mutateCodexConversationThreadName(
      state,
      event.notification.params.threadId,
      event.notification.params.threadName,
    );
    return effects;
  }

  if (event.notification.method === "thread/settings/updated") {
    mutateCodexConversationThreadSettings(
      state,
      event.notification.params.threadId,
      event.notification.params.threadSettings,
    );
    return effects;
  }

  if (event.notification.method === "thread/status/changed") {
    return mutateCodexConversationThreadStatus(
      state,
      event.notification.params.threadId,
      event.notification.params.status,
    );
  }

  if (event.notification.method === "thread/goal/updated") {
    return mutateCodexConversationThreadGoalUpdated(
      state,
      event.notification.params.threadId,
      event.notification.params.goal,
    );
  }

  if (event.notification.method === "thread/goal/cleared") {
    mutateCodexConversationThreadGoalCleared(state, event.notification.params.threadId);
    return effects;
  }

  if (event.notification.method === "thread/tokenUsage/updated") {
    mutateCodexConversationThreadTokenUsage(state, {
      conversationId: event.notification.params.threadId,
      tokenUsage: event.notification.params.tokenUsage,
    });
    return effects;
  }

  if (event.notification.method === "turn/diff/updated") {
    const { threadId, turnId, diff } = event.notification.params;
    const reduced = mutateCodexConversationTurnDiff(state, threadId, turnId, diff, context.now());
    return reduced.effects;
  }

  if (event.notification.method === "model/safetyBuffering/updated") {
    const { threadId, turnId, useCases, reasons, showBufferingUi, fasterModel } =
      event.notification.params;
    const reduced = mutateCodexConversationSafetyBuffering(
      state,
      threadId,
      turnId,
      { useCases, reasons, showBufferingUi, fasterModel },
      context.now(),
    );
    return reduced.effects;
  }

  if (
    event.notification.method === "hook/started" ||
    event.notification.method === "hook/completed"
  ) {
    const { threadId, turnId, run } = event.notification.params;
    const reduced = mutateCodexConversationHookRun(
      state,
      threadId,
      turnId,
      event.notification.method,
      run,
      context.now(),
    );
    return reduced.effects;
  }

  if (event.notification.method === "turn/plan/updated") {
    if (!context.createId) throw new Error("turn/plan/updated requires createId");
    const reduced = mutateCodexConversationTurnPlan(
      state,
      event.notification,
      context.createId(),
      context.now(),
    );
    return reduced.effects;
  }

  if (event.notification.method === "model/rerouted") {
    if (!context.createId) throw new Error("model/rerouted requires createId");
    const reduced = mutateCodexConversationModelRerouted(
      state,
      event.notification,
      context.createId(),
      context.now(),
    );
    return reduced.effects;
  }

  if (event.notification.method === "error") {
    if (!context.createId) throw new Error("error notification requires createId");
    const reduced = mutateCodexConversationError(
      state,
      event.notification,
      context.createId(),
      context.now(),
    );
    return reduced.effects;
  }

  if (
    event.notification.method === "item/autoApprovalReview/started" ||
    event.notification.method === "item/autoApprovalReview/completed"
  ) {
    const reduced = mutateCodexConversationAutomaticApprovalReview(
      state,
      event.notification,
      context.now(),
    );
    return reduced.effects;
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
    if (!accepted) return effects;
    if (!context.createId) throw new Error("guardianWarning requires createId");
    const reduced = mutateCodexConversationGuardianWarning(
      state,
      params.threadId,
      context.createId(),
    );
    return reduced.effects;
  }

  if (
    event.notification.method === "turn/started" ||
    event.notification.method === "turn/completed"
  ) {
    const lifecycle = mutateCodexConversationTurnLifecycle(state, {
      conversationId: event.notification.params.threadId,
      method: event.notification.method,
      turn: event.notification.params.turn,
      observedAtMs: context.now(),
    });
    effects.push(...lifecycle.effects);
    return effects;
  }

  if (event.notification.method === "item/started") {
    if (state.id === event.notification.params.threadId) {
      effects.push({
        type: "markConversationStreaming",
        threadId: event.notification.params.threadId,
      });
    }
    mutateItemStarted(state, event.notification, context, effects);
    return effects;
  }

  if (event.notification.method === "item/completed") {
    mutateItemCompleted(state, event.notification, context, effects);
    return effects;
  }

  return effects;
}

export function reduceCodexConversationEventWithEffects(
  state: CodexCanonicalConversationState,
  event: CodexConversationReplayEvent,
  context: CodexConversationReducerContext,
): CodexConversationReducerResult {
  let effects: readonly CodexConversationReducerEffect[] = [];
  const [next, patches] = produceWithPatches(state, (draft) => {
    effects = mutateCodexConversationEvent(draft, event, context);
  });
  return { state: next, effects, patches };
}

export function reduceCodexConversationEvent(
  state: CodexCanonicalConversationState,
  event: CodexConversationReplayEvent,
  context: CodexConversationReducerContext,
): CodexCanonicalConversationState {
  return reduceCodexConversationEventWithEffects(state, event, context).state;
}

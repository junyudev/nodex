import { produce, type Draft } from "immer";
import { residentConversationTurnEntries, residentConversationTurns, conversationTurnDraft } from "./codex-turn-mutation";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type {
  CodexCanonicalConversationState,
} from "./codex-conversation-state";
import { resolveCodexTurnReference } from "./codex-turn-reference";
import type {
  CodexFrameTextDeltaTarget,
  CodexFrameTextDeltaUpdate,
} from "./codex-frame-text-delta-queue";
import {
  appendCodexReasoningPartDelta,
  canAppendCodexReasoningPartDelta,
} from "./codex-reasoning-parts";

export type CodexFrameTextDeltaNotification = Extract<
  ServerNotification,
  {
    method:
      | "item/agentMessage/delta"
      | "item/plan/delta"
      | "item/reasoning/summaryTextDelta"
      | "item/reasoning/textDelta";
  }
>;

export type CodexReasoningSummaryPartAddedNotification = Extract<
  ServerNotification,
  {
    method: "item/reasoning/summaryPartAdded";
  }
>;

export type CodexFrameTextDeltaDisposition =
  | "applied"
  | "foreignConversation"
  | "noTurns"
  | "missingTurn"
  | "missingItem"
  | "invalidReasoningIndex";

export type CodexFrameTextDeltaTurnResolutionKind =
  | "none"
  | "latest"
  | "existing"
  | "reboundCompletedEmptyPlaceholder";

export interface CodexFrameTextDeltaOutcome {
  readonly update: CodexFrameTextDeltaUpdate;
  readonly disposition: CodexFrameTextDeltaDisposition;
  readonly turnResolution: CodexFrameTextDeltaTurnResolutionKind;
  readonly stateChanged: boolean;
}

export interface CodexFrameTextDeltaBatchResult {
  readonly state: CodexCanonicalConversationState;
  readonly outcomes: readonly CodexFrameTextDeltaOutcome[];
}

export interface CodexFrameTextDeltaTurnReference {
  readonly turnId: string | null;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly hasError: boolean;
  readonly itemCount: number;
}

export type CodexFrameTextDeltaTurnResolution =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "latest";
      readonly turnIndex: number;
    }
  | {
      readonly kind: "existing";
      readonly turnIndex: number;
    }
  | {
      readonly kind: "reboundCompletedEmptyPlaceholder";
      readonly turnIndex: number;
    };

export interface CodexFrameTextDeltaItemsResult {
  readonly items: readonly unknown[];
  readonly disposition: "applied" | "missingItem" | "invalidReasoningIndex";
  readonly itemIndex: number;
}

interface ProtocolItemRecord {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

function asProtocolItemRecord(value: unknown): ProtocolItemRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.type !== "string") {
    return null;
  }
  return record as ProtocolItemRecord;
}

function expectedProtocolItemType(target: CodexFrameTextDeltaTarget): string {
  if (target.type === "agentMessage") return "agentMessage";
  if (target.type === "plan") return "plan";
  return "reasoning";
}

function reduceRawItem(
  item: ProtocolItemRecord,
  update: CodexFrameTextDeltaUpdate,
): ProtocolItemRecord {
  switch (update.target.type) {
    case "agentMessage":
    case "plan": {
      const text = `${typeof item.text === "string" ? item.text : ""}${update.delta}`;
      if (item.text === text) return item;
      return { ...item, text };
    }
    case "reasoningSummary": {
      const summary = appendCodexReasoningPartDelta(
        item.summary,
        update.target.summaryIndex,
        update.delta,
      );
      if (summary === item.summary) return item;
      return { ...item, summary };
    }
    case "reasoningContent": {
      const content = appendCodexReasoningPartDelta(
        item.content,
        update.target.contentIndex,
        update.delta,
      );
      if (content === item.content) return item;
      return { ...item, content };
    }
  }
}

export function isCodexFrameTextDeltaNotification(
  notification: ServerNotification,
): notification is CodexFrameTextDeltaNotification {
  return (
    notification.method === "item/agentMessage/delta" ||
    notification.method === "item/plan/delta" ||
    notification.method === "item/reasoning/summaryTextDelta" ||
    notification.method === "item/reasoning/textDelta"
  );
}

export function isCodexReasoningSummaryPartAddedNotification(
  notification: ServerNotification,
): notification is CodexReasoningSummaryPartAddedNotification {
  return notification.method === "item/reasoning/summaryPartAdded";
}

export function toCodexFrameTextDelta(
  notification: CodexFrameTextDeltaNotification,
  turnIdOverride?: string | null,
): CodexFrameTextDeltaUpdate {
  const turnId = turnIdOverride === undefined ? notification.params.turnId : turnIdOverride;
  const target: CodexFrameTextDeltaTarget = (() => {
    if (notification.method === "item/agentMessage/delta") {
      return { type: "agentMessage" };
    }
    if (notification.method === "item/plan/delta") {
      return { type: "plan" };
    }
    if (notification.method === "item/reasoning/summaryTextDelta") {
      return {
        type: "reasoningSummary",
        summaryIndex: notification.params.summaryIndex,
      };
    }
    return {
      type: "reasoningContent",
      contentIndex: notification.params.contentIndex,
    };
  })();

  return {
    conversationId: notification.params.threadId,
    turnId,
    itemId: notification.params.itemId,
    target,
    delta: notification.params.delta,
  };
}

/**
 * The protocol announces a new reasoning-summary part before its text delta. Represent that
 * announcement as an empty dense append so subsequent text cannot require sparse padding.
 */
export function toCodexReasoningSummaryPartAddedDelta(
  notification: CodexReasoningSummaryPartAddedNotification,
): CodexFrameTextDeltaUpdate {
  return {
    conversationId: notification.params.threadId,
    turnId: notification.params.turnId,
    itemId: notification.params.itemId,
    target: {
      type: "reasoningSummary",
      summaryIndex: notification.params.summaryIndex,
    },
    delta: "",
  };
}

export function groupCodexFrameTextDeltasByConversation<TUpdate extends CodexFrameTextDeltaUpdate>(
  updates: readonly TUpdate[],
): ReadonlyMap<string, readonly TUpdate[]> {
  const grouped = new Map<string, TUpdate[]>();
  for (const update of updates) {
    const existing = grouped.get(update.conversationId);
    if (existing) {
      existing.push(update);
    } else {
      grouped.set(update.conversationId, [update]);
    }
  }
  return grouped;
}

/** Exact `_Q` subset used by frame-text deltas. It never synthesizes a turn. */
export function resolveCodexFrameTextDeltaTurn(
  turns: readonly CodexFrameTextDeltaTurnReference[],
  turnId: string | null,
): CodexFrameTextDeltaTurnResolution {
  const resolution = resolveCodexTurnReference(turns, turnId);
  if (resolution.kind === "reboundInProgressPlaceholder") {
    return { kind: "none" };
  }
  return resolution;
}

/**
 * Applies one delta to the reverse-last exact raw ID/type match. `unknown[]`
 * keeps temporary view adapters from becoming a second protocol type model.
 */
export function reduceCodexFrameTextDeltaItems(
  items: readonly unknown[],
  update: CodexFrameTextDeltaUpdate,
): CodexFrameTextDeltaItemsResult {
  const expectedType = expectedProtocolItemType(update.target);
  let itemIndex = -1;
  let item: ProtocolItemRecord | null = null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = asProtocolItemRecord(items[index]);
    if (candidate?.id !== update.itemId || candidate.type !== expectedType) {
      continue;
    }
    itemIndex = index;
    item = candidate;
    break;
  }

  if (!item || itemIndex < 0) {
    return { items, disposition: "missingItem", itemIndex: -1 };
  }

  const reasoningIndex =
    update.target.type === "reasoningSummary"
      ? update.target.summaryIndex
      : update.target.type === "reasoningContent"
        ? update.target.contentIndex
        : null;
  const reasoningParts =
    update.target.type === "reasoningSummary"
      ? item.summary
      : update.target.type === "reasoningContent"
        ? item.content
        : null;
  if (
    reasoningIndex !== null &&
    !canAppendCodexReasoningPartDelta(reasoningParts, reasoningIndex)
  ) {
    return { items, disposition: "invalidReasoningIndex", itemIndex };
  }

  const nextItem = reduceRawItem(item, update);
  if (nextItem === item) {
    return { items, disposition: "applied", itemIndex };
  }

  const nextItems = [...items];
  nextItems[itemIndex] = nextItem;
  return { items: nextItems, disposition: "applied", itemIndex };
}

export function mutateCodexConversationFrameTextDeltas(
  state: Draft<CodexCanonicalConversationState>,
  updates: readonly CodexFrameTextDeltaUpdate[],
  context: { readonly now: () => number },
): readonly CodexFrameTextDeltaOutcome[] {
  const outcomes: CodexFrameTextDeltaOutcome[] = [];
  for (const update of updates) {
    const entries = residentConversationTurnEntries(state);
    if (state.id !== update.conversationId || entries.length === 0) {
      outcomes.push({ update, disposition: state.id !== update.conversationId ? "foreignConversation" : "noTurns", turnResolution: "none", stateChanged: false });
      continue;
    }
    const resolution = resolveCodexFrameTextDeltaTurn(residentConversationTurns(state).map((turn) => ({ turnId: turn.turnId, status: turn.status, hasError: turn.error !== null, itemCount: turn.items.length })), update.turnId);
    if (resolution.kind === "none") {
      outcomes.push({ update, disposition: "missingTurn", turnResolution: "none", stateChanged: false });
      continue;
    }
    const entry = entries[resolution.turnIndex]!;
    const turn = conversationTurnDraft(state, entry.address)!;
    let changed = false;
    if (resolution.kind === "reboundCompletedEmptyPlaceholder" && update.turnId) {
      turn.turnId = update.turnId;
      turn.status = "inProgress";
      turn.turnStartedAtMs ??= context.now();
      changed = true;
    }
    const result = reduceCodexFrameTextDeltaItems(turn.items, update);
    const item = turn.items[result.itemIndex];
    if (result.items !== turn.items && item) {
      if (item.type === "agentMessage" || item.type === "plan") {
        item.text = `${typeof item.text === "string" ? item.text : ""}${update.delta}`;
      } else if (item.type === "reasoning") {
        const target = update.target;
        if (target.type === "reasoningSummary" || target.type === "reasoningContent") {
          const parts = target.type === "reasoningSummary" ? item.summary : item.content;
          const index = target.type === "reasoningSummary" ? target.summaryIndex : target.contentIndex;
          while (parts.length <= index) parts.push("");
          parts[index] = `${parts[index] ?? ""}${update.delta}`;
        }
      }
      changed = true;
    }
    outcomes.push({ update, disposition: result.disposition, turnResolution: resolution.kind, stateChanged: changed });
  }
  return outcomes;
}

export function reduceCodexConversationFrameTextDeltas(
  initialState: CodexCanonicalConversationState,
  updates: readonly CodexFrameTextDeltaUpdate[],
  context: { readonly now: () => number },
): CodexFrameTextDeltaBatchResult {
  let outcomes: readonly CodexFrameTextDeltaOutcome[] = [];
  const state = produce(initialState, (draft) => { outcomes = mutateCodexConversationFrameTextDeltas(draft, updates, context); });
  return { state, outcomes };
}

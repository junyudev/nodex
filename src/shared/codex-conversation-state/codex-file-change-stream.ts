import { produce, type Draft } from "immer";
import {
  residentConversationTurnEntries,
  residentConversationTurns,
  conversationTurnDraft,
} from "./codex-turn-mutation";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { FileUpdateChange, ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalItem,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";
import {
  resolveCodexTurnReference,
  type CodexTurnReference,
  type CodexTurnReferenceResolution,
} from "./codex-turn-reference";

export type CodexFileChangePatchUpdatedNotification = Extract<
  ServerNotification,
  {
    method: "item/fileChange/patchUpdated";
  }
>;

export type CodexFileChangeOutputDeltaNotification = Extract<
  ServerNotification,
  {
    method: "item/fileChange/outputDelta";
  }
>;

export type CodexMcpToolCallProgressNotification = Extract<
  ServerNotification,
  {
    method: "item/mcpToolCall/progress";
  }
>;
export type CodexRawFileChange = Extract<
  ThreadItem,
  {
    type: "fileChange";
  }
>;
export interface CodexFileChangePatchUpdate {
  readonly conversationId: string;
  readonly turnId: string | null;
  readonly itemId: string;
  readonly changes: FileUpdateChange[];
}

export interface CodexMcpToolCallProgressUpdate {
  readonly conversationId: string;
  readonly turnId: string | null;
  readonly itemId: string;
  readonly message: string;
}

export interface CodexFileChangeMutationContext {
  readonly now: () => number;
}

export interface CodexFileChangeRawTurn extends CodexTurnReference {
  readonly turnStartedAtMs: number | null | undefined;
  readonly firstTurnWorkItemStartedAtMs: number | null | undefined;
  readonly items: readonly unknown[];
  readonly hookRuns?: readonly unknown[];
}

export type CodexFileChangeItemMutation = "updatedExact" | "replacedSameId" | "appended";

export type CodexFileChangeRawMutationDisposition = "applied" | "noTurns" | "missingTurn";

export interface CodexFileChangeRawMutationResult {
  readonly disposition: CodexFileChangeRawMutationDisposition;
  readonly resolutionKind: CodexTurnReferenceResolution["kind"];
  readonly turnIndex: number;
  readonly itemIndex: number;
  readonly itemMutation: CodexFileChangeItemMutation | null;
  readonly rawItem: CodexRawFileChange | null;
  readonly turn: CodexFileChangeRawTurn | null;
  readonly stateChanged: boolean;
}

export interface CodexMcpProgressRawMutationResult {
  readonly disposition: CodexFileChangeRawMutationDisposition;
  readonly resolutionKind: CodexTurnReferenceResolution["kind"];
  readonly turnIndex: number;
  readonly matchedItemIndex: number;
  readonly turn: CodexFileChangeRawTurn | null;
  readonly stateChanged: boolean;
}

export type CodexFileChangeCanonicalMutationDisposition =
  | CodexFileChangeRawMutationDisposition
  | "foreignConversation";

export interface CodexFileChangeCanonicalMutationResult {
  readonly state: CodexCanonicalConversationState;
  readonly disposition: CodexFileChangeCanonicalMutationDisposition;
  readonly resolutionKind: CodexTurnReferenceResolution["kind"];
  readonly turnIndex: number;
  readonly itemIndex: number;
  readonly itemMutation: CodexFileChangeItemMutation | null;
  readonly stateChanged: boolean;
}

export interface CodexMcpProgressCanonicalMutationResult {
  readonly state: CodexCanonicalConversationState;
  readonly disposition: CodexFileChangeCanonicalMutationDisposition;
  readonly resolutionKind: CodexTurnReferenceResolution["kind"];
  readonly turnIndex: number;
  readonly matchedItemIndex: number;
  readonly stateChanged: boolean;
}

interface RawItemIdentity {
  readonly id: string;
  readonly type: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asRawItemIdentity(value: unknown): RawItemIdentity | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  if (typeof candidate.id !== "string" || typeof candidate.type !== "string") {
    return null;
  }
  return { id: candidate.id, type: candidate.type };
}

function asRawFileChange(value: unknown): CodexRawFileChange | null {
  const identity = asRawItemIdentity(value);
  if (identity?.type !== "fileChange") return null;
  return value as CodexRawFileChange;
}

function findReverseExactItemIndex(
  items: readonly unknown[],
  itemId: string,
  type: ThreadItem["type"],
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const identity = asRawItemIdentity(items[index]);
    if (identity?.id === itemId && identity.type === type) return index;
  }
  return -1;
}

function findFirstSameIdIndex(items: readonly unknown[], itemId: string): number {
  return items.findIndex((item) => asRawItemIdentity(item)?.id === itemId);
}

function emptyRawResult(disposition: "noTurns" | "missingTurn"): CodexFileChangeRawMutationResult {
  return {
    disposition,
    resolutionKind: "none",
    turnIndex: -1,
    itemIndex: -1,
    itemMutation: null,
    rawItem: null,
    turn: null,
    stateChanged: false,
  };
}

function emptyProgressResult(
  disposition: "noTurns" | "missingTurn",
): CodexMcpProgressRawMutationResult {
  return {
    disposition,
    resolutionKind: "none",
    turnIndex: -1,
    matchedItemIndex: -1,
    turn: null,
    stateChanged: false,
  };
}

function resolveRawTurn(
  turns: readonly CodexFileChangeRawTurn[],
  turnId: string | null,
  rebindLatestInProgressPlaceholder: boolean,
): CodexTurnReferenceResolution {
  return resolveCodexTurnReference(turns, turnId, {
    rebindLatestInProgressPlaceholder,
  });
}

function applyTurnRebind(
  turn: CodexFileChangeRawTurn,
  resolution: CodexTurnReferenceResolution,
  turnId: string | null,
  context: CodexFileChangeMutationContext,
): CodexFileChangeRawTurn {
  if (
    resolution.kind !== "reboundInProgressPlaceholder" &&
    resolution.kind !== "reboundCompletedEmptyPlaceholder"
  ) {
    return turn;
  }
  if (!turnId) return turn;

  const turnStartedAtMs = turn.turnStartedAtMs ?? context.now();
  return {
    ...turn,
    turnId,
    turnStartedAtMs,
    status: resolution.kind === "reboundCompletedEmptyPlaceholder" ? "inProgress" : turn.status,
  };
}

/** Exact `_1`: every `updateTurnState` callback sees initialized collections. */
function ensureRawTurnCollections(turn: CodexFileChangeRawTurn): CodexFileChangeRawTurn {
  if (turn.hookRuns !== undefined) return turn;
  return { ...turn, hookRuns: [] };
}

export function reduceCodexFileChangePatchRawTurns(
  turns: readonly CodexFileChangeRawTurn[],
  update: CodexFileChangePatchUpdate,
  context: CodexFileChangeMutationContext,
): CodexFileChangeRawMutationResult {
  if (turns.length === 0) return emptyRawResult("noTurns");

  const resolution = resolveRawTurn(turns, update.turnId, true);
  if (resolution.kind === "none") return emptyRawResult("missingTurn");
  const sourceTurn = turns[resolution.turnIndex];
  if (!sourceTurn) return emptyRawResult("missingTurn");

  let nextTurn = applyTurnRebind(sourceTurn, resolution, update.turnId, context);
  nextTurn = ensureRawTurnCollections(nextTurn);
  if (nextTurn.firstTurnWorkItemStartedAtMs == null) {
    nextTurn = {
      ...nextTurn,
      firstTurnWorkItemStartedAtMs: context.now(),
    };
  }

  const exactItemIndex = findReverseExactItemIndex(nextTurn.items, update.itemId, "fileChange");
  let itemIndex = exactItemIndex;
  let itemMutation: CodexFileChangeItemMutation;
  let rawItem: CodexRawFileChange;

  if (exactItemIndex >= 0) {
    const existing = asRawFileChange(nextTurn.items[exactItemIndex]);
    if (!existing) return emptyRawResult("missingTurn");
    rawItem =
      existing.changes === update.changes ? existing : { ...existing, changes: update.changes };
    itemMutation = "updatedExact";
  } else {
    rawItem = {
      type: "fileChange",
      id: update.itemId,
      changes: update.changes,
      status: "inProgress",
    };
    const sameIdIndex = findFirstSameIdIndex(nextTurn.items, update.itemId);
    itemIndex = sameIdIndex >= 0 ? sameIdIndex : nextTurn.items.length;
    itemMutation = sameIdIndex >= 0 ? "replacedSameId" : "appended";
  }

  const currentItem = nextTurn.items[itemIndex];
  if (currentItem !== rawItem) {
    const items = [...nextTurn.items];
    if (itemIndex < items.length) {
      items[itemIndex] = rawItem;
    } else {
      items.push(rawItem);
    }
    nextTurn = { ...nextTurn, items };
  }

  return {
    disposition: "applied",
    resolutionKind: resolution.kind,
    turnIndex: resolution.turnIndex,
    itemIndex,
    itemMutation,
    rawItem,
    turn: nextTurn,
    stateChanged: nextTurn !== sourceTurn,
  };
}

export function reduceCodexMcpToolCallProgressRawTurns(
  turns: readonly CodexFileChangeRawTurn[],
  update: CodexMcpToolCallProgressUpdate,
  context: CodexFileChangeMutationContext,
): CodexMcpProgressRawMutationResult {
  if (turns.length === 0) return emptyProgressResult("noTurns");

  const resolution = resolveRawTurn(turns, update.turnId, false);
  if (resolution.kind === "none") return emptyProgressResult("missingTurn");
  const sourceTurn = turns[resolution.turnIndex];
  if (!sourceTurn) return emptyProgressResult("missingTurn");

  const reboundTurn = applyTurnRebind(sourceTurn, resolution, update.turnId, context);
  const turn = ensureRawTurnCollections(reboundTurn);
  return {
    disposition: "applied",
    resolutionKind: resolution.kind,
    turnIndex: resolution.turnIndex,
    matchedItemIndex: findReverseExactItemIndex(turn.items, update.itemId, "mcpToolCall"),
    turn,
    stateChanged: turn !== sourceTurn,
  };
}

function buildCanonicalRawTurns(
  state: CodexCanonicalConversationState,
): readonly CodexFileChangeRawTurn[] {
  return residentConversationTurns(state).map((turn) => ({
    turnId: turn.turnId,
    status: turn.status,
    hasError: turn.error !== null,
    itemCount: turn.items.length,
    turnStartedAtMs: turn.turnStartedAtMs,
    firstTurnWorkItemStartedAtMs: turn.firstTurnWorkItemStartedAtMs,
    items: turn.items,
    hookRuns: turn.hookRuns,
  }));
}

function applyRawTurnMetadata(
  state: Draft<CodexCanonicalConversationState>,
  index: number,
  raw: CodexFileChangeRawTurn,
): Draft<CodexCanonicalTurnState> | null {
  const entry = residentConversationTurnEntries(state)[index];
  const turn = entry ? conversationTurnDraft(state, entry.address) : null;
  if (!turn) return null;
  turn.turnId = raw.turnId;
  turn.status = raw.status;
  turn.turnStartedAtMs = raw.turnStartedAtMs ?? null;
  if (raw.firstTurnWorkItemStartedAtMs !== undefined)
    turn.firstTurnWorkItemStartedAtMs = raw.firstTurnWorkItemStartedAtMs;
  if (raw.hookRuns !== undefined) Object.assign(turn, { hookRuns: raw.hookRuns });
  return turn;
}

export function mutateCodexConversationFileChangePatch(
  state: Draft<CodexCanonicalConversationState>,
  update: CodexFileChangePatchUpdate,
  context: CodexFileChangeMutationContext,
): Omit<CodexFileChangeCanonicalMutationResult, "state"> {
  if (state.id !== update.conversationId)
    return {
      disposition: "foreignConversation",
      resolutionKind: "none",
      turnIndex: -1,
      itemIndex: -1,
      itemMutation: null,
      stateChanged: false,
    };
  const result = reduceCodexFileChangePatchRawTurns(buildCanonicalRawTurns(state), update, context);
  if (result.stateChanged && result.turn) {
    const turn = applyRawTurnMetadata(state, result.turnIndex, result.turn);
    if (turn && result.rawItem) {
      const current = turn.items[result.itemIndex];
      if (result.itemMutation === "updatedExact" && current?.type === "fileChange")
        Object.assign(current, { changes: result.rawItem.changes });
      else if (result.itemIndex < turn.items.length)
        turn.items[result.itemIndex] = result.rawItem as Draft<CodexCanonicalItem>;
      else turn.items.push(result.rawItem as Draft<CodexCanonicalItem>);
    }
  }
  return {
    disposition: result.disposition,
    resolutionKind: result.resolutionKind,
    turnIndex: result.turnIndex,
    itemIndex: result.itemIndex,
    itemMutation: result.itemMutation,
    stateChanged: result.stateChanged,
  };
}
export function mutateCodexConversationMcpToolCallProgress(
  state: Draft<CodexCanonicalConversationState>,
  update: CodexMcpToolCallProgressUpdate,
  context: CodexFileChangeMutationContext,
): Omit<CodexMcpProgressCanonicalMutationResult, "state"> {
  if (state.id !== update.conversationId)
    return {
      disposition: "foreignConversation",
      resolutionKind: "none",
      turnIndex: -1,
      matchedItemIndex: -1,
      stateChanged: false,
    };
  const result = reduceCodexMcpToolCallProgressRawTurns(
    buildCanonicalRawTurns(state),
    update,
    context,
  );
  if (result.stateChanged && result.turn)
    applyRawTurnMetadata(state, result.turnIndex, result.turn);
  return {
    disposition: result.disposition,
    resolutionKind: result.resolutionKind,
    turnIndex: result.turnIndex,
    matchedItemIndex: result.matchedItemIndex,
    stateChanged: result.stateChanged,
  };
}
export function reduceCodexConversationFileChangePatch(
  state: CodexCanonicalConversationState,
  update: CodexFileChangePatchUpdate,
  context: CodexFileChangeMutationContext,
): CodexFileChangeCanonicalMutationResult {
  let operation!: Omit<CodexFileChangeCanonicalMutationResult, "state">;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationFileChangePatch(draft, update, context);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}
export function reduceCodexConversationMcpToolCallProgress(
  state: CodexCanonicalConversationState,
  update: CodexMcpToolCallProgressUpdate,
  context: CodexFileChangeMutationContext,
): CodexMcpProgressCanonicalMutationResult {
  let operation!: Omit<CodexMcpProgressCanonicalMutationResult, "state">;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationMcpToolCallProgress(draft, update, context);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}

export function isCodexFileChangePatchUpdatedNotification(
  notification: ServerNotification,
): notification is CodexFileChangePatchUpdatedNotification {
  return notification.method === "item/fileChange/patchUpdated";
}

export function isCodexFileChangeOutputDeltaNotification(
  notification: ServerNotification,
): notification is CodexFileChangeOutputDeltaNotification {
  return notification.method === "item/fileChange/outputDelta";
}

export function isCodexMcpToolCallProgressNotification(
  notification: ServerNotification,
): notification is CodexMcpToolCallProgressNotification {
  return notification.method === "item/mcpToolCall/progress";
}

export function toCodexFileChangePatchUpdate(
  notification: CodexFileChangePatchUpdatedNotification,
  turnIdOverride?: string | null,
): CodexFileChangePatchUpdate {
  return {
    conversationId: notification.params.threadId,
    turnId: turnIdOverride === undefined ? notification.params.turnId : turnIdOverride,
    itemId: notification.params.itemId,
    changes: notification.params.changes,
  };
}

export function toCodexMcpToolCallProgressUpdate(
  notification: CodexMcpToolCallProgressNotification,
  turnIdOverride?: string | null,
): CodexMcpToolCallProgressUpdate {
  return {
    conversationId: notification.params.threadId,
    turnId: turnIdOverride === undefined ? notification.params.turnId : turnIdOverride,
    itemId: notification.params.itemId,
    message: notification.params.message,
  };
}

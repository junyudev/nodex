import { produce, type Draft } from "immer";
import { mutateCodexTurnExecution, type CodexPreparedTurnExecution } from "./codex-turn-execution";
import {
  residentConversationTurnEntries,
  conversationTurnDraft,
  appendConversationTurnDraft,
  removeConversationTurnDraft,
} from "./codex-turn-mutation";
import type { Turn } from "@nodex/codex-app-server-protocol/v2/Turn";
import {
  appendCodexCanonicalWorktreeInitItem,
  type CodexCanonicalConversationState,
  type CodexCanonicalLiveTurnParams,
  type CodexCanonicalTurnState,
  type CodexCanonicalWorktreeInitItem,
} from "./codex-conversation-state";

export interface CodexOptimisticTurnInput {
  readonly execution?: CodexPreparedTurnExecution;
  readonly params: CodexCanonicalLiveTurnParams;
  readonly localMetadata?: unknown;
  readonly mcpAppModelContextAttachments?: unknown;
  readonly startedAtMs?: number;
  readonly createId?: () => string;
}

const CODEX_MODEL_GENERATIONS = ["luna", "terra", "sol"] as const;
const CODEX_VERSIONED_MODEL_PATTERN =
  /^(?<family>[a-z][a-z0-9-]*?)-(?<version>\d+(?:\.\d+)*)(?:-|$)/iu;

function parseCodexVersionedModel(model: string): {
  readonly family: string;
  readonly parts: readonly number[];
} | null {
  const match = CODEX_VERSIONED_MODEL_PATTERN.exec(model);
  const family = match?.groups?.family;
  const version = match?.groups?.version;
  if (!family || !version) return null;
  return { family: family.toLowerCase(), parts: version.split(".").map(Number) };
}

function compareCodexModelVersionParts(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function readCodexModelGeneration(model: string): (typeof CODEX_MODEL_GENERATIONS)[number] | null {
  const tokens = model.toLowerCase().split(/[^a-z0-9]+/u);
  const matches = CODEX_MODEL_GENERATIONS.filter((generation) => tokens.includes(generation));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Exact `R6e`: upgrades suppress the local model-changed marker. */
function isCodexModelUpgrade(previousModel: string, currentModel: string): boolean {
  if (previousModel === currentModel) return false;
  const previousVersion = parseCodexVersionedModel(previousModel);
  const currentVersion = parseCodexVersionedModel(currentModel);
  if (previousVersion && currentVersion && previousVersion.family === currentVersion.family) {
    const comparison = compareCodexModelVersionParts(currentVersion.parts, previousVersion.parts);
    if (comparison !== 0) return comparison > 0;
  }
  const previousGeneration = readCodexModelGeneration(previousModel);
  const currentGeneration = readCodexModelGeneration(currentModel);
  return (
    previousGeneration !== null &&
    currentGeneration !== null &&
    CODEX_MODEL_GENERATIONS.indexOf(currentGeneration) >
      CODEX_MODEL_GENERATIONS.indexOf(previousGeneration)
  );
}

function isMatchingOptimisticTurn(
  turn: CodexCanonicalTurnState,
  clientUserMessageId: string,
): boolean {
  return (
    turn.turnId === null &&
    turn.status === "inProgress" &&
    turn.params.clientUserMessageId === clientUserMessageId
  );
}

function findMatchingOptimisticTurnIndex(
  turns: readonly CodexCanonicalTurnState[],
  clientUserMessageId: string,
): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn && isMatchingOptimisticTurn(turn, clientUserMessageId)) return index;
  }
  return -1;
}

function findBoundTurnIndex(turns: readonly CodexCanonicalTurnState[], turnId: string): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.turnId === turnId) return index;
  }
  return -1;
}

function mergeCanonicalTurnItems(
  optimistic: CodexCanonicalTurnState,
  bound: CodexCanonicalTurnState,
): readonly CodexCanonicalTurnState["items"][number][] {
  const items = [...optimistic.items];
  const indexById = new Map(items.map((item, index) => [item.id, index] as const));
  for (const item of bound.items) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex === undefined) {
      indexById.set(item.id, items.length);
      items.push(item);
      continue;
    }
    items[existingIndex] = item;
  }
  return items;
}

function mergeSplitOptimisticTurn(
  optimistic: CodexCanonicalTurnState,
  bound: CodexCanonicalTurnState,
  responseTurn: Turn,
): CodexCanonicalTurnState {
  const status = bound.status === "inProgress" ? responseTurn.status : bound.status;
  return {
    ...optimistic,
    ...bound,
    status,
    items: mergeCanonicalTurnItems(optimistic, bound),
    entityKey: optimistic.entityKey ?? bound.entityKey,
    params: optimistic.params,
    turnStartedAtMs: optimistic.turnStartedAtMs ?? bound.turnStartedAtMs,
  };
}

/** Exact `X1`/`gQ`: publish a nullable in-progress turn before dispatch. */
export function mutateCodexCanonicalOptimisticTurn(
  state: Draft<CodexCanonicalConversationState>,
  input: CodexOptimisticTurnInput,
): void {
  const observedAtMs = input.startedAtMs ?? Date.now();
  const previousModel = state.previousTurnModel ?? null;
  const currentModel = state.latestCollaborationMode.settings.model;
  const items =
    previousModel && currentModel && !isCodexModelUpgrade(previousModel, currentModel)
      ? [
          {
            id: (input.createId ?? (() => globalThis.crypto.randomUUID()))(),
            type: "modelChanged" as const,
            fromModel: previousModel,
            toModel: currentModel,
          },
        ]
      : [];
  const turn: CodexCanonicalTurnState = {
    turnId: null,
    itemsView: "full",
    status: "inProgress",
    error: null,
    durationMs: null,
    items,
    entityKey:
      input.params.clientUserMessageId === null
        ? undefined
        : `turn-local:${input.params.clientUserMessageId}`,
    params: input.params,
    ...(input.localMetadata === undefined ? {} : { localMetadata: input.localMetadata }),
    ...(input.mcpAppModelContextAttachments === undefined
      ? {}
      : { mcpAppModelContextAttachments: input.mcpAppModelContextAttachments }),
    diff: null,
    turnStartedAtMs: observedAtMs,
    firstTurnWorkItemStartedAtMs: null,
    finalAssistantStartedAtMs: null,
    hookRuns: [],
  };

  appendConversationTurnDraft(
    state,
    turn,
    input.createId ?? (() => globalThis.crypto.randomUUID()),
  );
  if (state.threadRuntimeStatus.type !== "active")
    state.threadRuntimeStatus = { type: "active", activeFlags: [] };
  state.updatedAt = observedAtMs;
  state.recencyAt = observedAtMs;
  state.previousTurnModel = null;
  if (input.execution) mutateCodexTurnExecution(state, input.execution);
}

export function appendCodexCanonicalOptimisticTurn(
  state: CodexCanonicalConversationState,
  input: CodexOptimisticTurnInput,
): CodexCanonicalConversationState {
  return produce(state, (draft) => mutateCodexCanonicalOptimisticTurn(draft, input));
}

/**
 * Publish worktree initialization into the optimistic first turn before its
 * app-server items arrive. This keeps the activity in the Turn's collapsible
 * agent body while the user message still owns the Turn prefix.
 */
export function appendCodexCanonicalOptimisticFirstTurn(
  state: CodexCanonicalConversationState,
  input: CodexOptimisticTurnInput,
  worktreeInit?: CodexCanonicalWorktreeInitItem,
): CodexCanonicalConversationState {
  const optimistic = appendCodexCanonicalOptimisticTurn(state, input);
  return worktreeInit ? appendCodexCanonicalWorktreeInitItem(optimistic, worktreeInit) : optimistic;
}

/** Bind the matching nullable turn, coalescing any server occurrence that won the race. */
export function mutateCodexCanonicalOptimisticTurnBinding(
  state: Draft<CodexCanonicalConversationState>,
  clientUserMessageId: string,
  turn: Turn,
): void {
  const entries = residentConversationTurnEntries(state);
  const turns = entries.map(({ turn }) => turn);
  const boundIndex = findBoundTurnIndex(turns, turn.id);
  const optimisticIndex = findMatchingOptimisticTurnIndex(turns, clientUserMessageId);
  if (boundIndex >= 0 && optimisticIndex >= 0) {
    const merged = mergeSplitOptimisticTurn(turns[optimisticIndex]!, turns[boundIndex]!, turn);
    const retained = entries[Math.min(boundIndex, optimisticIndex)]!;
    const removed = entries[Math.max(boundIndex, optimisticIndex)]!;
    Object.assign(conversationTurnDraft(state, retained.address)!, merged);
    removeConversationTurnDraft(state, removed.address);
    return;
  }
  const entry = entries[boundIndex >= 0 ? boundIndex : optimisticIndex];
  if (!entry) return;
  const target = conversationTurnDraft(state, entry.address)!;
  const status = target.status === "inProgress" ? turn.status : target.status;
  target.turnId = turn.id;
  target.status = status;
}
export function bindCodexCanonicalOptimisticTurn(
  state: CodexCanonicalConversationState,
  clientUserMessageId: string,
  turn: Turn,
): CodexCanonicalConversationState {
  return produce(state, (draft) =>
    mutateCodexCanonicalOptimisticTurnBinding(draft, clientUserMessageId, turn),
  );
}

/** Exact `X1` catch branch: keep the created thread and terminalize its placeholder. */
export function mutateCodexCanonicalOptimisticTurnFailure(
  state: Draft<CodexCanonicalConversationState>,
  clientUserMessageId: string,
  errorItemId = globalThis.crypto.randomUUID(),
): void {
  const entries = residentConversationTurnEntries(state);
  const entry =
    entries[
      findMatchingOptimisticTurnIndex(
        entries.map(({ turn }) => turn),
        clientUserMessageId,
      )
    ];
  if (!entry) return;
  const turn = conversationTurnDraft(state, entry.address)!;
  const message = "Error submitting message";
  turn.items.push({
    id: errorItemId,
    type: "error",
    message,
    willRetry: false,
    errorInfo: null,
    additionalDetails: null,
  });
  turn.status = "failed";
  turn.error = { message, codexErrorInfo: null, additionalDetails: null, misalignment: null };
}
export function failCodexCanonicalOptimisticTurn(
  state: CodexCanonicalConversationState,
  clientUserMessageId: string,
  errorItemId = globalThis.crypto.randomUUID(),
): CodexCanonicalConversationState {
  return produce(state, (draft) =>
    mutateCodexCanonicalOptimisticTurnFailure(draft, clientUserMessageId, errorItemId),
  );
}

/** Resume failures remove their userless placeholder so Resume remains available. */
export function mutateCodexCanonicalOptimisticTurnRemoval(
  state: Draft<CodexCanonicalConversationState>,
  clientUserMessageId: string,
  options?: { readonly previousTurnModel: string | null },
): void {
  const entries = residentConversationTurnEntries(state);
  const entry =
    entries[
      findMatchingOptimisticTurnIndex(
        entries.map(({ turn }) => turn),
        clientUserMessageId,
      )
    ];
  if (!entry) return;
  removeConversationTurnDraft(state, entry.address);
  if (options && state.previousTurnModel === null)
    state.previousTurnModel = options.previousTurnModel;
}
export function removeCodexCanonicalOptimisticTurn(
  state: CodexCanonicalConversationState,
  clientUserMessageId: string,
  options?: { readonly previousTurnModel: string | null },
): CodexCanonicalConversationState {
  return produce(state, (draft) =>
    mutateCodexCanonicalOptimisticTurnRemoval(draft, clientUserMessageId, options),
  );
}

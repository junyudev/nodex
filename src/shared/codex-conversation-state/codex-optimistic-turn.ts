import type { Turn } from "@nodex/codex-app-server-protocol/v2/Turn";
import {
  appendCodexCanonicalWorktreeInitItem,
  type CodexCanonicalConversationState,
  type CodexCanonicalLiveTurnParams,
  type CodexCanonicalTurnState,
  type CodexCanonicalWorktreeInitItem,
} from "./codex-conversation-state";

export interface CodexOptimisticTurnInput {
  readonly params: CodexCanonicalLiveTurnParams;
  readonly currentCollaborationModel?: string;
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

function readCurrentCollaborationModel(
  state: CodexCanonicalConversationState,
  input: CodexOptimisticTurnInput,
): string {
  return (
    input.currentCollaborationModel ??
    state.sidecar.latestThreadSettings?.collaborationMode.settings.model ??
    state.sidecar.hydrationContext?.latestThreadSettings?.collaborationMode?.settings.model ??
    ""
  );
}

function isMatchingOptimisticTurn(
  turn: CodexCanonicalTurnState,
  clientUserMessageId: string,
): boolean {
  return (
    turn.protocol.id === null &&
    turn.protocol.status === "inProgress" &&
    turn.sidecar.params.clientUserMessageId === clientUserMessageId
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
    if (turns[index]?.protocol.id === turnId) return index;
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
  const status =
    bound.protocol.status === "inProgress" ? responseTurn.status : bound.protocol.status;
  return {
    protocol: {
      ...bound.protocol,
      status,
    },
    items: mergeCanonicalTurnItems(optimistic, bound),
    sidecar: {
      ...optimistic.sidecar,
      ...bound.sidecar,
      params: optimistic.sidecar.params,
      turnStartedAtMs: optimistic.sidecar.turnStartedAtMs ?? bound.sidecar.turnStartedAtMs,
    },
  };
}

/** Exact `X1`/`gQ`: publish a nullable in-progress turn before dispatch. */
export function appendCodexCanonicalOptimisticTurn(
  state: CodexCanonicalConversationState,
  input: CodexOptimisticTurnInput,
): CodexCanonicalConversationState {
  const previousModel = state.sidecar.previousTurnModel ?? null;
  const currentModel = readCurrentCollaborationModel(state, input);
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
    protocol: {
      id: null,
      itemsView: "full",
      status: "inProgress",
      error: null,
      durationMs: null,
    },
    items,
    sidecar: {
      params: input.params,
      diff: null,
      turnStartedAtMs: input.startedAtMs ?? Date.now(),
      firstTurnWorkItemStartedAtMs: null,
      finalAssistantStartedAtMs: null,
      hookRuns: [],
    },
  };

  return {
    ...state,
    turns: [...state.turns, turn],
    sidecar: {
      ...state.sidecar,
      previousTurnModel: null,
    },
  };
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
export function bindCodexCanonicalOptimisticTurn(
  state: CodexCanonicalConversationState,
  clientUserMessageId: string,
  turn: Turn,
): CodexCanonicalConversationState {
  const boundTurnIndex = findBoundTurnIndex(state.turns, turn.id);
  const optimisticTurnIndex = findMatchingOptimisticTurnIndex(state.turns, clientUserMessageId);
  if (boundTurnIndex >= 0 && optimisticTurnIndex >= 0) {
    const bound = state.turns[boundTurnIndex];
    const optimistic = state.turns[optimisticTurnIndex];
    if (!bound || !optimistic) return state;

    const merged = mergeSplitOptimisticTurn(optimistic, bound, turn);
    const mergedIndex = Math.min(boundTurnIndex, optimisticTurnIndex);
    const turns = state.turns.flatMap((candidate, index) => {
      if (index === mergedIndex) return [merged];
      if (index === boundTurnIndex || index === optimisticTurnIndex) return [];
      return [candidate];
    });
    return { ...state, turns };
  }

  const turnIndex = boundTurnIndex >= 0 ? boundTurnIndex : optimisticTurnIndex;
  if (turnIndex < 0) return state;

  const current = state.turns[turnIndex];
  if (!current) return state;
  const status = current.protocol.status === "inProgress" ? turn.status : current.protocol.status;
  if (current.protocol.id === turn.id && current.protocol.status === status) {
    return state;
  }
  const turns = [...state.turns];
  turns[turnIndex] = {
    ...current,
    protocol: {
      ...current.protocol,
      id: turn.id,
      status,
    },
  };

  return { ...state, turns };
}

/** Exact `X1` catch branch: keep the created thread and terminalize its placeholder. */
export function failCodexCanonicalOptimisticTurn(
  state: CodexCanonicalConversationState,
  clientUserMessageId: string,
  errorItemId = globalThis.crypto.randomUUID(),
): CodexCanonicalConversationState {
  const turnIndex = findMatchingOptimisticTurnIndex(state.turns, clientUserMessageId);
  if (turnIndex < 0) return state;

  const optimistic = state.turns[turnIndex];
  if (!optimistic) return state;
  const message = "Error submitting message";
  const turns = [...state.turns];
  turns[turnIndex] = {
    ...optimistic,
    items: [
      ...optimistic.items,
      {
        type: "error",
        id: errorItemId,
        message,
        willRetry: false,
        errorInfo: null,
        additionalDetails: null,
      },
    ],
    protocol: {
      ...optimistic.protocol,
      status: "failed",
      error: {
        message,
        codexErrorInfo: null,
        additionalDetails: null,
        misalignment: null,
      },
    },
  };

  return { ...state, turns };
}

/** Resume failures remove their userless placeholder so Resume remains available. */
export function removeCodexCanonicalOptimisticTurn(
  state: CodexCanonicalConversationState,
  clientUserMessageId: string,
  options?: { readonly previousTurnModel: string | null },
): CodexCanonicalConversationState {
  const turnIndex = findMatchingOptimisticTurnIndex(state.turns, clientUserMessageId);
  if (turnIndex < 0) return state;

  return {
    ...state,
    turns: state.turns.filter((_, index) => index !== turnIndex),
    ...(options && state.sidecar.previousTurnModel === null
      ? {
          sidecar: {
            ...state.sidecar,
            previousTurnModel: options.previousTurnModel,
          },
        }
      : {}),
  };
}

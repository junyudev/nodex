import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalItem,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";
import {
  appendCodexCommandOutputTail,
  CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX,
  stripCodexCommandOutputTruncationPrefix,
  type CodexCommandOutputUpdate,
} from "./codex-command-output-queue";
import { codexUtf8ByteLength } from "../codex-terminal-interaction";

export const CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT = 128;
export const CODEX_TERMINAL_COMMAND_ACTION_MAX_UTF8_BYTES = 256 * 1_024;
const CODEX_TERMINAL_COMMAND_ACTION_MAX_CANDIDATE_SCAN = 256;

export type CodexCommandOutputNotification = Extract<
  ServerNotification,
  { method: "item/commandExecution/outputDelta" }
>;

export type CodexTerminalInteractionNotification = Extract<
  ServerNotification,
  { method: "item/commandExecution/terminalInteraction" }
>;

export type CodexRawCommandExecution = Extract<ThreadItem, { type: "commandExecution" }>;

export interface CodexTerminalCommandUpdate {
  readonly conversationId: string;
  readonly turnId: string | null;
  readonly itemId: string;
  readonly commands: readonly string[];
}

export type CodexCommandExecutionMutationDisposition =
  | "applied"
  | "foreignConversation"
  | "noTurns"
  | "missingItem";

export interface CodexCommandExecutionRawTurn {
  readonly items: readonly unknown[];
}

export interface CodexCommandExecutionRawMutationResult {
  readonly disposition: "applied" | "noTurns" | "missingItem";
  readonly turnIndex: number;
  readonly itemIndex: number;
  readonly rawItem: CodexRawCommandExecution | null;
  readonly stateChanged: boolean;
}

export interface CodexCommandExecutionCanonicalMutationResult {
  readonly state: CodexCanonicalConversationState;
  readonly disposition: CodexCommandExecutionMutationDisposition;
  readonly turnIndex: number;
  readonly itemIndex: number;
  readonly stateChanged: boolean;
}

function asRawCommandExecution(value: unknown): CodexRawCommandExecution | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { id?: unknown; type?: unknown };
  if (typeof candidate.id !== "string" || candidate.type !== "commandExecution") {
    return null;
  }
  return value as CodexRawCommandExecution;
}

function findRawCommandExecution(
  turns: readonly CodexCommandExecutionRawTurn[],
  itemId: string,
): {
  readonly turnIndex: number;
  readonly itemIndex: number;
  readonly item: CodexRawCommandExecution;
} | null {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    if (!turn) continue;

    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = asRawCommandExecution(turn.items[itemIndex]);
      if (item?.id !== itemId) continue;
      return { turnIndex, itemIndex, item };
    }
  }
  return null;
}

function readAggregatedOutput(item: CodexRawCommandExecution): string {
  return typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
}

function appendRawCommandOutput(
  item: CodexRawCommandExecution,
  delta: string,
): CodexRawCommandExecution {
  const { text: currentPayload, hadPrefix: hadTruncationPrefix } =
    stripCodexCommandOutputTruncationPrefix(readAggregatedOutput(item));
  const { next, didTruncate } = appendCodexCommandOutputTail({
    current: currentPayload,
    delta,
  });
  const aggregatedOutput =
    didTruncate || hadTruncationPrefix ? `${CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX}${next}` : next;
  if (item.aggregatedOutput === aggregatedOutput) return item;
  return { ...item, aggregatedOutput };
}

function appendRawTerminalCommands(
  item: CodexRawCommandExecution,
  commands: readonly string[],
): CodexRawCommandExecution {
  if (commands.length === 0) return item;
  const commandActions = boundedTerminalCommandActions(item.commandActions, commands);
  if (
    commandActions.length === item.commandActions.length &&
    commandActions.every((action, index) => action === item.commandActions[index])
  ) {
    return item;
  }
  return { ...item, commandActions };
}

type CodexCommandAction = CodexRawCommandExecution["commandActions"][number];

function optionalUtf8ByteLength(value: string | null): number {
  return value === null ? 0 : codexUtf8ByteLength(value);
}

function codexCommandActionUtf8Bytes(action: CodexCommandAction): number {
  if (action.type === "read") {
    return (
      codexUtf8ByteLength(action.command) +
      codexUtf8ByteLength(action.name) +
      codexUtf8ByteLength(action.path) +
      32
    );
  }
  if (action.type === "listFiles") {
    return codexUtf8ByteLength(action.command) + optionalUtf8ByteLength(action.path) + 24;
  }
  if (action.type === "search") {
    return (
      codexUtf8ByteLength(action.command) +
      optionalUtf8ByteLength(action.query) +
      optionalUtf8ByteLength(action.path) +
      32
    );
  }
  return codexUtf8ByteLength(action.command) + 16;
}

/** Keeps a terminal command-action tail bounded even when the input stream contains many lines. */
function boundedTerminalCommandActions(
  existing: readonly CodexCommandAction[],
  commands: readonly string[],
): CodexCommandAction[] {
  const newestFirst: CodexCommandAction[] = [];
  let bytes = 0;
  const appendIfWithinBudget = (action: CodexCommandAction): boolean => {
    const actionBytes = codexCommandActionUtf8Bytes(action);
    if (
      newestFirst.length >= CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT ||
      actionBytes > CODEX_TERMINAL_COMMAND_ACTION_MAX_UTF8_BYTES - bytes
    ) {
      return false;
    }
    newestFirst.push(action);
    bytes += actionBytes;
    return newestFirst.length < CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT;
  };
  const scanTail = <T>(
    values: readonly T[],
    toAction: (value: T) => CodexCommandAction,
  ): boolean => {
    const firstIndex = Math.max(
      0,
      values.length - CODEX_TERMINAL_COMMAND_ACTION_MAX_CANDIDATE_SCAN,
    );
    for (let index = values.length - 1; index >= firstIndex; index -= 1) {
      const value = values[index];
      if (value === undefined) continue;
      if (!appendIfWithinBudget(toAction(value))) {
        if (newestFirst.length >= CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT) return false;
      }
    }
    return newestFirst.length < CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT;
  };

  const hasRoomAfterIncoming = scanTail(commands, (command) => ({ type: "unknown", command }));
  if (hasRoomAfterIncoming) scanTail(existing, (action) => action);
  return newestFirst.reverse();
}

function reduceRawCommandExecution(
  turns: readonly CodexCommandExecutionRawTurn[],
  itemId: string,
  reduceItem: (item: CodexRawCommandExecution) => CodexRawCommandExecution,
): CodexCommandExecutionRawMutationResult {
  if (turns.length === 0) {
    return {
      disposition: "noTurns",
      turnIndex: -1,
      itemIndex: -1,
      rawItem: null,
      stateChanged: false,
    };
  }

  const target = findRawCommandExecution(turns, itemId);
  if (!target) {
    return {
      disposition: "missingItem",
      turnIndex: -1,
      itemIndex: -1,
      rawItem: null,
      stateChanged: false,
    };
  }

  const rawItem = reduceItem(target.item);
  return {
    disposition: "applied",
    turnIndex: target.turnIndex,
    itemIndex: target.itemIndex,
    rawItem,
    stateChanged: rawItem !== target.item,
  };
}

export function reduceCodexCommandOutputRawTurns(
  turns: readonly CodexCommandExecutionRawTurn[],
  update: CodexCommandOutputUpdate,
): CodexCommandExecutionRawMutationResult {
  return reduceRawCommandExecution(turns, update.itemId, (item) =>
    appendRawCommandOutput(item, update.delta),
  );
}

export function reduceCodexTerminalCommandsRawTurns(
  turns: readonly CodexCommandExecutionRawTurn[],
  update: CodexTerminalCommandUpdate,
): CodexCommandExecutionRawMutationResult {
  return reduceRawCommandExecution(turns, update.itemId, (item) =>
    appendRawTerminalCommands(item, update.commands),
  );
}

function replaceCanonicalRawItem(
  state: CodexCanonicalConversationState,
  result: CodexCommandExecutionRawMutationResult,
): CodexCanonicalConversationState {
  if (!result.stateChanged || !result.rawItem) return state;
  const turn = state.turns[result.turnIndex];
  if (!turn) return state;
  const items = [...turn.items];
  items[result.itemIndex] = result.rawItem as CodexCanonicalItem;
  const turns = [...state.turns];
  turns[result.turnIndex] = {
    ...turn,
    items,
  } as CodexCanonicalTurnState;
  return { ...state, turns };
}

function reduceCanonicalCommandExecution(
  state: CodexCanonicalConversationState,
  conversationId: string,
  reduce: () => CodexCommandExecutionRawMutationResult,
): CodexCommandExecutionCanonicalMutationResult {
  if (state.protocol.id !== conversationId) {
    return {
      state,
      disposition: "foreignConversation",
      turnIndex: -1,
      itemIndex: -1,
      stateChanged: false,
    };
  }

  const result = reduce();
  const nextState = replaceCanonicalRawItem(state, result);
  return {
    state: nextState,
    disposition: result.disposition,
    turnIndex: result.turnIndex,
    itemIndex: result.itemIndex,
    stateChanged: nextState !== state,
  };
}

export function reduceCodexConversationCommandOutput(
  state: CodexCanonicalConversationState,
  update: CodexCommandOutputUpdate,
): CodexCommandExecutionCanonicalMutationResult {
  return reduceCanonicalCommandExecution(state, update.conversationId, () =>
    reduceCodexCommandOutputRawTurns(state.turns, update),
  );
}

export function reduceCodexConversationTerminalCommands(
  state: CodexCanonicalConversationState,
  update: CodexTerminalCommandUpdate,
): CodexCommandExecutionCanonicalMutationResult {
  return reduceCanonicalCommandExecution(state, update.conversationId, () =>
    reduceCodexTerminalCommandsRawTurns(state.turns, update),
  );
}

export function isCodexCommandOutputNotification(
  notification: ServerNotification,
): notification is CodexCommandOutputNotification {
  return notification.method === "item/commandExecution/outputDelta";
}

export function toCodexCommandOutputUpdate(
  notification: CodexCommandOutputNotification,
): CodexCommandOutputUpdate {
  return {
    conversationId: notification.params.threadId,
    turnId: notification.params.turnId,
    itemId: notification.params.itemId,
    delta: notification.params.delta,
  };
}

export function groupCodexCommandOutputUpdatesByConversation<
  TUpdate extends CodexCommandOutputUpdate,
>(updates: readonly TUpdate[]): ReadonlyMap<string, readonly TUpdate[]> {
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

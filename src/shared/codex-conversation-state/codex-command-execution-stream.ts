import { produce, type Draft } from "immer";
import {
  residentConversationTurnEntries,
  residentConversationTurns,
  conversationTurnDraft,
} from "./codex-turn-mutation";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalConversationState } from "./codex-conversation-state";
import {
  appendCodexCommandOutputTail,
  CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX,
  stripCodexCommandOutputTruncationPrefix,
  type CodexCommandOutputUpdate,
} from "./codex-command-output-queue";

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
  return {
    ...item,
    commandActions: [
      ...item.commandActions,
      ...commands.map((command): CodexRawCommandExecution["commandActions"][number] => ({
        type: "unknown",
        command,
      })),
    ],
  };
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

type CommandMutation = Omit<CodexCommandExecutionCanonicalMutationResult, "state">;

export function mutateCodexConversationCommandOutput(
  state: Draft<CodexCanonicalConversationState>,
  update: CodexCommandOutputUpdate,
): CommandMutation {
  if (state.id !== update.conversationId)
    return {
      disposition: "foreignConversation",
      turnIndex: -1,
      itemIndex: -1,
      stateChanged: false,
    };
  const result = reduceCodexCommandOutputRawTurns(residentConversationTurns(state), update);
  const entry = residentConversationTurnEntries(state)[result.turnIndex];
  const item = entry ? conversationTurnDraft(state, entry.address)?.items[result.itemIndex] : null;
  if (result.stateChanged && result.rawItem && item?.type === "commandExecution")
    item.aggregatedOutput = result.rawItem.aggregatedOutput;
  return {
    disposition: result.disposition,
    turnIndex: result.turnIndex,
    itemIndex: result.itemIndex,
    stateChanged: result.stateChanged,
  };
}
export function mutateCodexConversationTerminalCommands(
  state: Draft<CodexCanonicalConversationState>,
  update: CodexTerminalCommandUpdate,
): CommandMutation {
  if (state.id !== update.conversationId)
    return {
      disposition: "foreignConversation",
      turnIndex: -1,
      itemIndex: -1,
      stateChanged: false,
    };
  const result = reduceCodexTerminalCommandsRawTurns(residentConversationTurns(state), update);
  const entry = residentConversationTurnEntries(state)[result.turnIndex];
  const item = entry ? conversationTurnDraft(state, entry.address)?.items[result.itemIndex] : null;
  if (result.stateChanged && item?.type === "commandExecution")
    item.commandActions.push(
      ...update.commands.map((command) => ({ type: "unknown" as const, command })),
    );
  return {
    disposition: result.disposition,
    turnIndex: result.turnIndex,
    itemIndex: result.itemIndex,
    stateChanged: result.stateChanged,
  };
}
export function reduceCodexConversationCommandOutput(
  state: CodexCanonicalConversationState,
  update: CodexCommandOutputUpdate,
): CodexCommandExecutionCanonicalMutationResult {
  let operation!: CommandMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationCommandOutput(draft, update);
  });
  return { ...operation, state: next, stateChanged: next !== state };
}
export function reduceCodexConversationTerminalCommands(
  state: CodexCanonicalConversationState,
  update: CodexTerminalCommandUpdate,
): CodexCommandExecutionCanonicalMutationResult {
  let operation!: CommandMutation;
  const next = produce(state, (draft) => {
    operation = mutateCodexConversationTerminalCommands(draft, update);
  });
  return { ...operation, state: next, stateChanged: next !== state };
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

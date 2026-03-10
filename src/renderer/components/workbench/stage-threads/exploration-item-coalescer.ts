import type { CodexItemStatus, CodexItemView } from "../../../lib/types";
import { extractCommandActions, isExplorationAction } from "./tools/command-actions";

interface CoalesceExplorationOptions {
  activeTurnId?: string | null;
}

function isReasoningItem(item: CodexItemView): boolean {
  return item.normalizedKind === "reasoning";
}

function isExplorationCommandItem(item: CodexItemView): boolean {
  const commandActions = extractCommandActions(item);
  return commandActions.length > 0 && commandActions.every(isExplorationAction);
}

function mergeExplorationStatus(items: CodexItemView[]): CodexItemStatus | undefined {
  const statuses = items
    .map((item) => item.status)
    .filter((status): status is CodexItemStatus => status !== undefined);

  if (statuses.length === 0) return undefined;
  if (statuses.includes("inProgress")) return "inProgress";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("interrupted")) return "interrupted";
  if (statuses.includes("declined")) return "declined";
  if (statuses.includes("completed")) return "completed";
  return statuses[statuses.length - 1];
}

function latestNonEmptyOutput(items: CodexItemView[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const output = items[index]?.toolCall?.result;
    if (typeof output !== "string") continue;
    if (typeof output !== "string") continue;
    if (output.trim().length === 0) continue;
    return output;
  }
  return undefined;
}

function coalesceExplorationGroup(
  commandItems: CodexItemView[],
  absorbedItems: CodexItemView[],
): CodexItemView {
  const firstCommandItem = commandItems[0];
  const lastAbsorbedItem = absorbedItems[absorbedItems.length - 1];
  const mergedActions = commandItems.flatMap((item) => extractCommandActions(item));

  if (absorbedItems.length === 1) return firstCommandItem;

  return {
    ...firstCommandItem,
    itemId: `${firstCommandItem.itemId}::explore::${lastAbsorbedItem.itemId}`,
    status: mergeExplorationStatus(absorbedItems),
    toolCall: firstCommandItem.toolCall
      ? {
          ...firstCommandItem.toolCall,
          args: {
            ...(typeof firstCommandItem.toolCall.args === "object" && firstCommandItem.toolCall.args !== null
              ? firstCommandItem.toolCall.args as Record<string, unknown>
              : {}),
            commandActions: mergedActions,
          },
          result: latestNonEmptyOutput(absorbedItems) ?? firstCommandItem.toolCall.result,
        }
      : firstCommandItem.toolCall,
    createdAt: firstCommandItem.createdAt,
    updatedAt: absorbedItems.reduce(
      (latestUpdatedAt, item) => Math.max(latestUpdatedAt, item.updatedAt),
      firstCommandItem.updatedAt,
    ),
  };
}

function shouldKeepTerminalStatus(status: string | undefined): boolean {
  return status === "declined" || status === "interrupted";
}

function withActiveTurnExplorationStatus(
  item: CodexItemView,
  options: CoalesceExplorationOptions | undefined,
  isTailOfTurn: boolean,
): CodexItemView {
  if (!options?.activeTurnId) return item;
  if (item.turnId !== options.activeTurnId) return item;
  if (!isTailOfTurn) return item;
  if (shouldKeepTerminalStatus(item.status)) return item;
  if (item.status === "inProgress") return item;
  return { ...item, status: "inProgress" };
}

export function coalesceExplorationItems(
  items: CodexItemView[],
  options?: CoalesceExplorationOptions,
): CodexItemView[] {
  if (items.length === 0) return items;

  const coalesced: CodexItemView[] = [];
  let index = 0;

  while (index < items.length) {
    const current = items[index];
    if (!isExplorationCommandItem(current)) {
      coalesced.push(current);
      index += 1;
      continue;
    }

    const commandItems = [current];
    const absorbedItems = [current];
    let cursor = index + 1;
    while (cursor < items.length) {
      const candidate = items[cursor];
      if (candidate.turnId !== current.turnId) break;
      if (isExplorationCommandItem(candidate)) {
        commandItems.push(candidate);
        absorbedItems.push(candidate);
        cursor += 1;
        continue;
      }
      if (!isReasoningItem(candidate)) break;
      absorbedItems.push(candidate);
      cursor += 1;
    }

    const coalescedGroup = coalesceExplorationGroup(commandItems, absorbedItems);
    const nextItem = items[cursor];
    const isTailOfTurn = !nextItem || nextItem.turnId !== current.turnId;
    coalesced.push(
      withActiveTurnExplorationStatus(coalescedGroup, options, isTailOfTurn),
    );
    index = cursor;
  }

  return coalesced;
}

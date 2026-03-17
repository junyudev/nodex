import type {
  BlockDropImportInput,
  Card,
  CardCreateInput,
  CardCreatePlacement,
  CardDropMoveToEditorInput,
  CardInput,
  MoveCardInput,
  MoveCardsInput,
  Board,
} from "./types";
import { DEFAULT_CARD_STATUS } from "../../shared/card-status";

export type BoardTransform = (board: Board) => Board;

interface PatchTransformOptions {
  bumpRevision?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizePatch(updates: Partial<CardInput>): Partial<Card> {
  const normalized: Partial<Card> = {};

  if ("title" in updates) normalized.title = updates.title ?? "";
  if ("description" in updates) normalized.description = updates.description ?? "";
  if ("priority" in updates) normalized.priority = updates.priority ?? undefined;
  if ("estimate" in updates) normalized.estimate = updates.estimate ?? undefined;
  if ("tags" in updates && Array.isArray(updates.tags)) normalized.tags = updates.tags;
  if ("dueDate" in updates) normalized.dueDate = updates.dueDate ?? undefined;
  if ("scheduledStart" in updates) normalized.scheduledStart = updates.scheduledStart ?? undefined;
  if ("scheduledEnd" in updates) normalized.scheduledEnd = updates.scheduledEnd ?? undefined;
  if ("isAllDay" in updates) normalized.isAllDay = updates.isAllDay ?? undefined;
  if ("recurrence" in updates) normalized.recurrence = updates.recurrence ?? undefined;
  if ("reminders" in updates && Array.isArray(updates.reminders)) normalized.reminders = updates.reminders;
  if ("scheduleTimezone" in updates) normalized.scheduleTimezone = updates.scheduleTimezone ?? undefined;
  if ("assignee" in updates) normalized.assignee = updates.assignee ?? undefined;
  if ("agentBlocked" in updates && updates.agentBlocked !== undefined) normalized.agentBlocked = updates.agentBlocked;
  if ("agentStatus" in updates) normalized.agentStatus = updates.agentStatus ?? undefined;
  if ("runInTarget" in updates) normalized.runInTarget = updates.runInTarget ?? undefined;
  if ("runInLocalPath" in updates) normalized.runInLocalPath = updates.runInLocalPath ?? undefined;
  if ("runInBaseBranch" in updates) normalized.runInBaseBranch = updates.runInBaseBranch ?? undefined;
  if ("runInWorktreePath" in updates) normalized.runInWorktreePath = updates.runInWorktreePath ?? undefined;
  if ("runInEnvironmentPath" in updates) normalized.runInEnvironmentPath = updates.runInEnvironmentPath ?? undefined;

  return normalized;
}

function findCardLocation(
  board: Board,
  cardId: string,
  preferredColumnId?: string,
): { columnIndex: number; cardIndex: number } | null {
  if (preferredColumnId) {
    const preferredColumnIndex = board.columns.findIndex((column) => column.id === preferredColumnId);
    if (preferredColumnIndex >= 0) {
      const preferredCardIndex = board.columns[preferredColumnIndex]?.cards.findIndex((card) => card.id === cardId) ?? -1;
      if (preferredCardIndex >= 0) {
        return { columnIndex: preferredColumnIndex, cardIndex: preferredCardIndex };
      }
    }
  }

  for (let columnIndex = 0; columnIndex < board.columns.length; columnIndex += 1) {
    const cardIndex = board.columns[columnIndex]?.cards.findIndex((card) => card.id === cardId) ?? -1;
    if (cardIndex >= 0) return { columnIndex, cardIndex };
  }

  return null;
}

function reindexCards(cards: Card[]): Card[] {
  let changed = false;
  const next = cards.map((card, index) => {
    if (card.order === index) return card;
    changed = true;
    return {
      ...card,
      order: index,
    };
  });
  return changed ? next : cards;
}

function replaceColumnCards(
  board: Board,
  columnIndex: number,
  nextCards: Card[],
): Board {
  const column = board.columns[columnIndex];
  if (!column) return board;

  const withOrder = reindexCards(nextCards);
  if (column.cards === withOrder) return board;

  const nextColumns = [...board.columns];
  nextColumns[columnIndex] = {
    ...column,
    cards: withOrder,
  };

  return {
    ...board,
    columns: nextColumns,
  };
}

function insertCardIntoColumn(
  board: Board,
  columnId: string,
  card: Card,
  placement: CardCreatePlacement,
  insertIndex?: number,
): Board {
  const columnIndex = board.columns.findIndex((column) => column.id === columnId);
  if (columnIndex < 0) return board;

  const column = board.columns[columnIndex];
  if (!column) return board;

  const nextCards = [...column.cards];
  const index = insertIndex !== undefined
    ? clamp(insertIndex, 0, nextCards.length)
    : (placement === "top" ? 0 : nextCards.length);
  nextCards.splice(index, 0, card);
  return replaceColumnCards(board, columnIndex, nextCards);
}

function applyCardPatch(card: Card, updates: Partial<CardInput>): Card {
  const patch = normalizePatch(updates);
  if (Object.keys(patch).length === 0) {
    return card;
  }

  return {
    ...card,
    ...patch,
  };
}

export function buildPatchCardTransform(
  columnId: string | undefined,
  cardId: string,
  updates: Partial<CardInput>,
  options: PatchTransformOptions = {},
): BoardTransform {
  const patch = normalizePatch(updates);
  const patchEntries = Object.entries(patch);
  if (patchEntries.length === 0) {
    return (board) => board;
  }

  const shouldBumpRevision = options.bumpRevision === true;

  return (board) => {
    const location = findCardLocation(board, cardId, columnId);
    if (!location) return board;

    const column = board.columns[location.columnIndex];
    const target = column?.cards[location.cardIndex];
    if (!column || !target) return board;

    const changed = patchEntries.some(([key, value]) => target[key as keyof Card] !== value);
    if (!changed) return board;

    const nextCards = [...column.cards];
    const nextRevision = shouldBumpRevision
      ? ((target.revision ?? 0) + 1)
      : target.revision;
    nextCards[location.cardIndex] = {
      ...target,
      ...patch,
      ...(shouldBumpRevision ? { revision: nextRevision } : {}),
    };

    return replaceColumnCards(board, location.columnIndex, nextCards);
  };
}

export function createOptimisticCard(input: CardCreateInput): Card {
  return {
    id: input.id ?? `optimistic:${crypto.randomUUID()}`,
    status: input.status ?? DEFAULT_CARD_STATUS,
    archived: false,
    title: input.title,
    description: input.description ?? "",
    priority: input.priority ?? undefined,
    estimate: input.estimate ?? undefined,
    tags: input.tags ?? [],
    dueDate: input.dueDate ?? undefined,
    scheduledStart: input.scheduledStart ?? undefined,
    scheduledEnd: input.scheduledEnd ?? undefined,
    isAllDay: input.isAllDay ?? undefined,
    recurrence: input.recurrence ?? undefined,
    reminders: input.reminders ?? [],
    scheduleTimezone: input.scheduleTimezone ?? undefined,
    assignee: input.assignee ?? undefined,
    agentBlocked: input.agentBlocked ?? false,
    agentStatus: input.agentStatus ?? undefined,
    runInTarget: input.runInTarget ?? "localProject",
    runInLocalPath: input.runInLocalPath ?? undefined,
    runInBaseBranch: input.runInBaseBranch ?? undefined,
    runInWorktreePath: input.runInWorktreePath ?? undefined,
    runInEnvironmentPath: input.runInEnvironmentPath ?? undefined,
    created: new Date(),
    order: 0,
  };
}

export function buildCreateCardTransform(
  columnId: string,
  card: Card,
  placement: CardCreatePlacement,
): BoardTransform {
  return (board) => insertCardIntoColumn(board, columnId, card, placement);
}

export function buildDeleteCardTransform(
  columnId: string | undefined,
  cardId: string,
): BoardTransform {
  return (board) => {
    const location = findCardLocation(board, cardId, columnId);
    if (!location) return board;

    const column = board.columns[location.columnIndex];
    if (!column) return board;

    const nextCards = [...column.cards];
    nextCards.splice(location.cardIndex, 1);
    return replaceColumnCards(board, location.columnIndex, nextCards);
  };
}

export function buildMoveCardTransform(input: MoveCardInput): BoardTransform {
  return (board) => {
    const location = findCardLocation(board, input.cardId, input.fromStatus);
    if (!location) return board;

    const sourceColumn = board.columns[location.columnIndex];
    if (!sourceColumn) return board;
    const movingCard = sourceColumn.cards[location.cardIndex];
    if (!movingCard) return board;
    const patchedCard = input.fieldPatch
      ? applyCardPatch(movingCard, input.fieldPatch)
      : movingCard;

    const withoutSourceCards = [...sourceColumn.cards];
    withoutSourceCards.splice(location.cardIndex, 1);
    let nextBoard = replaceColumnCards(board, location.columnIndex, withoutSourceCards);

    const targetColumnIndex = nextBoard.columns.findIndex((column) => column.id === input.toStatus);
    if (targetColumnIndex < 0) return board;
    const targetColumn = nextBoard.columns[targetColumnIndex];
    if (!targetColumn) return board;

    const targetCards = [...targetColumn.cards];
    const insertIndex = clamp(input.newOrder ?? targetCards.length, 0, targetCards.length);
    targetCards.splice(insertIndex, 0, patchedCard);
    nextBoard = replaceColumnCards(nextBoard, targetColumnIndex, targetCards);
    return nextBoard;
  };
}

export function buildMoveCardsTransform(input: MoveCardsInput): BoardTransform {
  const targetCardIds = new Set(input.cardIds);
  return (board) => {
    if (targetCardIds.size === 0) return board;

    const movingCards: Card[] = [];
    let nextBoard = board;

    for (let columnIndex = 0; columnIndex < nextBoard.columns.length; columnIndex += 1) {
      const column = nextBoard.columns[columnIndex];
      if (!column) continue;

      const retainedCards: Card[] = [];
      let changed = false;
      for (const card of column.cards) {
        if (!targetCardIds.has(card.id)) {
          retainedCards.push(card);
          continue;
        }
        changed = true;
        movingCards.push(input.fieldPatch ? applyCardPatch(card, input.fieldPatch) : card);
      }

      if (!changed) continue;
      nextBoard = replaceColumnCards(nextBoard, columnIndex, retainedCards);
    }

    if (movingCards.length === 0) return board;

    const targetColumnIndex = nextBoard.columns.findIndex((column) => column.id === input.toStatus);
    if (targetColumnIndex < 0) return board;
    const targetColumn = nextBoard.columns[targetColumnIndex];
    if (!targetColumn) return board;

    const targetCards = [...targetColumn.cards];
    const insertIndex = clamp(input.newOrder ?? targetCards.length, 0, targetCards.length);
    targetCards.splice(insertIndex, 0, ...movingCards);
    nextBoard = replaceColumnCards(nextBoard, targetColumnIndex, targetCards);
    return nextBoard;
  };
}

function applySourceUpdateTransform(
  board: Board,
  update: BlockDropImportInput["sourceUpdates"][number],
): Board {
  return buildPatchCardTransform(update.status, update.cardId, update.updates)(board);
}

export function buildImportBlockDropTransform(
  input: BlockDropImportInput,
  optimisticCards: Card[],
): BoardTransform {
  return (board) => {
    let nextBoard = board;
    for (const update of input.sourceUpdates) {
      nextBoard = applySourceUpdateTransform(nextBoard, update);
    }

    const insertIndex = input.insertIndex;
    for (let index = 0; index < optimisticCards.length; index += 1) {
      const card = optimisticCards[index];
      if (!card) continue;
      const cardInsertIndex = insertIndex === undefined ? undefined : insertIndex + index;
      nextBoard = insertCardIntoColumn(nextBoard, input.targetStatus, card, "bottom", cardInsertIndex);
    }
    return nextBoard;
  };
}

export function buildMoveDropToEditorTransform(
  input: CardDropMoveToEditorInput,
): BoardTransform {
  return (board) => {
    let nextBoard = board;
    for (const update of input.targetUpdates) {
      nextBoard = applySourceUpdateTransform(nextBoard, update);
    }

    const sourceCardIds = input.sourceCards?.map((entry) => entry.cardId) ?? [input.sourceCardId];
    for (const cardId of sourceCardIds) {
      nextBoard = buildDeleteCardTransform(undefined, cardId)(nextBoard);
    }
    return nextBoard;
  };
}

export function buildCompleteOrSkipOccurrenceTransform(cardId: string): BoardTransform {
  return (board) => {
    const location = findCardLocation(board, cardId);
    if (!location) return board;

    const column = board.columns[location.columnIndex];
    const card = column?.cards[location.cardIndex];
    if (!column || !card || card.recurrence) return board;

    const nextCards = [...column.cards];
    nextCards[location.cardIndex] = {
      ...card,
      scheduledStart: undefined,
      scheduledEnd: undefined,
    };
    return replaceColumnCards(board, location.columnIndex, nextCards);
  };
}

export function overlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((key) => rightSet.has(key));
}

export function conflictKeyForCard(cardId: string): string {
  return `card:${cardId}:existence`;
}

export function conflictKeyForCardPosition(cardId: string): string {
  return `card:${cardId}:position`;
}

export function conflictKeyForCardField(cardId: string, field: string): string {
  return `card:${cardId}:field:${field}`;
}

export function conflictKeysForPatch(cardId: string, updates: Partial<CardInput>): string[] {
  const fields = Object.keys(updates);
  if (fields.length === 0) return [conflictKeyForCard(cardId)];
  return fields.map((field) => conflictKeyForCardField(cardId, field));
}

export function conflictKeysForCreate(columnId: string, cardId: string): string[] {
  void columnId;
  return [
    conflictKeyForCard(cardId),
  ];
}

export function conflictKeysForDelete(cardId: string): string[] {
  return [
    conflictKeyForCard(cardId),
    conflictKeyForCardPosition(cardId),
  ];
}

export function conflictKeysForMove(input: MoveCardInput): string[] {
  const patchKeys = input.fieldPatch
    ? conflictKeysForPatch(input.cardId, input.fieldPatch)
    : [];
  return [
    conflictKeyForCardPosition(input.cardId),
    `column:${input.toStatus}:cards`,
    ...(input.fromStatus ? [`column:${input.fromStatus}:cards`] : []),
    ...patchKeys,
  ];
}

export function conflictKeysForMoveMany(input: MoveCardsInput): string[] {
  const keys = [
    `column:${input.toStatus}:cards`,
    ...(input.fromStatus ? [`column:${input.fromStatus}:cards`] : []),
  ];
  for (const cardId of input.cardIds) {
    keys.push(conflictKeyForCardPosition(cardId));
    if (input.fieldPatch) {
      keys.push(...conflictKeysForPatch(cardId, input.fieldPatch));
    }
  }
  return keys;
}

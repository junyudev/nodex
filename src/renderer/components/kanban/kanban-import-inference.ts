import type { Card, CardInput, CardStatus, Estimate, Priority } from "@/lib/types";
import type {
  DbViewCardRecord,
  DbViewFilterClause,
  DbViewFilterGroup,
  DbViewRules,
  DbViewSortField,
} from "../../lib/db-view-prefs";
import { filterDbViewCards } from "../../lib/db-view-prefs";
import type { Board } from "../../lib/types";
import { resolveFilteredDropOrder } from "./filtered-drag-order";

type CardInputWithDefaults = CardInput & {
  tags: string[];
};

export type KanbanImportInferenceResult =
  | {
      mode: "blocked";
    }
  | {
      mode: "column";
      cards: CardInput[];
    }
  | {
      mode: "slot";
      cards: CardInput[];
      insertIndex: number;
    };

interface ResolveKanbanImportInferenceInput {
  board: Board | null;
  visibleBoard: Board | null;
  rules: DbViewRules;
  targetColumnId: CardStatus;
  targetVisibleIndex: number;
  cards: CardInput[];
  hasSearchFilter: boolean;
}

interface SortAnchor {
  beforeCardId?: string;
  afterCardId?: string;
}

const SUPPORTED_SORT_FIELDS = new Set<DbViewSortField>(["board-order", "priority", "estimate"]);

const CARD_STATUS_NAMES: Record<CardStatus, string> = {
  draft: "Draft",
  backlog: "Backlog",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

function hasOwn<T extends object, K extends keyof T>(value: T, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeCardInput(input: CardInput): CardInputWithDefaults {
  return {
    ...input,
    tags: input.tags ? [...input.tags] : [],
  };
}

function dedupeTags(tags: readonly string[]): string[] {
  return Array.from(new Set(tags.filter((tag) => tag.length > 0)));
}

function buildVisibleCardRecord(card: CardInputWithDefaults, targetColumnId: CardStatus): DbViewCardRecord {
  return {
    id: `import:${crypto.randomUUID()}`,
    status: targetColumnId,
    columnId: targetColumnId,
    columnName: CARD_STATUS_NAMES[targetColumnId],
    archived: false,
    title: card.title,
    description: card.description ?? "",
    priority: hasOwn(card, "priority") ? card.priority ?? undefined : undefined,
    estimate: hasOwn(card, "estimate") ? card.estimate ?? undefined : undefined,
    tags: card.tags,
    dueDate: card.dueDate ?? undefined,
    scheduledStart: card.scheduledStart ?? undefined,
    scheduledEnd: card.scheduledEnd ?? undefined,
    isAllDay: card.isAllDay ?? undefined,
    recurrence: card.recurrence ?? undefined,
    reminders: card.reminders ?? [],
    scheduleTimezone: card.scheduleTimezone ?? undefined,
    assignee: card.assignee ?? undefined,
    agentBlocked: card.agentBlocked ?? false,
    agentStatus: card.agentStatus ?? undefined,
    runInTarget: card.runInTarget ?? "localProject",
    runInLocalPath: card.runInLocalPath ?? undefined,
    runInBaseBranch: card.runInBaseBranch ?? undefined,
    runInWorktreePath: card.runInWorktreePath ?? undefined,
    runInEnvironmentPath: card.runInEnvironmentPath ?? undefined,
    created: new Date(),
    order: 0,
    boardIndex: 0,
  };
}

function resolvePriorityPatch(
  card: CardInputWithDefaults,
  clause: Extract<DbViewFilterClause, { field: "priority" }>,
): CardInput["priority"] | typeof NO_CHANGE | null {
  if (hasOwn(card, "priority")) {
    const current = card.priority ?? null;
    if (current === null) {
      return clause.includeEmpty ? NO_CHANGE : null;
    }
    return clause.values.includes(current) ? NO_CHANGE : null;
  }

  if (clause.includeEmpty) {
    return NO_CHANGE;
  }
  if (clause.values.length === 1) {
    return clause.values[0];
  }
  return null;
}

const NO_CHANGE = Symbol("no-change");

function applyFilterGroupPatch(
  card: CardInputWithDefaults,
  targetColumnId: CardStatus,
  group: DbViewFilterGroup,
): CardInputWithDefaults | null {
  let next: CardInputWithDefaults = normalizeCardInput(card);

  for (const clause of group.all) {
    if (clause.field === "status") {
      if (!clause.values.includes(targetColumnId)) {
        return null;
      }
      continue;
    }

    if (clause.field === "priority") {
      const priorityPatch = resolvePriorityPatch(next, clause);
      if (priorityPatch === null) {
        return null;
      }
      if (priorityPatch !== NO_CHANGE) {
        next = {
          ...next,
          priority: priorityPatch,
        };
      }
      continue;
    }

    if (clause.op === "hasAll") {
      next = {
        ...next,
        tags: dedupeTags([...next.tags, ...clause.values]),
      };
      continue;
    }

    if (clause.op === "hasNone") {
      if (next.tags.some((tag) => clause.values.includes(tag))) {
        return null;
      }
      continue;
    }

    if (next.tags.some((tag) => clause.values.includes(tag))) {
      continue;
    }

    if (clause.values.length !== 1) {
      return null;
    }

    next = {
      ...next,
      tags: dedupeTags([...next.tags, clause.values[0]]),
    };
  }

  const visible = filterDbViewCards(
    [buildVisibleCardRecord(next, targetColumnId)],
    { filter: { any: [group] }, sort: [] },
  );
  return visible.length > 0 ? next : null;
}

function pickSafestFilterPatch(
  cards: CardInput[],
  targetColumnId: CardStatus,
  rules: DbViewRules,
): CardInput[] | null {
  if (rules.filter.any.length === 0) {
    return cards.map((card) => normalizeCardInput(card));
  }

  const patchedCards: CardInput[] = [];
  for (const card of cards) {
    const normalized = normalizeCardInput(card);
    let bestPatch: CardInputWithDefaults | null = null;
    let bestCost = Number.POSITIVE_INFINITY;

    for (const group of rules.filter.any) {
      const candidate = applyFilterGroupPatch(normalized, targetColumnId, group);
      if (!candidate) continue;

      const cost = Number(hasOwn(candidate, "priority") !== hasOwn(normalized, "priority"))
        + Math.abs(candidate.tags.length - normalized.tags.length);
      if (cost < bestCost) {
        bestPatch = candidate;
        bestCost = cost;
      }
    }

    if (!bestPatch) {
      return null;
    }

    patchedCards.push(bestPatch);
  }

  return patchedCards;
}

function resolveSortValue(card: Card | CardInput | undefined, field: "priority" | "estimate"): Priority | Estimate | null | undefined {
  if (!card) return undefined;
  if (field === "priority") {
    return hasOwn(card, "priority") ? card.priority ?? null : undefined;
  }
  return hasOwn(card, "estimate") ? card.estimate ?? null : undefined;
}

function applySortFieldPatch(
  cards: CardInput[],
  field: "priority" | "estimate",
  value: Priority | Estimate | null | undefined,
): CardInput[] | null {
  const patchedCards: CardInput[] = [];
  for (const card of cards) {
    if (hasOwn(card, field)) {
      const current = (card[field] ?? null) as Priority | Estimate | null;
      const nextValue = value ?? null;
      if (current !== nextValue) {
        return null;
      }
      patchedCards.push(card);
      continue;
    }

    if (value === undefined) {
      patchedCards.push(card);
      continue;
    }

    patchedCards.push({
      ...card,
      [field]: value,
    });
  }

  return patchedCards;
}

function findCardOrderIndex(board: Board, targetColumnId: CardStatus, cardId: string): number | null {
  const targetColumn = board.columns.find((column) => column.id === targetColumnId);
  if (!targetColumn) return null;
  const index = targetColumn.cards.findIndex((card) => card.id === cardId);
  return index >= 0 ? index : null;
}

function resolveAnchorInsertIndex(board: Board, targetColumnId: CardStatus, anchor: SortAnchor): number {
  if (anchor.afterCardId) {
    const index = findCardOrderIndex(board, targetColumnId, anchor.afterCardId);
    if (index !== null) return index;
  }

  if (anchor.beforeCardId) {
    const index = findCardOrderIndex(board, targetColumnId, anchor.beforeCardId);
    if (index !== null) return index + 1;
  }

  const targetColumn = board.columns.find((column) => column.id === targetColumnId);
  return targetColumn?.cards.length ?? 0;
}

function resolveSortedSlot(args: {
  board: Board;
  visibleBoard: Board;
  targetColumnId: CardStatus;
  targetVisibleIndex: number;
  rules: DbViewRules;
  cards: CardInput[];
}): KanbanImportInferenceResult {
  const targetColumn = args.visibleBoard.columns.find((column) => column.id === args.targetColumnId);
  const visibleCards = targetColumn?.cards ?? [];
  const visibleIndex = Math.max(0, Math.min(args.targetVisibleIndex, visibleCards.length));
  const beforeCard = visibleIndex > 0 ? visibleCards[visibleIndex - 1] : undefined;
  const afterCard = visibleIndex < visibleCards.length ? visibleCards[visibleIndex] : undefined;

  let nextCards = args.cards.map((card) => ({ ...card }));
  let anchor: SortAnchor = {
    ...(afterCard ? { afterCardId: afterCard.id } : {}),
    ...(beforeCard ? { beforeCardId: beforeCard.id } : {}),
  };

  for (const sortKey of args.rules.sort) {
    if (sortKey.field === "board-order") {
      continue;
    }
    if (!SUPPORTED_SORT_FIELDS.has(sortKey.field)) {
      return { mode: "column", cards: nextCards };
    }

    const field = sortKey.field;
    if (field !== "priority" && field !== "estimate") {
      return { mode: "column", cards: nextCards };
    }

    const beforeValue = resolveSortValue(beforeCard, field);
    const afterValue = resolveSortValue(afterCard, field);

    if (beforeCard && afterCard && beforeValue === afterValue) {
      const patched = applySortFieldPatch(nextCards, field, beforeValue);
      if (!patched) {
        return { mode: "column", cards: nextCards };
      }
      nextCards = patched;
      continue;
    }

    if (beforeCard) {
      const patched = applySortFieldPatch(nextCards, field, beforeValue);
      if (!patched) {
        return { mode: "column", cards: nextCards };
      }
      nextCards = patched;
      anchor = { beforeCardId: beforeCard.id };
      return {
        mode: "slot",
        cards: nextCards,
        insertIndex: resolveAnchorInsertIndex(args.board, args.targetColumnId, anchor),
      };
    }

    if (afterCard) {
      const patched = applySortFieldPatch(nextCards, field, afterValue);
      if (!patched) {
        return { mode: "column", cards: nextCards };
      }
      nextCards = patched;
      anchor = { afterCardId: afterCard.id };
      return {
        mode: "slot",
        cards: nextCards,
        insertIndex: resolveAnchorInsertIndex(args.board, args.targetColumnId, anchor),
      };
    }
  }

  return {
    mode: "slot",
    cards: nextCards,
    insertIndex: resolveAnchorInsertIndex(args.board, args.targetColumnId, anchor),
  };
}

export function resolveKanbanImportInference(
  input: ResolveKanbanImportInferenceInput,
): KanbanImportInferenceResult {
  if (input.hasSearchFilter) {
    return { mode: "blocked" };
  }

  if (!input.board || !input.visibleBoard) {
    return { mode: "blocked" };
  }

  const filterPatched = pickSafestFilterPatch(
    input.cards,
    input.targetColumnId,
    input.rules,
  );
  if (!filterPatched) {
    return { mode: "blocked" };
  }

  const hasNonDefaultSort = input.rules.sort.some((entry) => entry.field !== "board-order");
  if (!hasNonDefaultSort) {
    return {
      mode: "slot",
      cards: filterPatched,
      insertIndex: resolveFilteredDropOrder({
        board: input.board,
        visibleBoard: input.visibleBoard,
        draggedCardIds: [],
        targetColumnId: input.targetColumnId,
        targetVisibleIndex: input.targetVisibleIndex,
      }),
    };
  }

  return resolveSortedSlot({
    board: input.board,
    visibleBoard: input.visibleBoard,
    targetColumnId: input.targetColumnId,
    targetVisibleIndex: input.targetVisibleIndex,
    rules: input.rules,
    cards: filterPatched,
  });
}

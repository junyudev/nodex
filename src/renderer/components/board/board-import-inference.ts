import { resolveWorkflowStatusName } from "../../../shared/workflow-status";
import type { BoardSummary, PageInput, WorkflowStatus, Estimate, Priority } from "@/lib/types";
import type {
  DbViewCardRecord,
  DbViewFilterClause,
  DbViewFilterGroup,
  DbViewRules,
  DbViewSortField,
} from "../../lib/db-view-prefs";
import { filterDbViewCards } from "../../lib/db-view-prefs";
import { resolveFilteredDropOrder } from "./filtered-drag-order";
import { summarizePageDescription } from "../../../shared/page-summary";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";

type CardInputWithDefaults = PageInput & {
  tags: string[];
};

export type BoardImportInferenceResult =
  | {
      mode: "blocked";
    }
  | {
      mode: "column";
      cards: PageInput[];
    }
  | {
      mode: "slot";
      cards: PageInput[];
      insertIndex: number;
    };

interface ResolveBoardImportInferenceInput {
  board: BoardSummary | null;
  visibleBoard: BoardSummary | null;
  rules: DbViewRules;
  targetColumnId: WorkflowStatus;
  targetVisibleIndex: number;
  cards: PageInput[];
  hasSearchFilter: boolean;
}

interface SortAnchor {
  beforePageId?: string;
  afterPageId?: string;
}

const SUPPORTED_SORT_FIELDS = new Set<DbViewSortField>(["board-order", "priority", "estimate"]);

function hasOwn<T extends object, K extends keyof T>(value: T, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeCardInput(input: PageInput): CardInputWithDefaults {
  return {
    ...input,
    tags: input.tags ? [...input.tags] : [],
  };
}

function displayPropertyValue(value: string | null | undefined): string {
  if (!value) return "None";
  return value
    .replace(/^p([0-4])-/, "P$1 ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function resolveBoardImportPreviewLabel(
  sourceCards: PageInput[],
  inferredCards: PageInput[],
): string | undefined {
  if (sourceCards.length !== inferredCards.length || sourceCards.length === 0) return undefined;

  for (const field of ["priority", "estimate"] as const) {
    const values = new Set(inferredCards.map((card) => card[field] ?? null));
    const changed = inferredCards.some(
      (card, index) => (sourceCards[index]?.[field] ?? null) !== (card[field] ?? null),
    );
    if (changed && values.size === 1) {
      const value = inferredCards[0]?.[field];
      return `${field === "priority" ? "Priority" : "Estimate"} ${displayPropertyValue(value)}`;
    }
  }

  const addedTags = inferredCards.map((card, index) => {
    const sourceTags = new Set(sourceCards[index]?.tags ?? []);
    return (card.tags ?? []).filter((tag) => !sourceTags.has(tag));
  });
  const sharedAddedTag = addedTags[0]?.find((tag) => addedTags.every((tags) => tags.includes(tag)));
  return sharedAddedTag ? `Add #${sharedAddedTag}` : undefined;
}

function dedupeTags(tags: readonly string[]): string[] {
  return Array.from(new Set(tags.filter((tag) => tag.length > 0)));
}

function buildVisibleCardRecord(
  card: CardInputWithDefaults,
  targetColumnId: WorkflowStatus,
  statusOptions: readonly { readonly id: string; readonly name: string }[],
): DbViewCardRecord {
  return {
    id: `import:${crypto.randomUUID()}`,
    pageKey: null,
    status: targetColumnId,
    columnId: targetColumnId,
    columnName: resolveWorkflowStatusName(targetColumnId, statusOptions),
    archived: false,
    title: card.title,
    richTitle: plainTextToPortableRichText(card.title),
    ...summarizePageDescription(card.description ?? ""),
    priority: hasOwn(card, "priority") ? (card.priority ?? undefined) : undefined,
    estimate: hasOwn(card, "estimate") ? (card.estimate ?? undefined) : undefined,
    tags: card.tags,
    dueDate: card.dueDate ?? undefined,
    scheduledStart: card.scheduledStart ?? undefined,
    scheduledEnd: card.scheduledEnd ?? undefined,
    isAllDay: card.isAllDay ?? undefined,
    recurrence: card.recurrence ?? undefined,
    reminders: card.reminders ?? [],
    scheduleTimezone: card.scheduleTimezone ?? undefined,
    assignee: card.assignee ?? undefined,
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
): PageInput["priority"] | typeof NO_CHANGE | null {
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
  targetColumnId: WorkflowStatus,
  group: DbViewFilterGroup,
  statusOptions: readonly { readonly id: string; readonly name: string }[],
): CardInputWithDefaults | null {
  const next = normalizeCardInput(card);
  const nextTags = new Set(next.tags);

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
        next.priority = priorityPatch;
      }
      continue;
    }

    if (clause.op === "hasAll") {
      for (const value of clause.values) nextTags.add(value);
      continue;
    }

    if (clause.op === "hasNone") {
      if (clause.values.some((value) => nextTags.has(value))) {
        return null;
      }
      continue;
    }

    if (clause.values.some((value) => nextTags.has(value))) {
      continue;
    }

    if (clause.values.length !== 1) {
      return null;
    }

    nextTags.add(clause.values[0]);
  }

  next.tags = dedupeTags([...nextTags]);

  const visible = filterDbViewCards([buildVisibleCardRecord(next, targetColumnId, statusOptions)], {
    filter: { any: [group] },
    sort: [],
  });
  return visible.length > 0 ? next : null;
}

function pickSafestFilterPatch(
  cards: PageInput[],
  targetColumnId: WorkflowStatus,
  rules: DbViewRules,
  statusOptions: readonly { readonly id: string; readonly name: string }[],
): PageInput[] | null {
  if (rules.filter.any.length === 0) {
    return cards.map((card) => normalizeCardInput(card));
  }

  const patchedCards: PageInput[] = [];
  for (const card of cards) {
    const normalized = normalizeCardInput(card);
    let bestPatch: CardInputWithDefaults | null = null;
    let bestCost = Number.POSITIVE_INFINITY;

    for (const group of rules.filter.any) {
      const candidate = applyFilterGroupPatch(normalized, targetColumnId, group, statusOptions);
      if (!candidate) continue;

      const cost =
        Number(hasOwn(candidate, "priority") !== hasOwn(normalized, "priority")) +
        Math.abs(candidate.tags.length - normalized.tags.length);
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

function resolveSortValue(
  card: Pick<PageInput, "priority" | "estimate"> | undefined,
  field: "priority" | "estimate",
): Priority | Estimate | null | undefined {
  if (!card) return undefined;
  if (field === "priority") {
    return hasOwn(card, "priority") ? (card.priority ?? null) : undefined;
  }
  return hasOwn(card, "estimate") ? (card.estimate ?? null) : undefined;
}

function applySortFieldPatch(
  cards: PageInput[],
  field: "priority" | "estimate",
  value: Priority | Estimate | null | undefined,
): PageInput[] | null {
  const patchedCards: PageInput[] = [];
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

function findCardOrderIndex(
  board: BoardSummary,
  targetColumnId: WorkflowStatus,
  pageId: string,
): number | null {
  const targetColumn = board.columns.find((column) => column.id === targetColumnId);
  if (!targetColumn) return null;
  const index = targetColumn.cards.findIndex((card) => card.id === pageId);
  return index >= 0 ? index : null;
}

function resolveAnchorInsertIndex(
  board: BoardSummary,
  targetColumnId: WorkflowStatus,
  anchor: SortAnchor,
): number {
  if (anchor.afterPageId) {
    const index = findCardOrderIndex(board, targetColumnId, anchor.afterPageId);
    if (index !== null) return index;
  }

  if (anchor.beforePageId) {
    const index = findCardOrderIndex(board, targetColumnId, anchor.beforePageId);
    if (index !== null) return index + 1;
  }

  const targetColumn = board.columns.find((column) => column.id === targetColumnId);
  return targetColumn?.cards.length ?? 0;
}

function resolveSortedSlot(args: {
  board: BoardSummary;
  visibleBoard: BoardSummary;
  targetColumnId: WorkflowStatus;
  targetVisibleIndex: number;
  rules: DbViewRules;
  cards: PageInput[];
}): BoardImportInferenceResult {
  const targetColumn = args.visibleBoard.columns.find(
    (column) => column.id === args.targetColumnId,
  );
  const visibleCards = targetColumn?.cards ?? [];
  const visibleIndex = Math.max(0, Math.min(args.targetVisibleIndex, visibleCards.length));
  const beforeCard = visibleIndex > 0 ? visibleCards[visibleIndex - 1] : undefined;
  const afterCard = visibleIndex < visibleCards.length ? visibleCards[visibleIndex] : undefined;

  let nextCards = args.cards.map((card) => ({ ...card }));
  let anchor: SortAnchor = {
    ...(afterCard ? { afterPageId: afterCard.id } : {}),
    ...(beforeCard ? { beforePageId: beforeCard.id } : {}),
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
      anchor = { beforePageId: beforeCard.id };
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
      anchor = { afterPageId: afterCard.id };
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

export function resolveBoardImportInference(
  input: ResolveBoardImportInferenceInput,
): BoardImportInferenceResult {
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
    input.board.columns,
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
        draggedPageIds: [],
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

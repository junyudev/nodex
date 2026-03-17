import type { Board, Card, CardStatus, MoveCardInput } from "@/lib/types";
import type { DbViewRules, DbViewSortField } from "../../lib/db-view-prefs";
import { DB_VIEW_SORT_FIELD_LABELS } from "../../lib/db-view-prefs";
import { resolveFilteredDropOrder } from "./filtered-drag-order";

interface DragItemLike {
  columnId: string;
  card: Pick<Card, "id" | "priority" | "estimate">;
}

type MoveFieldPatch = NonNullable<MoveCardInput["fieldPatch"]>;
type MoveFieldPatchField = keyof MoveFieldPatch;

export type KanbanCardDragMode =
  | { kind: "manual-rank" }
  | { kind: "property-sorted"; field: MoveFieldPatchField }
  | { kind: "derived-move-only"; field: DbViewSortField };

export type KanbanCardDropIntent =
  | {
      kind: "reorder";
      columnId: CardStatus;
      newOrder: number;
    }
  | {
      kind: "reorder-with-patch";
      columnId: CardStatus;
      newOrder: number;
      fieldPatch: MoveFieldPatch;
      previewLabel: string;
    }
  | {
      kind: "move-only";
      columnId: CardStatus;
    }
  | {
      kind: "blocked";
      columnId: CardStatus;
      message: string;
    };

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function getPrimarySortField(rules: DbViewRules): DbViewSortField {
  return rules.sort[0]?.field ?? "board-order";
}

function resolveSortBucketValue(card: Pick<Card, "priority" | "estimate"> | undefined, field: MoveFieldPatchField) {
  if (!card) return null;
  return field === "priority"
    ? (card.priority ?? null)
    : (card.estimate ?? null);
}

function buildPreviewLabel(field: MoveFieldPatchField, value: Card["priority"] | Card["estimate"] | null): string {
  if (field === "priority") {
    const label = value === null
      ? "Empty"
      : value === "p0-critical"
        ? "P0"
        : value === "p1-high"
          ? "P1"
          : value === "p2-medium"
            ? "P2"
            : value === "p3-low"
              ? "P3"
              : "P4";
    return `Priority: ${label}`;
  }

  const label = typeof value === "string" ? value.toUpperCase() : "Empty";
  return `Estimate: ${label}`;
}

function resolveAnchorInsertIndex(args: {
  board: Board;
  targetColumnId: CardStatus;
  draggedCardIds: readonly string[];
  beforeCardId?: string;
  afterCardId?: string;
}): number {
  const targetColumn = args.board.columns.find((column) => column.id === args.targetColumnId);
  if (!targetColumn) {
    return 0;
  }

  const draggedCardIdSet = new Set(args.draggedCardIds);
  const remainingCards = targetColumn.cards.filter((card) => !draggedCardIdSet.has(card.id));
  if (args.afterCardId) {
    const afterIndex = remainingCards.findIndex((card) => card.id === args.afterCardId);
    if (afterIndex >= 0) {
      return afterIndex;
    }
  }

  if (args.beforeCardId) {
    const beforeIndex = remainingCards.findIndex((card) => card.id === args.beforeCardId);
    if (beforeIndex >= 0) {
      return beforeIndex + 1;
    }
  }

  return remainingCards.length;
}

export function resolveKanbanCardDragMode(args: {
  rules: DbViewRules;
}): KanbanCardDragMode {
  const primarySortField = getPrimarySortField(args.rules);
  if (primarySortField === "board-order") {
    return { kind: "manual-rank" };
  }

  if (primarySortField === "priority" || primarySortField === "estimate") {
    return {
      kind: "property-sorted",
      field: primarySortField,
    };
  }

  return {
    kind: "derived-move-only",
    field: primarySortField,
  };
}

export function resolveKanbanCardDropIntent(args: {
  board: Board | null;
  visibleBoard: Board | null;
  rules: DbViewRules;
  destinationColumnId: CardStatus;
  destinationIndex: number;
  dragItems: readonly DragItemLike[];
}): KanbanCardDropIntent {
  const dragMode = resolveKanbanCardDragMode({ rules: args.rules });
  const draggedCardIds = args.dragItems.map((entry) => entry.card.id);

  if (dragMode.kind === "manual-rank") {
    return {
      kind: "reorder",
      columnId: args.destinationColumnId,
      newOrder: resolveFilteredDropOrder({
        board: args.board,
        visibleBoard: args.visibleBoard,
        draggedCardIds,
        targetColumnId: args.destinationColumnId,
        targetVisibleIndex: args.destinationIndex,
      }),
    };
  }

  if (dragMode.kind === "derived-move-only") {
    const hasCrossColumnMove = args.dragItems.some((entry) => entry.columnId !== args.destinationColumnId);
    if (hasCrossColumnMove) {
      return {
        kind: "move-only",
        columnId: args.destinationColumnId,
      };
    }

    return {
      kind: "blocked",
      columnId: args.destinationColumnId,
      message: `Sorted by ${DB_VIEW_SORT_FIELD_LABELS[dragMode.field]}; switch to Board Order to manually rank.`,
    };
  }

  if (!args.board || !args.visibleBoard) {
    return {
      kind: "move-only",
      columnId: args.destinationColumnId,
    };
  }

  const targetColumn = args.visibleBoard.columns.find((column) => column.id === args.destinationColumnId);
  const visibleCards = targetColumn?.cards ?? [];
  const visibleIndex = clamp(args.destinationIndex, 0, visibleCards.length);
  if (visibleCards.length === 0) {
    return {
      kind: "reorder",
      columnId: args.destinationColumnId,
      newOrder: resolveFilteredDropOrder({
        board: args.board,
        visibleBoard: args.visibleBoard,
        draggedCardIds,
        targetColumnId: args.destinationColumnId,
        targetVisibleIndex: visibleIndex,
      }),
    };
  }

  const beforeCard = visibleIndex > 0 ? visibleCards[visibleIndex - 1] : undefined;
  const afterCard = visibleIndex < visibleCards.length ? visibleCards[visibleIndex] : undefined;
  const beforeValue = resolveSortBucketValue(beforeCard, dragMode.field);
  const afterValue = resolveSortBucketValue(afterCard, dragMode.field);

  const targetValue = beforeCard && afterCard && beforeValue === afterValue
    ? beforeValue
    : afterCard
      ? afterValue
      : beforeValue;

  const newOrder = resolveAnchorInsertIndex({
    board: args.board,
    targetColumnId: args.destinationColumnId,
    draggedCardIds,
    ...(afterCard ? { afterCardId: afterCard.id } : {}),
    ...(beforeCard && !afterCard ? { beforeCardId: beforeCard.id } : {}),
  });

  const needsPatch = args.dragItems.some(
    (entry) => resolveSortBucketValue(entry.card, dragMode.field) !== targetValue,
  );
  if (!needsPatch) {
    return {
      kind: "reorder",
      columnId: args.destinationColumnId,
      newOrder,
    };
  }

  return {
    kind: "reorder-with-patch",
    columnId: args.destinationColumnId,
    newOrder,
    fieldPatch: {
      [dragMode.field]: targetValue,
    },
    previewLabel: buildPreviewLabel(dragMode.field, targetValue),
  };
}

import type { CardStatus } from "@/lib/types";

interface DragItemLike {
  columnId: string;
}

export type KanbanCardDropStrategy = "reorder" | "move-only" | "none";

export function resolveKanbanCardDropStrategy(args: {
  hasNonDefaultSort: boolean;
  destinationColumnId: CardStatus;
  dragItems: readonly DragItemLike[];
}): KanbanCardDropStrategy {
  if (!args.hasNonDefaultSort) {
    return "reorder";
  }

  return args.dragItems.some((entry) => entry.columnId !== args.destinationColumnId)
    ? "move-only"
    : "none";
}

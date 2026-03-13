interface DragDataLike {
  current?: {
    columnId?: unknown;
    column?: {
      id?: unknown;
    };
  } | null;
}

interface DragEntryLike {
  data: DragDataLike;
}

export function resolveKanbanDragColumnId(
  entry: DragEntryLike | null | undefined,
): string | null {
  const current = entry?.data.current;
  if (!current) return null;

  if (typeof current.columnId === "string") {
    return current.columnId;
  }

  if (current.column && typeof current.column.id === "string") {
    return current.column.id;
  }

  return null;
}

export function shouldFreezeSameColumnPreview({
  columnId,
  active,
  over,
  isSorting,
}: {
  columnId: string;
  active: DragEntryLike | null | undefined;
  over: DragEntryLike | null | undefined;
  isSorting: boolean;
}): boolean {
  if (!isSorting) return false;

  const activeColumnId = resolveKanbanDragColumnId(active);
  if (activeColumnId !== columnId) return false;

  return resolveKanbanDragColumnId(over) === columnId;
}

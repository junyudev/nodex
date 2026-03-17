import type { KanbanCardDragMode } from "./kanban-card-drop-strategy";

export interface KanbanDropCapabilities {
  allowCardTargets: boolean;
  allowColumnTargets: boolean;
}

export function resolveKanbanDropCapabilities(args: {
  dragMode: KanbanCardDragMode;
}): KanbanDropCapabilities {
  if (args.dragMode.kind === "derived-move-only") {
    return {
      allowCardTargets: false,
      allowColumnTargets: true,
    };
  }

  return {
    allowCardTargets: true,
    allowColumnTargets: true,
  };
}

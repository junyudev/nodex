import type { DragEvent } from "react";

import { useDragDepth } from "./use-drag-depth";

const isSystemFileDrag = (dataTransfer: DataTransfer): boolean =>
  Array.from(dataTransfer.types).includes("Files");

/**
 * A drop target for Files dragged in from the system. Other drags pass through untouched. While
 * `enabled` is false the target refuses the drop, yet still keeps it from whatever lies behind.
 */
export function useSystemFileDrop({
  enabled,
  onDrop,
}: {
  readonly enabled: boolean;
  readonly onDrop: (files: File[]) => void;
}) {
  const drag = useDragDepth();
  const takes = (event: DragEvent<HTMLElement>): boolean => {
    if (!isSystemFileDrag(event.dataTransfer)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  return {
    /** Whether a drop the target would take is over it. */
    active: drag.active,
    end: drag.end,
    handlers: {
      onDragEnter: (event: DragEvent<HTMLElement>): void => {
        if (!takes(event)) return;
        if (!enabled) {
          event.dataTransfer.dropEffect = "none";
          return;
        }
        drag.enter();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragOver: (event: DragEvent<HTMLElement>): void => {
        if (!takes(event)) return;
        event.dataTransfer.dropEffect = enabled ? "copy" : "none";
      },
      onDragLeave: (event: DragEvent<HTMLElement>): void => {
        if (takes(event)) drag.leave();
      },
      onDrop: (event: DragEvent<HTMLElement>): void => {
        if (!takes(event)) return;
        drag.end();
        if (enabled) onDrop(Array.from(event.dataTransfer.files));
      },
      onDragEnd: drag.end,
    },
  };
}

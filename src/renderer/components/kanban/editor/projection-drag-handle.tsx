import { SideMenuExtension } from "@blocknote/core/extensions";
import { GripVertical } from "lucide-react";
import type { DragEvent } from "react";
import { cn } from "../../../lib/utils";

export const PROJECTION_ACTION_BTN =
  "h-7 border border-[var(--border)] rounded-md bg-[var(--card)] text-[var(--foreground-secondary)] px-2.5 inline-flex items-center gap-1.5 text-xs font-medium cursor-pointer transition-all duration-swift ease-out hover:border-[var(--border-strong)] hover:text-[var(--foreground)] hover:bg-[var(--background-secondary)]";

interface ProjectionDragHandleExtension {
  blockDragStart: (
    event: { dataTransfer: DataTransfer | null; clientY: number },
    block: unknown,
  ) => void;
  blockDragEnd: () => void;
}

interface ProjectionDragEditor {
  getExtension: (extension: unknown) => unknown;
  getBlock?: (id: string) => unknown;
}

interface ProjectionDragBlock {
  id: string;
}

interface ProjectionDragEvent {
  dataTransfer: DataTransfer | null;
  clientY: number;
  preventDefault: () => void;
}

function supportsProjectionDragHandleExtension(
  value: unknown,
): value is ProjectionDragHandleExtension {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProjectionDragHandleExtension>;
  if (typeof candidate.blockDragStart !== "function") return false;
  return typeof candidate.blockDragEnd === "function";
}

function getProjectionDragHandleExtension(
  editor: ProjectionDragEditor,
): ProjectionDragHandleExtension | null {
  const extension = editor.getExtension(SideMenuExtension);
  if (!supportsProjectionDragHandleExtension(extension)) return null;
  return extension;
}

export function startProjectionBlockDrag(
  editor: ProjectionDragEditor,
  block: ProjectionDragBlock,
  event: ProjectionDragEvent,
): boolean {
  const extension = getProjectionDragHandleExtension(editor);
  if (!extension) {
    event.preventDefault();
    return false;
  }

  const nextBlock = typeof editor.getBlock === "function"
    ? (editor.getBlock(block.id) ?? block)
    : block;
  extension.blockDragStart(event, nextBlock);
  return true;
}

export function endProjectionBlockDrag(editor: ProjectionDragEditor): void {
  getProjectionDragHandleExtension(editor)?.blockDragEnd();
}

interface ProjectionDragHandleButtonProps {
  editor: ProjectionDragEditor;
  block: ProjectionDragBlock;
  className?: string;
  title?: string;
}

export function ProjectionDragHandleButton({
  editor,
  block,
  className,
  title = "Drag block",
}: ProjectionDragHandleButtonProps) {
  const handleDragStart = (event: DragEvent<HTMLButtonElement>) => {
    startProjectionBlockDrag(editor, block, event);
  };

  const handleDragEnd = () => {
    endProjectionBlockDrag(editor);
  };

  return (
    <button
      type="button"
      draggable
      className={cn(
        PROJECTION_ACTION_BTN,
        "w-7 cursor-grab justify-center px-0 active:cursor-grabbing",
        className,
      )}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      contentEditable={false}
      aria-label={title}
      title={title}
    >
      <GripVertical className="size-3.5" />
    </button>
  );
}

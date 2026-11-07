import { SideMenuExtension } from "@blocknote/core/extensions";

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

  const nextBlock =
    typeof editor.getBlock === "function" ? (editor.getBlock(block.id) ?? block) : block;
  extension.blockDragStart(event, nextBlock);
  return true;
}

export function endProjectionBlockDrag(editor: ProjectionDragEditor): void {
  getProjectionDragHandleExtension(editor)?.blockDragEnd();
}

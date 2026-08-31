import { getNearestBlockPos } from "@blocknote/core";
import type { Node } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";

interface BlockSelectionLike {
  node?: Node;
  nodes?: readonly Node[];
}

function getSelectionNodeBlockId(node: Node | undefined): string | null {
  const id = node?.attrs?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function getSelectedBlockContentOwnerId(
  selection: Selection,
  node: Node | undefined,
): string | null {
  if (!node?.type.isInGroup("blockContent")) return null;

  try {
    return getSelectionNodeBlockId(getNearestBlockPos(selection.$from.doc, selection.from).node);
  } catch {
    return null;
  }
}

/** Resolves ProseMirror Block selections, including an atomic Block's selected content node. */
export function getNfmBlockSelectionIds(selection: Selection): string[] {
  const blockSelection = selection as Selection & BlockSelectionLike;
  if (Array.isArray(blockSelection.nodes)) {
    return Array.from(
      new Set(
        blockSelection.nodes.map(getSelectionNodeBlockId).filter((id): id is string => id !== null),
      ),
    );
  }

  const nodeId = getSelectionNodeBlockId(blockSelection.node);
  if (nodeId) return [nodeId];

  const ownerId = getSelectedBlockContentOwnerId(selection, blockSelection.node);
  return ownerId ? [ownerId] : [];
}

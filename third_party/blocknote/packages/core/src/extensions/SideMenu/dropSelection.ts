import type { Slice } from "@tiptap/pm/model";
import type { Node } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";

import { getNearestBlockPos } from "../../api/getBlockInfoFromPos.js";
import { getNodeById, isNodeBlock } from "../../api/nodeUtil.js";
import { MultipleNodeSelection } from "./MultipleNodeSelection.js";

interface BlockSelectionLike {
  node?: Node;
  nodes?: readonly Node[];
}

function toUniqueBlockIds(blockIds: string[]): string[] {
  return Array.from(new Set(blockIds.filter((id) => id.length > 0)));
}

function getBlockIdFromNode(node: Node): string | null {
  const id = node.attrs?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function getSelectedBlockContentOwnerId(
  selection: Selection,
  node: Node | undefined,
): string | null {
  if (!node?.type.isInGroup("blockContent")) return null;

  try {
    return getBlockIdFromNode(
      getNearestBlockPos(selection.$from.doc, selection.from).node,
    );
  } catch {
    return null;
  }
}

export function getSideMenuDroppedBlockIdsFromSelection(
  selection: Selection,
): string[] {
  const blockSelection = selection as Selection & BlockSelectionLike;
  if (Array.isArray(blockSelection.nodes)) {
    return toUniqueBlockIds(
      blockSelection.nodes
        .map(getBlockIdFromNode)
        .filter((id): id is string => id !== null),
    );
  }

  const nodeId = blockSelection.node
    ? getBlockIdFromNode(blockSelection.node)
    : null;
  if (nodeId) return [nodeId];

  const ownerId = getSelectedBlockContentOwnerId(
    selection,
    blockSelection.node,
  );
  return ownerId ? [ownerId] : [];
}

export function getSideMenuDroppedBlockIdsFromSlice(slice: Slice): string[] {
  const blockIds: string[] = [];

  slice.content.forEach((node) => {
    if (isNodeBlock(node)) {
      const blockId = getBlockIdFromNode(node);
      if (blockId) blockIds.push(blockId);
      return;
    }

    node.descendants((descendant) => {
      if (!isNodeBlock(descendant)) return true;

      const blockId = getBlockIdFromNode(descendant);
      if (blockId) blockIds.push(blockId);
      return false;
    });
  });

  return toUniqueBlockIds(blockIds);
}

function normalizeBlockRangeAroundSelectionIds(
  from: number,
  to: number,
  doc: Node,
) {
  try {
    const $from = doc.resolve(from);
    const $to = doc.resolve(to);
    const sharedDepth = $from.sharedDepth($to.pos);
    const normalizedFrom = $from.posAtIndex(
      $from.index(sharedDepth),
      sharedDepth,
    );
    const normalizedTo = $to.posAtIndex($to.indexAfter(sharedDepth), sharedDepth);

    if (normalizedFrom >= normalizedTo) return undefined;
    return { from: normalizedFrom, to: normalizedTo };
  } catch {
    return undefined;
  }
}

export function createSideMenuDroppedBlockSelection(
  doc: Node,
  blockIds: string[],
): Selection | undefined {
  const blockPositions = toUniqueBlockIds(blockIds)
    .map((blockId) => getNodeById(blockId, doc))
    .filter((position): position is NonNullable<typeof position> => position !== undefined)
    .sort((a, b) => a.posBeforeNode - b.posBeforeNode);

  if (blockPositions.length === 0) return undefined;

  const firstPosition = blockPositions[0];
  const lastPosition = blockPositions[blockPositions.length - 1];
  const normalizedRange = normalizeBlockRangeAroundSelectionIds(
    firstPosition.posBeforeNode,
    lastPosition.posBeforeNode + lastPosition.node.nodeSize,
    doc,
  );
  if (!normalizedRange) return undefined;

  return MultipleNodeSelection.create(
    doc,
    normalizedRange.from,
    normalizedRange.to,
  );
}

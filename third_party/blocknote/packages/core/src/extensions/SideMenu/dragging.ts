import { Node, type Schema, Slice } from "prosemirror-model";
import { NodeSelection, Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { createExternalHTMLExporter } from "../../api/exporters/html/externalHTMLExporter.js";
import { cleanHTMLToMarkdown } from "../../api/exporters/markdown/markdownExporter.js";
import { getBlockInfoWithManualOffset } from "../../api/getBlockInfoFromPos.js";
import { fragmentToBlocks } from "../../api/nodeConversions/fragmentToBlocks.js";
import { getNodeById } from "../../api/nodeUtil.js";
import { Block } from "../../blocks/defaultBlocks.js";
import type { BlockNoteEditor } from "../../editor/BlockNoteEditor.js";
import { UiElementPosition } from "../../extensions-shared/UiElementPosition.js";
import {
  BlockSchema,
  InlineContentSchema,
  StyleSchema,
} from "../../schema/index.js";
import { getSideMenuDroppedBlockIdsFromSlice } from "./dropSelection.js";
import { MultipleNodeSelection } from "./MultipleNodeSelection.js";

let dragImageElement: Element | undefined;

export const BLOCKNOTE_SLICE_MIME = "application/x-blocknote-slice+json";

export function serializeSideMenuDragSlice(slice: Slice): string {
  return JSON.stringify(slice.toJSON());
}

export function parseSideMenuDragSlice(
  serializedSlice: string,
  schema: Schema,
): Slice | undefined {
  try {
    const value: unknown = JSON.parse(serializedSlice);
    if (
      !value ||
      typeof value !== "object" ||
      !("content" in value) ||
      !Array.isArray(value.content)
    ) {
      return undefined;
    }

    return Slice.fromJSON(schema, value);
  } catch {
    return undefined;
  }
}

export type SideMenuBlockDragStartEvent = {
  dataTransfer: DataTransfer | null;
  clientY: number;
  selectedBlockIds?: string[];
  selectionFrom?: number;
  selectionTo?: number;
};

export type SideMenuBlockDragStartResult = {
  slice: Slice;
  blockIds: string[];
};

export type SideMenuBlockPositionRange = {
  from: number;
  to: number;
};

type SideMenuDragBlockRecord = {
  id: string;
  posBeforeNode: number;
  posAfterNode: number;
  parentDepth: number;
  parentStart: number;
  indexInParent: number;
  contentStart?: number;
  contentEnd?: number;
};

export type SideMenuState<
  BSchema extends BlockSchema,
  I extends InlineContentSchema,
  S extends StyleSchema,
> = UiElementPosition & {
  // The block that the side menu is attached to.
  block: Block<BSchema, I, S>;
};

function blockPositionsFromSelection(selection: Selection, doc: Node) {
  // Absolute positions just before the first block spanned by the selection, and just after the last block. Having the
  // selection start and end just before and just after the target blocks ensures no whitespace/line breaks are left
  // behind after dragging & dropping them.
  let beforeFirstBlockPos: number;
  let afterLastBlockPos: number;

  // Even the user starts dragging blocks but drops them in the same place, the selection will still be moved just
  // before & just after the blocks spanned by the selection, and therefore doesn't need to change if they try to drag
  // the same blocks again. If this happens, the anchor & head move out of the block content node they were originally
  // in. If the anchor should update but the head shouldn't and vice versa, it means the user selection is outside a
  // block content node, which should never happen.
  const selectionStartInBlockContent =
    doc.resolve(selection.from).node().type.spec.group === "blockContent";
  const selectionEndInBlockContent =
    doc.resolve(selection.to).node().type.spec.group === "blockContent";

  // Ensures that entire outermost nodes are selected if the selection spans multiple nesting levels.
  const minDepth = Math.min(selection.$anchor.depth, selection.$head.depth);

  if (selectionStartInBlockContent && selectionEndInBlockContent) {
    // Absolute positions at the start of the first block in the selection and at the end of the last block. User
    // selections will always start and end in block content nodes, but we want the start and end positions of their
    // parent block nodes, which is why minDepth - 1 is used.
    const startFirstBlockPos = selection.$from.start(minDepth - 1);
    const endLastBlockPos = selection.$to.end(minDepth - 1);

    // Shifting start and end positions by one moves them just outside the first and last selected blocks.
    beforeFirstBlockPos = doc.resolve(startFirstBlockPos - 1).pos;
    afterLastBlockPos = doc.resolve(endLastBlockPos + 1).pos;
  } else {
    beforeFirstBlockPos = selection.from;
    afterLastBlockPos = selection.to;
  }

  return { from: beforeFirstBlockPos, to: afterLastBlockPos };
}

function getBlockId(node: Node) {
  const id = node.attrs.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function getBlockRecordContentRange(node: Node, posBeforeNode: number) {
  try {
    const blockInfo = getBlockInfoWithManualOffset(node, posBeforeNode);
    if (!blockInfo.isBlockContainer) {
      return undefined;
    }

    return {
      contentStart: blockInfo.blockContent.beforePos + 1,
      contentEnd: blockInfo.blockContent.afterPos - 1,
    };
  } catch {
    return undefined;
  }
}

function collectSideMenuDragBlockRecords(doc: Node) {
  const records: SideMenuDragBlockRecord[] = [];

  doc.descendants((node, pos) => {
    if (!node.type.isInGroup("bnBlock")) {
      return true;
    }

    const id = getBlockId(node);
    if (!id) {
      return true;
    }

    const resolvedPos = doc.resolve(pos);
    records.push({
      id,
      posBeforeNode: pos,
      posAfterNode: pos + node.nodeSize,
      parentDepth: resolvedPos.depth,
      parentStart: resolvedPos.start(resolvedPos.depth),
      indexInParent: resolvedPos.index(resolvedPos.depth),
      ...getBlockRecordContentRange(node, pos),
    });

    return true;
  });

  return records;
}

function recordIsInSelectionBounds(
  record: SideMenuDragBlockRecord,
  selectionFrom: number,
  selectionTo: number,
) {
  if (
    typeof record.contentStart !== "number" ||
    typeof record.contentEnd !== "number"
  ) {
    return false;
  }

  const { contentStart, contentEnd } = record;
  if (contentStart <= selectionFrom && selectionFrom <= contentEnd) {
    return true;
  }

  if (selectionFrom < contentEnd && contentStart < selectionTo) {
    return true;
  }

  return (
    contentStart === contentEnd &&
    selectionFrom < contentStart &&
    contentStart < selectionTo
  );
}

function blockPositionsFromCandidateIds(
  records: SideMenuDragBlockRecord[],
  candidateIds: Set<string>,
  draggedBlockId: string,
  doc: Node,
): SideMenuBlockPositionRange | undefined {
  const candidateRecords = records
    .filter((record) => candidateIds.has(record.id))
    .sort((a, b) => a.posBeforeNode - b.posBeforeNode);
  const firstCandidateRecord = candidateRecords[0];
  const lastCandidateRecord = candidateRecords[candidateRecords.length - 1];
  if (!firstCandidateRecord || !lastCandidateRecord) {
    return undefined;
  }

  const range = normalizeBlockRangeAroundBlockRecords(
    firstCandidateRecord,
    lastCandidateRecord,
    doc,
  );
  if (!range) {
    return undefined;
  }

  if (candidateIds.has(draggedBlockId)) {
    return range;
  }

  const rangeBlockIds = getBlockIdsFromSelectionRange(doc, range);
  return rangeBlockIds.has(draggedBlockId) ? range : undefined;
}

function normalizeBlockRangeAroundBlockRecords(
  firstRecord: SideMenuDragBlockRecord,
  lastRecord: SideMenuDragBlockRecord,
  doc: Node,
) {
  try {
    const $from = doc.resolve(firstRecord.posBeforeNode);
    const $to = doc.resolve(lastRecord.posAfterNode);
    const sharedDepth = $from.sharedDepth($to.pos);
    const normalizedFrom = $from.posAtIndex(
      $from.index(sharedDepth),
      sharedDepth,
    );
    const normalizedTo = $to.posAtIndex($to.indexAfter(sharedDepth), sharedDepth);

    if (normalizedFrom >= normalizedTo) {
      return undefined;
    }

    return { from: normalizedFrom, to: normalizedTo };
  } catch {
    return undefined;
  }
}

function getBlockIdsFromSelectionRange(doc: Node, range: SideMenuBlockPositionRange) {
  const blockIds = new Set<string>();

  try {
    for (const node of MultipleNodeSelection.create(doc, range.from, range.to)
      .nodes) {
      const blockId = getBlockId(node);
      if (blockId) blockIds.add(blockId);
    }
  } catch {
    return blockIds;
  }

  return blockIds;
}

function blockPositionsFromSelectionRange(
  event: Pick<SideMenuBlockDragStartEvent, "selectionFrom" | "selectionTo">,
  draggedBlockId: string,
  doc: Node,
) {
  if (
    typeof event.selectionFrom !== "number" ||
    typeof event.selectionTo !== "number" ||
    event.selectionFrom === event.selectionTo
  ) {
    return undefined;
  }

  const selectionFrom = Math.min(event.selectionFrom, event.selectionTo);
  const selectionTo = Math.max(event.selectionFrom, event.selectionTo);
  const records = collectSideMenuDragBlockRecords(doc);
  const candidateIds = new Set(
    records
      .filter((record) =>
        recordIsInSelectionBounds(record, selectionFrom, selectionTo),
      )
      .map((record) => record.id),
  );

  return blockPositionsFromCandidateIds(
    records,
    candidateIds,
    draggedBlockId,
    doc,
  );
}

function blockPositionsFromSelectedBlockIds(
  selectedBlockIds: string[] | undefined,
  draggedBlockId: string,
  doc: Node,
) {
  if (!selectedBlockIds || selectedBlockIds.length === 0) {
    return undefined;
  }

  const selectedBlockIdSet = new Set(selectedBlockIds);
  if (!selectedBlockIdSet.has(draggedBlockId)) {
    return undefined;
  }

  const records = collectSideMenuDragBlockRecords(doc);
  const recordIds = new Set(records.map((record) => record.id));
  for (const selectedBlockId of selectedBlockIdSet) {
    if (!recordIds.has(selectedBlockId)) {
      return undefined;
    }
  }

  return blockPositionsFromCandidateIds(
    records,
    selectedBlockIdSet,
    draggedBlockId,
    doc,
  );
}

function hasDragSelectionSnapshot(event: SideMenuBlockDragStartEvent) {
  return (
    (Array.isArray(event.selectedBlockIds) &&
      event.selectedBlockIds.length > 0) ||
    (typeof event.selectionFrom === "number" &&
      typeof event.selectionTo === "number" &&
      event.selectionFrom !== event.selectionTo)
  );
}

export function getSideMenuDragBlockPositionsFromSnapshot(
  options: Pick<
    SideMenuBlockDragStartEvent,
    "selectedBlockIds" | "selectionFrom" | "selectionTo"
  > & {
    draggedBlockId: string;
    doc: Node;
  },
): SideMenuBlockPositionRange | undefined {
  const rangeFromSelection = blockPositionsFromSelectionRange(
    options,
    options.draggedBlockId,
    options.doc,
  );
  if (rangeFromSelection) {
    return rangeFromSelection;
  }

  return blockPositionsFromSelectedBlockIds(
    options.selectedBlockIds,
    options.draggedBlockId,
    options.doc,
  );
}

function blockPositionsFromDragStartEvent(
  event: SideMenuBlockDragStartEvent,
  draggedBlockId: string,
  doc: Node,
) {
  return getSideMenuDragBlockPositionsFromSnapshot({
    selectedBlockIds: event.selectedBlockIds,
    selectionFrom: event.selectionFrom,
    selectionTo: event.selectionTo,
    draggedBlockId,
    doc,
  });
}

function setSingleBlockDragSelection(view: EditorView, pos: number) {
  view.dispatch(
    view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)),
  );
  setDragImage(view, pos);
}

function setDragImage(view: EditorView, from: number, to = from) {
  if (from === to) {
    // Moves to position to be just after the first (and only) selected block.
    to += view.state.doc.resolve(from + 1).node().nodeSize;
  }

  // Parent element is cloned to remove all unselected children without affecting the editor content.
  const parentClone = view.domAtPos(from).node.cloneNode(true) as Element;
  const parent = view.domAtPos(from).node as Element;

  const getElementIndex = (parentElement: Element, targetElement: Element) =>
    Array.prototype.indexOf.call(parentElement.children, targetElement);

  const firstSelectedBlockIndex = getElementIndex(
    parent,
    // Expects from position to be just before the first selected block.
    view.domAtPos(from + 1).node.parentElement!,
  );
  const lastSelectedBlockIndex = getElementIndex(
    parent,
    // Expects to position to be just after the last selected block.
    view.domAtPos(to - 1).node.parentElement!,
  );

  for (let i = parent.childElementCount - 1; i >= 0; i--) {
    if (i > lastSelectedBlockIndex || i < firstSelectedBlockIndex) {
      parentClone.removeChild(parentClone.children[i]);
    }
  }

  // dataTransfer.setDragImage(element) only works if element is attached to the DOM.
  unsetDragImage(view.root);
  dragImageElement = parentClone;

  // Browsers may have CORS policies which prevents iframes from being
  // manipulated, so better to stay on the safe side and remove them from the
  // drag preview. The drag preview doesn't work with embedded documents
  // (iframe/embed/object) anyway, and including an <embed> (e.g. a PDF)
  // can prevent the drag from initiating at all.
  const embeddedDocs = dragImageElement.querySelectorAll(
    "iframe, embed, object",
  );
  embeddedDocs.forEach((el) => el.parentElement?.removeChild(el));

  // TODO: This is hacky, need a better way of assigning classes to the editor so that they can also be applied to the
  //  drag preview.
  const classes = view.dom.className.split(" ");
  const inheritedClasses = classes
    .filter(
      (className) =>
        className !== "ProseMirror" &&
        className !== "bn-root" &&
        className !== "bn-editor",
    )
    .join(" ");

  dragImageElement.className =
    dragImageElement.className + " bn-drag-preview " + inheritedClasses;

  if (view.root instanceof ShadowRoot) {
    view.root.appendChild(dragImageElement);
  } else {
    view.root.body.appendChild(dragImageElement);
  }
}

export function unsetDragImage(_rootEl?: Document | ShadowRoot) {
  if (dragImageElement !== undefined) {
    dragImageElement.remove();
    dragImageElement = undefined;
  }
}

export function dragStart<
  BSchema extends BlockSchema,
  I extends InlineContentSchema,
  S extends StyleSchema,
>(
  e: SideMenuBlockDragStartEvent,
  block: Block<BSchema, I, S>,
  editor: BlockNoteEditor<BSchema, I, S>,
): SideMenuBlockDragStartResult | undefined {
  if (!e.dataTransfer) {
    return;
  }

  const view = editor.prosemirrorView;
  if (!view) return;

  const posInfo = getNodeById(block.id, view.state.doc);
  if (!posInfo) {
    throw new Error(`Block with ID ${block.id} not found`);
  }
  const pos = posInfo.posBeforeNode;

  if (pos != null) {
    const selection = view.state.selection;
    const doc = view.state.doc;
    const explicitBlockSelection = blockPositionsFromDragStartEvent(
      e,
      block.id,
      doc,
    );

    if (explicitBlockSelection) {
      const { from, to } = explicitBlockSelection;

      view.dispatch(
        view.state.tr.setSelection(MultipleNodeSelection.create(doc, from, to)),
      );
      setDragImage(view, from, to);
    } else if (hasDragSelectionSnapshot(e)) {
      setSingleBlockDragSelection(view, pos);
    } else {
      const { from, to } = blockPositionsFromSelection(selection, doc);

      const draggedBlockInSelection = from <= pos && pos < to;
      const multipleBlocksSelected =
        selection.$anchor.node() !== selection.$head.node() ||
        selection instanceof MultipleNodeSelection;

      if (draggedBlockInSelection && multipleBlocksSelected) {
        view.dispatch(
          view.state.tr.setSelection(MultipleNodeSelection.create(doc, from, to)),
        );
        setDragImage(view, from, to);
      } else {
        setSingleBlockDragSelection(view, pos);
      }
    }

    const selectedSlice = view.state.selection.content();
    const schema = editor.pmSchema;

    const externalHTMLExporter = createExternalHTMLExporter(schema, editor);

    const blocks = fragmentToBlocks(selectedSlice.content);
    const externalHTML = externalHTMLExporter.exportBlocks(blocks, {});

    const plainText = cleanHTMLToMarkdown(externalHTML);

    e.dataTransfer.clearData();
    e.dataTransfer.setData(
      BLOCKNOTE_SLICE_MIME,
      serializeSideMenuDragSlice(selectedSlice),
    );
    e.dataTransfer.setData("text/html", externalHTML);
    e.dataTransfer.setData("text/plain", plainText);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setDragImage(dragImageElement!, 0, 0);

    return {
      slice: selectedSlice,
      blockIds: getSideMenuDroppedBlockIdsFromSlice(selectedSlice),
    };
  }
  return undefined;
}

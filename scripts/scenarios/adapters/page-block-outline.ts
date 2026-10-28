import type * as Y from "yjs";
import { assertValidBlockDocument } from "../../../src/shared/block-documents/block-structure";
import { assertValidPageDocumentRoots } from "../../../src/shared/block-documents/page-document";
import type { ScenarioBlockNode } from "../contracts";

/**
 * A Page's committed Blocks by identity, type and order, read from its Document without decoding
 * content, so seed adapters also run where the editor's schema cannot load.
 */
export const readPageBlockOutline = (document: Y.Doc): readonly ScenarioBlockNode[] => {
  const scanned = assertValidBlockDocument(assertValidPageDocumentRoots(document).body);
  const children = new Map<string, ScenarioBlockNode[]>();
  const roots: ScenarioBlockNode[] = [];
  // The scan is in document order, so every parent precedes its children.
  for (const block of scanned) {
    const node: ScenarioBlockNode = { id: block.id, type: block.blockType, children: [] };
    children.set(block.id, node.children as ScenarioBlockNode[]);
    (block.parentBlockId === null ? roots : children.get(block.parentBlockId)!).push(node);
  }
  return roots;
};

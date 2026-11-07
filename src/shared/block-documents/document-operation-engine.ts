import * as Y from "yjs";
import {
  createDetachedPageDocumentFromBlockTree,
  type BlockTreeNode,
  type PageDocumentMaterialization,
} from "./block-document-codec";
import {
  getBlockDocumentSchemaAdapter,
  inspectOwnedBlockDocument,
  toPersistedBlockDocumentMaterialization,
} from "./document-schema-adapters";
import {
  BlockSubtreeOperationError,
  indexBlockDocumentTree,
  locateBlockContainer,
  relocateBlockSubtrees,
} from "./block-subtree-relocation";
import { BLOCK_GROUP_NODE_NAME } from "./block-structure";
import {
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
  createPageDocument,
} from "./page-document";
import type { DocumentBlockOperation, DocumentBlockUpdatePatch } from "./document-operations";
import { cloneXmlSubtree } from "./xml-subtree-codec";
import {
  plainTextToPortableRichText,
  portableRichTextSemanticSource,
  readPortableRichTextFromYText,
  replaceYTextWithPortableRichText,
} from "./portable-rich-text";

export type DocumentOperationEngineErrorCode =
  | "duplicate_block_id"
  | "block_not_found"
  | "invalid_anchor"
  | "ancestor_cycle"
  | "invalid_block"
  | "invalid_operation"
  | "no_change";

export class DocumentOperationEngineError extends Error {
  readonly code: DocumentOperationEngineErrorCode;
  readonly operationIndex?: number;
  readonly blockId?: string;

  constructor(
    code: DocumentOperationEngineErrorCode,
    message: string,
    options: ErrorOptions & {
      readonly operationIndex?: number;
      readonly blockId?: string;
    } = {},
  ) {
    super(message, options);
    this.name = "DocumentOperationEngineError";
    this.code = code;
    this.operationIndex = options.operationIndex;
    this.blockId = options.blockId;
  }
}

export interface PrepareDocumentOperationUpdateInput {
  /** Current durable state. This source remains byte-for-byte read-only. */
  readonly document: Y.Doc;
  readonly operations: readonly DocumentBlockOperation[];
  readonly schema?: {
    readonly ownerType: string;
    readonly schemaKey: string;
    readonly schemaVersion: number;
  };
  readonly transactionOrigin?: unknown;
  /** Internal ownership transitions may refill or retire the Document before outer commit. */
  readonly allowTransientEmptyResult?: boolean;
}

export interface PreparedDocumentOperationUpdate {
  readonly update: Uint8Array;
  readonly materialization: PageDocumentMaterialization;
  /** Application identities whose existing Yjs structs were removed/replaced. */
  readonly writeFenceBlockIds: readonly string[];
  /** True when any operation replaced title structs, even if the net title is unchanged. */
  readonly titleWriteFenceRequired: boolean;
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

const flattenBlockTree = (blocks: readonly BlockTreeNode[]): readonly BlockTreeNode[] =>
  blocks.flatMap((block) => [block, ...flattenBlockTree(block.children)]);

const collectInsertedIds = (
  operations: readonly DocumentBlockOperation[],
  existingIds: ReadonlySet<string>,
): void => {
  const insertedIds = new Set<string>();
  operations.forEach((operation, operationIndex) => {
    if (operation.kind !== "insert_block") return;
    for (const block of flattenBlockTree([operation.block])) {
      if (!existingIds.has(block.id) && !insertedIds.has(block.id)) {
        insertedIds.add(block.id);
        continue;
      }
      throw new DocumentOperationEngineError(
        "duplicate_block_id",
        `Inserted Block identity ${block.id} already exists in this batch or Document`,
        { operationIndex, blockId: block.id },
      );
    }
  });
};

const readContentElement = (
  container: Y.XmlElement,
  blockId: string,
): { readonly element: Y.XmlElement; readonly index: number } => {
  const children = container.toArray();
  const index = children.findIndex(
    (child) => child instanceof Y.XmlElement && child.nodeName !== BLOCK_GROUP_NODE_NAME,
  );
  const element = children[index];
  if (index >= 0 && element instanceof Y.XmlElement) return { element, index };
  throw new DocumentOperationEngineError(
    "invalid_block",
    `Block ${blockId} has no canonical content element`,
    { blockId },
  );
};

const hasPatchContent = (patch: DocumentBlockUpdatePatch): boolean =>
  Object.hasOwn(patch, "content") || patch.unsetContent === true;

const semanticPatchChangesBlock = (
  current: BlockTreeNode,
  patch: DocumentBlockUpdatePatch,
): boolean => {
  if (patch.type !== undefined && patch.type !== current.type) return true;
  if (
    patch.props !== undefined &&
    stableStringify(patch.props) !== stableStringify(current.props)
  ) {
    return true;
  }
  if (!hasPatchContent(patch)) return false;
  const targetContent = patch.unsetContent === true ? undefined : patch.content;
  return stableStringify(targetContent) !== stableStringify(current.content);
};

const patchedStandaloneBlock = (
  current: BlockTreeNode,
  patch: DocumentBlockUpdatePatch,
): BlockTreeNode => {
  const content =
    patch.unsetContent === true
      ? undefined
      : hasPatchContent(patch)
        ? patch.content
        : current.content;
  return {
    id: current.id,
    type: patch.type ?? current.type,
    props: patch.props ?? current.props,
    ...(content === undefined ? {} : { content }),
    children: [],
  };
};

const replaceBlockContent = (
  document: Y.Doc,
  operation: Extract<DocumentBlockOperation, { readonly kind: "update_block" }>,
  operationIndex: number,
  semanticBlocks: Map<string, BlockTreeNode>,
  writeFenceBlockIds: Set<string>,
): void => {
  const current = semanticBlocks.get(operation.blockId);
  if (!current) {
    throw new DocumentOperationEngineError(
      "block_not_found",
      `Block ${operation.blockId} does not exist`,
      { operationIndex, blockId: operation.blockId },
    );
  }
  if (!semanticPatchChangesBlock(current, operation.patch)) return;
  const patched = patchedStandaloneBlock(current, operation.patch);

  let candidate;
  try {
    candidate = createDetachedPageDocumentFromBlockTree({
      documentId: `${document.guid}:update:${operationIndex}`,
      blockTree: [patched],
    });
  } catch (error) {
    throw new DocumentOperationEngineError(
      "invalid_block",
      `Block ${operation.blockId} update is not valid for the canonical schema`,
      { cause: error, operationIndex, blockId: operation.blockId },
    );
  }
  try {
    const currentLocation = locateBlockContainer(
      document.getXmlFragment("body"),
      operation.blockId,
    );
    const candidateLocation = locateBlockContainer(
      candidate.document.getXmlFragment("body"),
      operation.blockId,
    );
    const currentContent = readContentElement(currentLocation.container, operation.blockId);
    const candidateContent = readContentElement(candidateLocation.container, operation.blockId);
    currentLocation.container.delete(currentContent.index, 1);
    currentLocation.container.insert(currentContent.index, [
      cloneXmlSubtree(candidateContent.element),
    ]);
    semanticBlocks.set(operation.blockId, {
      ...patched,
      children: current.children,
    });
    writeFenceBlockIds.add(operation.blockId);
  } finally {
    candidate.document.destroy();
  }
};

const insertBlock = (
  document: Y.Doc,
  operation: Extract<DocumentBlockOperation, { readonly kind: "insert_block" }>,
  operationIndex: number,
  semanticBlocks: Map<string, BlockTreeNode>,
): void => {
  let candidate;
  try {
    candidate = createDetachedPageDocumentFromBlockTree({
      documentId: `${document.guid}:insert:${operationIndex}`,
      blockTree: [operation.block],
    });
  } catch (error) {
    throw new DocumentOperationEngineError(
      "invalid_block",
      `Inserted Block ${operation.block.id} is not valid for the canonical schema`,
      { cause: error, operationIndex, blockId: operation.block.id },
    );
  }
  try {
    relocateBlockSubtrees({
      sourceDocument: candidate.document,
      targetDocument: document,
      sourceBody: candidate.document.getXmlFragment("body"),
      targetBody: document.getXmlFragment("body"),
      rootBlockIds: [operation.block.id],
      target: {
        ...(operation.parentBlockId ? { parentBlockId: operation.parentBlockId } : {}),
        ...(operation.beforeBlockId ? { beforeBlockId: operation.beforeBlockId } : {}),
      },
      transactionOrigin: `document-operation:insert:${operationIndex}`,
    });
    flattenBlockTree([operation.block]).forEach((block) => {
      semanticBlocks.set(block.id, block);
    });
  } finally {
    candidate.document.destroy();
  }
};

const deleteBlock = (
  document: Y.Doc,
  blockId: string,
  operationIndex: number,
  semanticBlocks: Map<string, BlockTreeNode>,
  writeFenceBlockIds: Set<string>,
): void => {
  const trash = createPageDocument({
    documentId: `${document.guid}:delete:${operationIndex}`,
  });
  try {
    const location = indexBlockDocumentTree(document.getXmlFragment("body")).blocks.get(blockId);
    const deletedIds = location ? [location.blockId, ...location.descendantBlockIds] : [blockId];
    relocateBlockSubtrees({
      sourceDocument: document,
      targetDocument: trash.document,
      sourceBody: document.getXmlFragment("body"),
      targetBody: trash.document.getXmlFragment("body"),
      rootBlockIds: [blockId],
      target: {},
      transactionOrigin: `document-operation:delete:${operationIndex}`,
    });
    deletedIds.forEach((deletedId) => semanticBlocks.delete(deletedId));
    deletedIds.forEach((deletedId) => writeFenceBlockIds.add(deletedId));
  } finally {
    trash.document.destroy();
  }
};

const isMoveNoop = (
  document: Y.Doc,
  operation: Extract<DocumentBlockOperation, { readonly kind: "move_block" }>,
): boolean => {
  const index = indexBlockDocumentTree(document.getXmlFragment("body"));
  const current = index.blocks.get(operation.blockId);
  if (!current) return false;
  const targetParentId = operation.parentBlockId ?? null;
  if (current.parentBlockId !== targetParentId) return false;
  const siblings = targetParentId
    ? index.blocks.get(targetParentId)?.directChildBlockIds
    : index.rootBlockIds;
  if (!siblings) return false;
  const remaining = siblings.filter((blockId) => blockId !== operation.blockId);
  const currentIndex = siblings.indexOf(operation.blockId);
  const targetIndex = operation.beforeBlockId
    ? remaining.indexOf(operation.beforeBlockId)
    : remaining.length;
  return targetIndex >= 0 && targetIndex === currentIndex;
};

const moveBlock = (
  document: Y.Doc,
  operation: Extract<DocumentBlockOperation, { readonly kind: "move_block" }>,
  operationIndex: number,
  writeFenceBlockIds: Set<string>,
): void => {
  if (isMoveNoop(document, operation)) return;
  const location = indexBlockDocumentTree(document.getXmlFragment("body")).blocks.get(
    operation.blockId,
  );
  const invalidatedIds = location
    ? [location.blockId, ...location.descendantBlockIds]
    : [operation.blockId];
  relocateBlockSubtrees({
    sourceDocument: document,
    targetDocument: document,
    sourceBody: document.getXmlFragment("body"),
    targetBody: document.getXmlFragment("body"),
    rootBlockIds: [operation.blockId],
    target: {
      ...(operation.parentBlockId ? { parentBlockId: operation.parentBlockId } : {}),
      ...(operation.beforeBlockId ? { beforeBlockId: operation.beforeBlockId } : {}),
    },
    transactionOrigin: `document-operation:move:${operationIndex}`,
  });
  invalidatedIds.forEach((blockId) => writeFenceBlockIds.add(blockId));
};

const mapSubtreeError = (
  error: BlockSubtreeOperationError,
  operationIndex: number,
): DocumentOperationEngineError => {
  const options = {
    cause: error,
    operationIndex,
    ...(error.blockId ? { blockId: error.blockId } : {}),
  };
  switch (error.code) {
    case "source_block_not_found":
      return new DocumentOperationEngineError("block_not_found", error.message, options);
    case "target_parent_not_found":
    case "target_parent_rejects_children":
    case "target_anchor_not_found":
    case "target_anchor_wrong_parent":
    case "target_anchor_in_moved_subtree":
      return new DocumentOperationEngineError("invalid_anchor", error.message, options);
    case "ancestor_cycle":
      return new DocumentOperationEngineError("ancestor_cycle", error.message, options);
    case "target_identity_conflict":
      return new DocumentOperationEngineError("duplicate_block_id", error.message, options);
    default:
      return new DocumentOperationEngineError("invalid_operation", error.message, options);
  }
};

const applyOperation = (
  document: Y.Doc,
  operation: DocumentBlockOperation,
  operationIndex: number,
  semanticBlocks: Map<string, BlockTreeNode>,
  writeFenceBlockIds: Set<string>,
  titleWriteFence: { required: boolean },
  supportsTitle: boolean,
): void => {
  try {
    switch (operation.kind) {
      case "set_title": {
        if (!supportsTitle) {
          throw new DocumentOperationEngineError(
            "invalid_operation",
            "This Document schema does not own a title root",
            { operationIndex },
          );
        }
        const title = document.getText("title");
        const desired = plainTextToPortableRichText(operation.title);
        if (
          portableRichTextSemanticSource(readPortableRichTextFromYText(title)) ===
          portableRichTextSemanticSource(desired)
        )
          return;
        titleWriteFence.required = true;
        replaceYTextWithPortableRichText(title, desired);
        return;
      }
      case "set_rich_title": {
        if (!supportsTitle) {
          throw new DocumentOperationEngineError(
            "invalid_operation",
            "This Document schema does not own a title root",
            { operationIndex },
          );
        }
        const title = document.getText("title");
        if (
          portableRichTextSemanticSource(readPortableRichTextFromYText(title)) ===
          portableRichTextSemanticSource(operation.richTitle)
        )
          return;
        titleWriteFence.required = true;
        replaceYTextWithPortableRichText(title, operation.richTitle);
        return;
      }
      case "insert_block":
        insertBlock(document, operation, operationIndex, semanticBlocks);
        return;
      case "update_block":
        replaceBlockContent(
          document,
          operation,
          operationIndex,
          semanticBlocks,
          writeFenceBlockIds,
        );
        return;
      case "delete_block":
        deleteBlock(
          document,
          operation.blockId,
          operationIndex,
          semanticBlocks,
          writeFenceBlockIds,
        );
        return;
      case "move_block":
        moveBlock(document, operation, operationIndex, writeFenceBlockIds);
        return;
    }
  } catch (error) {
    if (error instanceof DocumentOperationEngineError) throw error;
    if (error instanceof BlockSubtreeOperationError) {
      throw mapSubtreeError(error, operationIndex);
    }
    throw new DocumentOperationEngineError(
      "invalid_operation",
      `Document operation ${operationIndex} failed validation`,
      { cause: error, operationIndex },
    );
  }
};

/**
 * Generate one relative Yjs update from a detached current-head clone. The
 * supplied source Y.Doc is never mutated, even when a later operation fails.
 */
export const prepareDocumentOperationUpdate = ({
  document,
  operations,
  schema = {
    ownerType: "page",
    schemaKey: PAGE_DOCUMENT_SCHEMA_KEY,
    schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
  },
  transactionOrigin = "document-operation-batch",
  allowTransientEmptyResult = false,
}: PrepareDocumentOperationUpdateInput): PreparedDocumentOperationUpdate => {
  const adapter = getBlockDocumentSchemaAdapter(schema);
  const sourceMaterialization = toPersistedBlockDocumentMaterialization(
    inspectOwnedBlockDocument(document, schema).materialization,
  );
  const sourceState = Y.encodeStateAsUpdate(document);
  const sourceStateVector = Y.encodeStateVector(document);
  const working = new Y.Doc({ guid: document.guid });
  try {
    Y.applyUpdate(working, sourceState);
    const initialIndex = indexBlockDocumentTree(working.getXmlFragment("body"));
    collectInsertedIds(operations, new Set(initialIndex.blockIdsInDocumentOrder));
    const semanticBlocks = new Map(
      flattenBlockTree(sourceMaterialization.blockTree).map((block) => [block.id, block]),
    );
    const writeFenceBlockIds = new Set<string>();
    const titleWriteFence = { required: false };
    working.transact(() => {
      operations.forEach((operation, index) =>
        applyOperation(
          working,
          operation,
          index,
          semanticBlocks,
          writeFenceBlockIds,
          titleWriteFence,
          adapter.capabilities.title,
        ),
      );
    }, transactionOrigin);
    const materialization = toPersistedBlockDocumentMaterialization(
      inspectOwnedBlockDocument(working, schema).materialization,
    );
    if (!allowTransientEmptyResult && materialization.blockTree.length === 0) {
      throw new DocumentOperationEngineError(
        "invalid_operation",
        "BlockNote-backed Documents must retain one editable root Block",
      );
    }
    if (
      stableStringify({
        richTitle: sourceMaterialization.richTitle,
        blockTree: sourceMaterialization.blockTree,
      }) ===
      stableStringify({
        richTitle: materialization.richTitle,
        blockTree: materialization.blockTree,
      })
    ) {
      throw new DocumentOperationEngineError(
        "no_change",
        "Document operation batch produced no semantic change",
      );
    }
    const update = Y.encodeStateAsUpdate(working, sourceStateVector);
    return {
      update,
      materialization,
      writeFenceBlockIds: [...writeFenceBlockIds].sort(),
      titleWriteFenceRequired: titleWriteFence.required,
    };
  } finally {
    working.destroy();
  }
};

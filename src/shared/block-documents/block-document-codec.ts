import { BlockNoteEditor } from "@blocknote/core";
import {
  blocksToYXmlFragment,
  yXmlElementToBlockFields,
  yXmlFragmentToBlocks,
} from "@blocknote/core/yjs";
import * as Y from "yjs";
import { createUuidV7 } from "../uuid-v7";
import { extractPlainText } from "../nfm/extract-text";
import { parseNfm } from "../nfm/parser";
import { serializeNfm } from "../nfm/serializer";
import {
  assertValidBlockDocument,
  BLOCK_GROUP_NODE_NAME,
  collectBlockChildrenViolations,
  type ScannedDocumentBlock,
} from "./block-structure";
import {
  assertValidPageDocumentRoots,
  PAGE_DOCUMENT_SCHEMA_VERSION,
  createPageDocument,
} from "./page-document";
import type { BlockId, DocumentId } from "./contracts";
import {
  deriveBlockDocumentRecords,
  type BlockDocumentAssetReference,
  type BlockDocumentReference,
} from "./derived-records";
import { headlessBlockDocumentSchema } from "./headless-blocknote-schema";
import {
  blockNoteToNfm,
  nfmToBlockNoteWithIds,
  type BlockNoteBlockValue,
} from "./nfm-blocknote-adapter";
import {
  canonicalizePortableRichText,
  portableRichTextPlainText,
  readPortableRichTextFromYText,
  replaceYTextWithPortableRichText,
  type PortableRichText,
} from "./portable-rich-text";

export type BlockTreeValue =
  | null
  | boolean
  | number
  | string
  | readonly BlockTreeValue[]
  | { readonly [key: string]: BlockTreeValue };

export interface BlockTreeNode {
  readonly id: BlockId;
  readonly type: string;
  readonly props: Readonly<Record<string, BlockTreeValue>>;
  readonly content?: BlockTreeValue;
  readonly children: readonly BlockTreeNode[];
}

export type { BlockDocumentAssetReference, BlockDocumentReference } from "./derived-records";

export interface BlockDocumentMaterialization {
  readonly schemaVersion: number;
  readonly title: string;
  readonly blockTree: readonly BlockTreeNode[];
  readonly nfm: string;
  readonly plainText: string;
  readonly preview: string;
  readonly references: readonly BlockDocumentReference[];
  readonly assetRefs: readonly BlockDocumentAssetReference[];
}

export interface PageDocumentMaterialization extends BlockDocumentMaterialization {
  readonly richTitle: PortableRichText;
}

/**
 * Common projection shape for every BlockNote-backed Document schema.
 *
 * `title` is a projection field, not proof that a schema owns a Y.Text root.
 * Body-only schemas deliberately materialize it as an empty string so the
 * existing relational projection remains rebuildable without inventing a
 * hidden collaborative title root.
 */

export interface CreatePageDocumentGenesisInput {
  readonly documentId: DocumentId;
  /** Plain convenience seam; richTitle is the canonical authority input. */
  readonly title?: string;
  readonly richTitle?: PortableRichText;
  readonly nfm: string;
  readonly allocateBlockId?: () => BlockId;
}

export interface PageDocumentGenesis {
  readonly document: Y.Doc;
  readonly update: Uint8Array;
  readonly stateVector: Uint8Array;
  readonly materialization: PageDocumentMaterialization;
}

export interface CreateDetachedPageDocumentFromBlockTreeInput {
  readonly documentId: DocumentId;
  readonly title?: string;
  readonly richTitle?: PortableRichText;
  readonly blockTree: readonly BlockTreeNode[];
}

export interface DetachedPageDocumentFromBlockTree {
  readonly document: Y.Doc;
  readonly materialization: PageDocumentMaterialization;
}

export class BlockDocumentCodecError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlockDocumentCodecError";
  }
}

/**
 * Canonicalize imported NFM to the durable semantics representable by a
 * BlockNote-backed Document. Disclosure state is intentionally omitted: an
 * expanded toggle is window-local UI state, not collaborative Page content.
 */
export const createBlockDocumentNfmContentParitySignature = (nfm: string): string => {
  let nextBlockId = 0;
  const blocks = nfmToBlockNoteWithIds(parseNfm(nfm), () => {
    nextBlockId += 1;
    return `nfm-parity-${nextBlockId}`;
  });
  return serializeNfm(blockNoteToNfm(blocks));
};

const headlessEditor = BlockNoteEditor.create({
  schema: headlessBlockDocumentSchema,
  generateBlockId: createUuidV7,
});

const ensureCanonicalBodyRoot = (body: Y.XmlFragment): void => {
  if (body.length > 0) return;
  body.insert(0, [new Y.XmlElement(BLOCK_GROUP_NODE_NAME)]);
};

/**
 * BlockNote's ProseMirror schema requires at least one Block. Keeping the
 * application identity in authority data prevents the editor from inventing
 * its process-wide `initialBlockId` placeholder when an empty Page mounts.
 */
export const createCanonicalEmptyParagraphBlock = (blockId: BlockId): BlockTreeNode => ({
  id: blockId,
  type: "paragraph",
  props: {
    backgroundColor: "default",
    textColor: "default",
    textAlignment: "left",
  },
  content: [],
  children: [],
});

export const populateBlockDocumentBodyFromNfm = (
  body: Y.XmlFragment,
  nfm: string,
  allocateBlockId: () => BlockId = createUuidV7,
): void => {
  const imported = nfmToBlockNoteWithIds(parseNfm(nfm), allocateBlockId);
  const blockNoteBlocks =
    imported.length > 0 ? imported : [createCanonicalEmptyParagraphBlock(allocateBlockId())];
  blocksToYXmlFragment(
    headlessEditor,
    blockNoteBlocks as (typeof headlessBlockDocumentSchema.Block)[],
    body,
  );
  ensureCanonicalBodyRoot(body);
};

export const populateBlockDocumentBodyFromBlockTree = (
  body: Y.XmlFragment,
  blockTree: readonly BlockTreeNode[],
): void => {
  blocksToYXmlFragment(
    headlessEditor,
    blockTree as (typeof headlessBlockDocumentSchema.Block)[],
    body,
  );
  ensureCanonicalBodyRoot(body);
};

const OMIT_VALUE = Symbol("omit-block-tree-value");

const cloneBlockTreeValue = (
  value: unknown,
  ancestors = new Set<object>(),
): BlockTreeValue | typeof OMIT_VALUE => {
  if (value === undefined) return OMIT_VALUE;
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BlockDocumentCodecError("Block tree values must contain finite numbers");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new BlockDocumentCodecError(`Unsupported Block tree value: ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new BlockDocumentCodecError("Block tree values must not contain cycles");
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const cloned = cloneBlockTreeValue(entry, nextAncestors);
      return cloned === OMIT_VALUE ? null : cloned;
    });
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BlockDocumentCodecError(`Unsupported Block tree object: ${value.constructor.name}`);
  }

  const entries = Object.entries(value).flatMap(([key, entry]) => {
    const cloned = cloneBlockTreeValue(entry, nextAncestors);
    return cloned === OMIT_VALUE ? [] : [[key, cloned] as const];
  });
  return Object.fromEntries(entries);
};

const cloneProps = (
  props: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, BlockTreeValue>> => {
  const cloned = cloneBlockTreeValue(props ?? {});
  if (
    cloned === OMIT_VALUE ||
    typeof cloned !== "object" ||
    cloned === null ||
    Array.isArray(cloned)
  ) {
    throw new BlockDocumentCodecError("Block props must be a portable object");
  }
  return cloned as Readonly<Record<string, BlockTreeValue>>;
};

const toBlockTree = (blocks: readonly BlockNoteBlockValue[]): readonly BlockTreeNode[] =>
  blocks.map((block) => {
    if (!block.id) {
      throw new BlockDocumentCodecError("Materialized Block is missing its identity");
    }
    const content = cloneBlockTreeValue(block.content);
    return {
      id: block.id,
      type: block.type,
      props: cloneProps(block.props),
      ...(content === OMIT_VALUE ? {} : { content }),
      children: toBlockTree(block.children ?? []),
    };
  });

/** A local history record never serializes an unchanged descendant subtree. */
export const materializeBlockFields = (container: Y.XmlElement): BlockTreeNode =>
  toBlockTree([yXmlElementToBlockFields(headlessEditor, container)])[0]!;

const flattenBlockTree = (
  blocks: readonly BlockTreeNode[],
  parentBlockId: BlockId | null = null,
): readonly {
  readonly block: BlockTreeNode;
  readonly parentBlockId: BlockId | null;
}[] =>
  blocks.flatMap((block) => [
    { block, parentBlockId },
    ...flattenBlockTree(block.children, block.id),
  ]);

const blockTreeValuesEqual = (
  left: BlockTreeValue | undefined,
  right: BlockTreeValue | undefined,
): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => blockTreeValuesEqual(entry, right[index]))
    );
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightRecord = right as Readonly<Record<string, BlockTreeValue>>;
  return leftEntries.every(
    ([key, value]) =>
      Object.hasOwn(rightRecord, key) && blockTreeValuesEqual(value, rightRecord[key]),
  );
};

const requestedBlockSemanticsArePreserved = (
  requested: BlockTreeNode,
  actual: BlockTreeNode,
): boolean =>
  blockTreeValuesEqual(requested.props, actual.props) &&
  (!Object.hasOwn(requested, "content") || blockTreeValuesEqual(requested.content, actual.content));

const assertMaterializationMatchesScan = (
  blockTree: readonly BlockTreeNode[],
  scannedBlocks: readonly ScannedDocumentBlock[],
): void => {
  const materializedBlocks = flattenBlockTree(blockTree);
  if (materializedBlocks.length !== scannedBlocks.length) {
    throw new BlockDocumentCodecError(
      "BlockNote materialization does not match the persisted Block registry",
    );
  }
  materializedBlocks.forEach(({ block, parentBlockId }, index) => {
    const scanned = scannedBlocks[index];
    if (
      !scanned ||
      scanned.id !== block.id ||
      scanned.blockType !== block.type ||
      scanned.parentBlockId !== parentBlockId
    ) {
      throw new BlockDocumentCodecError(`BlockNote materialization diverges at Block ${block.id}`);
    }
  });
};

const assertCanonicalBlockChildren = (body: Y.XmlFragment): void => {
  const violation = collectBlockChildrenViolations(body)[0];
  if (!violation) return;
  throw new BlockDocumentCodecError(
    `${violation.blockType} Block ${violation.blockId ?? "unknown"} must not contain generic child Blocks`,
  );
};

const buildPreview = (plainText: string): string => {
  if (plainText.length <= 240) return plainText;
  return `${plainText.slice(0, 240).trimEnd()}...`;
};

export const semanticEmptyDocumentRoot = (
  blockTree: readonly BlockTreeNode[],
): BlockTreeNode | undefined => {
  if (blockTree.length !== 1) return undefined;
  const root = blockTree[0];
  if (!root || root.type !== "paragraph" || root.children.length > 0) {
    return undefined;
  }
  return Array.isArray(root.content) && root.content.length === 0 ? root : undefined;
};

export interface MaterializeBlockDocumentBodyInput {
  readonly body: Y.XmlFragment;
  readonly schemaVersion: number;
  readonly title?: string;
  readonly schemaLabel: string;
}

/** DOM-neutral materializer shared by registered BlockNote Document schemas. */
export const materializeBlockDocumentBody = ({
  body,
  schemaVersion,
  title = "",
  schemaLabel,
}: MaterializeBlockDocumentBodyInput): BlockDocumentMaterialization => {
  const scannedBlocks = assertValidBlockDocument(body);
  assertCanonicalBlockChildren(body);
  let blockNoteBlocks: readonly BlockNoteBlockValue[] = [];
  if (scannedBlocks.length > 0) {
    try {
      blockNoteBlocks = yXmlFragmentToBlocks(
        headlessEditor,
        body,
      ) as readonly BlockNoteBlockValue[];
    } catch (error) {
      throw new BlockDocumentCodecError(
        `${schemaLabel} body cannot be decoded with the canonical BlockNote schema`,
        { cause: error },
      );
    }
  }

  const blockTree = toBlockTree(blockNoteBlocks);
  assertMaterializationMatchesScan(blockTree, scannedBlocks);
  const nfmBlocks = blockNoteToNfm(blockNoteBlocks);
  const nfm = semanticEmptyDocumentRoot(blockTree) ? "" : serializeNfm(nfmBlocks);
  const { references, assetRefs } = deriveBlockDocumentRecords(blockTree, nfmBlocks);
  const plainText = extractPlainText(nfm);

  return {
    schemaVersion,
    title,
    blockTree,
    nfm,
    plainText,
    preview: buildPreview(plainText),
    references,
    assetRefs,
  };
};

export const materializePageDocument = (document: Y.Doc): PageDocumentMaterialization => {
  const envelope = assertValidPageDocumentRoots(document);
  const richTitle = readPortableRichTextFromYText(envelope.title);
  return {
    ...materializeBlockDocumentBody({
      body: envelope.body,
      schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
      title: portableRichTextPlainText(richTitle),
      schemaLabel: "Page",
    }),
    richTitle,
  };
};

export const createPageDocumentGenesis = ({
  documentId,
  title = "",
  richTitle,
  nfm,
  allocateBlockId = createUuidV7,
}: CreatePageDocumentGenesisInput): PageDocumentGenesis => {
  if (richTitle !== undefined && title.length > 0) {
    throw new BlockDocumentCodecError("Page genesis accepts richTitle or plain title, not both");
  }
  const envelope = createPageDocument({
    documentId,
    initialTitle: title,
    initializeBody: false,
  });
  try {
    if (richTitle !== undefined) {
      replaceYTextWithPortableRichText(envelope.title, canonicalizePortableRichText(richTitle));
    }
    populateBlockDocumentBodyFromNfm(envelope.body, nfm, allocateBlockId);
    const materialization = materializePageDocument(envelope.document);
    return {
      document: envelope.document,
      update: Y.encodeStateAsUpdate(envelope.document),
      stateVector: Y.encodeStateVector(envelope.document),
      materialization,
    };
  } catch (error) {
    envelope.document.destroy();
    if (error instanceof BlockDocumentCodecError) throw error;
    throw new BlockDocumentCodecError(`Could not import NFM genesis for Document ${documentId}`, {
      cause: error,
    });
  }
};

/**
 * Build a disposable, validated Page Document from an internal stable-ID
 * BlockTree. This is a codec primitive for headless writers: it does not run
 * BlockNote editor commands and it never mutates an authoritative Y.Doc.
 */
export const createDetachedPageDocumentFromBlockTree = ({
  documentId,
  title = "",
  richTitle,
  blockTree,
}: CreateDetachedPageDocumentFromBlockTreeInput): DetachedPageDocumentFromBlockTree => {
  if (richTitle !== undefined && title.length > 0) {
    throw new BlockDocumentCodecError("Detached Page accepts richTitle or plain title, not both");
  }
  const envelope = createPageDocument({
    documentId,
    initialTitle: title,
    initializeBody: false,
  });
  try {
    if (richTitle !== undefined) {
      replaceYTextWithPortableRichText(envelope.title, canonicalizePortableRichText(richTitle));
    }
    populateBlockDocumentBodyFromBlockTree(envelope.body, blockTree);
    const materialization = materializePageDocument(envelope.document);
    const requested = flattenBlockTree(blockTree);
    const actual = flattenBlockTree(materialization.blockTree);
    const identityMatches =
      requested.length === actual.length &&
      requested.every(({ block, parentBlockId }, index) => {
        const candidate = actual[index];
        return (
          candidate?.block.id === block.id &&
          candidate.block.type === block.type &&
          candidate.parentBlockId === parentBlockId &&
          requestedBlockSemanticsArePreserved(block, candidate.block)
        );
      });
    if (!identityMatches) {
      throw new BlockDocumentCodecError(
        "Stable-ID BlockTree encoding changed identity, type, or hierarchy",
      );
    }
    return { document: envelope.document, materialization };
  } catch (error) {
    envelope.document.destroy();
    if (error instanceof BlockDocumentCodecError) throw error;
    throw new BlockDocumentCodecError(
      `Could not encode stable-ID BlockTree for Document ${documentId}`,
      { cause: error },
    );
  }
};

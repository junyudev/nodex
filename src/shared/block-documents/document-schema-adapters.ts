import * as Y from "yjs";
import {
  materializeBlockDocumentBody,
  type BlockDocumentAssetReference,
  type BlockDocumentReference,
  type BlockTreeNode,
  type PageDocumentMaterialization,
} from "./block-document-codec";
import { assertValidBlockDocument, type ScannedDocumentBlock } from "./block-structure";
import {
  assertValidPageDocumentRoots,
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
  createPageDocument,
  type PageDocumentEnvelope,
} from "./page-document";
import {
  MAX_PAGE_DOCUMENT_BLOCKS,
  MAX_PAGE_DOCUMENT_BODY_XML_LENGTH,
  MAX_PAGE_DOCUMENT_STATE_BYTES,
  MAX_PAGE_DOCUMENT_UPDATE_BYTES,
  MAX_PAGE_DOCUMENT_XML_PATH_DEPTH,
  type DocumentId,
} from "./contracts";
import {
  assertValidSyncedBlockDocumentRoots,
  createSyncedBlockDocument,
  SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY,
  SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
  SYNCED_BLOCK_SOURCE_TYPE,
  type SyncedBlockDocumentEnvelope,
} from "./synced-block-document";
import {
  REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_KEY,
  REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_VERSION,
  REUSABLE_TEMPLATE_SOURCE_TYPE,
} from "./additional-document-bearing-blocks";
import {
  assertValidBodyOnlyBlockDocumentRoots,
  createBodyOnlyBlockDocument,
  type BodyOnlyBlockDocumentEnvelope,
} from "./body-only-block-document";
import {
  CANVAS_BLOCK_TYPE,
  CANVAS_DOCUMENT_SCHEMA_KEY,
  CANVAS_DOCUMENT_SCHEMA_VERSION,
} from "./canvas-document-identity";
import type { PortableCanvasScene } from "./canvas-scene";
import {
  portableRichTextPlainText,
  readPortableRichTextFromYText,
  type PortableRichText,
} from "./portable-rich-text";

export interface CommonOwnedDocumentMaterialization {
  readonly schemaVersion: number;
  readonly blockTree: readonly BlockTreeNode[];
  readonly markdown: string;
  readonly plainText: string;
  readonly preview: string;
  readonly references: readonly BlockDocumentReference[];
  readonly assetRefs: readonly BlockDocumentAssetReference[];
}

export interface PageOwnedDocumentMaterialization extends CommonOwnedDocumentMaterialization {
  readonly kind: "page";
  readonly title: string;
  readonly richTitle: PortableRichText;
}

export interface SyncedBlockOwnedDocumentMaterialization extends CommonOwnedDocumentMaterialization {
  readonly kind: "synced_block";
}

export interface ReusableTemplateOwnedDocumentMaterialization extends CommonOwnedDocumentMaterialization {
  readonly kind: "reusable_template";
}

export type OwnedDocumentMaterialization =
  | PageOwnedDocumentMaterialization
  | SyncedBlockOwnedDocumentMaterialization
  | ReusableTemplateOwnedDocumentMaterialization;

export type RegisteredOwnedDocumentMaterialization =
  | OwnedDocumentMaterialization
  | PortableCanvasScene;

export type BlockTreeOwnedDocumentEnvelope =
  | ({ readonly kind: "page" } & PageDocumentEnvelope)
  | ({ readonly kind: "synced_block" } & SyncedBlockDocumentEnvelope)
  | ({ readonly kind: "reusable_template" } & BodyOnlyBlockDocumentEnvelope);

export type OwnedDocumentEnvelope = BlockTreeOwnedDocumentEnvelope;

export interface OwnedDocumentInspection {
  readonly envelope: BlockTreeOwnedDocumentEnvelope;
  readonly blocks: readonly ScannedDocumentBlock[];
  readonly materialization: OwnedDocumentMaterialization;
}

export type RegisteredOwnedDocumentInspection = OwnedDocumentInspection;

export interface BlockDocumentSchemaCapabilities {
  readonly title: boolean;
  readonly blockTree: true;
  readonly markdownGenesis: boolean;
  readonly markdownReplace: boolean;
}

export interface BlockDocumentSchemaLimits {
  readonly maxUpdateBytes: number;
  readonly maxStateBytes: number;
  readonly maxBodyXmlLength: number;
  readonly maxBlocks: number;
  readonly maxXmlPathDepth: number;
}

export interface BlockDocumentSchemaAdapter {
  readonly kind: BlockTreeOwnedDocumentEnvelope["kind"];
  readonly contentModel: "block_tree";
  readonly syncEngine: "yjs";
  readonly ownerType: string;
  readonly schemaKey: string;
  readonly schemaVersion: number;
  readonly capabilities: BlockDocumentSchemaCapabilities;
  readonly limits: BlockDocumentSchemaLimits;
  readonly create: (documentId: DocumentId) => BlockTreeOwnedDocumentEnvelope;
  readonly inspect: (document: Y.Doc) => OwnedDocumentInspection;
}

export type RegisteredBlockDocumentSchemaAdapter = BlockDocumentSchemaAdapter;

export interface OwnedDocumentSchemaRegistration {
  readonly kind: BlockTreeOwnedDocumentEnvelope["kind"] | "scene_graph";
  readonly contentModel: "block_tree" | "scene_graph";
  readonly syncEngine: "yjs" | "canvas_scene";
  readonly ownerType: string;
  readonly schemaKey: string;
  readonly schemaVersion: number;
}

export class BlockDocumentSchemaError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlockDocumentSchemaError";
  }
}

const DEFAULT_BLOCKNOTE_LIMITS: BlockDocumentSchemaLimits = {
  maxUpdateBytes: MAX_PAGE_DOCUMENT_UPDATE_BYTES,
  maxStateBytes: MAX_PAGE_DOCUMENT_STATE_BYTES,
  maxBodyXmlLength: MAX_PAGE_DOCUMENT_BODY_XML_LENGTH,
  maxBlocks: MAX_PAGE_DOCUMENT_BLOCKS,
  maxXmlPathDepth: MAX_PAGE_DOCUMENT_XML_PATH_DEPTH,
};

const inspectBlockNoteBody = (
  envelope: BlockTreeOwnedDocumentEnvelope,
  schemaVersion: number,
  schemaLabel: string,
  title?: string,
  richTitle?: PortableRichText,
): OwnedDocumentInspection => {
  const blocks = assertValidBlockDocument(envelope.body);
  const projected = materializeBlockDocumentBody({
    body: envelope.body,
    schemaVersion,
    title,
    schemaLabel,
  });
  if (envelope.kind === "page") {
    return {
      envelope,
      blocks,
      materialization: {
        kind: "page",
        ...projected,
        title: projected.title,
        richTitle: richTitle ?? [],
      },
    };
  }
  const { title: projectionOnlyTitle, ...materialization } = projected;
  void projectionOnlyTitle;
  return {
    envelope,
    blocks,
    materialization: { kind: envelope.kind, ...materialization },
  };
};

const assertTemplateBodyCanInstantiate = (blockTree: readonly BlockTreeNode[]): void => {
  const pending = [...blockTree];
  while (pending.length > 0) {
    const block = pending.pop();
    if (!block) continue;
    pending.push(...block.children);
    if (
      block.type !== "page" &&
      block.type !== REUSABLE_TEMPLATE_SOURCE_TYPE &&
      block.type !== SYNCED_BLOCK_SOURCE_TYPE
    ) {
      continue;
    }
    throw new BlockDocumentSchemaError(
      `Reusable Template content cannot own nested document-bearing Block ${block.id} (${block.type})`,
    );
  }
};

const pageDocumentAdapter: BlockDocumentSchemaAdapter = {
  kind: "page",
  contentModel: "block_tree",
  syncEngine: "yjs",
  ownerType: "page",
  schemaKey: PAGE_DOCUMENT_SCHEMA_KEY,
  schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
  capabilities: {
    title: true,
    blockTree: true,
    markdownGenesis: true,
    markdownReplace: true,
  },
  limits: DEFAULT_BLOCKNOTE_LIMITS,
  create: (documentId) => ({
    kind: "page",
    ...createPageDocument({ documentId }),
  }),
  inspect: (document) => {
    const envelope = assertValidPageDocumentRoots(document);
    const richTitle = readPortableRichTextFromYText(envelope.title);
    return inspectBlockNoteBody(
      { kind: "page", ...envelope },
      PAGE_DOCUMENT_SCHEMA_VERSION,
      "Page",
      portableRichTextPlainText(richTitle),
      richTitle,
    );
  },
};

const syncedBlockDocumentAdapter: BlockDocumentSchemaAdapter = {
  kind: "synced_block",
  contentModel: "block_tree",
  syncEngine: "yjs",
  ownerType: SYNCED_BLOCK_SOURCE_TYPE,
  schemaKey: SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY,
  schemaVersion: SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
  capabilities: {
    title: false,
    blockTree: true,
    markdownGenesis: true,
    markdownReplace: false,
  },
  limits: DEFAULT_BLOCKNOTE_LIMITS,
  create: (documentId) => ({
    kind: "synced_block",
    ...createSyncedBlockDocument({ documentId }),
  }),
  inspect: (document) =>
    inspectBlockNoteBody(
      {
        kind: "synced_block",
        ...assertValidSyncedBlockDocumentRoots(document),
      },
      SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
      "Synced Block",
    ),
};

const reusableTemplateDocumentAdapter: BlockDocumentSchemaAdapter = {
  kind: "reusable_template",
  contentModel: "block_tree",
  syncEngine: "yjs",
  ownerType: REUSABLE_TEMPLATE_SOURCE_TYPE,
  schemaKey: REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_KEY,
  schemaVersion: REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_VERSION,
  capabilities: {
    title: false,
    blockTree: true,
    markdownGenesis: true,
    markdownReplace: false,
  },
  limits: DEFAULT_BLOCKNOTE_LIMITS,
  create: (documentId) => ({
    kind: "reusable_template",
    ...createBodyOnlyBlockDocument({ documentId, label: "Reusable Template" }),
  }),
  inspect: (document) => {
    const inspection = inspectBlockNoteBody(
      {
        kind: "reusable_template",
        ...assertValidBodyOnlyBlockDocumentRoots(document, {
          label: "Reusable Template",
        }),
      },
      REUSABLE_TEMPLATE_DOCUMENT_SCHEMA_VERSION,
      "Reusable Template",
    );
    assertTemplateBodyCanInstantiate(inspection.materialization.blockTree);
    return inspection;
  },
};

const canvasDocumentRegistration: OwnedDocumentSchemaRegistration = {
  kind: "scene_graph",
  contentModel: "scene_graph",
  syncEngine: "canvas_scene",
  ownerType: CANVAS_BLOCK_TYPE,
  schemaKey: CANVAS_DOCUMENT_SCHEMA_KEY,
  schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
};

const schemaAdapters: readonly BlockDocumentSchemaAdapter[] = [
  pageDocumentAdapter,
  syncedBlockDocumentAdapter,
  reusableTemplateDocumentAdapter,
] as const;

const schemaRegistrations: readonly OwnedDocumentSchemaRegistration[] = [
  ...schemaAdapters.map(
    ({ kind, contentModel, syncEngine, ownerType, schemaKey, schemaVersion }) => ({
      kind,
      contentModel,
      syncEngine,
      ownerType,
      schemaKey,
      schemaVersion,
    }),
  ),
  canvasDocumentRegistration,
] as const;

export const getRegisteredBlockDocumentSchemaAdapter = (input: {
  readonly ownerType: string;
  readonly schemaKey: string;
  readonly schemaVersion: number;
}): BlockDocumentSchemaAdapter => {
  const adapter = schemaAdapters.find(
    (candidate) =>
      candidate.ownerType === input.ownerType &&
      candidate.schemaKey === input.schemaKey &&
      candidate.schemaVersion === input.schemaVersion,
  );
  if (adapter) return adapter;
  throw new BlockDocumentSchemaError(
    `No owned Document Adapter is registered for ${input.ownerType}/${input.schemaKey}@${input.schemaVersion}`,
  );
};

export const getOwnedDocumentSchemaRegistration = (input: {
  readonly ownerType: string;
  readonly schemaKey: string;
  readonly schemaVersion: number;
}): OwnedDocumentSchemaRegistration => {
  const registration = schemaRegistrations.find(
    (candidate) =>
      candidate.ownerType === input.ownerType &&
      candidate.schemaKey === input.schemaKey &&
      candidate.schemaVersion === input.schemaVersion,
  );
  if (registration) return registration;
  throw new BlockDocumentSchemaError(
    `No owned Document schema is registered for ${input.ownerType}/${input.schemaKey}@${input.schemaVersion}`,
  );
};

export const getOwnedDocumentSchemaRegistrationForSchema = (input: {
  readonly schemaKey: string;
  readonly schemaVersion: number;
}): OwnedDocumentSchemaRegistration => {
  const matches = schemaRegistrations.filter(
    (candidate) =>
      candidate.schemaKey === input.schemaKey && candidate.schemaVersion === input.schemaVersion,
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  throw new BlockDocumentSchemaError(
    `Owned Document schema ${input.schemaKey}@${input.schemaVersion} is ${matches.length === 0 ? "not registered" : "ambiguous without an owner type"}`,
  );
};

/** Yjs content code must never receive a scene-native Canvas registration. */
export const getYjsDocumentSchemaAdapter = (input: {
  readonly ownerType: string;
  readonly schemaKey: string;
  readonly schemaVersion: number;
}): BlockDocumentSchemaAdapter => {
  return getRegisteredBlockDocumentSchemaAdapter(input);
};

/** BlockNote/Nodex Markdown pipelines must opt into the block-tree content model. */
export const getBlockDocumentSchemaAdapter = (input: {
  readonly ownerType: string;
  readonly schemaKey: string;
  readonly schemaVersion: number;
}): BlockDocumentSchemaAdapter => {
  const adapter = getYjsDocumentSchemaAdapter(input);
  if (adapter.contentModel === "block_tree") return adapter;
  throw new BlockDocumentSchemaError(
    `Owned Document ${input.ownerType}/${input.schemaKey}@${input.schemaVersion} does not use the block-tree content model`,
  );
};

export const getBlockDocumentSchemaAdapterForSchema = (input: {
  readonly schemaKey: string;
  readonly schemaVersion: number;
}): BlockDocumentSchemaAdapter => {
  const matches = schemaAdapters.filter(
    (candidate) =>
      candidate.schemaKey === input.schemaKey && candidate.schemaVersion === input.schemaVersion,
  );
  if (matches.length === 1 && matches[0]) {
    if (matches[0].contentModel === "block_tree") return matches[0];
    throw new BlockDocumentSchemaError(
      `Owned Document schema ${input.schemaKey}@${input.schemaVersion} uses ${matches[0].contentModel}, not the block-tree pipeline`,
    );
  }
  throw new BlockDocumentSchemaError(
    `Owned Document schema ${input.schemaKey}@${input.schemaVersion} is ${matches.length === 0 ? "not registered" : "ambiguous without an owner type"}`,
  );
};

export const getRegisteredBlockDocumentSchemaAdapterForSchema = (input: {
  readonly schemaKey: string;
  readonly schemaVersion: number;
}): RegisteredBlockDocumentSchemaAdapter => {
  const matches = schemaAdapters.filter(
    (candidate) =>
      candidate.schemaKey === input.schemaKey && candidate.schemaVersion === input.schemaVersion,
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  throw new BlockDocumentSchemaError(
    `Owned Document schema ${input.schemaKey}@${input.schemaVersion} is ${matches.length === 0 ? "not registered" : "ambiguous without an owner type"}`,
  );
};

export const inspectOwnedBlockDocument = (
  document: Y.Doc,
  input: {
    readonly ownerType: string;
    readonly schemaKey: string;
    readonly schemaVersion: number;
  },
): OwnedDocumentInspection => getBlockDocumentSchemaAdapter(input).inspect(document);

export const inspectRegisteredOwnedBlockDocument = (
  document: Y.Doc,
  input: {
    readonly ownerType: string;
    readonly schemaKey: string;
    readonly schemaVersion: number;
  },
): OwnedDocumentInspection => getRegisteredBlockDocumentSchemaAdapter(input).inspect(document);

/** Relational persistence keeps a non-null title column for Card compatibility. */
export const toPersistedBlockDocumentMaterialization = (
  materialization: OwnedDocumentMaterialization,
): PageDocumentMaterialization => ({
  schemaVersion: materialization.schemaVersion,
  title: materialization.kind === "page" ? materialization.title : "",
  richTitle: materialization.kind === "page" ? materialization.richTitle : [],
  blockTree: materialization.blockTree,
  markdown: materialization.markdown,
  plainText: materialization.plainText,
  preview: materialization.preview,
  references: materialization.references,
  assetRefs: materialization.assetRefs,
});

export const listBlockDocumentSchemaAdapters = (): readonly BlockDocumentSchemaAdapter[] =>
  schemaAdapters;

import * as Y from "yjs";
import type { RecoveryDraftCapture } from "../../../src/shared/block-documents/document-recovery";
import {
  openPageDocument,
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
  type PageDocumentEnvelope,
} from "../../../src/shared/block-documents/page-document";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import type { ScenarioRecoveryDraftSeed } from "../contracts";

/**
 * Builds the package a window that lost its connection would send: the canonical Page plus edits
 * Core never received. Core alone then decides what that package can do.
 */
export const buildRecoveryDraftCapture = (
  input: ScenarioRecoveryDraftSeed,
  canonical: {
    readonly update: Uint8Array;
    readonly storeEpoch: string;
    readonly generation: number;
    readonly headSeq: number;
  },
): RecoveryDraftCapture => {
  const retained = new Y.Doc({ guid: input.documentId });
  try {
    Y.applyUpdate(retained, canonical.update);
    input.edit(openPageDocument(retained));
    const state = Array.from(Y.encodeStateAsUpdate(retained));
    return {
      draft_id: input.draftId,
      document_id: input.documentId,
      source_store_epoch: canonical.storeEpoch,
      generation: canonical.generation,
      base_head_seq: canonical.headSeq,
      created_at: input.createdAt,
      schema_key: PAGE_DOCUMENT_SCHEMA_KEY,
      schema_version: PAGE_DOCUMENT_SCHEMA_VERSION,
      content: { kind: "yjs", state, unintegrated_updates: [] },
      source: { state, originalSubmission: { update: state, updateId: `${input.draftId}:update` } },
    };
  } finally {
    retained.destroy();
  }
};

const rootGroup = (body: Y.XmlFragment): Y.XmlElement => body.get(0) as Y.XmlElement;

/** The text of a top-level Block whose only content is one run of text. */
const blockText = (container: Y.XmlElement): Y.XmlText | null => {
  const text = (container.get(0) as Y.XmlElement | undefined)?.get(0);
  return text instanceof Y.XmlText ? text : null;
};

const findBlock = (body: Y.XmlFragment, prefix: string): number => {
  const index = rootGroup(body)
    .toArray()
    .findIndex((block) =>
      blockText(block as Y.XmlElement)
        ?.toString()
        .startsWith(prefix),
    );
  if (index < 0) throw new Error(`No Block starts with ${prefix}`);
  return index;
};

const blockContainer = (child: Y.XmlElement): Y.XmlElement => {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", createUuidV7());
  container.insert(0, [child]);
  return container;
};

export const insertParagraphAfter = (
  { body }: PageDocumentEnvelope,
  prefix: string,
  text: string,
): void => {
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  rootGroup(body).insert(findBlock(body, prefix) + 1, [blockContainer(paragraph)]);
};

export const removeBlock = ({ body }: PageDocumentEnvelope, prefix: string): void => {
  rootGroup(body).delete(findBlock(body, prefix), 1);
};

export const replaceInBlock = (
  { body }: PageDocumentEnvelope,
  prefix: string,
  find: string,
  replacement: string,
): void => {
  const text = blockText(rootGroup(body).get(findBlock(body, prefix)) as Y.XmlElement);
  const offset = text?.toString().indexOf(find) ?? -1;
  if (!text || offset < 0) throw new Error(`No Block text matches ${find}`);
  text.delete(offset, find.length);
  text.insert(offset, replacement);
};

/** A nested Page that was never captured leaves Core unable to apply the package. */
export const insertUncapturedPage = ({ body }: PageDocumentEnvelope, prefix: string): void => {
  rootGroup(body).insert(findBlock(body, prefix) + 1, [blockContainer(new Y.XmlElement("page"))]);
};

/** Typing and deleting leaves engine evidence behind without changing what anyone can read. */
export const typeAndDelete = ({ body }: PageDocumentEnvelope, prefix: string): void => {
  const text = blockText(rootGroup(body).get(findBlock(body, prefix)) as Y.XmlElement);
  if (!text) throw new Error(`No Block text starts with ${prefix}`);
  text.insert(0, "x");
  text.delete(0, 1);
};

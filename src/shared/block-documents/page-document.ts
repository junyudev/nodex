import * as Y from "yjs";
import { BLOCK_GROUP_NODE_NAME } from "./block-structure";
import type { DocumentId } from "./contracts";
import { PortableRichTextError, readPortableRichTextFromYText } from "./portable-rich-text";

export const PAGE_DOCUMENT_SCHEMA_KEY = "nodex.page";
export const PAGE_DOCUMENT_SCHEMA_VERSION = 4;
export const PAGE_DOCUMENT_TITLE_KEY = "title";
export const PAGE_DOCUMENT_BODY_KEY = "body";

export interface PageDocumentEnvelope {
  readonly documentId: DocumentId;
  readonly document: Y.Doc;
  readonly title: Y.Text;
  readonly body: Y.XmlFragment;
}

export interface CreatePageDocumentOptions {
  readonly documentId: DocumentId;
  readonly initialTitle?: string;
  /** Genesis codecs may let BlockNote create the canonical body root directly. */
  readonly initializeBody?: boolean;
  readonly gc?: boolean;
}

export class PageDocumentRootValidationError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PageDocumentRootValidationError";
  }
}

const resolveCanonicalRoot = <Root>(key: string, resolve: () => Root): Root => {
  try {
    return resolve();
  } catch (error) {
    throw new TypeError(`Page document root "${key}" has an incompatible Yjs type`, {
      cause: error,
    });
  }
};

export const openPageDocument = (document: Y.Doc): PageDocumentEnvelope => {
  // Updates loaded into a fresh Y.Doc initially expose named roots as Yjs'
  // generic AbstractType placeholders. The typed getters resolve those
  // placeholders and still throw when a root was genuinely created with an
  // incompatible constructor.
  const title = resolveCanonicalRoot(PAGE_DOCUMENT_TITLE_KEY, () =>
    document.getText(PAGE_DOCUMENT_TITLE_KEY),
  );
  const body = resolveCanonicalRoot(PAGE_DOCUMENT_BODY_KEY, () =>
    document.getXmlFragment(PAGE_DOCUMENT_BODY_KEY),
  );

  return {
    documentId: document.guid,
    document,
    title,
    body,
  };
};

export const assertValidPageDocumentRoots = (document: Y.Doc): PageDocumentEnvelope => {
  const envelope = openPageDocument(document);
  const unexpectedRoots = [...document.share.keys()].filter(
    (key) => key !== PAGE_DOCUMENT_TITLE_KEY && key !== PAGE_DOCUMENT_BODY_KEY,
  );
  if (unexpectedRoots.length > 0) {
    throw new PageDocumentRootValidationError(
      `Page document contains unsupported named roots: ${unexpectedRoots.join(", ")}`,
    );
  }
  try {
    readPortableRichTextFromYText(envelope.title);
  } catch (error) {
    if (!(error instanceof PortableRichTextError)) throw error;
    throw new PageDocumentRootValidationError(
      `Page document title is not canonical rich text: ${error.message}`,
      { cause: error },
    );
  }
  if (Object.keys(envelope.title.getAttributes()).length > 0) {
    throw new PageDocumentRootValidationError("Page document title contains hidden map attributes");
  }
  return envelope;
};

export const createPageDocument = ({
  documentId,
  initialTitle = "",
  initializeBody = true,
  gc = true,
}: CreatePageDocumentOptions): PageDocumentEnvelope => {
  if (documentId.trim().length === 0) {
    throw new TypeError("Page documentId must not be empty");
  }

  const envelope = openPageDocument(new Y.Doc({ guid: documentId, gc }));
  envelope.document.transact(() => {
    if (initialTitle.length > 0) {
      envelope.title.insert(0, initialTitle);
    }
    if (initializeBody) {
      envelope.body.insert(0, [new Y.XmlElement(BLOCK_GROUP_NODE_NAME)]);
    }
  });
  return envelope;
};

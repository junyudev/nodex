import {
  canonicalizePortableRichText,
  portableRichTextPlainText,
  type PortableRichText,
} from "./block-documents/portable-rich-text";

export type PageLifecycle = "active" | "archived" | "deleted";

export type PageParent =
  | { readonly kind: "library"; readonly libraryId: string }
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "data_source"; readonly dataSourceId: string };

/**
 * Canonical Page read model. A Page owns its Document and has exactly one
 * ownership parent; Data Source values and View coordinates are intentionally
 * absent because they belong to Database Module rows.
 */
export interface Page {
  readonly pageId: string;
  readonly libraryId: string;
  readonly parent: PageParent;
  readonly lifecycle: PageLifecycle;
  readonly parentRevision: number;
  readonly metadataRevision: number;
  readonly documentId: string;
  readonly documentGeneration: number;
  readonly documentHeadSeq: number;
  readonly title: string;
  readonly richTitle: PortableRichText;
  readonly preview: string;
  readonly plainText: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class PageContractError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PageContractError";
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (isRecord(value)) return value;
  throw new PageContractError(`${label} must be an object`);
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  label: string,
  keys: readonly string[],
): void => {
  const expected = new Set(keys);
  for (const key of keys) {
    if (Object.hasOwn(value, key)) continue;
    throw new PageContractError(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (expected.has(key)) continue;
    throw new PageContractError(`${label}.${key} is not supported`);
  }
};

const text = (value: unknown, label: string, allowEmpty = false): string => {
  if (
    typeof value === "string" &&
    value.length <= 1_000_000 &&
    (allowEmpty || value.length > 0) &&
    (allowEmpty || value === value.trim())
  ) {
    return value;
  }
  throw new PageContractError(`${label} must be a bounded string`);
};

const identity = (value: unknown, label: string): string => {
  const parsed = text(value, label);
  if (parsed.length <= 512) return parsed;
  throw new PageContractError(`${label} exceeds the identity length limit`);
};

const revision = (value: unknown, label: string): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new PageContractError(`${label} must be a non-negative safe integer`);
};

const parseParent = (value: unknown): PageParent => {
  const parent = record(value, "page.parent");
  if (parent.kind === "library") {
    exactKeys(parent, "page.parent", ["kind", "libraryId"]);
    return {
      kind: "library",
      libraryId: identity(parent.libraryId, "page.parent.libraryId"),
    };
  }
  if (parent.kind === "page") {
    exactKeys(parent, "page.parent", ["kind", "pageId"]);
    return { kind: "page", pageId: identity(parent.pageId, "page.parent.pageId") };
  }
  if (parent.kind === "data_source") {
    exactKeys(parent, "page.parent", ["kind", "dataSourceId"]);
    return {
      kind: "data_source",
      dataSourceId: identity(parent.dataSourceId, "page.parent.dataSourceId"),
    };
  }
  throw new PageContractError("page.parent.kind is unsupported");
};

export const parsePage = (value: unknown): Page => {
  const page = record(value, "page");
  exactKeys(page, "page", [
    "pageId",
    "libraryId",
    "parent",
    "lifecycle",
    "parentRevision",
    "metadataRevision",
    "documentId",
    "documentGeneration",
    "documentHeadSeq",
    "title",
    "richTitle",
    "preview",
    "plainText",
    "createdAt",
    "updatedAt",
  ]);
  if (
    page.lifecycle !== "active" &&
    page.lifecycle !== "archived" &&
    page.lifecycle !== "deleted"
  ) {
    throw new PageContractError("page.lifecycle is unsupported");
  }
  let richTitle: PortableRichText;
  try {
    richTitle = canonicalizePortableRichText(page.richTitle);
  } catch (error) {
    throw new PageContractError("page.richTitle is invalid", { cause: error });
  }
  const title = text(page.title, "page.title", true);
  if (portableRichTextPlainText(richTitle) !== title) {
    throw new PageContractError("page rich and plain titles diverge");
  }
  return {
    pageId: identity(page.pageId, "page.pageId"),
    libraryId: identity(page.libraryId, "page.libraryId"),
    parent: parseParent(page.parent),
    lifecycle: page.lifecycle,
    parentRevision: revision(page.parentRevision, "page.parentRevision"),
    metadataRevision: revision(page.metadataRevision, "page.metadataRevision"),
    documentId: identity(page.documentId, "page.documentId"),
    documentGeneration: revision(page.documentGeneration, "page.documentGeneration"),
    documentHeadSeq: revision(page.documentHeadSeq, "page.documentHeadSeq"),
    title,
    richTitle,
    preview: text(page.preview, "page.preview", true),
    plainText: text(page.plainText, "page.plainText", true),
    createdAt: text(page.createdAt, "page.createdAt"),
    updatedAt: text(page.updatedAt, "page.updatedAt"),
  };
};

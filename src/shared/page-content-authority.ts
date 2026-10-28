import type { PageInput } from "./types";

export const PAGE_DOCUMENT_PATCH_FIELDS = ["title", "description"] as const;

export type PageDocumentPatchField = (typeof PAGE_DOCUMENT_PATCH_FIELDS)[number];

export type PageMetadataPatch = Partial<Omit<PageInput, PageDocumentPatchField>>;

export const PAGE_DOCUMENT_MUTATION_REQUIRED_MESSAGE =
  "Page title and description belong to the Page Document. Use a Y.Doc Document mutation; whole-body Nodex Markdown replacement is an explicit generation/head-CAS import only.";

export const findPageDocumentPatchFields = (patch: object): readonly PageDocumentPatchField[] =>
  PAGE_DOCUMENT_PATCH_FIELDS.filter((field) => Object.hasOwn(patch, field));

export const assertPageUpdateExcludesDocumentContent = (patch: object): void => {
  const documentFields = findPageDocumentPatchFields(patch);
  if (documentFields.length === 0) return;
  throw new TypeError(
    `${PAGE_DOCUMENT_MUTATION_REQUIRED_MESSAGE} Rejected fields: ${documentFields.join(", ")}.`,
  );
};

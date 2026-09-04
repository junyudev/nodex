import type { components } from "@nodex/core-protocol";

type Schemas = components["schemas"];
export type LibraryFile = Schemas["LibraryFile"];
export type LibraryFilePage = Schemas["LibraryFilePage"];
export type LibraryFilePresentation = Schemas["LibraryFilePresentation"];
export type LibraryFileReadBinding = Schemas["LibraryFileReadBinding"];
export type LibraryFileReadSource = Schemas["LibraryFileReadSource"];
export type LibraryFileChange = Schemas["LibraryFileChange"];
export type LibraryFileVersion = Schemas["LibraryFileVersion"];
export type LibraryFileVersionPage = Schemas["LibraryFileVersionPage"];
export type LibraryFileUsage = Schemas["LibraryFileUsage"];
export type LibraryFileUsagePage = Schemas["LibraryFileUsagePage"];
export type LibraryFileUsageFilter = Schemas["LibraryFileUsageFilter"];
export type LibraryFileMutationResult = Schemas["LibraryFileMutationResult"];
export type LibraryPageFileInventory = Schemas["LibraryPageFileInventory"];
export type LibraryPageFileItem = Schemas["LibraryPageFileItem"];
export type LibraryPageFileEntryChange = Schemas["LibraryPageFileEntryChange"];
export type LibraryPageFileEntryReceipt = Schemas["LibraryPageFileEntryReceipt"];
export type LibraryPageFileSelector = Schemas["LibraryPageFileSelector"];

export const LIBRARY_FILE_READ_KINDS = [
  "files",
  "file",
  "file_presentation",
  "file_usages",
  "file_versions",
  "page_file_inventory",
  "resolve_page_file",
] as const;
export type CoreLibraryFileRead = Extract<
  Schemas["LibraryReadRequest"]["read"],
  {
    readonly kind: (typeof LIBRARY_FILE_READ_KINDS)[number];
  }
>;

type ReadMode<T> = T extends { readonly kind: infer Kind }
  ? Omit<T, "kind"> & { readonly mode: Kind }
  : never;
/** File payloads retain the generated Core vocabulary; only the shared read envelope uses mode. */
export type LibraryFileRead = ReadMode<CoreLibraryFileRead>;
export type LibraryFileReadValue = Extract<
  Extract<Schemas["LibraryReadResponse"], { readonly status: "ok" }>["payload"]["value"],
  {
    readonly kind:
      | Exclude<(typeof LIBRARY_FILE_READ_KINDS)[number], "resolve_page_file">
      | "resolved_page_file";
  }
>;

export const LIBRARY_FILE_OPERATION_KINDS = [
  "apply_file_change",
  "put_page_file_entry",
  "apply_page_file_entries",
  "transfer_page_file_entry",
] as const;
export type LibraryFileOperation = Extract<
  Schemas["LibraryApplyRequest"]["intent"],
  {
    readonly kind: (typeof LIBRARY_FILE_OPERATION_KINDS)[number];
  }
>;

export const isLibraryFileReadMode = (value: unknown): value is LibraryFileRead["mode"] =>
  LIBRARY_FILE_READ_KINDS.some((kind) => kind === value);
export const isLibraryFileReadValueKind = (value: unknown): value is LibraryFileReadValue["kind"] =>
  value === "resolved_page_file" || (value !== "resolve_page_file" && isLibraryFileReadMode(value));
export const isLibraryFileOperationKind = (value: unknown): value is LibraryFileOperation["kind"] =>
  LIBRARY_FILE_OPERATION_KINDS.some((kind) => kind === value);

export interface ReadFileBytesInput {
  readonly fileId: string;
  readonly source: LibraryFileReadSource;
  readonly version?: number;
}

export interface SaveFileInput extends ReadFileBytesInput {
  readonly defaultName: string;
}

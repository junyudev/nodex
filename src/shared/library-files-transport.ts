import { z } from "zod";
import type {
  CoreLibraryFileRead,
  LibraryFile,
  LibraryFileChange,
  LibraryFileMutationResult,
  LibraryFileOperation,
  LibraryFilePresentation,
  LibraryFileRead,
  LibraryFileReadSource,
  LibraryFileReadValue,
  LibraryFileVersion,
  LibraryPageFileEntryChange,
  LibraryPageFileEntryReceipt,
  LibraryPageFileInventory,
  LibraryPageFileItem,
  LibraryPageFileSelector,
  ReadFileBytesInput,
  SaveFileInput,
} from "./library-files";

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const revision = z.number().int().safe().nonnegative();
const version = revision.min(1);
const name = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const cursor = z.string().max(2048).nullish();
const query = z.string().max(256).nullish();
const limit = version.max(200).nullish();
const collision = z.enum(["reject", "suffix"]);

export const fileReadSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct") }).strict(),
  z.object({ kind: z.literal("page"), page_id: identity }).strict(),
  z
    .object({ kind: z.literal("document_revision"), document_id: identity, revision_id: identity })
    .strict(),
  z
    .object({ kind: z.literal("recovery_draft"), document_id: identity, draft_id: identity })
    .strict(),
  z.object({ kind: z.literal("canvas"), canvas_id: identity, scene_file_id: identity }).strict(),
  z
    .object({
      kind: z.literal("canvas_revision"),
      document_id: identity,
      revision_id: identity,
      scene_file_id: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("canvas_recovery"),
      document_id: identity,
      draft_id: identity,
      scene_file_id: identity,
    })
    .strict(),
]) satisfies z.ZodType<LibraryFileReadSource>;

export const readFileBytesSchema = z
  .object({
    fileId: identity,
    source: fileReadSourceSchema,
    version: version.optional(),
  })
  .strict() satisfies z.ZodType<ReadFileBytesInput>;

export const saveFileSchema = readFileBytesSchema
  .extend({ defaultName: name })
  .strict() satisfies z.ZodType<SaveFileInput>;

const fileSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file_id"), file_id: identity }).strict(),
  z.object({ kind: z.literal("path"), logical_path: name }).strict(),
]) satisfies z.ZodType<LibraryPageFileSelector>;

export const libraryFileReadSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("files"),
      query,
      cursor,
      limit,
      lifecycle: z.enum(["live", "trashed"]),
      usage: z.enum(["all", "unused"]),
    })
    .strict(),
  z.object({ mode: z.literal("file"), file_id: identity }).strict(),
  z
    .object({
      mode: z.literal("file_presentation"),
      file_id: identity,
      source: fileReadSourceSchema,
      version: version.nullish(),
    })
    .strict(),
  z.object({ mode: z.literal("file_usages"), file_id: identity, cursor, limit }).strict(),
  z.object({ mode: z.literal("file_versions"), file_id: identity, cursor, limit }).strict(),
  z
    .object({ mode: z.literal("page_file_inventory"), page_id: identity, query, cursor, limit })
    .strict(),
  z
    .object({
      mode: z.literal("resolve_page_file"),
      page_id: identity,
      selector: fileSelectorSchema,
    })
    .strict(),
]) satisfies z.ZodType<LibraryFileRead>;

/** A mechanical envelope rename; all resource coordinates retain their generated shape. */
export const toCoreLibraryFileRead = (read: LibraryFileRead): CoreLibraryFileRead => {
  const { mode, ...coordinates } = read;
  return { kind: mode, ...coordinates } as CoreLibraryFileRead;
};

const fileChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create"),
      file_id: identity,
      default_name: name,
      mime_type: identity,
      prepared_blob_receipt_id: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace_content"),
      file_id: identity,
      expected_revision: version,
      expected_head_version: version,
      mime_type: identity,
      prepared_blob_receipt_id: identity,
    })
    .strict(),
  z
    .object({
      kind: z.literal("rename"),
      file_id: identity,
      expected_revision: version,
      default_name: name,
    })
    .strict(),
  z.object({ kind: z.literal("trash"), file_id: identity, expected_revision: version }).strict(),
  z.object({ kind: z.literal("restore"), file_id: identity, expected_revision: version }).strict(),
  z.object({ kind: z.literal("purge"), file_id: identity, expected_revision: version }).strict(),
  z
    .object({
      kind: z.literal("fork"),
      source_file_id: identity,
      source_version: version,
      source: fileReadSourceSchema,
      file_id: identity,
      default_name: name,
    })
    .strict(),
]) satisfies z.ZodType<LibraryFileChange>;

const entryChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("import"),
      file_id: identity,
      logical_path: name,
      mime_type: identity,
      prepared_blob_receipt_id: identity,
      collision_policy: collision,
    })
    .strict(),
  z
    .object({
      kind: z.literal("attach"),
      file_id: identity,
      logical_path: name,
      source: fileReadSourceSchema,
      collision_policy: collision,
    })
    .strict(),
  z.object({ kind: z.literal("rename"), file_id: identity, logical_path: name }).strict(),
  z.object({ kind: z.literal("remove"), file_id: identity }).strict(),
  z
    .object({
      kind: z.literal("retarget"),
      file_id: identity,
      replacement_file_id: identity,
      source: fileReadSourceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("replace"),
      file_id: identity,
      replacement_file_id: identity,
      mime_type: identity,
      prepared_blob_receipt_id: identity,
    })
    .strict(),
]) satisfies z.ZodType<LibraryPageFileEntryChange>;

export const libraryFileOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("put_page_file_entry"),
      page_id: identity,
      expected_manifest_revision: revision,
      file_id: identity,
      logical_path: name,
      mime_type: identity,
      prepared_blob_receipt_id: identity,
      replace_entry: z.boolean(),
      turn_id: identity.nullish(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("apply_file_change"),
      change: fileChangeSchema,
      turn_id: identity.nullish(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("apply_page_file_entries"),
      page_id: identity,
      expected_manifest_revision: revision,
      changes: z.array(entryChangeSchema).min(1).max(100),
      turn_id: identity.nullish(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("transfer_page_file_entry"),
      file_id: identity,
      source_page_id: identity,
      source_manifest_revision: revision,
      target_page_id: identity,
      target_manifest_revision: revision,
      target_logical_path: name,
      copy: z.boolean(),
    })
    .strict(),
]) satisfies z.ZodType<LibraryFileOperation>;

const presentationFields = {
  file_id: identity,
  version,
  default_name: name,
  mime_type: identity,
  byte_length: revision.max(64 * 1024 * 1024),
  blob_etag: hash,
};
export const filePresentationSchema = z
  .object(presentationFields)
  .strict() satisfies z.ZodType<LibraryFilePresentation>;
export const libraryFileSchema = z
  .object({
    file_id: identity,
    library_id: identity,
    default_name: name,
    head_version: version,
    revision: version,
    lifecycle: z.enum(["live", "trashed"]),
    mime_type: identity,
    byte_length: presentationFields.byte_length,
    blob_etag: hash,
    created_by_actor_id: identity,
    created_by_turn_id: identity.nullish(),
    created_at: identity,
    updated_at: identity,
  })
  .strict() satisfies z.ZodType<LibraryFile>;
const fileVersionSchema = z
  .object({
    file_id: identity,
    version,
    mime_type: identity,
    byte_length: presentationFields.byte_length,
    blob_etag: hash,
    actor_id: identity,
    turn_id: identity.nullish(),
    operation_id: identity,
    occurred_at: identity,
  })
  .strict() satisfies z.ZodType<LibraryFileVersion>;
const pageItemSchema = z
  .object({
    file: libraryFileSchema,
    logical_path: name.nullish(),
    body_count: revision,
  })
  .strict() satisfies z.ZodType<LibraryPageFileItem>;
const pageInventorySchema = z
  .object({
    page_id: identity,
    revision,
    body_usage_revision: revision,
    can_write: z.boolean(),
    files: z.array(pageItemSchema).max(200),
    next_cursor: cursor,
    has_more: z.boolean(),
    total: revision,
    unplaced_total: revision,
    placed_total: revision,
  })
  .strict() satisfies z.ZodType<LibraryPageFileInventory>;
const placedTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), page_id: identity }).strict(),
  z.object({ kind: z.literal("database"), database_id: identity }).strict(),
  z.object({ kind: z.literal("canvas"), canvas_id: identity }).strict(),
]);
export const libraryFileReadValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), value: libraryFileSchema }).strict(),
  z.object({ kind: z.literal("file_presentation"), value: filePresentationSchema }).strict(),
  z
    .object({
      kind: z.literal("files"),
      value: z
        .object({
          items: z.array(libraryFileSchema).max(200),
          next_cursor: cursor,
          has_more: z.boolean(),
          total: revision,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file_versions"),
      value: z
        .object({
          items: z.array(fileVersionSchema).max(200),
          next_cursor: cursor,
          has_more: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file_usages"),
      value: z
        .object({
          items: z
            .array(
              z
                .object({
                  target: placedTargetSchema,
                  title: z.string(),
                  lifecycle: z.enum(["active", "archived", "deleted"]),
                  logical_path: name.nullish(),
                  occurrence_count: revision,
                })
                .strict(),
            )
            .max(200),
          next_cursor: cursor,
          has_more: z.boolean(),
          can_write: z.boolean(),
          can_trash: z.boolean(),
          can_restore: z.boolean(),
          can_purge: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal("page_file_inventory"), value: pageInventorySchema }).strict(),
  z.object({ kind: z.literal("resolved_page_file"), value: pageItemSchema }).strict(),
]) satisfies z.ZodType<LibraryFileReadValue>;

export const fileMutationResultSchema = z
  .object({
    file_id: identity,
    revision: version,
    file: libraryFileSchema.nullish(),
  })
  .strict() satisfies z.ZodType<LibraryFileMutationResult>;
export const pageFileEntryReceiptSchema = z
  .object({
    page_id: identity,
    manifest_revision: revision,
    changed_file_ids: z.array(identity),
    created_file_ids: z.array(identity),
    replacements: z.record(z.string(), identity),
    consumed_blob_receipt_ids: z.array(identity),
  })
  .strict() satisfies z.ZodType<LibraryPageFileEntryReceipt>;

import { z } from "zod";
import {
  MAX_PORTABLE_RICH_TEXT_SEGMENTS,
  type PortableRichText,
} from "../block-documents/portable-rich-text";
import { MAX_PAGE_TITLE_LENGTH } from "../page-limits";
import { DATE_MENTION_DATE_FORMATS, DATE_MENTION_TIME_FORMATS } from "../rich-text/date-mention";
import { RICH_TEXT_ALL_COLORS } from "../rich-text/colors";
export {
  NODEX_APP_TOOLS,
  NODEX_APP_TOOL_NAMESPACE,
  NODEX_APP_TOOLSET_REVISION,
  type NodexAgentToolName,
} from "./identity";

const boundedIdentity = (description: string) =>
  z.string().trim().min(1).max(512).describe(description);

export const ProjectIdSchema = boundedIdentity(
  "Stable Nodex Project identity",
).brand<"ProjectId">();
export const LibraryIdSchema = boundedIdentity("Stable Nodex Library identity");
export const DataSourceIdSchema = boundedIdentity("Stable Nodex Data Source identity");
export const BlockIdSchema = boundedIdentity("Stable Nodex Block identity").brand<"BlockId">();
export const DocumentIdSchema = boundedIdentity(
  "Stable Nodex Document identity",
).brand<"DocumentId">();
export const ViewIdSchema = boundedIdentity(
  "Stable Nodex Database View identity",
).brand<"ViewId">();
export const PropertyIdSchema = boundedIdentity(
  "Stable Nodex Database Property identity",
).brand<"PropertyId">();
export const CursorSchema = z
  .string()
  .min(1)
  .max(16_384)
  .describe("Opaque cursor bound to the captured Project snapshot")
  .brand<"Cursor">();
export const ETagSchema = z
  .string()
  .regex(/^nxe2\.[A-Za-z0-9_-]{43}$/u)
  .describe("Opaque validator for one observed semantic state")
  .brand<"ETag">();

export const JsonValueSchema = z.json();

const PortableRichTextStylesSchema = z.strictObject({
  bold: z.literal(true).optional(),
  italic: z.literal(true).optional(),
  underline: z.literal(true).optional(),
  strikethrough: z.literal(true).optional(),
  code: z.literal(true).optional(),
  color: z.enum(RICH_TEXT_ALL_COLORS).optional(),
});

const PortableRichTextItemSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    text: z.string(),
    styles: PortableRichTextStylesSchema,
  }),
  z.strictObject({
    type: z.literal("link"),
    text: z.string(),
    href: z.string().trim().min(1).max(4_096),
    styles: PortableRichTextStylesSchema,
  }),
  z.strictObject({ type: z.literal("linebreak") }),
  z.strictObject({
    type: z.literal("threadMention"),
    uuid: z.string().trim().min(1).max(1_024),
  }),
  z.strictObject({
    type: z.literal("pageMention"),
    targetPageId: z.string().trim().min(1).max(1_024),
  }),
  z.strictObject({
    type: z.literal("dateMention"),
    start: z.string().trim().min(1).max(1_024),
    end: z.string().trim().min(1).max(1_024).optional(),
    tz: z.string().trim().min(1).max(1_024).optional(),
    format: z.enum(DATE_MENTION_DATE_FORMATS).optional(),
    timeFormat: z.enum(DATE_MENTION_TIME_FORMATS).optional(),
    reminder: z.string().trim().min(1).max(1_024).optional(),
  }),
]);

export const PortableRichTextSchema = z
  .array(PortableRichTextItemSchema)
  .max(MAX_PORTABLE_RICH_TEXT_SEGMENTS) satisfies z.ZodType<PortableRichText>;

export const TextInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("plain"),
    text: z.string().max(MAX_PAGE_TITLE_LENGTH),
  }),
  z.strictObject({
    kind: z.literal("rich"),
    richText: PortableRichTextSchema,
  }),
]);

export const SiblingAnchorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("start") }),
  z.strictObject({ kind: z.literal("end") }),
  z.strictObject({ kind: z.literal("before"), blockId: BlockIdSchema }),
  z.strictObject({ kind: z.literal("after"), blockId: BlockIdSchema }),
]);

export const DocumentAnchorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("start"),
    parentBlockId: BlockIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("end"),
    parentBlockId: BlockIdSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("before"), blockId: BlockIdSchema }),
  z.strictObject({ kind: z.literal("after"), blockId: BlockIdSchema }),
]);

export function createPageInputSchema(maximum: number) {
  return z.strictObject({
    limit: z.number().int().min(1).max(maximum).optional(),
    cursor: CursorSchema.optional(),
  });
}

export const PageOutputSchema = z.strictObject({
  hasMore: z.boolean(),
  nextCursor: CursorSchema.optional(),
});

export const BlockLocationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("library"),
    libraryId: LibraryIdSchema,
  }),
  z.strictObject({
    kind: z.literal("document"),
    documentId: DocumentIdSchema,
    parentBlockId: BlockIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("data_source"),
    dataSourceId: DataSourceIdSchema,
  }),
]);

export const RecoveryActionSchema = z.enum([
  "retry_same",
  "get_block_again",
  "fetch_again",
  "query_database_again",
  "restart_search",
  "use_block_representation",
  "start_new_task",
  "none",
]);

export const ToolErrorCodeSchema = z.enum([
  "invalid_arguments",
  "tool_catalog_stale",
  "project_context_required",
  "authorization_denied",
  "not_found",
  "unsupported_resource",
  "projection_not_ready",
  "cursor_stale",
  "conflict",
  "invalid_markdown",
  "markdown_patch_mismatch",
  "markdown_patch_overlap",
  "protected_owner_deletion",
  "mixed_transfer_sources",
  "idempotency_collision",
  "result_too_large",
  "timeout",
  "internal_error",
]);

export const ToolFailureSchema = z.strictObject({
  error: z.strictObject({
    code: ToolErrorCodeSchema,
    message: z.string().min(1).max(4_096),
    retryable: z.boolean(),
    recovery: RecoveryActionSchema,
    details: z
      .strictObject({
        resourceId: z.string().min(1).max(512).optional(),
        domainCode: z.string().min(1).max(256).optional(),
      })
      .optional(),
  }),
});

export function createToolSuccessSchema<TData extends z.ZodType>(data: TData) {
  return z.strictObject({
    data,
    page: PageOutputSchema.optional(),
  });
}

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type LibraryId = z.infer<typeof LibraryIdSchema>;
export type DataSourceId = z.infer<typeof DataSourceIdSchema>;
export type BlockId = z.infer<typeof BlockIdSchema>;
export type DocumentId = z.infer<typeof DocumentIdSchema>;
export type ViewId = z.infer<typeof ViewIdSchema>;
export type PropertyId = z.infer<typeof PropertyIdSchema>;
export type Cursor = z.infer<typeof CursorSchema>;
export type ETag = z.infer<typeof ETagSchema>;
export type JsonValue = z.infer<typeof JsonValueSchema>;
export type TextInput = z.infer<typeof TextInputSchema>;
export type SiblingAnchor = z.infer<typeof SiblingAnchorSchema>;
export type DocumentAnchor = z.infer<typeof DocumentAnchorSchema>;
export type BlockLocation = z.infer<typeof BlockLocationSchema>;
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;
export type ToolFailure = z.infer<typeof ToolFailureSchema>;

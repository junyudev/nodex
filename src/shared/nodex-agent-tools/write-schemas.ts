import { z } from "zod";
import { MAX_PAGE_WRITE_BODY_BYTES } from "../page-limits";
import {
  BlockIdSchema,
  BlockLocationSchema,
  createToolSuccessSchema,
  DataSourceIdSchema,
  DocumentAnchorSchema,
  DocumentIdSchema,
  ETagSchema,
  JsonValueSchema,
  PropertyIdSchema,
  SiblingAnchorSchema,
  TextInputSchema,
  ViewIdSchema,
} from "./base-schemas";

export const DatabaseValueDraftSchema = z.strictObject({
  propertyId: PropertyIdSchema,
  value: JsonValueSchema,
});

const DatabaseDestinationViewSchema = z.strictObject({
  viewId: ViewIdSchema,
  groupKey: z.string().max(4_096).nullable().optional(),
  at: SiblingAnchorSchema.optional(),
});

export const CreateDestinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("library"),
    at: SiblingAnchorSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("document"),
    documentId: DocumentIdSchema,
    at: DocumentAnchorSchema,
  }),
  z.strictObject({
    kind: z.literal("data_source"),
    dataSourceId: DataSourceIdSchema,
    values: z.array(DatabaseValueDraftSchema).max(512).optional(),
    view: DatabaseDestinationViewSchema.optional(),
  }),
]);

export const CreateInputSchema = z.strictObject({
  resource: z.strictObject({
    kind: z.literal("page"),
    title: TextInputSchema,
    body: z
      .strictObject({
        format: z.literal("markdown"),
        content: z.string().max(MAX_PAGE_WRITE_BODY_BYTES),
      })
      .optional(),
  }),
  destination: CreateDestinationSchema,
  return: z
    .strictObject({
      blockIds: z.boolean().optional(),
      etags: z.boolean().optional(),
    })
    .optional(),
});

export const CreateDataSchema = z.strictObject({
  resource: z.strictObject({
    kind: z.literal("page"),
    blockId: BlockIdSchema,
    documentId: DocumentIdSchema,
    location: BlockLocationSchema,
    bodyBlockCount: z.number().int().min(0),
    createdBodyBlockIds: z.array(BlockIdSchema).optional(),
    etags: z
      .strictObject({
        title: ETagSchema,
        body: ETagSchema,
      })
      .optional(),
  }),
  database: z
    .strictObject({
      databaseBlockId: BlockIdSchema,
    })
    .optional(),
});

export const CreateOutputSchema = createToolSuccessSchema(CreateDataSchema);

export interface NewBlockDraftInput {
  readonly localId: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, z.infer<typeof JsonValueSchema>>>;
  readonly content?: z.infer<typeof JsonValueSchema>;
  readonly children?: readonly NewBlockDraftInput[];
}

export const NewBlockDraftSchema: z.ZodType<NewBlockDraftInput> = z.lazy(() =>
  z.strictObject({
    localId: z.string().trim().min(1).max(256),
    type: z.string().trim().min(1).max(256),
    props: z.record(z.string(), JsonValueSchema).optional(),
    content: JsonValueSchema.optional(),
    children: z.array(NewBlockDraftSchema).max(512).optional(),
  }),
);

export const BlockUpdatePatchSchema = z
  .strictObject({
    type: z.string().trim().min(1).max(256).optional(),
    props: z.record(z.string(), JsonValueSchema).optional(),
    content: JsonValueSchema.optional(),
    unsetContent: z.literal(true).optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "A Block update patch must change at least one field",
  )
  .refine(
    (patch) => !(patch.content !== undefined && patch.unsetContent === true),
    "content and unsetContent cannot be combined",
  );

export const TransferDestinationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("library"),
    at: SiblingAnchorSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("document"),
    documentId: DocumentIdSchema,
    at: DocumentAnchorSchema,
  }),
  z.strictObject({
    kind: z.literal("data_source"),
    dataSourceId: DataSourceIdSchema,
    values: z.array(DatabaseValueDraftSchema).max(512).optional(),
    view: DatabaseDestinationViewSchema.optional(),
  }),
]);

const TransferReturnSchema = z.strictObject({
  blockMap: z.boolean().optional(),
});

export const TransferBlocksInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("move"),
    blockIds: z.array(BlockIdSchema).min(1).max(16),
    from: BlockLocationSchema,
    destination: TransferDestinationSchema,
    return: TransferReturnSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal("copy"),
    blockIds: z.array(BlockIdSchema).min(1).max(16),
    destination: TransferDestinationSchema,
    return: TransferReturnSchema.optional(),
  }),
]);

export const TransferBlocksDataSchema = z.strictObject({
  mode: z.enum(["move", "copy"]),
  results: z
    .array(
      z.strictObject({
        sourceBlockId: BlockIdSchema,
        resultBlockId: BlockIdSchema,
        location: BlockLocationSchema,
        transformation: z.enum(["preserved", "wrapped", "promoted"]),
      }),
    )
    .max(16),
  copiedBlockIds: z.record(BlockIdSchema, BlockIdSchema).optional(),
});

export const TransferBlocksOutputSchema = createToolSuccessSchema(TransferBlocksDataSchema);

export type CreateInput = z.infer<typeof CreateInputSchema>;
export type CreateOutput = z.infer<typeof CreateOutputSchema>;
export type TransferBlocksInput = z.infer<typeof TransferBlocksInputSchema>;
export type TransferBlocksOutput = z.infer<typeof TransferBlocksOutputSchema>;

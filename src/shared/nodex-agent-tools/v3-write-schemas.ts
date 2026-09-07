import { z } from "zod";
import {
  BlockIdSchema,
  createToolSuccessSchema,
  DataSourceIdSchema,
  DocumentAnchorSchema,
  ETagSchema,
  SiblingAnchorSchema,
} from "./base-schemas";
import { BlockUpdatePatchSchema, NewBlockDraftSchema } from "./write-schemas";
import {
  PageDestinationV3Schema,
  PageLocationV3Schema,
  DatabaseDestinationViewV3Schema,
  DatabaseValueDraftV3Schema,
  InlineMarkdownTitleSchema,
  NestedMarkdownFragmentSchema,
  NestedMarkdownSchema,
  uniqueSelectorList,
} from "./v3-base-schemas";

const BlockIdMapV3Schema = z.record(BlockIdSchema, BlockIdSchema);

const CreatePageDraftV3Schema = z.strictObject({
  title: InlineMarkdownTitleSchema,
  markdown: NestedMarkdownSchema.optional(),
  values: z.array(DatabaseValueDraftV3Schema).max(512).optional(),
});

export const CreatePagesV3InputSchema = z
  .strictObject({
    destination: PageDestinationV3Schema,
    pages: z.array(CreatePageDraftV3Schema).min(1).max(16),
    return: uniqueSelectorList(["block_ids", "etags"]).optional(),
  })
  .superRefine((input, context) => {
    const bodyBytes = input.pages.reduce(
      (total, page) => total + new TextEncoder().encode(page.markdown ?? "").byteLength,
      0,
    );
    if (bodyBytes > 2 * 1024 * 1024) {
      context.addIssue({
        code: "custom",
        message: "The Page batch exceeds the 2 MiB aggregate Nested Markdown limit",
        path: ["pages"],
      });
    }
    if (input.destination.kind === "data_source") return;
    input.pages.forEach((page, index) => {
      if (page.values === undefined) return;
      context.addIssue({
        code: "custom",
        message: "Initial values require a Data Source destination",
        path: ["pages", index, "values"],
      });
    });
  });

const PageMutationEtagsV3Schema = z.strictObject({
  title: ETagSchema,
  body: ETagSchema,
});

export const CreatePagesResultPageV3Schema = z.strictObject({
  pageId: BlockIdSchema,
  location: PageLocationV3Schema,
  bodyBlocksCreated: z.number().int().min(0),
  blockIds: z.array(BlockIdSchema).optional(),
  etags: PageMutationEtagsV3Schema.optional(),
});

export const CreatePagesV3DataSchema = z.strictObject({
  pages: z.array(CreatePagesResultPageV3Schema).min(1).max(16),
  created: z.number().int().min(1).max(16),
});

export const CreatePagesV3OutputSchema = createToolSuccessSchema(CreatePagesV3DataSchema);

const ExactMarkdownPatchV3Schema = z.strictObject({
  oldMarkdown: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024),
  newMarkdown: NestedMarkdownSchema,
  expectedMatches: z.number().int().min(1).max(100).optional(),
});

export const PageBodyUpdateV3Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("insert"),
    at: DocumentAnchorSchema,
    markdown: NestedMarkdownFragmentSchema,
  }),
  z.strictObject({
    kind: z.literal("patch"),
    patches: z.array(ExactMarkdownPatchV3Schema).min(1).max(100),
    ifMatch: ETagSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("replace"),
    markdown: NestedMarkdownSchema,
    ifMatch: ETagSchema,
  }),
]);

const PageUpdateReturnV3Schema = uniqueSelectorList(["markdown", "block_ids", "etags"]);

export const UpdatePageV3InputSchema = z
  .strictObject({
    pageId: BlockIdSchema,
    title: z
      .strictObject({
        markdown: InlineMarkdownTitleSchema,
        ifMatch: ETagSchema,
      })
      .optional(),
    body: PageBodyUpdateV3Schema.optional(),
    return: PageUpdateReturnV3Schema.optional(),
  })
  .refine(
    (input) => input.title !== undefined || input.body !== undefined,
    "update_page requires title or body",
  );

const PageUpdateEffectsV3Schema = z.strictObject({
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  moved: z.number().int().min(0),
  deleted: z.number().int().min(0),
  blockIds: z
    .strictObject({
      created: z.array(BlockIdSchema),
      local: z.record(z.string(), BlockIdSchema),
      copied: BlockIdMapV3Schema,
      updated: z.array(BlockIdSchema),
      moved: z.array(BlockIdSchema),
      deleted: z.array(BlockIdSchema),
    })
    .optional(),
});

export const PageUpdateV3DataSchema = z.strictObject({
  pageId: BlockIdSchema,
  effects: PageUpdateEffectsV3Schema,
  body: z
    .strictObject({
      format: z.literal("markdown"),
      markdown: z.string(),
      contentHash: z.string().min(1).max(512),
    })
    .optional(),
  etags: PageMutationEtagsV3Schema.optional(),
});

export const UpdatePageV3OutputSchema = createToolSuccessSchema(PageUpdateV3DataSchema);

export const StableBlockEditV3Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("insert"),
    at: DocumentAnchorSchema,
    block: NewBlockDraftSchema,
  }),
  z.strictObject({
    kind: z.literal("update"),
    blockId: BlockIdSchema,
    ifMatch: ETagSchema,
    patch: BlockUpdatePatchSchema,
  }),
  z.strictObject({
    kind: z.literal("move"),
    blockId: BlockIdSchema,
    at: DocumentAnchorSchema,
  }),
  z.strictObject({
    kind: z.literal("delete"),
    blockId: BlockIdSchema,
    ifMatch: ETagSchema,
  }),
]);

export const AdvancedUpdatePageV3InputSchema = z.strictObject({
  pageId: BlockIdSchema,
  edits: z.array(StableBlockEditV3Schema).min(1).max(512),
  return: PageUpdateReturnV3Schema.optional(),
});

export const AdvancedUpdatePageV3OutputSchema = createToolSuccessSchema(PageUpdateV3DataSchema);

const MovePagesDestinationV3Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("library"), at: SiblingAnchorSchema.optional() }),
  z.strictObject({
    kind: z.literal("page"),
    pageId: BlockIdSchema,
    at: SiblingAnchorSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("data_source"),
    dataSourceId: DataSourceIdSchema,
    values: z.array(DatabaseValueDraftV3Schema).max(512).optional(),
    view: DatabaseDestinationViewV3Schema.optional(),
  }),
]);

export const MovePagesV3InputSchema = z.strictObject({
  pageIds: z
    .array(BlockIdSchema)
    .min(1)
    .max(16)
    .refine((ids) => new Set(ids).size === ids.length, "pageIds must be unique"),
  destination: MovePagesDestinationV3Schema,
});

export const MovePagesResultPageV3Schema = z.strictObject({
  pageId: BlockIdSchema,
  location: PageLocationV3Schema,
});

export const MovePagesV3DataSchema = z.strictObject({
  pages: z.array(MovePagesResultPageV3Schema).min(1).max(16),
  moved: z.number().int().min(1).max(16),
});

export const MovePagesV3OutputSchema = createToolSuccessSchema(MovePagesV3DataSchema);

const DuplicatePageDestinationV3Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("library"), at: SiblingAnchorSchema.optional() }),
  z.strictObject({
    kind: z.literal("page"),
    pageId: BlockIdSchema,
    at: SiblingAnchorSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("data_source"),
    dataSourceId: DataSourceIdSchema,
    values: z.array(DatabaseValueDraftV3Schema).max(512).optional(),
    view: DatabaseDestinationViewV3Schema.optional(),
  }),
]);

export const DuplicatePageV3InputSchema = z.strictObject({
  pageId: BlockIdSchema,
  destination: DuplicatePageDestinationV3Schema,
  return: uniqueSelectorList(["block_map", "etags"]).optional(),
});

export const DuplicatePageV3DataSchema = z.strictObject({
  sourcePageId: BlockIdSchema,
  pageId: BlockIdSchema,
  location: PageLocationV3Schema,
  bodyBlocksCreated: z.number().int().min(0),
  blockMap: BlockIdMapV3Schema.optional(),
  etags: PageMutationEtagsV3Schema.optional(),
});

export const DuplicatePageV3OutputSchema = createToolSuccessSchema(DuplicatePageV3DataSchema);

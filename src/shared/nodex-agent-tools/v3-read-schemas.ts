import { z } from "zod";
import {
  BlockIdSchema,
  createPageInputSchema,
  createToolSuccessSchema,
  DataSourceIdSchema,
  ETagSchema,
  JsonValueSchema,
  LibraryIdSchema,
  ProjectIdSchema,
  PropertyIdSchema,
  ViewIdSchema,
} from "./base-schemas";
import {
  DatabasePropertyValueTypeSchema,
  DatabaseViewFilterNodeSchema,
  DatabaseViewLayoutSchema,
  MAX_DATABASE_QUERY_PROPERTY_IDS,
  NonManualDatabaseViewSortSchema,
} from "./read-schemas";
import { PageLocationV3Schema, InlineMarkdownTitleSchema } from "./v3-base-schemas";

const DatabaseSummaryV3Schema = z.strictObject({
  databaseId: BlockIdSchema,
  name: z.string(),
  isBound: z.boolean(),
  dataSources: z.array(
    z.strictObject({
      dataSourceId: DataSourceIdSchema,
      name: z.string(),
      schemaRevision: z.number().int().min(1),
    }),
  ),
  views: z.array(
    z.strictObject({
      viewId: ViewIdSchema,
      dataSourceId: DataSourceIdSchema,
      name: z.string(),
      layout: DatabaseViewLayoutSchema,
      isDefault: z.boolean(),
    }),
  ),
});

export const GetContextV3InputSchema = z.strictObject({
  include: z
    .strictObject({
      databases: z.boolean().optional(),
      markdownGuide: z.boolean().optional(),
    })
    .optional(),
});

export const GetContextV3DataSchema = z.strictObject({
  project: z
    .strictObject({
      projectId: ProjectIdSchema,
      name: z.string(),
      lifecycle: z.enum(["active", "inactive", "archived"]),
      libraryId: LibraryIdSchema,
      boundDatabaseId: BlockIdSchema,
    })
    .nullable(),
  access: z.strictObject({
    read: z.enum(["allowed", "unavailable"]),
    write: z.enum(["granted", "consent_required", "unavailable"]),
    domains: z.array(z.enum(["page", "database"])),
  }),
  databases: z.array(DatabaseSummaryV3Schema).optional(),
  markdownGuide: z
    .strictObject({
      format: z.literal("markdown"),
      specificationVersion: z.string(),
      instructions: z.string(),
      examples: z.array(z.string()),
    })
    .optional(),
});

export const GetContextV3OutputSchema = createToolSuccessSchema(GetContextV3DataSchema);

export const DocumentBlockV3Schema = z.strictObject({
  id: BlockIdSchema,
  parentId: BlockIdSchema.nullable(),
  index: z.number().int().min(0),
  depth: z.number().int().min(0),
  type: z.string().min(1).max(256),
  props: z.record(z.string(), JsonValueSchema),
  content: JsonValueSchema.optional(),
  etag: ETagSchema.optional(),
});

export const FetchContentV3Schema = z.discriminatedUnion("format", [
  z.strictObject({ format: z.literal("summary"), text: z.string() }),
  z.strictObject({
    format: z.literal("markdown"),
    markdown: z.string(),
    contentHash: z.string().min(1).max(512),
    etag: ETagSchema.optional(),
  }),
  z.strictObject({
    format: z.literal("blocks"),
    blocks: z.array(DocumentBlockV3Schema),
  }),
]);

const FetchPrepareForV3Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("title") }),
  z.strictObject({ kind: z.literal("body") }),
  z.strictObject({
    kind: z.literal("block_update"),
    blockIds: z.array(BlockIdSchema).min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal("block_delete"),
    blockIds: z.array(BlockIdSchema).min(1).max(512),
  }),
]);

export const FetchV3InputSchema = z
  .strictObject({
    id: BlockIdSchema,
    format: z.enum(["markdown", "summary", "blocks"]).optional(),
    propertyIds: z.array(PropertyIdSchema).max(512).optional(),
    includeDataSource: z.boolean().optional(),
    prepareFor: z.array(FetchPrepareForV3Schema).max(8).optional(),
    maxDepth: z.number().int().min(0).max(512).optional(),
    page: createPageInputSchema(100).optional(),
  })
  .superRefine((input, context) => {
    if ((input.maxDepth !== undefined || input.page !== undefined) && input.format !== "blocks") {
      context.addIssue({
        code: "custom",
        message: "maxDepth and page require format=blocks",
        path: [input.maxDepth !== undefined ? "maxDepth" : "page"],
      });
    }
    const preparesBlocks =
      input.prepareFor?.some(
        (entry) => entry.kind === "block_update" || entry.kind === "block_delete",
      ) ?? false;
    if (preparesBlocks && input.format !== "blocks") {
      context.addIssue({
        code: "custom",
        message: "Preparing stable Blocks requires format=blocks",
        path: ["prepareFor"],
      });
    }
    const preparesBody = input.prepareFor?.some((entry) => entry.kind === "body") ?? false;
    if (preparesBody && input.format !== undefined && input.format !== "markdown") {
      context.addIssue({
        code: "custom",
        message: "Preparing the body requires the default Markdown format",
        path: ["prepareFor"],
      });
    }
  });

export const FetchResourceV3Schema = z.strictObject({
  id: BlockIdSchema,
  type: z.string().min(1).max(256),
  title: z
    .strictObject({
      markdown: InlineMarkdownTitleSchema,
      etag: ETagSchema.optional(),
    })
    .optional(),
  lifecycle: z.enum(["active", "archived", "deleted"]),
  location: PageLocationV3Schema,
  properties: z.record(PropertyIdSchema, z.strictObject({ value: JsonValueSchema })).optional(),
});

export const FetchV3DataSchema = z.strictObject({
  resource: FetchResourceV3Schema,
  content: FetchContentV3Schema.optional(),
  dataSource: z
    .strictObject({
      dataSourceId: DataSourceIdSchema,
      databaseId: BlockIdSchema,
    })
    .optional(),
});

export const FetchV3OutputSchema = createToolSuccessSchema(FetchV3DataSchema);

const SearchScopeV3Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("library") }),
  z.strictObject({ kind: z.literal("database"), databaseId: BlockIdSchema }),
  z.strictObject({ kind: z.literal("data_source"), dataSourceId: DataSourceIdSchema }),
  z.strictObject({ kind: z.literal("page"), pageId: BlockIdSchema }),
]);

const SearchQueryV3Schema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (query) => new TextEncoder().encode(query).byteLength <= 512,
    "Search query must be at most 512 UTF-8 bytes",
  );

export const SearchV3InputSchema = z
  .strictObject({
    query: SearchQueryV3Schema,
    target: z.enum(["pages", "blocks"]).optional(),
    scope: SearchScopeV3Schema.optional(),
    blockTypes: z.array(z.string().min(1).max(256)).max(64).optional(),
    includeArchived: z.boolean().optional(),
    page: createPageInputSchema(100).optional(),
  })
  .superRefine((input, context) => {
    if (input.blockTypes !== undefined && input.target !== "blocks") {
      context.addIssue({
        code: "custom",
        message: "blockTypes requires target=blocks",
        path: ["blockTypes"],
      });
    }
  });

const SearchMatchQualityV3Schema = z.enum(["exact", "prefix", "fuzzy"]);

export const PageSearchMatchV3Schema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("identity"),
    quality: z.enum(["exact", "prefix"]),
    excerpt: z.string(),
  }),
  z.strictObject({
    source: z.literal("title"),
    quality: SearchMatchQualityV3Schema,
    excerpt: z.string(),
  }),
  z.strictObject({
    source: z.literal("property"),
    quality: SearchMatchQualityV3Schema,
    propertyId: PropertyIdSchema,
    propertyName: z.string(),
    excerpt: z.string(),
  }),
  z.strictObject({
    source: z.literal("body"),
    quality: z.enum(["exact", "prefix"]),
    blockId: BlockIdSchema,
    blockType: z.string(),
    excerpt: z.string(),
  }),
]);

export const PageSearchResultV3Schema = z.strictObject({
  kind: z.literal("page"),
  id: BlockIdSchema,
  title: z.string(),
  location: PageLocationV3Schema,
  matches: z.array(PageSearchMatchV3Schema).max(3),
});

export const BlockSearchResultV3Schema = z.strictObject({
  kind: z.literal("block"),
  id: BlockIdSchema,
  blockType: z.string(),
  ownerPageId: BlockIdSchema,
  source: z.enum(["title", "body"]),
  quality: z.enum(["exact", "prefix"]),
  excerpt: z.string(),
});

const SearchResultV3Schema = z.discriminatedUnion("kind", [
  PageSearchResultV3Schema,
  BlockSearchResultV3Schema,
]);

export const SearchV3DataSchema = z.strictObject({
  results: z.array(SearchResultV3Schema).max(100),
});

export const SearchV3OutputSchema = createToolSuccessSchema(SearchV3DataSchema);

const QuerySelectV3Schema = z
  .strictObject({
    propertyIds: z.array(PropertyIdSchema).max(MAX_DATABASE_QUERY_PROPERTY_IDS).optional(),
    documentSummary: z.boolean().optional(),
  })
  .optional();

export const QueryDatabaseViewV3InputSchema = z.strictObject({
  viewId: ViewIdSchema,
  select: QuerySelectV3Schema,
  page: createPageInputSchema(200).optional(),
});

export const QueryDataSourceV3InputSchema = z.strictObject({
  dataSourceId: DataSourceIdSchema,
  filter: DatabaseViewFilterNodeSchema.optional(),
  sort: z.array(NonManualDatabaseViewSortSchema).max(4).optional(),
  select: QuerySelectV3Schema,
  page: createPageInputSchema(200).optional(),
});

export const QueryDatabaseRowV3Schema = z.strictObject({
  pageId: BlockIdSchema,
  title: z.string(),
  values: z.record(PropertyIdSchema, JsonValueSchema),
  placement: z
    .strictObject({
      viewId: ViewIdSchema,
      groupKey: z.string().nullable(),
    })
    .optional(),
  documentSummary: z.string().optional(),
});

export const QueryDatabaseV3DataSchema = z.strictObject({
  database: z.strictObject({
    databaseId: BlockIdSchema,
    name: z.string(),
  }),
  dataSource: z.strictObject({
    dataSourceId: DataSourceIdSchema,
    name: z.string(),
    properties: z.array(
      z.strictObject({
        propertyId: PropertyIdSchema,
        name: z.string(),
        valueType: DatabasePropertyValueTypeSchema,
        config: z.record(z.string(), JsonValueSchema),
      }),
    ),
  }),
  view: z
    .strictObject({
      viewId: ViewIdSchema,
      dataSourceId: DataSourceIdSchema,
      name: z.string(),
      layout: DatabaseViewLayoutSchema,
    })
    .optional(),
  rows: z.array(QueryDatabaseRowV3Schema).max(200),
});

export const QueryDatabaseV3OutputSchema = createToolSuccessSchema(QueryDatabaseV3DataSchema);

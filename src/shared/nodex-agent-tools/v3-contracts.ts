import type { z } from "zod";
import type { NodexAgentToolContract } from "./tool-contract";
import {
  FetchV3InputSchema,
  FetchV3OutputSchema,
  GetContextV3InputSchema,
  GetContextV3OutputSchema,
  QueryDatabaseV3OutputSchema,
  QueryDatabaseViewV3InputSchema,
  QueryDataSourceV3InputSchema,
  SearchV3InputSchema,
  SearchV3OutputSchema,
} from "./v3-read-schemas";
import {
  AdvancedUpdatePageV3InputSchema,
  AdvancedUpdatePageV3OutputSchema,
  CreatePagesV3InputSchema,
  CreatePagesV3OutputSchema,
  DuplicatePageV3InputSchema,
  DuplicatePageV3OutputSchema,
  MovePagesV3InputSchema,
  MovePagesV3OutputSchema,
  UpdatePageV3InputSchema,
  UpdatePageV3OutputSchema,
} from "./v3-write-schemas";

function defineV3Contract<TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
  contract: NodexAgentToolContract<TInputSchema, TOutputSchema>,
): NodexAgentToolContract<TInputSchema, TOutputSchema> {
  return contract;
}

export const NODEX_AGENT_V3_TOOL_CONTRACTS = {
  get_context: defineV3Contract({
    description:
      "Read the current Project binding, access state, Database/View catalog, or the full opt-in Nodex Markdown guide.",
    inputSchema: GetContextV3InputSchema,
    outputSchema: GetContextV3OutputSchema,
    deferLoading: false,
    classifyEffect: () => "read",
  }),
  search: defineV3Contract({
    description:
      "Discover Pages with typo-tolerant title/property matching or exact/prefix body Blocks; returns excerpts and stable IDs for fetch.",
    inputSchema: SearchV3InputSchema,
    outputSchema: SearchV3OutputSchema,
    deferLoading: false,
    classifyEffect: () => "read",
  }),
  fetch: defineV3Contract({
    description:
      "Fetch a known stable ID. Defaults to complete canonical Nodex Markdown; request summary or blocks only for compact or identity-sensitive work.",
    inputSchema: FetchV3InputSchema,
    outputSchema: FetchV3OutputSchema,
    deferLoading: false,
    classifyEffect: () => "read",
  }),
  query_database_view: defineV3Contract({
    description:
      "Query one saved Database View with its persisted filter, sort, grouping, and row order; results omit write validators.",
    inputSchema: QueryDatabaseViewV3InputSchema,
    outputSchema: QueryDatabaseV3OutputSchema,
    deferLoading: true,
    classifyEffect: () => "read",
  }),
  query_data_source: defineV3Contract({
    description:
      "Run a typed temporary filter and non-manual sort against one known Data Source without inheriting saved View rules or positions; omitted sort uses stable Page identity order.",
    inputSchema: QueryDataSourceV3InputSchema,
    outputSchema: QueryDatabaseV3OutputSchema,
    deferLoading: true,
    classifyEffect: () => "read",
  }),
  create_pages: defineV3Contract({
    description:
      "Atomically create one to sixteen complete Pages at one shared Library, Page, or Data Source destination, with direct inline-Markdown titles and optional Nodex Markdown bodies.",
    inputSchema: CreatePagesV3InputSchema,
    outputSchema: CreatePagesV3OutputSchema,
    deferLoading: true,
    classifyEffect: () => "write",
  }),
  update_page: defineV3Contract({
    description:
      "Update one Page title or body. Insert or exact-patch Nodex Markdown by default; whole replacement requires a body ETag.",
    inputSchema: UpdatePageV3InputSchema,
    outputSchema: UpdatePageV3OutputSchema,
    deferLoading: true,
    classifyEffect: (input: z.output<typeof UpdatePageV3InputSchema>) =>
      input.body?.kind === "replace" ? "destructive" : "write",
  }),
  advanced_update_page: defineV3Contract({
    description:
      "After fetch format=blocks, perform identity-sensitive insert, update, move, or delete operations using stable Block IDs and narrow ETags.",
    inputSchema: AdvancedUpdatePageV3InputSchema,
    outputSchema: AdvancedUpdatePageV3OutputSchema,
    deferLoading: true,
    classifyEffect: (input: z.output<typeof AdvancedUpdatePageV3InputSchema>) =>
      input.edits.some((edit) => edit.kind === "delete") ? "destructive" : "write",
  }),
  move_pages: defineV3Contract({
    description:
      "Atomically move one to sixteen existing Page roots to one destination; current parents and Project authority are resolved and verified by Nodex.",
    inputSchema: MovePagesV3InputSchema,
    outputSchema: MovePagesV3OutputSchema,
    deferLoading: true,
    classifyEffect: () => "write",
  }),
  duplicate_page: defineV3Contract({
    description:
      "Duplicate one complete Page ownership subtree to a destination with fresh identities; request the detailed Block map only when needed.",
    inputSchema: DuplicatePageV3InputSchema,
    outputSchema: DuplicatePageV3OutputSchema,
    deferLoading: true,
    classifyEffect: () => "write",
  }),
} as const;

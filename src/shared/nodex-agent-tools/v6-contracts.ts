import type { z } from "zod";
import type { NodexAgentToolContract } from "./tool-contract";
import { NODEX_AGENT_V5_TOOL_CONTRACTS } from "./v5-contracts";
import {
  CreatePagesV6OutputSchema,
  DuplicatePageV6OutputSchema,
  FetchV6OutputSchema,
  MovePagesV6OutputSchema,
  QueryDatabaseV6OutputSchema,
  SearchV6OutputSchema,
} from "./v6-schemas";

const defineV6Contract = <TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
  contract: NodexAgentToolContract<TInputSchema, TOutputSchema>,
): NodexAgentToolContract<TInputSchema, TOutputSchema> => contract;

/**
 * Revision-6 catalog. Page reads and structural receipts project current Page
 * keys while canonical UUIDs remain the only fetch and mutation identities.
 */
export const NODEX_AGENT_V6_TOOL_CONTRACTS = {
  ...NODEX_AGENT_V5_TOOL_CONTRACTS,
  search: defineV6Contract({
    ...NODEX_AGENT_V5_TOOL_CONTRACTS.search,
    description:
      "Discover Pages by current or historical Page key, stable identity, typo-tolerant title/property metadata, or exact/prefix body evidence. Use the returned canonical ID for fetches and writes.",
    outputSchema: SearchV6OutputSchema,
  }),
  fetch: defineV6Contract({
    ...NODEX_AGENT_V5_TOOL_CONTRACTS.fetch,
    description:
      "Fetch a known canonical stable ID. Defaults to complete canonical Nodex Markdown; Page responses include the current nullable Page key for human reference.",
    outputSchema: FetchV6OutputSchema,
  }),
  query_database_view: defineV6Contract({
    ...NODEX_AGENT_V5_TOOL_CONTRACTS.query_database_view,
    outputSchema: QueryDatabaseV6OutputSchema,
  }),
  query_data_source: defineV6Contract({
    ...NODEX_AGENT_V5_TOOL_CONTRACTS.query_data_source,
    outputSchema: QueryDatabaseV6OutputSchema,
  }),
  create_pages: defineV6Contract({
    ...NODEX_AGENT_V5_TOOL_CONTRACTS.create_pages,
    outputSchema: CreatePagesV6OutputSchema,
  }),
  move_pages: defineV6Contract({
    ...NODEX_AGENT_V5_TOOL_CONTRACTS.move_pages,
    outputSchema: MovePagesV6OutputSchema,
  }),
  duplicate_page: defineV6Contract({
    ...NODEX_AGENT_V5_TOOL_CONTRACTS.duplicate_page,
    outputSchema: DuplicatePageV6OutputSchema,
  }),
} as const;

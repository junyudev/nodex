import type { z } from "zod";
import type { NodexAgentToolContract } from "./tool-contract";
import { NODEX_AGENT_V3_TOOL_CONTRACTS } from "./v3-contracts";
import {
  CreatePagesV5InputSchema,
  DuplicatePageV5InputSchema,
  FetchV5InputSchema,
  FetchV5OutputSchema,
  MovePagesV5InputSchema,
  QueryDatabaseV5OutputSchema,
  QueryDatabaseViewV5InputSchema,
  QueryDataSourceV5InputSchema,
  SearchV5OutputSchema,
} from "./v5-schemas";

const defineV5Contract = <TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
  contract: NodexAgentToolContract<TInputSchema, TOutputSchema>,
): NodexAgentToolContract<TInputSchema, TOutputSchema> => contract;

/**
 * Revision-5 catalog. It retains the revision-4 intent vocabulary while
 * rejecting parent-derived Property and option coordinates after the v81
 * identity cutover.
 */
export const NODEX_AGENT_V5_TOOL_CONTRACTS = {
  get_context: NODEX_AGENT_V3_TOOL_CONTRACTS.get_context,
  search: defineV5Contract({
    ...NODEX_AGENT_V3_TOOL_CONTRACTS.search,
    outputSchema: SearchV5OutputSchema,
  }),
  fetch: defineV5Contract({
    ...NODEX_AGENT_V3_TOOL_CONTRACTS.fetch,
    inputSchema: FetchV5InputSchema,
    outputSchema: FetchV5OutputSchema,
  }),
  query_database_view: defineV5Contract({
    ...NODEX_AGENT_V3_TOOL_CONTRACTS.query_database_view,
    inputSchema: QueryDatabaseViewV5InputSchema,
    outputSchema: QueryDatabaseV5OutputSchema,
  }),
  query_data_source: defineV5Contract({
    ...NODEX_AGENT_V3_TOOL_CONTRACTS.query_data_source,
    inputSchema: QueryDataSourceV5InputSchema,
    outputSchema: QueryDatabaseV5OutputSchema,
  }),
  create_pages: defineV5Contract({
    ...NODEX_AGENT_V3_TOOL_CONTRACTS.create_pages,
    inputSchema: CreatePagesV5InputSchema,
  }),
  update_page: NODEX_AGENT_V3_TOOL_CONTRACTS.update_page,
  advanced_update_page: NODEX_AGENT_V3_TOOL_CONTRACTS.advanced_update_page,
  move_pages: defineV5Contract({
    ...NODEX_AGENT_V3_TOOL_CONTRACTS.move_pages,
    inputSchema: MovePagesV5InputSchema,
  }),
  duplicate_page: defineV5Contract({
    ...NODEX_AGENT_V3_TOOL_CONTRACTS.duplicate_page,
    inputSchema: DuplicatePageV5InputSchema,
  }),
} as const;

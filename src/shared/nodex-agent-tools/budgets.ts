/** Public acceptance budgets for nodex_app@3. */
export const NODEX_AGENT_V3_CATALOG_BUDGETS = {
  namespaceHintBytes: 200,
  eagerBytes: 5_500,
  completeBytes: 38_000,
  tools: {
    fetch: 2_500,
    query_database_view: 2_500,
    query_data_source: 4_500,
    create_pages: 6_000,
    update_page: 4_000,
    move_pages: 5_000,
    duplicate_page: 5_000,
    advanced_update_page: 8_000,
  },
  defaultQueryResultBytes: 4_000,
  defaultMutationResultBytes: 2_000,
  defaultCreatePagesBaseBytes: 512,
  defaultCreatePagesPerPageBytes: 256,
} as const;

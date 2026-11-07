export const NODEX_APP_TOOL_NAMESPACE = "nodex_app" as const;

export const NODEX_APP_V3_TOOLSET_REVISION = 4 as const;

export const NODEX_APP_V3_TOOLS = [
  "get_context",
  "search",
  "fetch",
  "query_database_view",
  "query_data_source",
  "create_pages",
  "update_page",
  "advanced_update_page",
  "move_pages",
  "duplicate_page",
] as const;

export type NodexAgentV3ToolName = (typeof NODEX_APP_V3_TOOLS)[number];

/** Compact-identity contract published with the schema-v81 cutover. */
export const NODEX_APP_V5_TOOLSET_REVISION = 5 as const;
export const NODEX_APP_V5_TOOLS = NODEX_APP_V3_TOOLS;

/** Page-key discovery and projection contract. */
export const NODEX_APP_V6_TOOLSET_REVISION = 6 as const;
export const NODEX_APP_V6_TOOLS = NODEX_APP_V5_TOOLS;
export type NodexAgentV6ToolName = (typeof NODEX_APP_V6_TOOLS)[number];

export const NODEX_APP_TOOLSET_REVISION = NODEX_APP_V6_TOOLSET_REVISION;
export const NODEX_APP_TOOLS = NODEX_APP_V6_TOOLS;
export type NodexAgentToolName = NodexAgentV6ToolName;

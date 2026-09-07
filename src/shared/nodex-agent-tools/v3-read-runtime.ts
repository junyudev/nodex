import type { ToolFailure } from "./base-schemas";
import type { NodexAgentAccess } from "./read-runtime";
import type { FrozenNodexAgentTurnAuthority } from "../nodex-agent-authority";
import type { NodexAgentResourceAccessOverlay } from "../nodex-agent-resource-access";
import type {
  FetchV3InputSchema,
  GetContextV3InputSchema,
  GetContextV3OutputSchema,
  QueryDataSourceV3InputSchema,
  QueryDatabaseViewV3InputSchema,
  SearchV3InputSchema,
} from "./v3-read-schemas";
import type {
  FetchV6OutputSchema,
  QueryDatabaseV6OutputSchema,
  SearchV6OutputSchema,
} from "./v6-schemas";
import type { z } from "zod";

export type NodexAgentV3ReadRequest =
  | {
      readonly tool: "get_context";
      readonly callId?: string;
      readonly projectId: string | null;
      readonly authority?: FrozenNodexAgentTurnAuthority | null;
      readonly resourceAccess?: NodexAgentResourceAccessOverlay;
      readonly access: NodexAgentAccess;
      readonly input: z.infer<typeof GetContextV3InputSchema>;
    }
  | {
      readonly tool: "fetch";
      readonly callId?: string;
      readonly projectId: string | null;
      readonly authority?: FrozenNodexAgentTurnAuthority;
      readonly resourceAccess?: NodexAgentResourceAccessOverlay;
      readonly input: z.infer<typeof FetchV3InputSchema>;
    }
  | {
      readonly tool: "search";
      readonly callId?: string;
      readonly projectId: string | null;
      readonly authority?: FrozenNodexAgentTurnAuthority;
      readonly resourceAccess?: NodexAgentResourceAccessOverlay;
      readonly input: z.infer<typeof SearchV3InputSchema>;
    }
  | {
      readonly tool: "query_database_view";
      readonly callId?: string;
      readonly projectId: string | null;
      readonly authority?: FrozenNodexAgentTurnAuthority;
      readonly resourceAccess?: NodexAgentResourceAccessOverlay;
      readonly input: z.infer<typeof QueryDatabaseViewV3InputSchema>;
    }
  | {
      readonly tool: "query_data_source";
      readonly callId?: string;
      readonly projectId: string | null;
      readonly authority?: FrozenNodexAgentTurnAuthority;
      readonly resourceAccess?: NodexAgentResourceAccessOverlay;
      readonly input: z.infer<typeof QueryDataSourceV3InputSchema>;
    };

export type NodexAgentV3ReadSuccess =
  | {
      readonly ok: true;
      readonly tool: "get_context";
      readonly output: z.infer<typeof GetContextV3OutputSchema>;
    }
  | {
      readonly ok: true;
      readonly tool: "fetch";
      readonly output: z.infer<typeof FetchV6OutputSchema>;
    }
  | {
      readonly ok: true;
      readonly tool: "search";
      readonly output: z.infer<typeof SearchV6OutputSchema>;
    }
  | {
      readonly ok: true;
      readonly tool: "query_database_view" | "query_data_source";
      readonly output: z.infer<typeof QueryDatabaseV6OutputSchema>;
    };

export type NodexAgentV3ReadCommandResult =
  | NodexAgentV3ReadSuccess
  | { readonly ok: false; readonly error: ToolFailure["error"] };

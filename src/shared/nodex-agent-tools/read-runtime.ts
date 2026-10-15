import type { ToolFailure } from "./base-schemas";
import type {
  GetBlockInput,
  GetBlockOutput,
  GetContextInput,
  GetContextOutput,
  QueryDatabaseInput,
  QueryDatabaseOutput,
  SearchInput,
  SearchOutput,
} from "./read-schemas";

export type NodexAgentReadRequest =
  | {
      readonly tool: "get_context";
      readonly projectId: string | null;

      readonly input: GetContextInput;
    }
  | {
      readonly tool: "get_block";
      readonly projectId: string;
      readonly input: GetBlockInput;
    }
  | {
      readonly tool: "search";
      readonly projectId: string;
      readonly input: SearchInput;
    }
  | {
      readonly tool: "query_database";
      readonly projectId: string;
      readonly input: QueryDatabaseInput;
    };

export type NodexAgentReadSuccess =
  | { readonly ok: true; readonly tool: "get_context"; readonly output: GetContextOutput }
  | { readonly ok: true; readonly tool: "get_block"; readonly output: GetBlockOutput }
  | { readonly ok: true; readonly tool: "search"; readonly output: SearchOutput }
  | { readonly ok: true; readonly tool: "query_database"; readonly output: QueryDatabaseOutput };

export type NodexAgentReadCommandResult =
  | NodexAgentReadSuccess
  | { readonly ok: false; readonly error: ToolFailure["error"] };

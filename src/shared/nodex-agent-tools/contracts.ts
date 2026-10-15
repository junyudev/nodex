import type { z } from "zod";
import {
  GetBlockInputSchema,
  GetBlockOutputSchema,
  GetContextInputSchema,
  GetContextOutputSchema,
  QueryDatabaseInputSchema,
  QueryDatabaseOutputSchema,
  SearchInputSchema,
  SearchOutputSchema,
} from "./read-schemas";
import {
  CreateInputSchema,
  CreateOutputSchema,
  EditDatabaseInputSchema,
  EditDatabaseOutputSchema,
  EditDocumentInputSchema,
  EditDocumentOutputSchema,
  TransferBlocksInputSchema,
  TransferBlocksOutputSchema,
} from "./write-schemas";

export type NodexAgentToolEffect = "read" | "write" | "destructive";

export interface NodexAgentToolContract<
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
> {
  readonly description: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema;
  readonly deferLoading: boolean;
  readonly classifyEffect: (input: z.output<TInputSchema>) => NodexAgentToolEffect;
}

function defineNodexAgentToolContract<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  contract: NodexAgentToolContract<TInputSchema, TOutputSchema>,
): NodexAgentToolContract<TInputSchema, TOutputSchema> {
  return contract;
}

/**
 * Legacy v2 compiler contracts used only behind the canonical v3 Page tools.
 * They retain storage-shaped inputs so old compilers can be removed as one
 * bounded adapter instead of leaking those coordinates into the tool catalog.
 */
export const NODEX_AGENT_TOOL_CONTRACTS = {
  get_context: defineNodexAgentToolContract({
    description:
      "Read the current Profile identity, optional Project routing, Database/View catalog, and a compact NFM authoring guide.",
    inputSchema: GetContextInputSchema,
    outputSchema: GetContextOutputSchema,
    deferLoading: false,
    classifyEffect: () => "read",
  }),
  get_block: defineNodexAgentToolContract({
    description:
      "Read one known Block by stable identity. Request selected properties, a summary, complete canonical NFM, or paged structural Blocks; prepare only the short ETags required by a specific later overwrite.",
    inputSchema: GetBlockInputSchema,
    outputSchema: GetBlockOutputSchema,
    deferLoading: false,
    classifyEffect: () => "read",
  }),
  search: defineNodexAgentToolContract({
    description:
      "Discover Pages or exact document Blocks in the current Profile's Library. Page search is typo-tolerant for titles and property display values; body and Block search use exact/prefix matching and return stable identities.",
    inputSchema: SearchInputSchema,
    outputSchema: SearchOutputSchema,
    deferLoading: false,
    classifyEffect: () => "read",
  }),
  query_database: defineNodexAgentToolContract({
    description:
      "Query a persisted Database View or run a typed ad-hoc Database filter/sort. Reads are validator-free by default and can prepare short ETags only for selected value or placement edits.",
    inputSchema: QueryDatabaseInputSchema,
    outputSchema: QueryDatabaseOutputSchema,
    deferLoading: true,
    classifyEffect: () => "read",
  }),
  create: defineNodexAgentToolContract({
    description:
      "Internal compiler for atomically creating one complete Page before returning canonical Library, Page, or Data Source coordinates.",
    inputSchema: CreateInputSchema,
    outputSchema: CreateOutputSchema,
    deferLoading: true,
    classifyEffect: () => "write",
  }),
  edit_document: defineNodexAgentToolContract({
    description:
      "Atomically edit one Page document and optional title. NFM insert and exact simultaneous patches use semantic matching; whole replacement and destructive stable-Block changes use narrow ifMatch ETags.",
    inputSchema: EditDocumentInputSchema,
    outputSchema: EditDocumentOutputSchema,
    deferLoading: true,
    classifyEffect: (input: z.output<typeof EditDocumentInputSchema>) => {
      if (input.body?.kind === "nfm.replace") {
        return "destructive";
      }
      if (
        input.body?.kind === "blocks" &&
        input.body.edits.some((edit) => edit.kind === "delete")
      ) {
        return "destructive";
      }
      return "write";
    },
  }),
  transfer_blocks: defineNodexAgentToolContract({
    description:
      "Internal compiler for moving or copying bounded Page roots before returning canonical Library, Page, or Data Source coordinates.",
    inputSchema: TransferBlocksInputSchema,
    outputSchema: TransferBlocksOutputSchema,
    deferLoading: true,
    classifyEffect: () => "write",
  }),
  edit_database: defineNodexAgentToolContract({
    description:
      "Atomically change typed Database values or persisted View placement. Membership changes use transfer_blocks; schema and View-definition changes are intentionally not exposed by this contract.",
    inputSchema: EditDatabaseInputSchema,
    outputSchema: EditDatabaseOutputSchema,
    deferLoading: true,
    classifyEffect: () => "write",
  }),
} as const;

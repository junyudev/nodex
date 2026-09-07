import type {
  DocumentOperationBatch,
  DocumentOperationCommandResult,
  DocumentOperationResult,
  DocumentCommitRef,
} from "../block-documents";
import type { ToolFailure } from "./base-schemas";
import type { AgentDocumentEditEffects } from "./document-edit-compiler";
import type {
  NodexAgentCallIdentity,
  NodexAgentDocumentHead,
  NodexAgentTransferAuthorizationEvidence,
  NodexAgentTransferCommand,
  PreparedNodexAgentCreateDestination,
} from "./write-runtime";
import type { CreateInput } from "./write-schemas";
import type {
  AdvancedUpdatePageV3InputSchema,
  AdvancedUpdatePageV3OutputSchema,
  CreatePagesV3InputSchema,
  DuplicatePageV3InputSchema,
  MovePagesV3InputSchema,
  UpdatePageV3InputSchema,
  UpdatePageV3OutputSchema,
} from "./v3-write-schemas";
import type {
  CreatePagesV6OutputSchema,
  DuplicatePageV6OutputSchema,
  MovePagesV6OutputSchema,
} from "./v6-schemas";
import type { z } from "zod";
import type { NodexAgentResourceAccessOverlay } from "../nodex-agent-resource-access";

export interface NodexAgentPreparedPageUpdate extends Pick<
  DocumentOperationBatch,
  "mutationId" | "storeEpoch" | "clientSessionId" | "documentId" | "generation" | "expectedHeadSeq"
> {
  readonly projectId: string | null;
  readonly threadId: string;
  readonly callId: string;
}

export type NodexAgentPageUpdateCommit = Omit<DocumentOperationResult, "projectId"> & {
  readonly projectId: string | null;
};

export type NodexAgentPageUpdateCommandResult =
  | Extract<DocumentOperationCommandResult, { readonly ok: false }>
  | (Omit<Extract<DocumentOperationCommandResult, { readonly ok: true }>, "value"> & {
      readonly value: NodexAgentPageUpdateCommit;
    });

export type NodexAgentPageUpdateTool = "update_page" | "advanced_update_page";

export type PrepareNodexAgentPageUpdateRequest = NodexAgentCallIdentity & {
  readonly projectId: string | null;
} & (
    | {
        readonly tool: "update_page";
        readonly input: z.infer<typeof UpdatePageV3InputSchema>;
      }
    | {
        readonly tool: "advanced_update_page";
        readonly input: z.infer<typeof AdvancedUpdatePageV3InputSchema>;
      }
  );

export type NodexAgentPageUpdateOutput =
  | z.infer<typeof UpdatePageV3OutputSchema>
  | z.infer<typeof AdvancedUpdatePageV3OutputSchema>;

export type PrepareNodexAgentPageUpdateResult =
  | {
      readonly ok: true;
      readonly value:
        | { readonly kind: "completed"; readonly output: NodexAgentPageUpdateOutput }
        | {
            readonly kind: "prepared";
            readonly mutation: NodexAgentPreparedPageUpdate;
            readonly effects: AgentDocumentEditEffects;
            readonly targetMarkdown: string;
            readonly resourceAccess?: NodexAgentResourceAccessOverlay;
          };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

export interface CompleteNodexAgentPageUpdateRequest extends NodexAgentCallIdentity {
  readonly projectId: string | null;
  readonly tool: NodexAgentPageUpdateTool;
  readonly pageId: string;
  readonly result: NodexAgentPageUpdateCommit;
}

export type CompleteNodexAgentPageUpdateResult =
  | { readonly ok: true; readonly output: NodexAgentPageUpdateOutput }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

export interface PreparedNodexAgentCreatePageV3 {
  readonly input: CreateInput;
  readonly pageId: string;
  readonly bodyBlockIds: readonly string[];
  readonly primaryMembershipId: string;
  readonly targetMembershipId: string;
}

export interface NodexAgentCreatePagesCommand extends NodexAgentCallIdentity {
  readonly projectId: string | null;
  readonly requestHash: string;
  readonly mutationId: string;
  readonly storeEpoch: string;
  readonly input: z.infer<typeof CreatePagesV3InputSchema>;
  readonly destination: PreparedNodexAgentCreateDestination;
  readonly pages: readonly PreparedNodexAgentCreatePageV3[];
}

export interface PrepareNodexAgentCreatePagesRequest extends NodexAgentCallIdentity {
  readonly projectId: string | null;
  readonly input: z.infer<typeof CreatePagesV3InputSchema>;
}

export type PrepareNodexAgentCreatePagesResult =
  | {
      readonly ok: true;
      readonly value:
        | {
            readonly kind: "completed";
            readonly output: z.infer<typeof CreatePagesV6OutputSchema>;
          }
        | {
            readonly kind: "prepared";
            readonly command: NodexAgentCreatePagesCommand;
            readonly documentHeads: readonly NodexAgentDocumentHead[];
            readonly previews: readonly {
              readonly pageId: string;
              readonly title: string;
              readonly bodyBlockCount: number;
              readonly targetMarkdown: string;
            }[];
          };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

export type ExecuteNodexAgentCreatePagesResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly output: z.infer<typeof CreatePagesV6OutputSchema>;
        readonly duplicate: boolean;
        readonly documentCommits: readonly DocumentCommitRef[];
        readonly affectedDatabaseBlockIds: readonly string[];
        readonly commitSeq: number;
      };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

export interface NodexAgentDuplicatePageCommand extends Omit<
  NodexAgentTransferCommand,
  "input" | "transfer" | "projectId"
> {
  readonly projectId: string | null;
  readonly input: z.infer<typeof DuplicatePageV3InputSchema>;
  readonly normalizedInput: NodexAgentTransferCommand["input"];
  readonly transfer?: NodexAgentTransferCommand["transfer"];
  readonly canonical?: {
    readonly newPageId: string;
    readonly primaryViewRankKey?: string;
  };
}

export interface PrepareNodexAgentDuplicatePageRequest extends NodexAgentCallIdentity {
  readonly projectId: string | null;
  readonly input: z.infer<typeof DuplicatePageV3InputSchema>;
}

export type PrepareNodexAgentDuplicatePageResult =
  | {
      readonly ok: true;
      readonly value:
        | {
            readonly kind: "completed";
            readonly output: z.infer<typeof DuplicatePageV6OutputSchema>;
          }
        | {
            readonly kind: "prepared";
            readonly command: NodexAgentDuplicatePageCommand;
            readonly authorization: NodexAgentTransferAuthorizationEvidence;
          };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

export type ExecuteNodexAgentDuplicatePageResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly output: z.infer<typeof DuplicatePageV6OutputSchema>;
        readonly duplicate: boolean;
        readonly documentCommits: readonly DocumentCommitRef[];
        readonly affectedDatabaseBlockIds: readonly string[];
        readonly commitSeq: number;
      };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

export interface NodexAgentMovePageTransferStep {
  readonly pageId: string;
  readonly normalizedInput: NodexAgentTransferCommand["input"];
  readonly transfer: NodexAgentTransferCommand["transfer"] | null;
  /** Frozen structural concurrency coordinates for the canonical transfer path. */
  readonly canonical?: {
    readonly expectedParentRevision: number;
    readonly expectedActiveMembershipRevision: number;
  };
}

export interface NodexAgentMovePagesCommand extends NodexAgentCallIdentity {
  readonly projectId: string | null;
  readonly requestHash: string;
  readonly mutationId: string;
  readonly storeEpoch: string;
  readonly input: z.infer<typeof MovePagesV3InputSchema>;
  readonly destination: PreparedNodexAgentCreateDestination;
  readonly transfers: readonly NodexAgentMovePageTransferStep[];
  readonly documentHeads: readonly NodexAgentDocumentHead[];
}

export interface PrepareNodexAgentMovePagesRequest extends NodexAgentCallIdentity {
  readonly projectId: string | null;
  readonly input: z.infer<typeof MovePagesV3InputSchema>;
}

export type PrepareNodexAgentMovePagesResult =
  | {
      readonly ok: true;
      readonly value:
        | {
            readonly kind: "completed";
            readonly output: z.infer<typeof MovePagesV6OutputSchema>;
          }
        | {
            readonly kind: "prepared";
            readonly command: NodexAgentMovePagesCommand;
            readonly authorization: NodexAgentTransferAuthorizationEvidence;
          };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

export type ExecuteNodexAgentMovePagesResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly output: z.infer<typeof MovePagesV6OutputSchema>;
        readonly duplicate: boolean;
        readonly documentCommits: readonly DocumentCommitRef[];
        readonly affectedDatabaseBlockIds: readonly string[];
        readonly commitSeq: number;
      };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

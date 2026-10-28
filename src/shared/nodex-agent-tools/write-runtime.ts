import type {
  DocumentMutationRequest,
  DocumentOperationResult,
} from "../block-documents/document-operations";
import type { DocumentCommitRef } from "../block-documents/contracts";
import type { BlockTransferRequest } from "../block-transfer";
import type { ToolFailure } from "./base-schemas";
import type { AgentDocumentEditEffects } from "./document-edit-compiler";
import type {
  CreateInput,
  CreateOutput,
  TransferBlocksInput,
  TransferBlocksOutput,
} from "./write-schemas";
import type { NodexAgentTurnContext } from "../nodex-agent-authority";

export interface NodexAgentCallIdentity {
  readonly threadId: string;
  readonly callId: string;
  /** Main-issued bounded identity shared by every phase of one tool call. */
  readonly operationId?: string;
  readonly authority?: NodexAgentTurnContext;
}

export interface NodexAgentDocumentHead {
  readonly documentId: string;
  readonly generation: number;
  readonly expectedHeadSeq: number;
}

export type PreparedNodexAgentCreateDestination =
  | {
      readonly kind: "library";
      readonly beforeBlockId?: string;
    }
  | {
      readonly kind: "document";
      readonly documentId: string;
      readonly generation: number;
      readonly expectedHeadSeq: number;
      readonly parentBlockId?: string;
      readonly beforeBlockId?: string;
    }
  | {
      readonly kind: "data_source";
      readonly dataSourceId: string;
      readonly schemaRevision: number;
      readonly view?: {
        readonly viewId: string;
        readonly viewRevision: number;
        readonly groupKey: string | null;
        readonly beforePageId?: string;
      };
    };

export interface NodexAgentCreatePageCommand extends NodexAgentCallIdentity {
  readonly projectId: string;
  readonly requestHash: string;
  readonly mutationId: string;
  readonly storeEpoch: string;
  readonly input: CreateInput;
  readonly pageId: string;
  readonly bodyBlockIds: readonly string[];
  readonly primaryMembershipId: string;
  readonly targetMembershipId: string;
  readonly destination: PreparedNodexAgentCreateDestination;
}

export interface PrepareNodexAgentCreateRequest extends NodexAgentCallIdentity {
  readonly projectId: string;
  readonly input: CreateInput;
}

export type PrepareNodexAgentCreateResult =
  | {
      readonly ok: true;
      readonly value:
        | { readonly kind: "completed"; readonly output: CreateOutput }
        | {
            readonly kind: "prepared";
            readonly command: NodexAgentCreatePageCommand;
            readonly documentHeads: readonly NodexAgentDocumentHead[];
            readonly createdBodyBlockIds: readonly string[];
            readonly targetMarkdown: string;
          };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

export type ExecuteNodexAgentCreateResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly output: CreateOutput;
        readonly duplicate: boolean;
        readonly documentCommits: readonly DocumentCommitRef[];
        readonly affectedDatabaseBlockIds: readonly string[];
        readonly commitSeq: number;
      };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

export interface NodexAgentTransferCommand extends NodexAgentCallIdentity {
  readonly projectId: string;
  readonly requestHash: string;
  readonly mutationId: string;
  readonly storeEpoch: string;
  readonly input: TransferBlocksInput;
  readonly transfer: BlockTransferRequest;
  readonly destination: PreparedNodexAgentCreateDestination;
  readonly documentHeads: readonly NodexAgentDocumentHead[];
}

export interface PrepareNodexAgentTransferRequest extends NodexAgentCallIdentity {
  readonly projectId: string;
  readonly input: TransferBlocksInput;
}

export type PrepareNodexAgentTransferResult =
  | {
      readonly ok: true;
      readonly value:
        | { readonly kind: "completed"; readonly output: TransferBlocksOutput }
        | {
            readonly kind: "prepared";
            readonly command: NodexAgentTransferCommand;
            readonly documentHeads: readonly NodexAgentDocumentHead[];
          };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

export type ExecuteNodexAgentTransferResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly output: TransferBlocksOutput;
        readonly duplicate: boolean;
        readonly documentCommits: readonly DocumentCommitRef[];
        readonly affectedDatabaseBlockIds: readonly string[];
        readonly commitSeq: number;
      };
    }
  | { readonly ok: false; readonly error: ToolFailure["error"] };

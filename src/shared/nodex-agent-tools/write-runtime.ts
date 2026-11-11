import type { BlockTransferRequest } from "../block-transfer";
import type { TransferBlocksInput } from "./write-schemas";
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
        readonly groupKey?: string | null;
        readonly beforePageId?: string;
      };
    };

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

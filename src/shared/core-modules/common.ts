export type StoreEpoch = string;

export type CoreAdapterKind = "electron_host" | "loopback_http" | "native_cli" | "agent" | "test";

/** Trusted transport identity. This context is never caller-authored JSON. */
export interface BoundModuleContext {
  readonly profileId: string;
  readonly libraryId: string;
  readonly projectId?: string;
  readonly connectionId: string;
  readonly adapter: CoreAdapterKind;
}

export interface ModuleReadRequest<Read> {
  readonly read: Read;
}

export interface ModuleApplyRequest<Intent> {
  readonly operationId: string;
  readonly storeEpoch: string;
  readonly intent: Intent;
}

export interface ModuleReadSnapshot<Value> {
  readonly storeEpoch: string;
  readonly eventHead: number;
  readonly value: Value;
}

export interface ModuleMutationReceipt {
  readonly operationId: string;
  readonly duplicate: boolean;
}

export interface CommittedModuleValue<Value, Receipt = ModuleMutationReceipt> {
  readonly value: Value;
  readonly receipt: Receipt;
  readonly eventSequence: number;
  readonly storeEpoch: string;
}

export type CoreModuleErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "not_found"
  | "ambiguous"
  | "stale_store_epoch"
  | "revision_conflict"
  | "generation_conflict"
  | "head_conflict"
  | "idempotency_key_reused"
  | "document_update_missing_dependencies"
  | "invalid_document_schema"
  | "maintenance_in_progress"
  | "schema_unsupported"
  | "store_corrupt"
  | "protocol_incompatible"
  | "event_replay_unavailable"
  | "core_unavailable";

export type CoreModuleRecoveryDetails =
  | { readonly kind: "none" }
  | { readonly kind: "current_store_epoch"; readonly storeEpoch: string }
  | { readonly kind: "current_revision"; readonly revision: number }
  | {
      readonly kind: "current_document_head";
      readonly generation: number;
      readonly headSeq: number;
    }
  | { readonly kind: "reconnect_document_subscription" }
  | {
      readonly kind: "supported_schema";
      readonly minimum: number;
      readonly maximum: number;
      readonly actual: number;
    };

export interface CoreModuleError {
  readonly code: CoreModuleErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly recovery: CoreModuleRecoveryDetails;
}

export type CoreModuleResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: CoreModuleError };

export interface DeepCoreModule<ReadRequest, ReadResult, ApplyRequest, ApplyResult> {
  read(context: BoundModuleContext, request: ReadRequest): Promise<ReadResult>;
  apply(context: BoundModuleContext, request: ApplyRequest): Promise<ApplyResult>;
}

/**
 * In-process oracle Adapter. It can bind a trusted host identity, but cannot
 * construct receipts, events, projections, or transaction steps.
 */
export const bindInProcessModule = <ReadRequest, ReadResult, ApplyRequest, ApplyResult>(
  module: DeepCoreModule<ReadRequest, ReadResult, ApplyRequest, ApplyResult>,
  bindContext: () => BoundModuleContext,
): {
  readonly read: (request: ReadRequest) => Promise<ReadResult>;
  readonly apply: (request: ApplyRequest) => Promise<ApplyResult>;
} => ({
  read: async (request) => await module.read(bindContext(), request),
  apply: async (request) => await module.apply(bindContext(), request),
});

import type { components } from "@nodex/core-protocol";

export type CoreFailureEvidence = Pick<components["schemas"]["CoreError"], "code" | "recovery">;
type CoreRecovery = CoreFailureEvidence["recovery"];

const coreCodes = {
  invalid_input: true,
  unauthorized: true,
  not_found: true,
  ambiguous: true,
  conflict: true,
  stale_store_epoch: true,
  revision_conflict: true,
  generation_conflict: true,
  head_conflict: true,
  patch_not_found: true,
  patch_ambiguous: true,
  patch_overlap: true,
  idempotency_key_reused: true,
  idempotency_window_expired: true,
  legacy_idempotency_unavailable: true,
  protected_owner_deletion: true,
  document_update_missing_dependencies: true,
  invalid_document_schema: true,
  materialization_stale: true,
  maintenance_in_progress: true,
  schema_unsupported: true,
  store_corrupt: true,
  protocol_incompatible: true,
  event_replay_unavailable: true,
  deadline_exceeded: true,
  cancelled: true,
  overloaded: true,
  resource_exhausted: true,
  core_unavailable: true,
} satisfies Record<CoreFailureEvidence["code"], true>;

const recoveryKinds = {
  none: true,
  reconnect_document_subscription: true,
  document_recovery_artifact: true,
  current_store_epoch: true,
  current_revision: true,
  current_document_head: true,
  supported_schema: true,
  database_view_order_preparation: true,
} satisfies Record<CoreRecovery["kind"], true>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const uint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Validate evidence at IPC/HTTP boundaries without losing the generated Core discriminants. */
export const parseCoreFailureEvidence = (value: unknown): CoreFailureEvidence => {
  if (!record(value) || typeof value.code !== "string" || !Object.hasOwn(coreCodes, value.code)) {
    throw new TypeError("Invalid Core failure code");
  }
  const recovery = parseRecovery(value.recovery);
  return { code: value.code as CoreFailureEvidence["code"], recovery };
};

const parseRecovery = (value: unknown): CoreRecovery => {
  if (!record(value) || typeof value.kind !== "string" || !Object.hasOwn(recoveryKinds, value.kind))
    throw new TypeError("Invalid Core recovery evidence");
  switch (value.kind) {
    case "none":
    case "reconnect_document_subscription":
      return { kind: value.kind };
    case "document_recovery_artifact":
      if (
        typeof value.artifact_id === "string" &&
        value.artifact_id.length > 0 &&
        typeof value.document_id === "string" &&
        value.document_id.length > 0 &&
        typeof value.store_epoch === "string" &&
        value.store_epoch.length > 0 &&
        typeof value.update_id === "string" &&
        value.update_id.length > 0 &&
        uint(value.generation) &&
        value.generation > 0
      ) {
        return {
          kind: value.kind,
          artifact_id: value.artifact_id,
          document_id: value.document_id,
          store_epoch: value.store_epoch,
          update_id: value.update_id,
          generation: value.generation,
        };
      }
      break;
    case "current_store_epoch":
      if (typeof value.store_epoch === "string" && value.store_epoch.length > 0)
        return { kind: value.kind, store_epoch: value.store_epoch };
      break;
    case "database_view_order_preparation":
      if (typeof value.view_id === "string" && value.view_id.length > 0)
        return { kind: value.kind, view_id: value.view_id };
      break;
    case "current_revision":
      if (uint(value.revision)) return { kind: value.kind, revision: value.revision };
      break;
    case "current_document_head":
      if (uint(value.generation) && value.generation > 0 && uint(value.head_seq))
        return { kind: value.kind, generation: value.generation, head_seq: value.head_seq };
      break;
    case "supported_schema":
      if (uint(value.actual) && uint(value.minimum) && uint(value.maximum))
        return {
          kind: value.kind,
          actual: value.actual,
          minimum: value.minimum,
          maximum: value.maximum,
        };
      break;
  }
  throw new TypeError("Invalid Core recovery evidence");
};

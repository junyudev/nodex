import type {
  DocumentRecoveryCommand,
  DocumentRecoveryScope,
} from "../../shared/block-documents/document-recovery";
import {
  contentAccessIdentityKey,
  parseContentAccessContext,
} from "../../shared/content-access-context";
import { isBoundedOperationId } from "../../shared/operation-identity";
import { recoveryRecord } from "./document-recovery-staging";

export type RecoveryResolveOperation = Extract<DocumentRecoveryCommand, { kind: "resolve" }>;

/** Persisted intent is untrusted input; never rebind an uncertain action to another Library world. */
export function parseRecoveryResolveOperation(
  value: unknown,
  scope: DocumentRecoveryScope,
  storeEpoch: string,
  draftId: string,
): RecoveryResolveOperation {
  const command = recoveryRecord(value);
  const resolve = recoveryRecord(command?.resolve);
  const choice = recoveryRecord(resolve?.choice);
  const nonnegative = (input: unknown): input is number =>
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
  if (
    !command ||
    command.kind !== "resolve" ||
    typeof command.operationId !== "string" ||
    !isBoundedOperationId(command.operationId) ||
    command.libraryId !== scope.libraryId ||
    command.storeEpoch !== storeEpoch ||
    !resolve ||
    resolve.draft_id !== draftId ||
    !nonnegative(resolve.revision) ||
    resolve.revision < 1 ||
    !(
      resolve.expected_generation == null ||
      (nonnegative(resolve.expected_generation) && resolve.expected_generation >= 1)
    ) ||
    !(resolve.expected_head_seq == null || nonnegative(resolve.expected_head_seq)) ||
    !choice ||
    !["reconcile", "restore", "copy", "discard", "reopen"].includes(String(choice.kind))
  )
    throw new Error(
      "A saved recovery action cannot be verified. Refresh its result or export the draft before continuing.",
    );
  const accessContext = parseContentAccessContext(command.accessContext);
  if (
    contentAccessIdentityKey({ libraryId: scope.libraryId, accessContext }) !==
    contentAccessIdentityKey(scope)
  )
    throw new Error("A saved recovery action belongs to another access context");
  return command as unknown as RecoveryResolveOperation;
}

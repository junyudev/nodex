import type { components } from "@nodex/core-protocol";
import type { ContentAccessContext } from "../content-access-context";
import type { LocalCommitCommandSuccess } from "../local-commit-delivery";

export type RecoveryDraftCapture = components["schemas"]["RecoveryDraftCapture"];
export type RecoveryDraftSummary = components["schemas"]["RecoveryDraftSummary"];
export type RecoveryDraftInspection = components["schemas"]["RecoveryDraftInspection"];
export type RecoveryDraftResolve = components["schemas"]["RecoveryDraftResolve"];
export type RecoveryRead = components["schemas"]["RecoveryRead"];
export type RecoveryReadValue = components["schemas"]["RecoveryReadValue"];
export type RecoveryPreview = components["schemas"]["RecoveryPreview"];
export type RecoveryChoice = components["schemas"]["RecoveryChoice"]["kind"];

export interface DocumentRecoveryScope {
  readonly libraryId: string;
  readonly accessContext: ContentAccessContext;
}
export interface DocumentRecoveryReadRequest extends DocumentRecoveryScope {
  readonly read: RecoveryRead;
}
export type DocumentRecoveryCommand = DocumentRecoveryScope & {
  readonly operationId: string;
  readonly storeEpoch: string;
} & (
    | { readonly kind: "capture"; readonly capture: RecoveryDraftCapture }
    | { readonly kind: "resolve"; readonly resolve: RecoveryDraftResolve }
  );
export type DocumentRecoveryFailure = import("../core-result").CoreResultFailure;
export type DocumentRecoveryReadResult =
  | { readonly ok: true; readonly value: RecoveryReadValue; readonly storeEpoch: string }
  | DocumentRecoveryFailure;
export type DocumentRecoveryCommandResult =
  | LocalCommitCommandSuccess<RecoveryDraftSummary>
  | DocumentRecoveryFailure;

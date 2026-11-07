import type { RecoveryDraftSummary } from "../../shared/block-documents/document-recovery";
import type { DocumentRecoveryState } from "./document-recovery";
import type { RecoveryStagingSummary } from "./document-recovery-staging";

export type RecoveryReviewEntry =
  | { readonly kind: "received"; readonly key: string; readonly draft: RecoveryDraftSummary }
  | { readonly kind: "staged"; readonly key: string; readonly source: RecoveryStagingSummary };
export const receivedRecoveryKey = (draftId: string): string =>
  JSON.stringify(["received", draftId]);
export const stagedRecoveryKey = (sourceKey: string): string =>
  JSON.stringify(["staged", sourceKey]);

/** Collapse only a proven identical package, never two snapshots that happen to share a document. */
export const recoveryReviewEntries = (state: DocumentRecoveryState): RecoveryReviewEntry[] => {
  const received = state.drafts.map((draft) => ({
    kind: "received" as const,
    key: receivedRecoveryKey(draft.draft_id),
    draft,
  }));
  const staged = state.staged
    .filter(
      (source) =>
        !state.drafts.some(
          (draft) =>
            draft.draft_id === source.draftId &&
            ((source.payloadHash !== null && source.payloadHash === draft.payload_hash) ||
              state.acceptedLocal[source.sourceKey] === draft.draft_id),
        ),
    )
    .map((source) => ({
      kind: "staged" as const,
      key: stagedRecoveryKey(source.sourceKey),
      source,
    }));
  return [...staged, ...received];
};

const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const fullDate = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export const formatRecoveryTime = (value: string, now: Date = new Date()): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return (date.getFullYear() === now.getFullYear() ? shortDate : fullDate).format(date);
};

import { formatRecoveryTime, recoveryReviewEntries } from "./document-recovery-entries";
import { contentRoutingIdentityKey } from "../../shared/content-routing-context";
import type { DocumentRecovery } from "./document-recovery";
import {
  contentRecoveryIssueId,
  type ContentEditIssue,
  type ContentEditIssueSource,
} from "./content-edit-issues";

/** Bounded durable drafts remain actionable even when their original document is closed. */
export function createDocumentRecoveryIssueSource(
  module: DocumentRecovery,
): ContentEditIssueSource {
  let previous: ReturnType<DocumentRecovery["getSnapshot"]> | undefined;
  let issues: readonly ContentEditIssue[] = [];
  return {
    subscribe: module.subscribe,
    getIssues: () => {
      const state = module.getSnapshot();
      if (previous === state) return issues;
      previous = state;
      const drafts = state.drafts.filter((draft) => !draft.resolution);
      const entries: ContentEditIssue[] = drafts.map((draft) => ({
        kind: "draft",
        id: contentRecoveryIssueId(module.scope, state.storeEpoch ?? "unknown", draft.draft_id),
        scope: module.scope,
        location: null,
        title: draft.source_title?.trim() || "Unsaved edits",
        detail: `Edits from ${formatRecoveryTime(draft.created_at)} weren’t saved to this Page. Review what’s different.`,
        actions: [
          {
            kind: "review",
            label: "Review edits",
            scope: module.scope,
            // Opens this draft inside everything its observer lists, so review can move on.
            documentId: module.documentId,
            draftId: draft.draft_id,
          },
        ],
      }));
      const local = recoveryReviewEntries(state).filter((entry) => entry.kind === "staged");
      for (const entry of local) {
        const source = entry.source;
        entries.push({
          kind: "draft",
          id: `${module.scope.libraryId}\0local:${source.sourceKey}`,
          scope: module.scope,
          location: null,
          title: source.sourceKind === "canvas" ? "Unsaved Canvas edits" : "Unsaved Page edits",
          detail:
            source.failure?.message ??
            "These edits are safe on this device and waiting for a recovery copy.",
          actions: [
            {
              kind: "review",
              label: "Review edits",
              scope: module.scope,
              documentId: module.documentId,
              sourceKey: source.sourceKey,
            },
          ],
        });
      }
      const moreLocal = state.stagedCount - state.staged.length;
      const remaining = state.pendingCount - drafts.length;
      if (remaining > 0 || moreLocal > 0 || state.error || state.localError)
        entries.push({
          kind: "draft",
          id: `${contentRoutingIdentityKey(module.scope)}\0${module.documentId ?? "library"}\0recovery-list`,
          scope: module.scope,
          location: null,
          title: state.localError
            ? "Couldn’t read unsaved edits on this device"
            : state.error
              ? "Couldn’t check for unsaved edits"
              : `${remaining + moreLocal} more with unsaved edits`,
          detail: state.localError ?? state.error ?? "Open the review to see the rest.",
          actions: [
            {
              kind: "review",
              label: "Review edits",
              scope: module.scope,
              documentId: module.documentId,
            },
          ],
        });
      issues = entries;
      return issues;
    },
  };
}

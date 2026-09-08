import { contentAccessIdentityKey } from "../../shared/content-access-context";
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
        detail:
          "Earlier edits are retained for review. They do not describe the current document’s save state.",
        actions: [
          {
            kind: "review",
            label: "Review edits",
            scope: module.scope,
            documentId: draft.document_id,
            draftId: draft.draft_id,
          },
        ],
      }));
      const remaining = state.pendingCount - drafts.length;
      if (remaining > 0 || state.error)
        entries.push({
          kind: "draft",
          id: `${contentAccessIdentityKey(module.scope)}\0${module.documentId ?? "library"}\0recovery-list`,
          scope: module.scope,
          location: null,
          title: state.error
            ? "Couldn’t check unsaved edits"
            : `${remaining} more retained ${remaining === 1 ? "draft" : "drafts"}`,
          detail: state.error ?? "Open the review to see the remaining drafts.",
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

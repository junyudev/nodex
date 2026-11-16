import { getIntl } from "@/lib/i18n";
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
        title:
          draft.source_title?.trim() ||
          getIntl().formatMessage({
            id: "lib.documentRecoveryIssues.unsaved",
            defaultMessage: "Unsaved edits",
          }),
        detail: getIntl().formatMessage(
          {
            id: "lib.documentRecoveryIssues.unsavedDetail",
            defaultMessage:
              "Edits from {time} weren’t saved to this Page. Review what’s different.",
          },
          { time: formatRecoveryTime(draft.created_at) },
        ),
        actions: [
          {
            kind: "review",
            label: getIntl().formatMessage({
              id: "lib.documentRecoveryIssues.review",
              defaultMessage: "Review edits",
            }),
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
          title:
            source.sourceKind === "canvas"
              ? getIntl().formatMessage({
                  id: "lib.documentRecoveryIssues.unsavedCanvas",
                  defaultMessage: "Unsaved Canvas edits",
                })
              : getIntl().formatMessage({
                  id: "lib.documentRecoveryIssues.unsavedPage",
                  defaultMessage: "Unsaved Page edits",
                }),
          detail:
            source.failure?.message ??
            getIntl().formatMessage({
              id: "lib.documentRecoveryIssues.awaitingCopy",
              defaultMessage:
                "These edits are safe on this device and waiting for a recovery copy.",
            }),
          actions: [
            {
              kind: "review",
              label: getIntl().formatMessage({
                id: "lib.documentRecoveryIssues.review",
                defaultMessage: "Review edits",
              }),
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
            ? getIntl().formatMessage({
                id: "lib.documentRecoveryIssues.readFailed",
                defaultMessage: "Couldn’t read unsaved edits on this device",
              })
            : state.error
              ? getIntl().formatMessage({
                  id: "lib.documentRecoveryIssues.checkFailed",
                  defaultMessage: "Couldn’t check for unsaved edits",
                })
              : getIntl().formatMessage(
                  {
                    id: "lib.documentRecoveryIssues.more",
                    defaultMessage: "{count} more with unsaved edits",
                  },
                  { count: remaining + moreLocal },
                ),
          detail:
            state.localError ??
            state.error ??
            getIntl().formatMessage({
              id: "lib.documentRecoveryIssues.seeRest",
              defaultMessage: "Open the review to see the rest.",
            }),
          actions: [
            {
              kind: "review",
              label: getIntl().formatMessage({
                id: "lib.documentRecoveryIssues.review",
                defaultMessage: "Review edits",
              }),
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

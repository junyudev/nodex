import { getIntl } from "@/lib/i18n";
import { contentRoutingContextKey } from "../../shared/content-routing-context";
import type { ContentInteractionHistoryScope } from "./content-interaction-history";
import type { HistoryAttention, InteractionHistory } from "./surface-history/owner";
import type {
  ContentEditIssue,
  ContentEditIssueAction,
  ContentEditIssueSource,
} from "./content-edit-issues";

type HistoryIssueOwner = Pick<
  InteractionHistory,
  "attention" | "snapshot" | "subscribe" | "recover" | "reset"
>;

/** Project one exact history failure; native Undo barriers alone never become alerts. */
export function createContentHistoryIssueSource(
  scope: ContentInteractionHistoryScope,
  history: HistoryIssueOwner,
): ContentEditIssueSource {
  let locale = "";
  let previous: readonly HistoryAttention[] | undefined;
  let issues: readonly ContentEditIssue[] = [];
  return {
    subscribe: history.subscribe,
    getIssues: () => {
      const attention = history.attention();
      const activeLocale = getIntl().locale;
      if (attention === previous && locale === activeLocale) return issues;
      locale = activeLocale;
      previous = attention;
      issues = attention.map((issue): ContentEditIssue => {
        const actions: ContentEditIssueAction[] = [];
        if (issue.canRetry)
          actions.push({
            kind: "run",
            label:
              issue.kind === "unconfirmed"
                ? getIntl().formatMessage({
                    id: "lib.contentHistoryIssues.checkAgain",
                    defaultMessage: "Check again",
                  })
                : issue.direction === "undo"
                  ? getIntl().formatMessage({
                      id: "lib.contentHistoryIssues.retryUndo",
                      defaultMessage: "Retry undo",
                    })
                  : getIntl().formatMessage({
                      id: "lib.contentHistoryIssues.retryRedo",
                      defaultMessage: "Retry redo",
                    }),
            run: () => history.recover(issue).result,
          });
        if (issue.canReset)
          actions.push({
            kind: "run",
            label: getIntl().formatMessage({
              id: "lib.contentHistoryIssues.clear",
              defaultMessage: "Clear undo history",
            }),
            confirmation: {
              title: getIntl().formatMessage({
                id: "lib.contentHistoryIssues.clearConfirm",
                defaultMessage: "Clear undo history?",
              }),
              description: getIntl().formatMessage({
                id: "lib.contentHistoryIssues.clearDetail",
                defaultMessage:
                  "Earlier Page and Database edits in this window will no longer be undoable or redoable. Current content will not change. Any submitted action will still finish being confirmed.",
              }),
              confirmLabel: getIntl().formatMessage({
                id: "lib.contentHistoryIssues.clear",
                defaultMessage: "Clear undo history",
              }),
            },
            run: () => {
              const current = history.snapshot();
              if (
                current.ownerId !== issue.ownerId ||
                current.generation !== issue.generation ||
                current.revision !== issue.revision
              )
                throw new Error(
                  getIntl().formatMessage({
                    id: "lib.contentHistoryIssues.changed",
                    defaultMessage:
                      "The content history changed. Review the current issue before clearing it.",
                  }),
                );
              history.reset();
            },
          });
        return {
          kind: "history",
          id: [
            scope.libraryId,
            contentRoutingContextKey(scope.routingContext),
            scope.storeEpoch,
            issue.ownerId,
            issue.generation,
            issue.entryId,
            issue.direction,
          ].join("\0"),
          scope,
          location: issue.location,
          title:
            issue.kind === "unconfirmed"
              ? getIntl().formatMessage(
                  {
                    id: "lib.contentHistoryIssues.unconfirmed",
                    defaultMessage:
                      "{direction, select, forward {Action} undo {Undo} other {Redo}} not confirmed: {label}",
                  },
                  { direction: issue.direction, label: issue.label },
                )
              : getIntl().formatMessage(
                  {
                    id: "lib.contentHistoryIssues.failed",
                    defaultMessage: "{direction, select, undo {Undo} other {Redo}} failed: {label}",
                  },
                  { direction: issue.direction, label: issue.label },
                ),
          detail: issue.checking
            ? getIntl().formatMessage({
                id: "lib.contentHistoryIssues.checking",
                defaultMessage: "Checking the action…",
              })
            : issue.kind === "unconfirmed"
              ? getIntl().formatMessage(
                  {
                    id: "lib.contentHistoryIssues.possiblySaved",
                    defaultMessage: "This action may already be saved. {reason}",
                  },
                  { reason: issue.reason },
                )
              : issue.reason,
          actions,
        };
      });
      return issues;
    },
  };
}

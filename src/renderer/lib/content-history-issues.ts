import { contentAccessContextKey } from "../../shared/content-access-context";
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
  let previous: readonly HistoryAttention[] | undefined;
  let issues: readonly ContentEditIssue[] = [];
  return {
    subscribe: history.subscribe,
    getIssues: () => {
      const attention = history.attention();
      if (attention === previous) return issues;
      previous = attention;
      issues = attention.map((issue): ContentEditIssue => {
        const direction = issue.direction === "undo" ? "Undo" : "Redo";
        const actions: ContentEditIssueAction[] = [];
        if (issue.canRetry)
          actions.push({
            kind: "run",
            label:
              issue.kind === "unconfirmed" ? "Check again" : `Retry ${direction.toLowerCase()}`,
            run: () => history.recover(issue).result,
          });
        if (issue.canReset)
          actions.push({
            kind: "run",
            label: "Clear undo history",
            confirmation: {
              title: "Clear undo history?",
              description:
                "Earlier Page and Database edits in this window will no longer be undoable or redoable. Current content will not change. Any submitted action will still finish being confirmed.",
              confirmLabel: "Clear undo history",
            },
            run: () => {
              const current = history.snapshot();
              if (
                current.ownerId !== issue.ownerId ||
                current.generation !== issue.generation ||
                current.revision !== issue.revision
              )
                throw new Error(
                  "The content history changed. Review the current issue before clearing it.",
                );
              history.reset();
            },
          });
        return {
          kind: "history",
          id: [
            scope.libraryId,
            contentAccessContextKey(scope.accessContext),
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
              ? `${issue.direction === "forward" ? "Action" : direction} not confirmed: ${issue.label}`
              : `${direction} failed: ${issue.label}`,
          detail: issue.checking
            ? "Checking the action…"
            : issue.kind === "unconfirmed"
              ? `This action may already be saved. ${issue.reason}`
              : issue.reason,
          actions,
        };
      });
      return issues;
    },
  };
}

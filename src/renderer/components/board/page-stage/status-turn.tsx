import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { useState } from "react";
import type { PageTurn } from "../../../../shared/page-turn";
import type { ExecutionHoldScope } from "../../../../shared/work-application";
import { SPACE_ACTION_REASON_MESSAGES } from "../../../../shared/space-connection";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { PageTurnPhraseView } from "@/components/workbench/page-turn-chip";
import { usePageTurnHolder } from "@/components/workbench/page-turn";
import { setExecutionHold } from "@/lib/execution-holds-runtime";
import { readableIpcError } from "@/lib/ipc-error-message";
import { pageTurnPhrase } from "@/lib/page-turn-phrase";
import { usePageTurn } from "@/lib/page-turn-runtime";
import { acceptReviewWithUndo, useReviewAccepted } from "@/lib/page-accept-undo";
import { useSpaceHostAvailable } from "@/lib/space-host-runtime";
import { startWork } from "@/lib/work-graph-runtime";

/** Reasons whose next step happens in the Page's active chat. */
const CHAT_REASONS = new Set<PageTurn["reason"]>([
  "question",
  "approval",
  "reply",
  "blocked",
  "failed",
  "stalled",
  "working",
]);

type StatusTurnAction =
  | { readonly kind: "resume"; readonly label: string; readonly scope: ExecutionHoldScope }
  | { readonly kind: "accept" | "start" | "open_chat"; readonly label: string };

/** The one action a Page's Status offers for its turn, when the reader can take it from here. */
const statusTurnAction = (
  intl: IntlShape,
  turn: PageTurn,
  canOpenChat: boolean,
): StatusTurnAction | null => {
  const hold = turn.reason === "paused" ? turn.hold : null;
  if (hold)
    return {
      kind: "resume",
      scope: hold.scope,
      label:
        hold.scope.kind === "project"
          ? intl.formatMessage({
              id: "board.statusTurn.resumeProject",
              defaultMessage: "Resume Project",
            })
          : hold.scope.kind === "space"
            ? intl.formatMessage({
                id: "board.statusTurn.resumeWork",
                defaultMessage: "Resume all work",
              })
            : intl.formatMessage({ id: "board.statusTurn.resume", defaultMessage: "Resume" }),
    };
  if (turn.reason === "review")
    return {
      kind: "accept",
      label: intl.formatMessage({ id: "board.statusTurn.accept", defaultMessage: "Accept" }),
    };
  if (turn.reason === "ready_to_start")
    return {
      kind: "start",
      label: intl.formatMessage({ id: "board.statusTurn.start", defaultMessage: "Start" }),
    };
  if (canOpenChat && CHAT_REASONS.has(turn.reason))
    return {
      kind: "open_chat",
      label: intl.formatMessage({ id: "board.statusTurn.openChat", defaultMessage: "Open chat" }),
    };
  return null;
};

/**
 * The Status row's second half: whose move the Page waits for, then the one action that makes it.
 * A Page without work says nothing here, so its Status row stays a plain Status row.
 */
export function PageStatusTurn({
  pageId,
  onOpenChat,
  onOpenPage,
}: {
  readonly pageId: string;
  readonly onOpenPage?: (pageId: string) => void;
  readonly onOpenChat?: (sessionId: string) => void | Promise<void>;
}) {
  const intl = useIntl();
  const { data } = usePageTurn(pageId);
  const [pending, setPending] = useState(false);
  const hostAvailable = useSpaceHostAvailable();
  const turn = data?.turn;
  const holder = usePageTurnHolder(turn);
  // A review accepted here or anywhere else reads as decided while its Undo is offered.
  const accepted = useReviewAccepted(turn?.reason === "review" ? turn : null);
  const phrase = turn ? pageTurnPhrase(turn, holder) : null;
  if (!turn || !phrase || accepted) return null;
  const run = (action: () => Promise<unknown>) => {
    setPending(true);
    void action()
      .catch((error: unknown) =>
        toast.danger(
          readableIpcError(
            error,
            getIntl().formatMessage({
              id: "board.statusTurn.updateFailed",
              defaultMessage: "Couldn’t update this Page",
            }),
          ),
        ),
      )
      .finally(() => setPending(false));
  };
  const chat = data?.activeChat?.session_id;
  const action = statusTurnAction(intl, turn, Boolean(chat && onOpenChat));
  const perform = () => {
    if (action?.kind === "resume") run(() => setExecutionHold(action.scope, false));
    // A review that asks the reader is held to the episode they see; another Member's is not.
    else if (action?.kind === "accept")
      acceptReviewWithUndo(turn, { fenced: holder.you || turn.actor.kind === "members" });
    else if (action?.kind === "start") run(() => startWork({ pageId, again: false }));
    else if (action?.kind === "open_chat" && chat) void onOpenChat?.(chat);
  };
  const unavailable = action?.kind === "start" && !hostAvailable;
  const unavailableReason = intl.formatMessage(SPACE_ACTION_REASON_MESSAGES.remoteAgent);
  const button = action ? (
    <NodexButton size="xs" variant="outline" disabled={pending || unavailable} onClick={perform}>
      {action.label}
    </NodexButton>
  ) : null;
  return (
    <span data-page-turn-line="true" className="flex min-w-0 flex-wrap items-center gap-x-2">
      <PageTurnPhraseView
        turn={turn}
        phrase={phrase}
        glyph={false}
        onOpenPage={onOpenPage}
        className="text-sm/5 [font-weight:400]"
      />
      {unavailable ? (
        <NodexTooltip tooltipContent={unavailableReason}>
          <span aria-label={unavailableReason}>{button}</span>
        </NodexTooltip>
      ) : (
        button
      )}
    </span>
  );
}

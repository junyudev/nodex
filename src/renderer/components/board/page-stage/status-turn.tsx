import { useState } from "react";
import type { PageTurn } from "../../../../shared/page-turn";
import type { ExecutionHoldScope } from "../../../../shared/work-application";
import { REMOTE_AGENT_REASON } from "../../../../shared/space-connection";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { PageTurnPhraseView } from "@/components/workbench/page-turn-chip";
import { usePageTurnHolder } from "@/components/workbench/page-turn";
import { setExecutionHold } from "@/lib/execution-holds-runtime";
import { readableIpcError } from "@/lib/ipc-error-message";
import { pageTurnPhrase } from "@/lib/page-turn-phrase";
import { acceptPageWork, usePageTurn } from "@/lib/page-turn-runtime";
import { useSpaceHostAvailable } from "@/lib/space-host-runtime";
import { startWork } from "@/lib/work-graph-runtime";

/** Reasons whose next step happens in the Page's active chat. */
const CHAT_REASONS = new Set<PageTurn["reason"]>([
  "question",
  "approval",
  "blocked",
  "failed",
  "stalled",
  "working",
]);

type StatusTurnAction =
  | { readonly kind: "resume"; readonly label: string; readonly scope: ExecutionHoldScope }
  | { readonly kind: "accept" | "start" | "open_chat"; readonly label: string };

/** The one action a Page's Status offers for its turn, when the reader can take it from here. */
const statusTurnAction = (turn: PageTurn, canOpenChat: boolean): StatusTurnAction | null => {
  const hold = turn.reason === "paused" ? turn.hold : null;
  if (hold)
    return {
      kind: "resume",
      scope: hold.scope,
      label:
        hold.scope.kind === "project"
          ? "Resume Project"
          : hold.scope.kind === "space"
            ? "Resume all work"
            : "Resume",
    };
  if (turn.reason === "review") return { kind: "accept", label: "Accept" };
  if (turn.reason === "ready_to_start") return { kind: "start", label: "Start" };
  if (canOpenChat && CHAT_REASONS.has(turn.reason))
    return { kind: "open_chat", label: "Open chat" };
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
  const { data } = usePageTurn(pageId);
  const [pending, setPending] = useState(false);
  const hostAvailable = useSpaceHostAvailable();
  const turn = data?.turn;
  const holder = usePageTurnHolder(turn);
  const phrase = turn ? pageTurnPhrase(turn, holder) : null;
  if (!turn || !phrase) return null;
  const run = (action: () => Promise<unknown>) => {
    setPending(true);
    void action()
      .catch((error: unknown) => toast.danger(readableIpcError(error, "Couldn’t update this Page")))
      .finally(() => setPending(false));
  };
  const chat = data?.activeChat?.session_id;
  const action = statusTurnAction(turn, Boolean(chat && onOpenChat));
  const perform = () => {
    if (action?.kind === "resume") run(() => setExecutionHold(action.scope, false));
    else if (action?.kind === "accept") run(() => acceptPageWork(pageId));
    else if (action?.kind === "start") run(() => startWork({ pageId, again: false }));
    else if (action?.kind === "open_chat" && chat) void onOpenChat?.(chat);
  };
  const unavailable = action?.kind === "start" && !hostAvailable;
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
        <NodexTooltip tooltipContent={REMOTE_AGENT_REASON}>
          <span aria-label={REMOTE_AGENT_REASON}>{button}</span>
        </NodexTooltip>
      ) : (
        button
      )}
    </span>
  );
}

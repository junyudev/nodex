import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ForkIcon, PageIcon, SendToChatIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { toastFailure } from "@/lib/failure-toast";
import { defineMessage, getIntl, useIntl } from "@/lib/i18n";
import { dispatchInboxEntries, prepareInboxConfirmation } from "@/lib/inbox-runtime";
import { useNodexReferenceRouter } from "@/lib/nodex-reference-router";
import { projectSessionDetailQueryOptions } from "@/lib/query-options";
import { presentSessionTitle } from "@/lib/session-title-presentation";
import { StatusIcon } from "@/lib/status-presentation";
import { cn } from "@/lib/utils";
import type {
  InboxDispatchAction,
  SessionFollowUp,
  SessionFollowUpState,
} from "../../../shared/inbox";
import { describeInboxSnoozedOutcome } from "./inbox-snooze";
import { invalidateInbox } from "./use-inbox";

/**
 * Follow-ups are the Inbox messages a chat's Agent left for later. The chat that raised them
 * shows them where they were raised and lets the person hand them back to that chat, or to a
 * fork of it, with the same fenced Inbox decision the Inbox itself makes.
 */

/** Whether the person can still decide where a follow-up goes. */
export const isFollowUpOpen = (state: SessionFollowUpState): boolean =>
  state.kind === "waiting" || state.kind === "snoozed" || state.kind === "failed";

/** Open follow-ups first; each group keeps Core's newest-first order. */
export const orderFollowUps = (items: readonly SessionFollowUp[]): SessionFollowUp[] => [
  ...items.filter((item) => isFollowUpOpen(item.state)),
  ...items.filter((item) => !isFollowUpOpen(item.state)),
];

const HANDOFF_PROMPT = defineMessage({
  id: "inbox.followUps.handoffPrompt",
  defaultMessage: "Please handle this follow-up you left in the Inbox.",
});

/**
 * Hands an Agent's message back to the chat that sent it, or to a fork of that chat. The chat
 * already knows why it raised the follow-up, so the prompt only asks it to act; the message
 * itself follows, quoted as every Inbox send composes it.
 */
export function followUpHandoffAction(
  type: "send_to_chat" | "fork_chat",
  sessionId: string,
  intl = getIntl(),
): Extract<InboxDispatchAction, { type: "send_to_chat" | "fork_chat" }> {
  return {
    type,
    sessionId,
    prompt: intl.formatMessage(HANDOFF_PROMPT),
    additions: [],
    skills: [],
  };
}

export interface FollowUpActions {
  readonly isPending: (pageId: string) => boolean;
  /** Sends the follow-up to the chat that raised it, through that chat's queue. */
  readonly continueHere: (followUp: SessionFollowUp) => void;
  /** Starts a fork of the chat that raised it, with the follow-up as its first message. */
  readonly fork: (followUp: SessionFollowUp) => void;
}

/**
 * Decides where one follow-up goes, fenced by the message the chat showed. Resolves to the chat
 * that receives it.
 */
async function dispatchFollowUp(
  storeEpoch: string,
  followUp: SessionFollowUp,
  action: InboxDispatchAction,
): Promise<string | null> {
  const prepared = await prepareInboxConfirmation({
    kind: "direct",
    storeEpoch,
    pageIds: [followUp.pageId],
    action,
    basis: [followUp.basis],
  });
  if (prepared.kind !== "direct") return null;
  const { kind: _kind, ...dispatch } = prepared;
  await dispatchInboxEntries(dispatch);
  return prepared.sessionId;
}

/** The decisions a chat offers on its own follow-ups; `sessionId` is that chat. */
export function useFollowUpActions(input: {
  readonly sessionId: string;
  readonly storeEpoch: string | null;
}): FollowUpActions {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const router = useNodexReferenceRouter();
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const mark = (pageId: string, busy: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (busy) next.add(pageId);
      else next.delete(pageId);
      return next;
    });

  const decide = (
    followUp: SessionFollowUp,
    action: InboxDispatchAction,
    failure: string,
  ): Promise<string | null> => {
    const storeEpoch = input.storeEpoch;
    if (storeEpoch === null || pending.has(followUp.pageId)) return Promise.resolve(null);
    mark(followUp.pageId, true);
    return dispatchFollowUp(storeEpoch, followUp, action)
      .catch((error: unknown) => {
        toastFailure(failure, error, { id: `follow-up:${followUp.pageId}` });
        return null;
      })
      .finally(() => {
        mark(followUp.pageId, false);
        void invalidateInbox(queryClient);
      });
  };

  return {
    isPending: (pageId) => pending.has(pageId),
    continueHere: (followUp) =>
      void decide(
        followUp,
        followUpHandoffAction("send_to_chat", input.sessionId, intl),
        intl.formatMessage({
          id: "inbox.followUps.continueFailed",
          defaultMessage: "Couldn’t send the follow-up to this chat",
        }),
      ),
    fork: (followUp) =>
      void decide(
        followUp,
        followUpHandoffAction("fork_chat", input.sessionId, intl),
        intl.formatMessage({
          id: "inbox.followUps.forkFailed",
          defaultMessage: "Couldn’t fork this chat for the follow-up",
        }),
      ).then((forkSessionId) => {
        if (!forkSessionId) return;
        toast.success(
          getIntl().formatMessage({
            id: "inbox.followUps.forked",
            defaultMessage: "Forked into a new chat",
          }),
          router
            ? {
                id: `follow-up-fork:${followUp.pageId}`,
                secondaryAction: {
                  label: getIntl().formatMessage({
                    id: "inbox.followUps.openFork",
                    defaultMessage: "Open",
                  }),
                  onClick: () =>
                    void router.open(
                      { kind: "session", sessionId: forkSessionId },
                      {
                        source: { surface: "conversation", sessionId: input.sessionId },
                        gesture: { kind: "activate" },
                      },
                    ),
                },
              }
            : undefined,
        );
      }),
  };
}

/** A follow-up's glyph: its Page's Status, as on Board and List, or the Page itself. */
export function FollowUpGlyph({
  followUp,
  className,
}: {
  readonly followUp: SessionFollowUp;
  readonly className?: string;
}) {
  return followUp.status ? (
    <StatusIcon statusId={followUp.status.id} className={cn("shrink-0", className)} />
  ) : (
    <PageIcon className={cn("shrink-0", className)} />
  );
}

/**
 * The chat a follow-up went to, as the chat showing it sees it: itself, a chat started for the
 * follow-up alone (a fork or new chat titled after it), or another chat by name.
 */
export type FollowUpDestination =
  | { readonly kind: "here" }
  | { readonly kind: "own" }
  | { readonly kind: "other"; readonly title: string };

/** Resolves where a follow-up's chat is; null while it waits or is held outside any chat. */
export function useFollowUpDestination(
  followUp: SessionFollowUp,
  /** The chat showing the follow-up. */
  sessionId: string,
): FollowUpDestination | null {
  const intl = useIntl();
  const { state } = followUp;
  const chatId = state.kind === "delivering" || state.kind === "inChat" ? state.sessionId : null;
  const chat = useQuery({
    ...projectSessionDetailQueryOptions(chatId ?? ""),
    enabled: chatId !== null && chatId !== sessionId,
  }).data;
  if (chatId === null) return null;
  if (chatId === sessionId) return { kind: "here" };
  const title = presentSessionTitle(chat ?? null, intl);
  return title === followUp.title ? { kind: "own" } : { kind: "other", title };
}

/** Where a follow-up stands, in a few words; another chat is named unless it is its own. */
export function describeFollowUpState(
  followUp: SessionFollowUp,
  destination: FollowUpDestination | null,
  now: Date,
  intl = getIntl(),
): string {
  const { state } = followUp;
  switch (state.kind) {
    case "waiting":
      return intl.formatMessage({
        id: "inbox.followUps.waiting",
        defaultMessage: "Waiting in Inbox",
      });
    case "snoozed":
      return describeInboxSnoozedOutcome(state.until, now);
    case "delivering":
      return destination?.kind === "here"
        ? intl.formatMessage({
            id: "inbox.followUps.sendingHere",
            defaultMessage: "Sending to this chat…",
          })
        : destination?.kind === "other"
          ? intl.formatMessage(
              { id: "inbox.followUps.sendingTo", defaultMessage: "Sending to “{chat}”…" },
              { chat: destination.title },
            )
          : intl.formatMessage({
              id: "inbox.followUps.startingOwnChat",
              defaultMessage: "Starting its own chat…",
            });
    case "inChat":
      return destination?.kind === "here"
        ? intl.formatMessage({ id: "inbox.followUps.inThisChat", defaultMessage: "In this chat" })
        : destination?.kind === "other"
          ? intl.formatMessage(
              { id: "inbox.followUps.inChat", defaultMessage: "In “{chat}”" },
              { chat: destination.title },
            )
          : intl.formatMessage({
              id: "inbox.followUps.inOwnChat",
              defaultMessage: "In its own chat",
            });
    case "held":
    case "done":
      return (
        followUp.status?.label ??
        intl.formatMessage({ id: "inbox.followUps.handled", defaultMessage: "Handled" })
      );
    case "notes":
      return intl.formatMessage({
        id: "inbox.followUps.savedToNotes",
        defaultMessage: "Saved to Notes",
      });
    case "failed":
      return intl.formatMessage(
        { id: "inbox.followUps.failed", defaultMessage: "Couldn’t start · {reason}" },
        { reason: state.message },
      );
  }
}

/**
 * Where a follow-up stands in a word or two, for a row too narrow to name another chat; the
 * row's tooltip carries the full state.
 */
export function describeFollowUpPlace(
  followUp: SessionFollowUp,
  destination: FollowUpDestination | null,
  intl = getIntl(),
): string {
  const { state } = followUp;
  switch (state.kind) {
    case "waiting":
      return intl.formatMessage({ id: "inbox.followUps.place.waiting", defaultMessage: "Waiting" });
    case "snoozed":
      return intl.formatMessage({ id: "inbox.followUps.place.snoozed", defaultMessage: "Snoozed" });
    case "delivering":
      return intl.formatMessage({
        id: "inbox.followUps.place.sending",
        defaultMessage: "Sending…",
      });
    case "inChat":
      return destination?.kind === "here"
        ? intl.formatMessage({ id: "inbox.followUps.place.thisChat", defaultMessage: "This chat" })
        : destination?.kind === "other"
          ? intl.formatMessage({
              id: "inbox.followUps.place.otherChat",
              defaultMessage: "Other chat",
            })
          : intl.formatMessage({ id: "inbox.followUps.place.ownChat", defaultMessage: "Own chat" });
    case "held":
    case "done":
      return (
        followUp.status?.label ??
        intl.formatMessage({ id: "inbox.followUps.handled", defaultMessage: "Handled" })
      );
    case "notes":
      return intl.formatMessage({ id: "inbox.followUps.place.notes", defaultMessage: "Notes" });
    case "failed":
      return intl.formatMessage({
        id: "inbox.followUps.place.failed",
        defaultMessage: "Couldn’t start",
      });
  }
}

/**
 * The decision an open follow-up asks for. `Continue here` is the one labeled action on a card;
 * a dense row shows both as icons. Fork appears only where the chat can be forked.
 */
export function FollowUpDecisions({
  followUp,
  actions,
  canFork,
  density,
}: {
  readonly followUp: SessionFollowUp;
  readonly actions: FollowUpActions;
  readonly canFork: boolean;
  readonly density: "card" | "row";
}) {
  const intl = useIntl();
  if (!isFollowUpOpen(followUp.state)) return null;
  const busy = actions.isPending(followUp.pageId);
  const continueLabel = intl.formatMessage({
    id: "inbox.followUps.continueHere",
    defaultMessage: "Continue here",
  });
  const continueHint = intl.formatMessage({
    id: "inbox.followUps.continueHereHint",
    defaultMessage: "Send it to this chat",
  });
  const forkLabel = intl.formatMessage({
    id: "inbox.followUps.fork",
    defaultMessage: "Fork into a new chat",
  });
  const iconButton = (label: string, Icon: typeof ForkIcon, onClick: () => void) => (
    <NodexTooltip tooltipContent={label} side="top">
      <NodexButton
        size="icon-xs"
        variant="ghost"
        aria-label={label}
        disabled={busy}
        className="text-token-description-foreground hover:text-token-foreground"
        onClick={onClick}
      >
        <Icon className="icon-xs" />
      </NodexButton>
    </NodexTooltip>
  );
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {density === "card" ? (
        <NodexTooltip tooltipContent={continueHint} side="top">
          <NodexButton
            variant="outline"
            size="xs"
            disabled={busy}
            className="gap-1 bg-transparent"
            onClick={() => actions.continueHere(followUp)}
          >
            <SendToChatIcon className="icon-2xs" />
            {continueLabel}
          </NodexButton>
        </NodexTooltip>
      ) : (
        iconButton(continueHint, SendToChatIcon, () => actions.continueHere(followUp))
      )}
      {canFork ? iconButton(forkLabel, ForkIcon, () => actions.fork(followUp)) : null}
    </span>
  );
}

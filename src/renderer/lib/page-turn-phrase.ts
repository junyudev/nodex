import { getIntl } from "@/lib/i18n";
import type { PageTurn, TurnReason } from "../../shared/page-turn";

/** Who holds a Page's turn, as the reader reads it. Core decides the holder; this only names it. */
export interface PageTurnHolder {
  /** The reader is the person whose move it is. */
  readonly you: boolean;
  /** A person's display name, or the Agent's provider name, such as Codex. */
  readonly name: string;
}

/** `attention` and `danger` ask the reader to act; every other phrase reads quietly. */
export type PageTurnTone = "attention" | "danger" | "quiet";

export interface PageTurnPhrase {
  readonly text: string;
  readonly tone: PageTurnTone;
  /** A fuller line for a tooltip and accessible name, when the phrase leaves out who or how far. */
  readonly detail: string | null;
}

export const ordinal = (position: number): string =>
  getIntl().formatMessage(
    {
      id: "lib.pageTurnPhrase.ordinal",
      defaultMessage: "{position, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
    },
    { position },
  );

/** Reasons that wait for one person, worded for whoever reads them. */
const ASKS: Partial<Record<TurnReason, (holder: PageTurnHolder) => string>> = {
  triage: (holder) =>
    holder.you
      ? getIntl().formatMessage({
          id: "lib.pageTurnPhrase.decisionYour",
          defaultMessage: "Needs your decision",
        })
      : getIntl().formatMessage(
          {
            id: "lib.pageTurnPhrase.decisionOther",
            defaultMessage: "Waiting for {name}’s decision",
          },
          { name: holder.name },
        ),
  delivery_recovery: (holder) =>
    holder.you
      ? getIntl().formatMessage({
          id: "lib.pageTurnPhrase.deliveryYour",
          defaultMessage: "Delivery needs your attention",
        })
      : getIntl().formatMessage(
          {
            id: "lib.pageTurnPhrase.deliveryOther",
            defaultMessage: "Delivery needs {name}’s attention",
          },
          { name: holder.name },
        ),
  question: (holder) =>
    holder.you
      ? getIntl().formatMessage({
          id: "lib.pageTurnPhrase.answerYour",
          defaultMessage: "Needs your answer",
        })
      : getIntl().formatMessage(
          { id: "lib.pageTurnPhrase.answerOther", defaultMessage: "Waiting for {name}’s answer" },
          { name: holder.name },
        ),
  approval: (holder) =>
    holder.you
      ? getIntl().formatMessage({
          id: "lib.pageTurnPhrase.approvalYour",
          defaultMessage: "Needs your approval",
        })
      : getIntl().formatMessage(
          {
            id: "lib.pageTurnPhrase.approvalOther",
            defaultMessage: "Waiting for {name}’s approval",
          },
          { name: holder.name },
        ),
  review: (holder) =>
    holder.you
      ? getIntl().formatMessage({
          id: "lib.pageTurnPhrase.reviewYour",
          defaultMessage: "Ready for your review",
        })
      : getIntl().formatMessage(
          { id: "lib.pageTurnPhrase.reviewOther", defaultMessage: "Ready for {name}’s review" },
          { name: holder.name },
        ),
  reply: (holder) =>
    holder.you
      ? getIntl().formatMessage({
          id: "lib.pageTurnPhrase.replyYour",
          defaultMessage: "Needs your reply",
        })
      : getIntl().formatMessage(
          { id: "lib.pageTurnPhrase.replyOther", defaultMessage: "Waiting for {name}’s reply" },
          { name: holder.name },
        ),
  blocked: (holder) =>
    holder.you
      ? getIntl().formatMessage({
          id: "lib.pageTurnPhrase.blockedYou",
          defaultMessage: "Blocked · needs you",
        })
      : getIntl().formatMessage(
          { id: "lib.pageTurnPhrase.blockedOther", defaultMessage: "Blocked · needs {name}" },
          { name: holder.name },
        ),
  failed: (holder) =>
    holder.you
      ? getIntl().formatMessage({
          id: "lib.pageTurnPhrase.failedYou",
          defaultMessage: "Failed · needs you",
        })
      : getIntl().formatMessage(
          { id: "lib.pageTurnPhrase.failedOther", defaultMessage: "Failed · needs {name}" },
          { name: holder.name },
        ),
  stalled: (holder) =>
    holder.you
      ? getIntl().formatMessage({
          id: "lib.pageTurnPhrase.stalledYou",
          defaultMessage: "Stalled · needs you",
        })
      : getIntl().formatMessage(
          { id: "lib.pageTurnPhrase.stalledOther", defaultMessage: "Stalled · needs {name}" },
          { name: holder.name },
        ),
};

const quiet = (text: string, detail: string | null = null): PageTurnPhrase => ({
  text,
  tone: "quiet",
  detail,
});

/**
 * Whose move a Page waits for, in the words every surface uses: the Page's Status row, Board cards,
 * List rows and Inbox rows. It formats Core's decision and never decides whose turn comes next.
 */
export function pageTurnPhrase(turn: PageTurn, holder: PageTurnHolder): PageTurnPhrase | null {
  const { reason, actor } = turn;
  if (!reason || actor.kind === "none") return null;
  const reader = actor.kind === "members" ? { ...holder, you: true } : holder;
  const ask = ASKS[reason];
  if (ask)
    return {
      text: ask(reader),
      tone: reader.you
        ? reason === "failed" || reason === "delivery_recovery"
          ? "danger"
          : "attention"
        : "quiet",
      detail: null,
    };
  switch (reason) {
    case "working":
      return quiet(
        holder.you
          ? getIntl().formatMessage({
              id: "lib.pageTurnPhrase.workingYou",
              defaultMessage: "You’re working",
            })
          : getIntl().formatMessage(
              { id: "lib.pageTurnPhrase.working", defaultMessage: "{name} is working" },
              { name: holder.name },
            ),
      );
    case "starting":
      return quiet(
        getIntl().formatMessage(
          { id: "lib.pageTurnPhrase.starting", defaultMessage: "{name} is starting" },
          { name: holder.name },
        ),
      );
    case "queued":
      return quiet(
        actor.kind === "queue"
          ? getIntl().formatMessage(
              { id: "lib.pageTurnPhrase.queuedPosition", defaultMessage: "Queued · {position}" },
              { position: ordinal(actor.position) },
            )
          : getIntl().formatMessage({ id: "lib.pageTurnPhrase.queued", defaultMessage: "Queued" }),
      );
    case "waiting_on_prerequisite":
      return quiet(
        actor.kind === "page" && actor.key != null
          ? getIntl().formatMessage(
              { id: "lib.pageTurnPhrase.waitingForPage", defaultMessage: "Waiting for {key}" },
              { key: actor.key },
            )
          : getIntl().formatMessage({
              id: "lib.pageTurnPhrase.waitingForPrerequisite",
              defaultMessage: "Waiting for another Page",
            }),
      );
    case "ready_to_start":
      return quiet(
        getIntl().formatMessage({
          id: "lib.pageTurnPhrase.ready",
          defaultMessage: "Ready to start",
        }),
      );
    case "paused": {
      const scope = turn.hold?.scope.kind;
      return quiet(
        getIntl().formatMessage({ id: "lib.pageTurnPhrase.paused", defaultMessage: "Paused" }),
        getIntl().formatMessage(
          {
            id: "lib.pageTurnPhrase.pauseDetail",
            defaultMessage:
              "{person} paused {scope, select, project {this Project} space {all work} other {this Page}}",
          },
          {
            person: holder.you
              ? getIntl().formatMessage({ id: "lib.pageTurnPhrase.you", defaultMessage: "You" })
              : holder.name,
            scope: scope ?? "page",
          },
        ),
      );
    }
    default:
      return null;
  }
}

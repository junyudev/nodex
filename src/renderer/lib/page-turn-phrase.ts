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
  `${position}${position % 100 >= 11 && position % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[position % 10] ?? "th")}`;

const possessive = (name: string) => `${name}’s`;

/** Reasons that wait for one person, worded for whoever reads them. */
const ASKS: Partial<Record<TurnReason, (holder: PageTurnHolder) => string>> = {
  question: (holder) =>
    holder.you ? "Needs your answer" : `Waiting for ${possessive(holder.name)} answer`,
  approval: (holder) =>
    holder.you ? "Needs your approval" : `Waiting for ${possessive(holder.name)} approval`,
  review: (holder) => `Ready for ${holder.you ? "your" : possessive(holder.name)} review`,
  blocked: (holder) => `Blocked · needs ${holder.you ? "you" : holder.name}`,
  failed: (holder) => `Failed · needs ${holder.you ? "you" : holder.name}`,
  stalled: (holder) => `Stalled · needs ${holder.you ? "you" : holder.name}`,
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
  const ask = ASKS[reason];
  if (ask)
    return {
      text: ask(holder),
      tone: holder.you ? (reason === "failed" ? "danger" : "attention") : "quiet",
      detail: null,
    };
  switch (reason) {
    case "working":
      return quiet(holder.you ? "You’re working" : `${holder.name} is working`);
    case "starting":
      return quiet(`${holder.name} is starting`);
    case "queued":
      return quiet(actor.kind === "queue" ? `Queued · ${ordinal(actor.position)}` : "Queued");
    case "waiting_on_prerequisite":
      return quiet(
        `Waiting for ${actor.kind === "page" ? (actor.key ?? "another Page") : "another Page"}`,
      );
    case "ready_to_start":
      return quiet("Ready to start");
    case "paused": {
      const scope = turn.hold?.scope.kind;
      return quiet(
        "Paused",
        `${holder.you ? "You" : holder.name} paused ${scope === "project" ? "this Project" : scope === "space" ? "all work" : "this Page"}`,
      );
    }
    default:
      return null;
  }
}

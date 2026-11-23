/** The provider's verdict on a final answer, as the app-server or the Agent Runtime carries it. */
export interface CodexAnswerModerationInput {
  readonly moderated: boolean;
  readonly display?:
    | { readonly mode: "show"; readonly annotation?: object | null }
    | { readonly mode: "hide" }
    | { readonly mode: "block"; readonly reason: { readonly kind: "cyber" | "protection" } }
    | null;
}

/**
 * How a moderated final answer is shown. The provider decides after the answer streamed:
 * `blocked` and `withheld` replace the answer, `helpline` keeps it and adds support.
 */
export type CodexAnswerModerationNotice =
  | { readonly kind: "blocked"; readonly reason: "cyber" | "protection" }
  | { readonly kind: "withheld" }
  | { readonly kind: "helpline" };

export function codexAnswerModerationNotice(
  moderation: CodexAnswerModerationInput | null | undefined,
): CodexAnswerModerationNotice | null {
  const display = moderation?.display;
  if (!display) return null;
  switch (display.mode) {
    case "block":
      return { kind: "blocked", reason: display.reason.kind };
    case "hide":
      return { kind: "withheld" };
    case "show":
      return display.annotation ? { kind: "helpline" } : null;
  }
}

/** Whether the answer's own text stays out of every transcript, copy and Agent read. */
export function codexAnswerModerationWithholdsText(
  notice: CodexAnswerModerationNotice | null,
): boolean {
  return notice?.kind === "blocked" || notice?.kind === "withheld";
}

const NOTICE_TEXT = {
  cyber: "This response was blocked by cybersecurity safeguards.",
  protection: "This response was blocked by safety safeguards.",
  withheld:
    "This response was hidden. If you're going through something difficult, you don't have to face it alone: reach out to someone you trust or a local helpline.",
  helpline:
    "If you're going through something difficult, you don't have to face it alone: reach out to someone you trust or a local helpline.",
} as const;

/** The notice in plain text, for surfaces that do not render the localized transcript notice. */
export function codexAnswerModerationText(notice: CodexAnswerModerationNotice): string {
  return notice.kind === "blocked" ? NOTICE_TEXT[notice.reason] : NOTICE_TEXT[notice.kind];
}

/** What a reader outside the transcript sees: a withheld answer reads as its notice. */
export function codexReadableAnswerText(item: {
  readonly text: string;
  readonly moderation?: CodexAnswerModerationInput | null;
}): string {
  const notice = codexAnswerModerationNotice(item.moderation);
  return notice && codexAnswerModerationWithholdsText(notice)
    ? codexAnswerModerationText(notice)
    : item.text;
}

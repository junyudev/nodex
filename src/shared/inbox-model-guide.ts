/**
 * Nodex's guide to what each model family does well, read by the suggestion Agent when it
 * chooses a new chat's models. The user's own routing preferences take precedence. Each note
 * reaches the suggestion only beside a model the live catalog offers, so a retired family's
 * note simply stops applying.
 */
export interface InboxModelGuideEntry {
  /** The family as people name it. */
  readonly family: string;
  /** Matches the family's catalog model ids or names. */
  readonly match: RegExp;
  readonly note: string;
}

export const INBOX_MODEL_GUIDE: readonly InboxModelGuideEntry[] = [
  {
    family: "GPT-6.1",
    match: /gpt[-\s]?6\.1/iu,
    note: "Very economical, even at its highest effort. Strong at backend, systems, algorithms, data and math-heavy work. Weak at frontend: its UI, visual design and copy come out plainer and less polished than Claude Opus 5.5's.",
  },
  {
    family: "Claude Opus 5.5",
    match: /opus[-\s]?5[.-]5/iu,
    note: "Excellent at frontend, UI and UX, with real taste in visual design, interaction and expression, and it writes strong copy; far better than GPT models at these. Solid at backend, and often the stronger architect. Spends the Claude budget faster than economical models.",
  },
];

/** The note for one catalog model, when its family is in the guide. */
export const inboxModelGuideNote = (model: {
  readonly slug: string;
  readonly name: string;
}): string | null =>
  INBOX_MODEL_GUIDE.find((entry) => entry.match.test(model.slug) || entry.match.test(model.name))
    ?.note ?? null;

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
  /** What suggestions are told about the family. */
  readonly note: string;
  /** The note in one line, as the Inbox shows it to people. */
  readonly summary: string;
  /** The family costs nothing to run, so it has no budget to weigh. */
  readonly free?: true;
}

export const INBOX_MODEL_GUIDE: readonly InboxModelGuideEntry[] = [
  {
    family: "GPT-6.1",
    match: /gpt[-\s]?6\.1/iu,
    note: "Very economical, even at its highest effort. Strong at backend, systems, algorithms, data and math-heavy work. Weak at frontend: its UI, visual design and copy come out plainer and less polished than Claude Opus 5.5's.",
    summary: "Backend, systems and data. Very economical, even at its highest effort.",
  },
  {
    family: "Claude Opus 5.5",
    match: /opus[-\s]?5[.-]5/iu,
    note: "Excellent at frontend, UI and UX, with real taste in visual design, interaction and expression, and it writes strong copy; far better than GPT models at these. Solid at backend, and often the stronger architect. Spends the Claude budget faster than economical models.",
    summary: "Frontend, UI and copy, with real taste. Spends the Claude budget faster.",
  },
  {
    family: "OpenCode free models",
    match: /^opencode\/[\w.-]+-free$/iu,
    note: "Free through OpenCode, so they spend no subscription budget. Smaller, faster models: fine for docs, notes, summaries and simple, well-specified changes, but weaker than GPT-6.1 or Claude Opus 5.5 at hard reasoning, architecture and taste. They can be slow or rate-limited when busy, so keep urgent or important work on a model with budget.",
    summary: "Docs, notes and simple changes. Weaker at hard problems.",
    free: true,
  },
];

/** The guide's entry for one catalog model, when its family is in the guide. */
export const inboxModelGuideEntry = (model: {
  readonly slug: string;
  readonly name: string;
}): InboxModelGuideEntry | null =>
  INBOX_MODEL_GUIDE.find((entry) => entry.match.test(model.slug) || entry.match.test(model.name)) ??
  null;

/** The note for one catalog model, when its family is in the guide. */
export const inboxModelGuideNote = (model: {
  readonly slug: string;
  readonly name: string;
}): string | null => inboxModelGuideEntry(model)?.note ?? null;

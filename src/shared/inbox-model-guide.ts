import { defineMessages, type MessageDescriptor } from "./i18n/messages";

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
  /** English guidance sent to the suggestion Agent. */
  readonly note: string;
  readonly noteMessage: MessageDescriptor;
  /** The note in one line, as the Inbox shows it to people. */
  readonly summaryMessage: MessageDescriptor;
}

const MODEL_GUIDE_MESSAGES = defineMessages({
  gptNote: {
    id: "inbox.modelGuide.gptNote",
    defaultMessage:
      "Very economical, even at its highest effort. Strong at backend, systems, algorithms, data and math-heavy work. Weak at frontend: its UI, visual design and copy come out plainer and less polished than Claude Opus 5.5's.",
  },
  gptSummary: {
    id: "inbox.modelGuide.gptSummary",
    defaultMessage: "Backend, systems and data. Very economical, even at its highest effort.",
  },
  opusNote: {
    id: "inbox.modelGuide.opusNote",
    defaultMessage:
      "Excellent at frontend, UI and UX, with real taste in visual design, interaction and expression, and it writes strong copy; far better than GPT models at these. Solid at backend, and often the stronger architect. Spends the Claude budget faster than economical models.",
  },
  opusSummary: {
    id: "inbox.modelGuide.opusSummary",
    defaultMessage: "Frontend, UI and copy, with real taste. Spends the Claude budget faster.",
  },
  geminiNote: {
    id: "inbox.modelGuide.geminiNote",
    defaultMessage:
      "Excellent at frontend, UI and UX, with real taste in visual design and interaction; close to Claude Opus 5.5 there and far better than GPT models. Spends a Gemini budget rather than Claude's, so it can take UI work when the Claude budget runs low.",
  },
  geminiSummary: {
    id: "inbox.modelGuide.geminiSummary",
    defaultMessage: "Frontend and UI, with real taste. Spends a Gemini budget, not Claude's.",
  },
});

export const INBOX_MODEL_GUIDE: readonly InboxModelGuideEntry[] = [
  {
    family: "GPT-6.2 Sol",
    match: /gpt[-\s]?6\.2[-\s]?sol/iu,
    note: MODEL_GUIDE_MESSAGES.gptNote.defaultMessage,
    noteMessage: MODEL_GUIDE_MESSAGES.gptNote,
    summaryMessage: MODEL_GUIDE_MESSAGES.gptSummary,
  },
  {
    family: "Claude Opus 5.5",
    match: /opus[-\s]?5[.-]5/iu,
    note: MODEL_GUIDE_MESSAGES.opusNote.defaultMessage,
    noteMessage: MODEL_GUIDE_MESSAGES.opusNote,
    summaryMessage: MODEL_GUIDE_MESSAGES.opusSummary,
  },
  {
    family: "Gemini 4 Neon",
    match: /gemini[-\s]?4[-\s]?neon/iu,
    note: MODEL_GUIDE_MESSAGES.geminiNote.defaultMessage,
    noteMessage: MODEL_GUIDE_MESSAGES.geminiNote,
    summaryMessage: MODEL_GUIDE_MESSAGES.geminiSummary,
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

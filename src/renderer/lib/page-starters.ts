import type { NfmTemplateBlock } from "@/lib/editor-model/nfm-template-blocks";

export type PageStarterId = "task-brief" | "bug-report" | "todo-list" | "meeting-notes";

/** A shape an empty Page can start from; choosing one writes its Blocks into the body. */
export interface PageStarter {
  readonly id: PageStarterId;
  readonly label: string;
  readonly blocks: readonly NfmTemplateBlock[];
}

const heading = (text: string): NfmTemplateBlock => ({
  type: "heading",
  props: { level: 2 },
  content: text,
});

const line = (caret?: true): NfmTemplateBlock => ({
  type: "paragraph",
  ...(caret ? { caret } : {}),
});

const todo = (caret?: true): NfmTemplateBlock => ({
  type: "checkListItem",
  ...(caret ? { caret } : {}),
});

const bullet = (caret?: true): NfmTemplateBlock => ({
  type: "bulletListItem",
  ...(caret ? { caret } : {}),
});

/**
 * Starters follow how Pages are used: most hand work to an Agent, so the first two are the
 * briefs an Agent can act on, with headings it can read and criteria it can check off.
 */
export const PAGE_STARTERS: readonly PageStarter[] = [
  {
    id: "task-brief",
    label: "Task brief",
    blocks: [
      heading("Goal"),
      line(true),
      heading("Context"),
      line(),
      heading("Acceptance criteria"),
      todo(),
    ],
  },
  {
    id: "bug-report",
    label: "Bug report",
    blocks: [
      heading("What happened"),
      line(true),
      heading("Steps to reproduce"),
      { type: "numberedListItem" },
      heading("Expected"),
      line(),
    ],
  },
  {
    id: "todo-list",
    label: "To-do list",
    blocks: [todo(true)],
  },
  {
    id: "meeting-notes",
    label: "Meeting notes",
    blocks: [
      heading("Agenda"),
      bullet(true),
      heading("Notes"),
      line(),
      heading("Action items"),
      todo(),
    ],
  },
];

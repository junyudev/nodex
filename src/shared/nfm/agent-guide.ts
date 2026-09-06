import { MAX_PAGE_WRITE_BODY_BYTES } from "../page-limits";

export const NESTED_MARKDOWN_COMPACT_HINT =
  'Nested Markdown is Markdown with Nodex tags and tab-nested Blocks. Use one literal tab per child level; spaces do not nest. Example string: "▶ Toggle title\\n\\tChild paragraph\\n\\t- [ ] Child task".';

export const NESTED_MARKDOWN_AGENT_GUIDE = {
  format: "markdown" as const,
  specificationVersion: "2",
  instructions: [
    NESTED_MARKDOWN_COMPACT_HINT,
    "Send one complete string to create, replace, patch, or insert many Blocks atomically. Leading spaces remain authored content; only literal tabs express Block ancestry.",
    "Blank physical lines are ignored. An insertion must contain at least one Block; use <empty-block/> for an intentional empty Block. Markdown headings, lists, tasks, quotes, and code create ordinary Blocks; Nodex tags include <mention-thread>, <mention-date>, Page references, attachments, and agent configuration.",
    '<page uuid="…" /> is the wire tag for an owning Page shell and may only preserve or reorder a Page already owned by the same body. <page-ref url="nodex://pages/…" /> is a non-owning Page reference. Use Page creation, move, or duplicate operations for owning Pages.',
    `A complete body is limited to ${MAX_PAGE_WRITE_BODY_BYTES} UTF-8 bytes. Read the structured Block representation before identity-sensitive Block edits.`,
    "Page titles use a single-line inline subset with styles, links, thread mentions, and date mentions; titles reject Block syntax, tabs, line breaks, attachments, agent configuration, and Page Blocks.",
  ].join(" "),
  examples: [
    "# Launch plan\nContext paragraph\n\t- [ ] Confirm scope\n\t- [x] Record decision",
    "> Important\n\tNested explanation",
    '<page-ref url="nodex://pages/PAGE_BLOCK_ID" />',
  ],
} as const;

export const NFM_AGENT_GUIDE = {
  format: "nfm" as const,
  specificationVersion: "2",
  instructions: [
    "NFM is Nodex's complete document language: send one string to create, replace, patch, or insert many Blocks atomically.",
    "Use tabs, never spaces, for Block nesting. Escape \\ * ~ ` $ [ ] < > { } | ^ with a backslash when the character is literal.",
    "Blank physical lines are ignored. An insertion must contain at least one Block; use <empty-block/> for an intentional empty Block. Markdown headings/lists/tasks/quotes/code create ordinary Blocks; supported Nodex tags include <mention-thread>, <mention-date>, <page-ref>, attachments, and agent configuration.",
    '<page uuid="…" /> is an owning Page shell and may only preserve or reorder a Page already owned by the same Document. <page-ref url="nodex://pages/…" /> is a non-owning reference. Use Page creation, move, or duplicate operations for owning Pages.',
    `A complete NFM body is limited to ${MAX_PAGE_WRITE_BODY_BYTES} UTF-8 bytes. Read stable Block identities with get_block format=blocks when an identity-sensitive edit is needed.`,
  ].join(" "),
  examples: [
    "# Launch plan\nContext paragraph\n\t- [ ] Confirm scope\n\t- [x] Record decision",
    "> Important\n\tNested explanation",
    '<page-ref url="nodex://pages/PAGE_BLOCK_ID" />',
  ],
} as const;

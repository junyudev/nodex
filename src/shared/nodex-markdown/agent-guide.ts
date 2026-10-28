import { MAX_PAGE_WRITE_BODY_BYTES } from "../page-limits";

export const NODEX_MARKDOWN_COMPACT_HINT =
  "Nodex Markdown is GitHub Flavored Markdown with directives for toggles, references and inline atoms. Fetch, patch and write the same exact text in markdown.";
/** One rule per topic; Agents receive them as one paragraph, references list them. */
export const NODEX_MARKDOWN_AGENT_RULES = [
  NODEX_MARKDOWN_COMPACT_HINT,
  "Write headings, space-indented lists, tasks, quotes, fenced code, pipe tables, images and GitHub alerts normally. A single newline is a line break; a blank line separates Blocks. Use <br> for an intentional empty paragraph, including an insertion fragment. An empty body is the empty Document.",
  'A toggle is :::toggle[Title], its body indented two spaces, and a closing :::. Use heading="2" on its attribute list for a toggle heading. A paragraph with children is :::paragraph[Text] with the same body layout. Callouts are > [!TIP], > [!NOTE], > [!IMPORTANT], > [!WARNING] or > [!CAUTION], or :::callout[Text]{icon="📌"}.',
  'Block colors end text as {color="red" background="yellow"}. Inline underline and colors use :span[text]{underline color="red" background="yellow"}. Supported colors: gray, brown, red, orange, yellow, green, blue, purple and pink. Tables needing header, widths or color use :::table{header="none" widths="120,auto" color="blue"} around a pipe table. A cell takes {background="yellow"}.',
  "An image is ![plain caption](url), resized as ![caption|480](url). Within text it is an inline image; [![alt](image)](link) makes it linked. Images have no colors. Inline math uses $$source$$; math Blocks use $$ fences.",
  'Page and chat mentions are <nodex://pages/ID> and <nodex://sessions/ID>; chat mentions always identify a Session. [Title](nodex://pages/ID) is a link with its own text. Dates use :date{start="2026-10-28"} with optional end, tz, format, time-format and reminder.',
  'An attachment is :attachment{kind="file" source="nodex://files/ID" name="notes.txt"}; kind is file, folder or text and mode is materialized by default or link. Optional attributes are mime, bytes and origin. Agent settings are :agent-config{mode="plan" provider="openai" model="MODEL" reasoning="high" speed="fast"}. Directives describe content and never execute actions.',
  'Owning shells are ::page{id="ID"}, ::database{id="ID"}, ::canvas{id="ID"}. Preserve only shells already owned by that body; create, move and delete their resources through typed commands. Non-owning references are ::page-ref{page="ID"}, ::database-view-ref{view="ID" hint="Name"}, ::synced-block-ref{source="ID"}, and ::template-ref{source="ID" hint="Name"}.',
  "Create, insert and replace use one markdown body field. Exact patches match oldMarkdown against fetched exact text and write newMarkdown. Malformed Nodex syntax is refused with a line and reason. Read the structured Blocks before identity-sensitive edits. Page titles use one-line inline Markdown with styles, links, Page/Session/date mentions; no Blocks, tabs, line breaks, images, attachments, math or Agent config.",
  `A complete body is limited to ${MAX_PAGE_WRITE_BODY_BYTES} UTF-8 bytes.`,
] as const;

export const NODEX_MARKDOWN_AGENT_GUIDE = {
  format: "markdown" as const,
  specificationVersion: "5",
  instructions: NODEX_MARKDOWN_AGENT_RULES.join(" "),
  examples: [
    "# Launch plan\n\nContext paragraph\n\n- [ ] Confirm scope\n- [x] Record decision",
    ":::toggle[Details]\n  Hidden paragraph\n\n  - detail\n:::",
    '::page-ref{page="PAGE_BLOCK_ID"}',
    "> [!TIP]\n> Keep the decision close to the work",
  ],
} as const;

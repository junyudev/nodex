# Nodex Markdown

This reference is generated from Nodex's production Agent guide. Specification
revision: `7`.

## Authoring rules

- Nodex Markdown is GitHub Flavored Markdown with directives for toggles, references and inline atoms. Fetch, patch and write the same exact text in markdown.
- Write headings, space-indented lists, tasks, quotes, fenced code, pipe tables, images and GitHub alerts normally. A single newline is a line break; a blank line separates Blocks. Use <br> for an intentional empty paragraph, including an insertion fragment. An empty body is the empty Document.
- A toggle is :::toggle[Title], its body indented two spaces, and a closing :::. Use heading="2" on its attribute list for a toggle heading. A paragraph with children is :::paragraph[Text] with the same body layout. Callouts are > [!TIP], > [!NOTE], > [!IMPORTANT], > [!WARNING] or > [!CAUTION], or :::callout[Text]{icon="📌"}.
- A Prompt is :::prompt[Rich first line] with a body indented two spaces and a closing :::. Its optional paired sent="nodex://sessions/SESSION_ID" and sent-at="2026-10-31T08:30:00.000Z" attributes record the last successful send; optional sent-message="MESSAGE_ID" identifies its accepted user message. Writing a Prompt never sends anything. Agents may create prompts but must not fabricate send records or message IDs; preserve existing records even if their chat was deleted.
- Block colors end text as {color="red" background="yellow"}. Inline underline and colors use :span[text]{underline color="red" background="yellow"}. Supported colors: gray, brown, red, orange, yellow, green, blue, purple and pink. Tables needing header, widths or color use :::table{header="none" widths="120,auto" color="blue"} around a pipe table. A cell takes {background="yellow"}.
- An image is ![plain caption](url), resized as ![caption|480](url). Within text it is an inline image; [![alt](image)](link) makes it linked. Images have no colors. Inline math is $$source$$; \(…\) and \[…\] within a line are plain text. Math Blocks use $$ fences.
- Page and chat mentions are <nodex://pages/ID> and <nodex://sessions/ID>; chat mentions always identify a Session. [Title](nodex://pages/ID) is a link with its own text. Dates use :date{start="2026-10-28"} with optional end, tz, format, time-format and reminder.
- Write a skill mention as :skill{name="review"} or use its qualified invocation name, for example :skill{name="toolkit:review"}. A name can outlive the installed skill. Escape the leading colon for literal directive prose. Bare $review, $5, and $HOME are ordinary text. Reading a Page preserves its mention. Sending its content as a message projects the mention to a separate $name token for the receiving Agent.
- An attachment is :attachment{kind="file" source="nodex://files/ID" name="notes.txt"}; kind is file, folder or text and mode is materialized by default or link. Optional attributes are mime, bytes and origin. Agent settings are :agent-config{mode="plan" provider="openai" model="MODEL" reasoning="high" speed="fast"}. Directives describe content and never execute actions.
- Owning shells are ::page{id="ID"}, ::database{id="ID"}, ::canvas{id="ID"}. Preserve only shells already owned by that body; create, move and delete their resources through typed commands. Non-owning references are ::page-ref{page="ID"}, ::database-view-ref{view="ID" hint="Name"}, ::synced-block-ref{source="ID"}, and ::template-ref{source="ID" hint="Name"}.
- Create, insert and replace use one markdown body field. Exact patches match oldMarkdown against fetched exact text and write newMarkdown. Malformed Nodex syntax is refused with a line and reason. Read the structured Blocks before identity-sensitive edits. Page titles use one-line inline Markdown with styles, links, Page, Session, date, and skill mentions. Blocks, tabs, line breaks, images, attachments, math and Agent config are body syntax.
- A complete body is limited to 2097152 UTF-8 bytes.

For the CLI, translate dynamic-tool wording to the equivalent native workflow:
use `nodex read` before identity-sensitive edits and use semantic `nodex page`
or `nodex block` commands for owning Pages. Write complete bodies through a
file so Markdown source and user text are preserved exactly.

## Round-trip examples

```markdown
# Launch plan

Context paragraph

- [ ] Confirm scope
- [x] Record decision
```

```markdown
:::toggle[Details]
  Hidden paragraph

  - detail
:::
```

```markdown
::page-ref{page="PAGE_BLOCK_ID"}
```

```markdown
> [!TIP]
> Keep the decision close to the work
```

Each example is parsed and serialized by the production Nodex Markdown codec
during artifact generation. A mismatch fails generation.

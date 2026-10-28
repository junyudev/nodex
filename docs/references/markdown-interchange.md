# Markdown Interchange

## Scope

[Nodex Markdown](./nodex-markdown.md) owns the text language of Blocks, including
exact reading, writing, directives and inline content. [ADR 0073](../adr/0073-one-text-language-for-blocks.md)
records its single implementation: Core links the `nodex-markdown` Rust crate and
the app uses its WebAssembly build. This reference owns clipboard sources, rich
HTML conversion and portable output. Written-message behavior belongs to
[Message Content Behavior](../product-specs/message-content-behavior.md).

## Reading Markdown

Markdown pasted into a Page uses the boundary reader. It follows GitHub comment
line breaks: one newline is a line break, while a blank line separates Blocks.
Plain text that is not Markdown keeps its lines instead, as
[Clipboard sources](#clipboard-sources) describes. A Markdown file uses document
reading, which folds soft line breaks into spaces. Exact writes refuse malformed
Nodex forms with their line and reason. The language reference and Rust
round-trip fixture own the grammar.

The app initializes WebAssembly before synchronous rendering, validation and
clipboard handlers can read text. Clipboard events remain synchronous after
initialization.

## Clipboard sources

Structural clipboard claims retain their identity and authority protocol. Their
standard HTML and text are portable presentations, not structural authority.
The Page editor keeps its own internal formats alongside portable Markdown.

A Page paste chooses structural claims and internal BlockNote HTML first, then
Notion's structured clipboard; Notion nodes become BlockNote JSON directly. Code
copied from an editor becomes a code Block. Explicit `text/markdown` reads as
Markdown. Other rich text pastes as its HTML, unless its plain text writes a GFM
table, which the rich form shows only as text.

Plain text with nothing richer beside it becomes Blocks by what it is. When
reading it as Markdown finds Markdown, such as a heading, list, quote, fenced
code, table, rule, formatting or a written link, it becomes those Blocks. Line
breaks, indentation and bare web or mail addresses alone are plain text's own.
Any other plain text becomes one paragraph per line with exactly its text, and
blank lines only separate them. Continuing an oversized paste inline, and
pasting over a typed-owner selection, follow the same rules. Nodex Markdown reads
every text a Page paste takes; the editor's own Markdown detection stays off.

A Composer edits Markdown source. Explicit `text/markdown` stays as written.
Nodex's own copies and code copied from an editor retain their plain text.
Other rich HTML becomes Blocks and then portable Markdown. If conversion would
lose words from the clipboard's plain text, the Composer keeps the plain text.
Images supplied by clipboard files become attachments rather than duplicate
image text.

## Rich HTML paste

The retained HTML adapter reads HAST and mdast, then maps the structure HTML
carries directly into BlockNote JSON. It keeps headings, paragraphs, lists,
quotes, code, links, images, tables and supported text styles. Runs of line divs
stay lines; an empty div separates paragraphs. CSS bold, italic and strike marks
are read from document copies, including weight-resetting wrappers. This
adapter does not parse Markdown.

External rich HTML spacer lines, including empty paragraphs, nonbreaking-space
paragraphs and paragraphs containing only line breaks, separate content without
creating empty Blocks. Leading and trailing line breaks in paragraphs are
discarded. Line breaks between real content stay within their paragraph, and
code keeps its whitespace. This spacing rule applies to Page and Composer paste;
Nodex's internal clipboard fragments retain their exact Block structure.

## Writing Markdown

Copy and export use `writePortableMarkdown`, the language writer with Nodex
extensions projected into ordinary Markdown. The result carries `{ markdown,
exact }`; `exact` says whether reading that text restores the same content.
Portable output never becomes the authoritative stored body.

Lists retain hierarchy, tables retain their readable cells, and code and math
retain their source. Toggles become their visible text and children. Colors,
underlining and other extension-only state are omitted and make output inexact.
Page mentions may use current Page titles supplied by the caller; chat mentions
retain Session destinations. Resource references become portable links where
possible. Images keep their source and plain caption. Managed File destinations
may be rewritten to explicitly materialized native paths by the clipboard File
export boundary.

Comment output keeps newlines as line breaks. Document output writes hard line
breaks explicitly. The Rust fixture and writer tests own canonical spelling and
exactness decisions.

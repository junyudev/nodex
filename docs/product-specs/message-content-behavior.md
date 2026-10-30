# Message Content Behavior

## Scope

This document owns what a message is wherever someone writes to Nodex: the
Inbox Composer, the thread Composer, and the message bubbles that show what was
written. Image ingress and submission for the thread Composer remain owned by
[Composer Image Attachments Behavior](./composer-image-attachments-behavior.md);
Inbox capture, triage, and dispatch remain owned by
[Inbox Behavior](./inbox-behavior.md). How Markdown is read and written is
specified in [Nodex Markdown](../references/nodex-markdown.md); clipboard sources and HTML conversion live in [Markdown Interchange](../references/markdown-interchange.md).

## One language

A message is written as Nodex Markdown: GitHub Flavored Markdown plus Nodex directives, read the same way in the Composer, in the bubble, in the Page it
becomes, in what an Agent receives, in Core, and on GitHub. An Agent's reply
beside it renders by the same Markdown rules.

- Markdown is structure: `**bold**`, `_italic_`, `~~struck~~`, `- item`,
  `1. item`, `- [ ] task`, `> quote`, `> [!NOTE]` alerts, fenced and indented
  code, `|` tables, `$$` math, and links.
- A single newline is a line break, and a blank line starts the next Block.
- A line keeps the spaces and tabs it is indented with, except inside a list or
  quote, where indentation is nesting.
- A bare URL is a link.
- Text that forms no markup stays literal: `a < b`, `[draft`, `price is $5`, and
  `snake_case` read as written.

There is no second message format. Every surface that accepts written input
reads it as message text, and every surface that shows it renders the result.

## Composers

A Composer edits message text. The text is what the user types, shown as typed;
formatting appears once the message is shown. Mentions are indivisible atoms in
the text. Images sit in one attachment row above the text, with the same
thumbnails in every Composer, and enter by paste, drop, or the picker.

Pasting inserts the Markdown source of what was copied, with every line it
shows. Rich text from another app becomes its Markdown: headings, emphasis,
lists, checklists, links, code and tables keep their meaning, and a run of
lines, as Notes and mail write them, stays a run of lines. Markdown a source
provides and Nodex's own copies stay as written, code copied from an editor or
a code block keeps its exact text, and a copy from another Composer keeps its
mentions. Images in rich text are left out of the text; image files on the
clipboard become attachments. When the Markdown would lose words the copy's
plain text has, the plain text is pasted instead.

A Composer displays authored Markdown source. Reopening a stored message uses its
exact Nodex Markdown, including escapes and directives needed to preserve the
Blocks. Copy uses portable Markdown. A Page sent to an Agent uses exact text
with image placeholders and typed image and Agent-config sidecars.

## Projections

One written message has exactly two projections.

- **Into a Page.** An Inbox message becomes its Page body: the text Blocks in
  order, then one Block per attachment.
- **Into Agent input.** Text, mentions, and images are projected to an Agent by
  the same rules everywhere, whether the source is a Composer or a Page sent to
  a chat. A Page's content is written as exact Nodex Markdown, mentions retain stable
  Page and Session references, and images travel as images, each marked in the text by a
  numbered placeholder.

Wherever Nodex sends an image's bytes to an Agent itself, rather than handing the
Agent a local file, the image is fitted instead of being refused or left out. One
message carries at most 20 images; each may use 5 MB or an equal share of 20 MB,
whichever is smaller. An image over its share has its longest edge stepped down
from 2048px, staying PNG while that fits, so screenshots stay sharp, and
otherwise becoming JPEG. The original is unchanged where the message keeps it.

## Message bubbles

Every bubble that shows written content, in the Inbox and in a chat, renders it
with one read-only message renderer in chat typography: lines of a paragraph sit
together, paragraphs and headings are a short step apart, and images, file
chips, links and mentions render in place. The images attached to a message, a
run of plain images at its start, show as thumbnails above the text, as in the
Composer, and open in the image viewer. A message that ends with such a run
instead, as messages did before images came first, shows it below the text,
where the Page keeps it.
Images are read with the access of the Page the message belongs to, and one
that cannot be read says so. An Inbox bubble shows its Page as it is now,
including anything later added in the Page; the stream shows a bounded part of
a long body, and the full message stays one action away. Long messages collapse
after the same number of lines in every bubble.

An Agent's reply is not a written message; it streams as conversation Markdown,
read by the same Markdown rules.

## Inbox message shape

A message written in a Composer has image Blocks of Library Files followed by
its text Blocks: the Composer imports each image as it is added and writes them
before the text as `![](nodex://files/…)`, so its Page opens with the images
the bubble shows first.

Every stored body can be edited in the Composer as its exact Markdown source.
Ordinary Library File images at the start of the body, or at its end in a
message written before images came first, reopen in the attachment row; saving
writes them first. A body with other image state, such as a caption, width or
image between paragraphs, reopens as complete Markdown source so its content
stays exact. Underlining, toggles and
other directives do not require a separate Page-editing fallback. Editing a
truncated stream item loads its complete body first. Concurrent changes remain
protected by the message rewrite boundary.

# Message Content Behavior

## Scope

This document owns what a message is wherever someone writes to Nodex: the
Inbox Composer, the thread Composer, and the message bubbles that show what was
written. Image ingress and submission for the thread Composer remain owned by
[Composer Image Attachments Behavior](./composer-image-attachments-behavior.md);
Inbox capture, triage, and dispatch remain owned by
[Inbox Behavior](./inbox-behavior.md). The text form itself is specified in
[Nested Markdown](../references/nested-markdown-spec.md#message-text).

## One language

A message is written as message text: Markdown as people write it, read as a
small Nested Markdown document. Nested Markdown is the text form of Page
content, so the same text means the same thing in the Composer, in the bubble,
in the Page it becomes, and in what an Agent receives.

- Markdown is structure: `**important**` is bold, `- item`, `* item` and `1)`
  start lists, a list item indented with spaces nests under the one before it
  and a line indented under a list item continues it, `> ` quotes, fenced code
  stays code, and a `|` pipe table is a table.
- Indentation shows as written: a line indented with spaces keeps its spaces,
  and a line nested with a tab steps in under the line above it.
- Lines written together stay together: consecutive lines of a paragraph or
  quote are one Block broken where they were written, and a blank line starts
  the next Block.
- A bare `http://` or `https://` URL is a link.
- Text that forms no markup stays literal: `a < b`, `[draft`, and `price is $5`
  read as written.

There is no second message format. Every surface that accepts written input
reads it as message text, and every surface that shows it renders the result.

## Composers

A Composer edits message text. The text is what the user types, shown as typed;
formatting appears once the message is shown. Mentions are indivisible atoms in
the text. Images sit in one attachment row above the text, with the same
thumbnails in every Composer, and enter by paste, drop, or the picker.

A Composer never fills the text with escapes. A message reopened for editing,
copied, or drafted into a prompt is written back as message text: lines as they
were written, nesting indented with spaces wherever spaces say the same, bare
URLs bare, and each escape only where removing it would change what the message
says.

## Projections

One written message has exactly two projections.

- **Into a Page.** An Inbox message becomes its Page body: the text Blocks in
  order, then one Block per attachment.
- **Into Agent input.** Text, mentions, and images are projected to an Agent by
  the same rules everywhere, whether the source is a Composer or a Page sent to
  a chat. Mentions become readable references; images travel as images.

## Message bubbles

Every bubble that shows written content, in the Inbox and in a chat, renders it
with one read-only message renderer in chat typography: lines of a paragraph sit
together, paragraphs and headings are a short step apart, and images, file
chips, links and mentions render in place. The images attached after the text
show as thumbnails above it, as in the Composer, and open in the image viewer.
Images are read with the access of the Page the message belongs to, and one
that cannot be read says so. An Inbox bubble shows its Page as it is now,
including anything later added in the Page; the stream shows a bounded part of
a long body, and the full message stays one action away. Long messages collapse
after the same number of lines in every bubble.

An Agent's reply is not a written message; it streams as conversation Markdown.

## Inbox message shape

A message written in a Composer has the message shape: text Blocks followed by
image Blocks of Library Files, which the Composer imports as each image is
added. A message with that shape is edited in place with the same Composer, and
the edit reads back exactly. A body that message text cannot say exactly, or
that no longer has that shape, for example because an image was moved between
paragraphs in the Page, is edited as its Page.

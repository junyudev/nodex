# Message Content Behavior

## Scope

This document owns what a message is wherever someone writes to Nodex: the
Inbox Composer, the thread Composer, and the message bubbles that show what was
written. Image ingress and submission for the thread Composer remain owned by
[Composer Image Attachments Behavior](./composer-image-attachments-behavior.md);
Inbox capture, triage, and dispatch remain owned by
[Inbox Behavior](./inbox-behavior.md). The text form itself is specified in
[Nested Markdown](../references/nested-markdown-spec.md).

## One language

A message is a small Nested Markdown document. Nested Markdown is the text form
of Page content: standard Markdown plus tags for what Markdown cannot express,
such as `<image source="nodex://files/<id>">Caption</image>` and
`<mention-page url="nodex://pages/<id>" />`. Ordinary Markdown is valid as
written, so `**important**` means bold in the Composer, in the bubble, in the
Page it becomes, and in what an Agent receives.

There is no second message format. A surface that accepts written input either
speaks Nested Markdown or keeps to plain text that is valid Nested Markdown.

## Composers

A Composer edits Nested Markdown source. The text is what the user types,
shown as typed; formatting appears once the message is shown. Mentions are
indivisible atoms in the text. Images and files sit in one attachment row above
the text, with the same thumbnails in every Composer, and enter by paste, drop,
or the picker.

Text that does not form markup stays literal: `a < b`, `[draft`, and `price is
$5` read as written. A Composer never fills the text with escapes; when a
message is reopened for editing, each Block appears in its plainest form that
still reads back unchanged.

## Projections

One written message has exactly two projections.

- **Into a Page.** An Inbox message becomes its Page body: the text Blocks in
  order, then one Block per attachment. Markdown becomes real structure, so a
  typed list is a list and typed bold is bold.
- **Into Agent input.** Text, mentions, and images are projected to an Agent by
  the same rules everywhere, whether the source is a Composer or a Page sent to
  a chat. Mentions become readable references; images travel as images.

## Message bubbles

Every bubble that shows written content renders its Nested Markdown with one
read-only message renderer: compact typography, images, file chips, and
mentions. The images attached after the text show as thumbnails above it, as in
the Composer, and open in the image viewer; an image inside the text stays in
place. Images are read with the access of the Page the message belongs to, and
one that cannot be read says so. An Inbox bubble shows its Page as it is now,
including anything later added in the Page; the stream shows a bounded part of a
long body, and the full message stays one action away. Long messages collapse
after the same number of lines as a user message in a chat.

## Inbox message shape

A message written in a Composer has the message shape: text Blocks followed by
attachment Blocks. A message with that shape is edited in place with the same
Composer, and the edit reads back exactly. A body that no longer has that shape,
for example because an image was moved between paragraphs in the Page, is
edited as its Page.

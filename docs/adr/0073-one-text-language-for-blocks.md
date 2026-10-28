# ADR 0073: One Text Language for Blocks

- Status: Accepted
- Date: 2026-10-28
- Owners: Nodex maintainers
- Refines: the Nested Markdown authoring path in [ADR 0016](0016-agent-interface-budgets-the-common-path.md)

## Context

Nested Markdown was the exact form of Blocks: Agents read and patched Pages in
it, and the clipboard, messages and exports converted it to and from Markdown.
Its tab nesting, tag-like elements and line rules were a language no Agent had
learned elsewhere, so Markdown habits inside an exact patch were read as
something else. Every rule existed twice, once in the app and once in Core.

## Decision

Blocks have one text language, Nodex Markdown, specified in
[Nodex Markdown](../references/nodex-markdown.md). It is GitHub Flavored
Markdown read the way GitHub reads a comment, so any Markdown means what GitHub
says. What Markdown cannot say uses one extension mechanism: directives such as
`:::toggle[Title]` and attribute lists such as `{color="red"}`. Where GitHub
already has a form, Nodex uses it: alerts are callouts, an autolink to a Page or
a chat is a mention, and `<br>` is a line break.

Every Block tree has one exact text, and reading it gives the same Blocks back.
Agents fetch, patch and write that text; the clipboard and exports receive the
same writer's portable output with the extensions left out. An exact write that
looks like Nodex syntax but is malformed is refused with the reason rather than
read as something else.

The language has one implementation, the `nodex-markdown` Rust crate. Core links
it natively; the app runs its WebAssembly build. Its round-trip fixture is the
language's contract.

Blocks the language leaves out leave Nodex with it: thread sections are removed.
A chat mention names the chat's Session, the identity Page links and the sidebar
use, and an image's caption is plain text.

## Consequences

- Agents learn GitHub Flavored Markdown and a short list of extensions in place
  of Nested Markdown, and write every Page body in the one `markdown` field.
- Nested Markdown, its parsers and its references are deleted, and stored
  projections are rebuilt as Nodex Markdown.
- A rule changes in one place; the WebAssembly module is regenerated with
  `vp run nodex-markdown:wasm:generate` and checked against the same fixture.
- Stored documents migrate once: thread sections are deleted, chat mentions
  move to Session ids, image captions become plain text and images lose their
  color.

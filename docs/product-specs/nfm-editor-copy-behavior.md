# NFM Editor Copy Behavior

Status: Active
Last Updated: 2026-03-08

This document describes the current copy-related behavior inside the NFM / BlockNote editor. It covers standard selection copy/cut and the separate image-toolbar copy action.

This is intentionally narrower than the main product spec. It is the detailed source of truth for editor clipboard behavior.

## Scope

Included:
- Copy and cut of editor selections through browser `copy` / `cut` events
- Image-block toolbar `Copy image`
- Clipboard MIME types written by each path
- Selection-shape rules that determine whether copied `text/plain` is raw text or structure-preserving text

Not included:
- Paste behavior
- Board drag/drop `text/plain` payloads
- Thread transcript copy actions outside the NFM editor

## Copy Surfaces

The NFM editor currently has 2 distinct copy paths:

1. Standard copy / cut inside the editor
2. Image-block toolbar copy (`Copy image`)

They share some helpers, but they are not the same pipeline.

## Standard Copy And Cut

The editor installs a ProseMirror plugin named `structured-plain-text-copy` that runs before BlockNote's default `copyToClipboard` extension.

### When it handles the event

Standard copy/cut is handled only when all of the following are true:
- the browser `ClipboardEvent` exposes `clipboardData`
- the ProseMirror selection is non-empty
- structured payload creation succeeds
- at least one clipboard MIME write succeeds

If any of those fail, the handler returns `false` and the editor falls back to downstream/default copy behavior instead of forcing its own result.

### MIME types written

When handled successfully, standard copy writes up to 3 clipboard items:
- `blocknote/html`
- `text/html`
- `text/plain`

Each MIME write is attempted independently. A failure to write one type does not abort the others. The copy is treated as successful if at least one of those writes succeeds.

On success, the handler calls `preventDefault()`.

### Cut behavior

Cut uses the same clipboard payload as copy.

After a successful clipboard write:
- if the editor view is editable, it deletes the selection
- if clipboard serialization/writing fails, it does not delete the selection

### How copy payloads are derived

All 3 clipboard payloads are derived from the same cut-aware BlockNote selection snapshot when available:
- `blocknote/html`
- `text/html`
- `text/plain`

The helper starts from `editor.getSelectionCutBlocks(false)`, rebuilds a normalized selected block tree, and then exports:
- `clipboardHTML` from `editor.blocksToFullHTML(...)`
- `externalHTML` from `editor.blocksToHTMLLossy(...)`
- `structuredText` from `blockNoteToNfm(...)` plus `serializeClipboardText(...)`

If the cut-aware path is unavailable or throws, the helper falls back to BlockNote's `selectedFragmentToHTML(...)` output and keeps the existing HTML-parse fallback for `text/plain`.

### Plain-text asset rewriting

Before writing to the clipboard, standard copy/cut rewrites `nodex://assets/...` URIs only inside `text/plain`.

`blocknote/html` and `text/html` are left unchanged so BlockNote's internal clipboard round-trip payload stays lossless and Chromium custom clipboard data is not mutated.

In Electron, the plain-text rewrite is synchronous and uses the preload-exposed asset path prefix so it can run safely inside the browser `copy` / `cut` event.

After replacement, `text/plain` additionally converts `<image ...>caption</image>` lines into Markdown image syntax:
- indentation before the image line is preserved
- the `source="..."` attribute becomes the Markdown destination
- captions become Markdown alt text
- alt text escapes only `\`, `[` and `]`
- destinations escape `\`, `(`, `)`, and `>` as needed
- destinations containing whitespace are wrapped in `<...>`

If an image tag line does not match the expected pattern or has no usable source, it is left unchanged.

### Image examples

These examples are specifically about the exported `text/plain` payload. `blocknote/html` and `text/html` stay unchanged and continue to carry the original serialized BlockNote image markup.

```text
# selection:
[<image source="nodex://assets/diagram.png">diagram</image>]
# expected text/plain:
![diagram](/absolute/path/diagram.png)
```

```text
# selection:
[	<image source="nodex://assets/plan.png"></image>]
# expected text/plain:
	![image](/absolute/path/plan.png)
```

```text
# selection:
[<image source="nodex://assets/my-file.png">release plan (v2)</image>]
# expected text/plain:
![release plan (v2)](/absolute/path/my-file.png)
```

```text
# selection:
[<image source="nodex://assets/my-file.png"></image>]
# resolved file path:
/workspace/my files/my-file (v2).png
# expected text/plain:
![image](</workspace/my files/my-file (v2).png>)
```

```text
# selection:
[<image source="/workspace/already-absolute.png">diagram</image>]
# expected text/plain:
![diagram](/workspace/already-absolute.png)
```

## Structured `text/plain` Rules

### Selection source preference

The copy helper first tries `editor.getSelectionCutBlocks(false)`. This preserves more detail for partial selections and cut semantics.

If that is unavailable or throws, it falls back to `editor.getSelection()`.

### Visible selection fidelity

When `getSelectionCutBlocks(false)` returns a sliced selection snapshot, all payloads are exported from that same normalized block tree.

That means partial inline selections and full-block selections now share one mental model:
- the selected content is projected from BlockNote selection blocks
- inline formatting markers are preserved when the sliced selection still carries those marks
- block-level structure is preserved whenever the sliced selection spans multiple blocks or nested children
- if the selection starts inside a wrapper block (`bulletListItem`, `numberedListItem`, `checkListItem`, `toggleListItem`, `heading`, or `quote`), only that first cut block is visually unwrapped to a paragraph so copied output matches the visible selection instead of preserving an unselected leading marker

Later blocks are not rewritten, including a partially cut last block.

### Structure reconstruction

For cut-aware selections, the helper:
- deduplicates blocks by id
- prefers the richer variant when the same block appears more than once
- rebuilds parent/child relations from both explicit child arrays and `getParentBlock(...)`
- keeps traversal order stable
- rewrites only the first cut wrapper block when the selection begins inside its content
- exports all payloads from the same normalized tree

### Examples

These examples describe the visible copied result. For `text/plain`, the result is exact. For `text/html` and `blocknote/html`, the exported structure is expected to represent the same visible content.

Partial first wrapper blocks are unwrapped so hidden leading markers are not copied:

```text
# selection:
- asdasd[asd
- lollo]llol
# expected copy result:
asd
- lollo
```

```text
# selection:
1. alpha[beta
2. gamm]a
# expected copy result:
beta
2. gamm
```

```text
# selection:
> quo[ted line
> second] line
# expected copy result:
ted line
> second
```

```text
# selection:
## Head[ing
next] paragraph
# expected copy result:
ing
next
```

```text
# selection:
▶ toggl[e title
after] line
# expected copy result:
e title
after
```

Selections that start at the first visible character of a block keep that block's marker:

```text
# selection:
[- alpha
- beta]
# expected copy result:
- alpha
- beta
```

```text
# selection:
[> quoted line
> second line]
# expected copy result:
> quoted line
> second line
```

```text
# selection:
[## Heading
paragraph]
# expected copy result:
## Heading
paragraph
```

Parent/child structure is preserved when the selected range includes the parent block:

```text
# selection:
1234[56
	1234567
	1234567
12345]6
# expected copy result:
56
	1234567
	1234567
12345
```

Nested selections are lifted when the ancestor itself is not selected:

```text
# selection:
123456
	123[4567
	1234567
12345]6
# expected copy result:
4567
1234567
12345
```

```text
# selection:
- parent
	child [one
	child two
tail] line
# expected copy result:
one
child two
tail
```

Later blocks are not rewritten just because the first block was cut:

```text
# selection:
- par[ent
- child]
# expected copy result:
ent
- child
```

Inline formatting markers follow the same serializer in partial and full-block copy:

```text
# selection:
plain **bo[ld** text
next *li]ne*
# expected copy result:
**ld** text
next *li*
```

```text
# selection:
prefix [label](htt
next **row**](https://example.com)
# expected copy result:
[label](htt
next **row**](https://example.com)
```

Empty selected blocks remain visible as blank lines:

```text
# selection:
first[

third]
# expected copy result:

third
```

### HTML fallback path

If there are no usable selection blocks, or structured serialization throws, the helper tries to recover structure from clipboard HTML:
- it prefers `clipboardHTML` first
- then falls back to `externalHTML`
- it parses HTML through `tryParseHTMLToBlocks(...)`
- it serializes the parsed blocks with the same clipboard-text serializer

When both a selection-derived result and an HTML-derived result exist, the helper keeps the "richer" one using a simple heuristic that favors:
- deeper tab indentation
- more blank lines
- more total lines

If all custom reconstruction fails, the helper falls back to BlockNote's original `markdown` text output.

## Structured Text Format

The clipboard serializer preserves block structure and keeps a small subset of inline formatting markers.

### Inline behavior

Inline serialization currently works like this:
- text spans emit their literal text
- links keep full link syntax (`[label](url)`)
- inline line breaks emit real `\n`
- bold spans keep `**...**`
- italic spans keep `*...*`
- strikethrough spans keep `~~...~~`
- underline spans keep `<span underline="true">...</span>`
- color spans keep `<span color="...">...</span>`
- inline code spans keep backtick delimiters
- inline markdown/NFM escape backslashes are not added

As a result:
- block-level structured copy keeps all current inline NFM markers
- special characters are not backslash-escaped just to satisfy NFM serialization
- partial inline-text copy uses the same inline serializer, so formatting markers are preserved when present in the selection snapshot

### Block markers kept in `text/plain`

The serializer keeps the editor's structural markers:
- headings keep `#` prefixes
- bullet items keep `- `
- numbered items keep `1. `
- checklists keep `- [ ]` or `- [x]`
- toggles keep `▶ ` or `▼ `
- blockquotes keep `> `
- code blocks keep fenced code syntax
- code blocks omit the `text` info string when no explicit language was chosen, so default plain-text fences export without a language label
- dividers keep `---`
- custom tag-style blocks stay tag-style (`<callout>`, `<image>`, `<toggle-list-inline-view />`, `<card-ref />`, `<card-toggle>`, etc.)

### Empty and multiline behavior

- Empty paragraph / empty block lines are serialized as blank lines
- Multiline inline content stays multiline in `text/plain`
- Nested children are indented with tabs
- Continuation lines preserve indentation depth, but they do not repeat list/heading markers on each continued line

### Color metadata

When a block serializer already represents color inline in text form, that color suffix is kept in the clipboard text too.

## Image Toolbar Copy

Image blocks have a separate `Copy image` button in the formatting toolbar. This does not use the selection-copy pipeline.

### When the button is shown

The button is shown only when the active selection resolves to exactly one image block with a string `url` prop.

If multiple blocks are selected, or the current block is not a valid image block, the button is hidden.

### What it copies

The button tries to copy actual image bytes first:
- resolve the image URL through `editor.resolveFileUrl(...)` when available
- fetch the resource
- if the blob is an `image/*`, `ClipboardItem` exists, `clipboard.write(...)` exists, and the MIME type is supported, write the image blob directly

If that is not possible, it falls back to copying the resolved image URL as plain text.

### Failure behavior

The image copy action throws on:
- missing source
- failed URL resolution
- failed fetch
- missing clipboard support

The button handler catches that error, logs it, and does not show user-facing recovery UI.

On success, the editor is focused again.

## Current Differences Between The 2 Copy Paths

### Standard copy / cut

- browser clipboard event driven
- can write `blocknote/html`, `text/html`, `text/plain`
- uses structure-preserving `text/plain`
- preserves `blocknote/html` and `text/html` exactly as serialized
- rewrites `nodex://assets/...` paths only in `text/plain` when the sync asset-path prefix is available
- rewrites image lines in `text/plain` to Markdown image syntax after plain-text asset resolution
- cut deletes the selection only after successful copy handling

### Image toolbar copy

- block-toolbar action, not selection copy
- copies image bytes when possible
- otherwise copies the resolved image URL text
- does not write BlockNote HTML or structure-preserving `text/plain`

## Known Intentional Limits Of The Current Behavior

- There is no dedicated ProseMirror `clipboardTextSerializer` hook in use; text handling lives inside the editor's custom copy helper
- Continuation lines inside structured text keep indentation depth but do not repeat list markers
- Image conversion during selection copy is line-pattern based, not a full structured image AST pass
- The image toolbar copy path has no visible success/error toast

# NFM Editor Copy Behavior

Status: Active
Last Updated: 2026-09-05

This document describes copy-related behavior inside the NFM / BlockNote editor. It covers ordinary selection copy/cut, structural selection copy/cut, and the separate image-toolbar copy action.

This is intentionally narrower than the main product spec. It is the detailed source of truth for editor clipboard behavior.

## Scope

Included:

- Copy and cut of ordinary and structural editor selections
- Image-block toolbar `Copy image`
- Portable clipboard presentations and the private structural MIME descriptor
- Selection-shape rules that determine whether copied `text/plain` is raw text or structure-preserving text

Detailed structural paste, identity, and undo behavior is owned by [NFM Editor Structural Editing Behavior](nfm-editor-structural-editing-behavior.md).

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

The editor resolves one semantic clipboard target, builds one portable presentation, then chooses the ordinary or structural authority path from that target. Complete Block roots use the Structural Clipboard. Partial inline ranges and other ordinary text selections stay on the portable editor path.

Target resolution follows this priority:

1. A non-empty text, node, cell, or multi-Block selection remains authoritative.
2. Otherwise, a collapsed text caret inside the host editor targets its complete current Block subtree.

Copying from a collapsed caret does not manufacture a text or Block selection, move the caret, or show whole-Block selection paint. A native control or embedded non-editable island keeps its own clipboard behavior; a stale collapsed host-editor selection behind that control never becomes a Block command target.

### When it handles the event

Standard copy/cut is handled only when all of the following are true:

- the browser `ClipboardEvent` exposes `clipboardData`
- the target is either a non-empty ProseMirror selection or a collapsed text caret inside the host editor
- structured payload creation succeeds
- at least one clipboard MIME write succeeds

If any of those fail, the handler returns `false` and the editor falls back to downstream/default copy behavior instead of forcing its own result.

### Clipboard presentations

Every handled standard copy writes up to 3 rich and text representations:

- `blocknote/html`
- `text/html`
- `text/plain`

`text/html` and `text/plain` are the standard portable fallback;
`blocknote/html` preserves editor-rich structure for compatible consumers. Each
write is attempted independently, and a failure to write one type does not abort
the others. A structural copy never treats the private descriptor alone as a
successful claim: it also requires a usable standard HTML or plain-text
presentation.

A complete-Block structural copy additionally writes a bounded, versioned descriptor under:

```text
application/x-nodex-structural-clipboard+json
```

The private descriptor carries only the structural protocol version, lifecycle phase, exact native write claim, action hint, and a ready capability locator when available. It never contains the copied Block forest, Page content, File bytes, or another copy of the Core bundle. It is routing evidence, not permission to create, move, or read content.

The standard HTML and plain-text presentations are always written alongside the private descriptor. They remain useful in another application, another Profile, after the host runtime has restarted, or whenever private data is missing, malformed, stale, superseded, or unsupported. Portable HTML cannot create an owning Page, Canvas, or Database, and a foreign presentation cannot materialize `nodex://files/...` as an authorized Library File reference.

On success, the handler calls `preventDefault()`.

### Cut behavior

Cut uses the same clipboard payload as copy.

For an ordinary target, after a successful clipboard write:

- if the editor view is editable, a range cut deletes that range and a collapsed-caret cut deletes the complete current Block subtree
- if clipboard serialization/writing fails, it does not delete the selection

A collapsed-caret cut resumes at the previous editable sibling's end, otherwise the next sibling's start, otherwise the parent or first surviving Block. Cutting the only root replaces it with one empty paragraph so the editor remains writable. The removal and cursor recovery form one undoable local transaction.

For complete Block roots, Core first captures an immutable ownership-closure snapshot. Electron Main publishes the safe portable presentation and private routing descriptor to the native clipboard under one exact write claim. A Cut submits one structural source deletion only after that claim still owns the native clipboard slot. Main does not expose the Cut as ready to another window until the deletion's LocalCommit has been admitted by the source renderer. Failure leaves the complete source unchanged and, when the portable presentation remains current, leaves a safe copy result rather than a half-completed move.

A registration or capture timeout may reject work before source deletion begins.
Once a Cut has published and source deletion is in flight, elapsed time alone
cannot prove that the source was preserved. That phase therefore remains
pending until the source renderer reports the admitted commit or preservation,
the source renderer is disposed, or the application Scope closes; Main never
turns an active deletion into a portable-copy verdict merely because a timer
expired.

Electron Main owns the application-scoped pending lifecycle for structural copy and cut. A paste in another Nodex window may begin waiting before source capture has registered; both sides still rendezvous by the exact write claim. Main does not require immediate native readback during registration because the browser may not have committed the ClipboardEvent yet. Final publication performs the exact slot comparison and supersedes older sessions. Registration/capture timeout, explicit source settlement, sender loss, Profile replacement, or application shutdown eventually settles every waiter without transferring semantic authority to Main.

### How copy payloads are derived

All 3 clipboard payloads are derived from the same resolved clipboard target:

- `blocknote/html`
- `text/html`
- `text/plain`

For a non-empty selection, the helper starts from `editor.getSelectionCutBlocks(false)` and rebuilds a normalized selected block tree. For a collapsed caret, it reads `editor.getTextCursorPosition().block` and keeps that Block's complete descendant tree. Both paths then export:

- `clipboardHTML` from the editor's lossless clipboard serializer. Custom inline
  content uses canonical schema wrappers rather than mounted NodeView UI, so
  browser HTML normalization cannot split the surrounding inline sequence. A
  complete Block forest is explicitly serialized as a closed ProseMirror Slice,
  so paste never infers a deeper open boundary and lifts descendants out of
  their copied parent. Partial text selections remain open and retain their
  normal boundary-merge behavior.
- `externalHTML` presents `editor.blocksToHTMLLossy(...)` to other applications
  and carries the lossless clipboard fragment in a versioned HTML attribute.
  Native clipboard replacement and context-menu reads can discard custom MIME
  data, so standard HTML must independently retain the selected tree and its
  ProseMirror Slice boundaries. Nodex recovers that fragment before generic
  HTML/Markdown parsing, including after the oversized-text prompt; Code Blocks
  still accept literal plain text. The fragment is bounded, untrusted
  presentation with typed-owner semantics removed, never a structural
  capability. Invalid fragments fall back to the visible HTML/text.
- `structuredText` from `blockNoteToNfm(...)` plus `serializeClipboardText(...)`

If the cut-aware range path is unavailable or throws, the helper falls back to BlockNote's `selectedFragmentToHTML(...)` output and keeps the existing HTML-parse fallback for `text/plain`. A collapsed-caret Block target never degrades into an empty text-range payload.

### Plain-text File references

Standard copy/cut keeps `nodex://assets/...` and `nodex://files/...` locators
portable by default. The `Copy file references as local paths` setting is off
by default. When enabled, Nodex resolves both locator families to their current
absolute local files only inside `text/plain`. A Library File resolves to a
private materialization of the exact version authorized by the current read
source; the File presentation name and rich HTML remain unchanged.

Legacy managed assets resolve synchronously. Library File identity resolves
through its direct, Page, Canvas, history, or recovery read source. For
ordinary selections, Nodex synchronously writes a portable rich fallback with a
bounded native clipboard claim, resolves the local paths, and asks Main to
enhance only its plain-text representation. Main writes only when the claim
still owns the system clipboard, so a newer copy from Nodex or another app is
never overwritten. The portable payload remains usable while resolution is in
flight or if it fails. The existing HTML and private clipboard formats are left
intact. Structural copy uses the same conditional writer to enhance text and
publish its HTML capability after Core prepares the authoritative bundle.

The rich fragment survives both ordinary enhancement and structural publication;
rewriting plain-text paths never changes its File locators, Block hierarchy,
or partial-selection boundaries. Ordinary write claims are not structural
descriptors and never start a Core clipboard wait.

A structural HTML capability does not bypass an active Main session. Cut remains
pending until the source admits its LocalCommit, even if the capability is already
present in the clipboard or a newer copy has replaced the native slot. A host with
no matching session can recover the published capability, subject to Core validation.

Native clipboard access is centralized in Main. Menu paste reads materialized
text, HTML, Markdown and native file URLs from one pasteboard generation; keyboard
paste never supplements its captured content with a later system read. Menu paste
and asynchronous resource insertion retain the original mapped selection and
cancel when that editor or target becomes invalid. Code Blocks retain literal
text paste priority over rich or structural routing.

Image and Browser screenshot copies finish only after the native PNG write has
completed. Native failures remain controlled copy failures; Browser link copy
also observes write completion instead of leaving an unhandled rejection.

Local-path rewriting is all-or-nothing for one copied payload. If any Nodex File
reference cannot be resolved, every reference remains portable instead of
producing mixed local and portable locators.

After replacement, `text/plain` additionally converts `<image ...>caption</image>` lines into Markdown image syntax:

- indentation before the image line is preserved
- the `source="..."` attribute becomes the Markdown destination
- captions become Markdown alt text
- alt text escapes only `\`, `[` and `]`
- destinations escape `\`, `(`, `)`, and `>` as needed
- destinations containing whitespace are wrapped in `<...>`

If an image tag line does not match the expected pattern or has no usable source, it is left unchanged.

### Image examples

These examples assume `Copy file references as local paths` is enabled and are
specifically about the exported `text/plain` payload. `text/html` stays
unchanged and continues to carry the original serialized image presentation.

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
- code blocks keep fenced code syntax when the code block itself is copied as structure
- text selections made inside a code block copy only the selected code text, without surrounding fences
- code blocks omit the `text` info string when no explicit language was chosen, so default plain-text fences export without a language label
- dividers keep `---`
- custom tag-style blocks stay tag-style (`<callout>`, `<image>`, `<page uuid="..." />`, `<page-ref url="nodex://pages/..." />`, etc.)

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
- treats a collapsed host-editor caret as its complete current Block subtree without changing selection presentation
- writes `blocknote/html`, `text/html`, and `text/plain`; complete Block roots also advertise the bounded private structural descriptor
- coordinates structural readiness across Nodex windows through the application-scoped host runtime
- uses structure-preserving `text/plain`
- preserves `blocknote/html` and `text/html` exactly as serialized for portable standard copy
- preserves the serialized `text/html` presentation when opt-in local-path resolution completes
- keeps Nodex File locators portable by default and optionally resolves both Library Files and legacy managed assets only in `text/plain`
- rewrites image lines in `text/plain` to Markdown image syntax after plain-text asset resolution
- cut deletes the resolved range or current Block only after successful copy handling

### Image toolbar copy

- block-toolbar action, not selection copy
- copies real image content through the native desktop clipboard
- does not fall back to copying the resolved image URL text
- does not write BlockNote HTML or structure-preserving `text/plain`
- shows a global in-app success toast when native image copy succeeds
- shows a global in-app error toast when native image copy fails

## Known Intentional Limits Of The Current Behavior

- There is no dedicated ProseMirror `clipboardTextSerializer` hook in use; text handling lives inside the editor's custom copy helper
- Continuation lines inside structured text keep indentation depth but do not repeat list markers
- Image conversion during selection copy is line-pattern based, not a full structured image AST pass

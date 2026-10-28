# Page Editor Copy Behavior

Status: Active
Last Updated: 2026-10-25

This document describes copy-related behavior inside the BlockNote Page editor. It covers ordinary selection copy/cut, structural selection copy/cut, and the separate image-toolbar copy action.

This is intentionally narrower than the main product spec. It is the detailed source of truth for editor clipboard behavior.

## Scope

Included:

- Copy and cut of ordinary and structural editor selections
- Image-block toolbar `Copy image`
- Portable clipboard presentations and the private structural MIME descriptor
- The Markdown written as copied `text/plain`, and the selection-shape rules it follows

Detailed structural paste, identity, and undo behavior is owned by [Page Editor Structural Editing Behavior](nfm-editor-structural-editing-behavior.md).

Not included:

- Paste behavior
- Board drag/drop `text/plain` payloads
- Thread transcript copy actions outside the Page editor

## Copy Surfaces

The Page editor currently has 2 distinct copy paths:

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

Electron Main owns the application-scoped pending lifecycle for structural copy and cut. A paste in another Nodex window may begin waiting before source capture has registered; both sides still rendezvous by the exact write claim. A gesture registers immediately when content history admits it, before queued content preparation. Main does not require immediate native readback during registration because the browser may not have committed the ClipboardEvent yet. Final publication performs the exact slot comparison and supersedes older sessions. Registration/capture timeout, explicit source settlement, sender loss, Profile replacement, or application shutdown eventually settles every waiter without transferring semantic authority to Main.

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
- `structuredText`, the portable Markdown of the same Blocks, produced by
  `writePortableMarkdown` according to the rules in
  [Markdown Interchange](../references/markdown-interchange.md)

The fallback serializer is evaluated only if the normal selection serializer is unavailable or throws. In that case, the helper falls back to BlockNote's `selectedFragmentToHTML(...)` output and keeps the existing HTML-parse fallback for `text/plain`. A collapsed-caret Block target never degrades into an empty text-range payload.

### Plain-text File references

Inline attachments copy as Markdown links, `[name](source)`, in paragraphs,
nested Blocks and table cells, and images as Markdown images,
`![caption](source)`. Linked files and folders retain
their existing absolute paths even when local-path copy is disabled. Saved
attachments retain their current Nodex locator by default; the original import
location never substitutes for the saved content. Missing targets retain a
readable attachment label. Rich fragments and exact Nodex Markdown retain attachment
identity rather than replacing the occurrence with a text link.

Standard copy/cut keeps `nodex://assets/...` and `nodex://files/...` locators
portable by default. The `Copy file references as local paths` setting is off
by default. When enabled, ordinary selections resolve both locator families to
local files only inside `text/plain`. Structural selections export supported
Library File occurrences from their captured versions; unsupported or mixed
legacy references keep the portable representation. A Library File resolves to a
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
intact. Structural copy publishes the portable text and its HTML capability first.
When local-path copy is enabled at the gesture, Core captures a bounded, immutable
File export manifest alongside the selected structure. Main exports those exact
versions independently, then rechecks the bundle lease and source authorization
before conditionally replacing only plain text. Cut readiness and internal Paste
never wait for this optional export. An external paste made before enhancement
receives the already available portable representation. Failed, unsupported,
revoked, or superseded exports leave that representation intact.

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

Local-path resolution replaces a locator in place, whether it is a Markdown
destination or bare text, and keeps the Markdown around it, including the
indentation of nested Blocks. A path written as a destination escapes literal
`\`, `<`, `>` and `&`, escapes `(` and `)` or, when the path contains whitespace,
is wrapped in `<...>`, so it reads back as exactly that path.

### Image examples

These examples assume `Copy file references as local paths` is enabled and are
specifically about the exported `text/plain` payload. `text/html` stays
unchanged and continues to carry the original serialized image presentation.

```text
# selection:
[![diagram](nodex://assets/diagram.png)]
# expected text/plain:
![diagram](/absolute/path/diagram.png)
```

```text
# selection:
[Plan
	![](nodex://assets/plan.png)]
# expected text/plain:
- Plan

  ![](/absolute/path/plan.png)
```

```text
# selection:
[![release plan (v2)](nodex://assets/my-file.png)]
# expected text/plain:
![release plan (v2)](/absolute/path/my-file.png)
```

```text
# selection:
[![](nodex://assets/my-file.png)]
# resolved file path:
/workspace/my files/my-file (v2).png
# expected text/plain:
![](</workspace/my files/my-file (v2).png>)
```

```text
# selection:
[![diagram](/workspace/already-absolute.png)]
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
:::toggle[toggl[e title]
:::

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
[## Heading
paragraph]
# expected copy result:
## Heading

paragraph
```

Parent/child structure is preserved when the selected range includes the parent block. Markdown nests only under list items and quotes, so a paragraph or toggle with Blocks under it is written as an outline:

```text
# selection:
1234[56
	1234567
	1234567
12345]6
# expected copy result:
- 56
  - 1234567
  - 1234567

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

Inline formatting follows the same writer in partial and full-block copy, and text that would read as Markdown is escaped only where it otherwise would:

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

next **row**](https\://example.com)
```

Selected empty Blocks have no Markdown and are left out:

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
- it writes the parsed blocks as Markdown by the same rules

When both a selection-derived result and an HTML-derived result exist, the helper keeps the "richer" one using a simple heuristic that favors:

- more indented lines, which is where Markdown keeps nesting
- more blank lines
- more total lines

If all custom reconstruction fails, the helper falls back to BlockNote's original `markdown` text output.

## Markdown Format

Copied `text/plain` is GitHub Flavored Markdown, as
[Markdown Interchange](../references/markdown-interchange.md) writes it, so
Markdown apps, chat apps and Composers read what was copied. Within that:

- a text selection made inside a code block copies only the selected code text,
  without surrounding fences
- a code Block without an explicit language is fenced without an info string
- a line break is a newline, Blocks are separated by a blank line, and a list
  follows the line that introduces it
- underline and colors are left out, and Nodex Blocks Markdown cannot say, such
  as callouts, toggles and Page mentions, are written as near as Markdown can

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
- writes `text/plain` as portable Markdown
- preserves `blocknote/html` and `text/html` exactly as serialized for portable standard copy
- preserves the serialized `text/html` presentation when opt-in local-path resolution completes
- keeps Nodex File locators portable by default and optionally resolves both Library Files and legacy managed assets only in `text/plain`
- presents attachments as Markdown links and images as Markdown images, with optional local-path resolution
- cut deletes the resolved range or current Block only after successful copy handling

### Image toolbar copy

- block-toolbar action, not selection copy
- copies real image content through the native desktop clipboard
- does not fall back to copying the resolved image URL text
- does not write BlockNote HTML or Markdown `text/plain`
- shows a global in-app success toast when native image copy succeeds
- shows a global in-app error toast when native image copy fails

## Known Intentional Limits Of The Current Behavior

- There is no dedicated ProseMirror `clipboardTextSerializer` hook in use; text handling lives inside the editor's custom copy helper
- Copied `text/plain` says what Markdown can; the rich formats beside it carry everything else, such as colors, toggles and Page mentions

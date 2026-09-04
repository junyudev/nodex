# NFM Editor Attachment Chip Behavior

Status: Active
Last Updated: 2026-09-05

This document describes the current pasted-attachment behavior inside the NFM / BlockNote editor.

It is the detailed source of truth for:

- oversized-text paste prompting
- native file/folder paste prompting
- inline attachment chip insertion
- attachment chip rendering, hover, click, and preview behavior
- attachment-related NFM serialization and clipboard plain-text behavior

The main product spec should stay high-level and defer to this document for exact behavior and examples.

## Scope

Included:

- paste interception for oversized text and native desktop file/folder pastes
- dialog choices and when each choice is shown
- persisted inline NFM syntax for attachments
- attachment chip visual contract and interaction model
- preview rules for saved text, files, and folders
- plain-text clipboard output for attachments

Not included:

- image block behavior
- Notion structured paste itself
- generic BlockNote custom-inline-content internals outside the attachment feature
- non-editor file-link behavior elsewhere in the app

## Terminology

- `attachment chip`: the inline visual token inserted into paragraph-like content
- `Library File attachment`: an attachment with `mode="materialized"` that
  points to an independent `nodex://files/<file-id>` resource and is readable
  through the containing Page's canonical occurrence
- `legacy saved attachment`: a materialized `nodex://assets/...` attachment
  created by a non-Page or older authoring surface
- `linked attachment`: an attachment with `mode="link"` that points to an original absolute local path
- `attachment popover`: the click-open details surface anchored to the chip

User-facing copy uses:

- `Save a Copy`
- `Keep as Link`
- `Paste Anyway`

Persisted data still uses:

- `mode="materialized|link"`

## Data Model

Attachments are persisted as inline NFM atoms, not blocks.

Syntax:

```xml
<attachment
  kind="text|file|folder"
  mode="materialized|link"
  source="nodex://files/<file-id>|nodex://assets/...|/abs/path"
  name="..."
  mime="..."
  bytes="..."
  origin="/abs/path"
/>
```

Attribute rules:

- `kind` is required and must be `text`, `file`, or `folder`
- `mode` is required and must be `materialized` or `link`
- `source` is required
- `name` is required
- `mime`, `bytes`, and `origin` are optional
- `origin` is typically present only for saved file/folder attachments that came from an original local path
- new materialized attachments in a Page use `nodex://files/<file-id>`; the
  source is stable identity and does not change when the File is renamed

Block-level `<resource ... />` is no longer a structured NFM element.

If old `<resource ... />` text appears in content:

- it is parsed as ordinary paragraph text
- it is not migrated
- it is not re-emitted as an attachment automatically

## Placement Model

Attachments are inline content and are intended to live inside any inline-capable text block.

Primary insertion target:

- paragraph
- heading
- list items
- toggle summary lines
- other inline-capable text blocks supported by the editor schema

Fallback insertion target:

- if the selection is block-only, or the current block cannot host inline content, the editor inserts or replaces a paragraph whose only content is the attachment chip sequence

For multi-item pastes:

- inline-capable target: chips are inserted inline, separated by a literal single space text node
- fallback paragraph target: one paragraph is inserted containing the chip sequence separated by single spaces

## Paste Triggers

The attachment flow activates in 2 cases.

### 1. Oversized plain text

The editor prompts when pasted `text/plain`:

- reaches or exceeds `Large paste text threshold`
- or would push the current description length to or beyond `Large paste description soft limit`

Default values:

- text threshold: `100,000`
- description soft limit: `750,000`

These settings are renderer-local and configurable in Settings -> Editor.

Whitespace-only text does not trigger the prompt.

### 2. Native desktop file/folder paste

On Electron desktop, keyboard paste captures Files from the PasteEvent before
the handler returns, including screenshots exposed only through DataTransferItem.
The existing File-object path capability identifies files and directories without
reading the system clipboard again. Main still owns filesystem validation and
rejects symbolic links.

Context-menu paste obtains bounded rich content and validated native file/folder
metadata in one asynchronous Main request. All formats come from one materialized
pasteboard generation; a changed generation fails the read instead of mixing
copies. Native resource metadata travels only with that internal paste operation,
not in a renderer-writable clipboard MIME. A failed native read does not fall
through to a later browser clipboard read.

Every asynchronous paste freezes its original editor selection. The selection
maps through subsequent document edits without following a moved caret. Closing
the view, replacing its Document generation, or deleting the target cancels
insertion. Resource uploads, attachment choices and Paste Anyway use this same
target; no temporary Blocks or Undo entries are created while waiting.

This path is for real native paste signals only.

It does not trigger for:

- plain-text absolute paths copied as text
- file-like strings inside `text/plain`
- browser runtime that lacks the Electron clipboard inspection surface

## Paste Priority

Paste handling order is:

1. Notion structured paste
2. existing image paste behavior
3. attachment prompt for native file/folder paste
4. attachment prompt for oversized text
5. normal BlockNote paste behavior

This means attachment prompts do not override Notion structured paste and do not replace current image-specific paste behavior.

## Prompt Behavior

### Oversized text prompt

The dialog shows:

- `Save a Copy`
- `Paste Anyway`
- `Cancel`

It does not show `Keep as Link`.

Dialog copy:

- title indicates that the text is too large to paste directly
- body explains that the user can save a copy, paste anyway, or cancel
- preview shows the raw pasted text, truncated to at most `100,000` visible characters in the dialog surface
- preview is scrollable
- metadata line shows character count and line count

### Native file/folder prompt

The dialog shows:

- `Keep as Link`
- `Cancel`

For file-only paste, the dialog also shows:

- `Save a Copy`

For folder paste, `Save a Copy` is not offered.

The dialog lists each pasted item with:

- kind icon
- item name
- path or mime summary

## Choice Semantics

### `Save a Copy`

#### Oversized text

The editor:

- on a Page, creates an independent `.txt` Library File; other editor hosts
  retain their narrow managed-asset behavior
- derives the preferred File default name from the first non-empty line,
  slugified and suffixed with `.txt`; it does not allocate a Page path
- derives the chip label from the first non-empty line, truncated to 80 characters, fallback `Pasted text`
- inserts a `kind="text"` attachment chip with `mode="materialized"`

#### Native file paste

The editor:

- on a Page, copies the exact bytes into an independent Library File through
  Core; other editor hosts retain their narrow managed-asset behavior
- inserts a `kind="file"` attachment chip with `mode="materialized"`
- preserves `origin` when the source came from an absolute local path

#### Native folder paste

The editor:

- does not offer `Save a Copy`
- only supports keeping a link to the original folder path
- does not create a saved folder manifest asset from the paste flow

### `Keep as Link`

Available only for real native file/folder paste.

The editor:

- does not copy file contents into assets
- inserts an attachment chip whose `source` is the original absolute local path
- uses `mode="link"`

For folders, this is the only supported choice.

Linked oversized text is not supported.

### `Paste Anyway`

Available only for oversized plain text.

This bypasses the attachment flow and replays normal paste semantics using the captured clipboard payload:

- `blocknote/html` first
- then `text/markdown`
- then `text/html`
- then `text/plain`

This path is intended to match ordinary paste behavior as closely as possible, including markdown preservation.

## Chip Rendering

Attachment chips are compact inline tokens, not embedded mini-cards.

Current visual contract:

- the same lightweight inline-reference visual as Page and chat mentions across
  editable, read-only, and static NFM surfaces
- inline, baseline-participating geometry with no resting fill or horizontal
  capsule padding
- concise label only
- path/MIME-derived File icon on the left, using the same glyph projection as
  Page Files and the existing file-type color projection; folders retain the
  folder glyph
- subtle solid label underline at rest
- a local foreground-derived highlight on hover, keyboard focus, or token
  selection
- optional link glyph on the right for linked attachments

The chip should feel like a mention/reference token, not like a separate block element.

### Label rules

`kind="text"`:

- use the attachment `name`
- this is typically derived from the first non-empty pasted line
- fallback `Pasted text`

`kind="file"` or `kind="folder"`:

- for a Library File, resolve its authorized presentation name by stable File ID
- otherwise use `name`

Inline display truncates labels to 48 characters.

### Click and hover

Hover:

- shows a tooltip with concise summary
- includes saved/link state
- includes byte size when available
- prompts the user to click for details

Click:

- opens an anchored popover
- does not directly open the file on click

## Popover Behavior

The attachment popover is the detailed interaction surface.

Header shows:

- the same type-colored, path/MIME-derived icon as the attachment chip
- full label
- kind
- byte size when available
- saved/link state

Metadata area shows:

- primary source/path
- original path when present and different

Actions:

- Library File: `Save` and `Copy reference`
- legacy saved or linked attachment: `Open`, `Reveal`, and `Copy path`
- `Open original` when `origin` exists and differs from the primary source

### Primary target resolution

Library File attachment:

- `Save` reads the currently authorized File bytes through Core and opens a
  destination chooser; no Profile path is revealed
- `Copy reference` copies the stable `nodex://files/<file-id>` reference

Legacy saved attachment:

- `Open` resolves the `nodex://assets/...` source to a local asset path, then opens it

Linked attachment:

- `Open` opens the original local path directly

`Reveal`:

- reveals the primary resolved path in the file manager

`Copy path`:

- copies the resolved primary path when available
- otherwise copies the displayed source/path string

`Open original`:

- opens `origin`
- shown only when `origin` is present and differs from the primary source

## Preview Rules

Preview loading follows the attachment resource identity, not the mounted
popover content. Hover, keyboard focus, or opening the popover may start the
bounded read. The result remains available while that attachment chip stays
mounted, so a metadata-only label refresh or closing and reopening the popover
does not restart the read. A change to source, owner authority, File manifest
revision, kind, or preview-relevant MIME invalidates the result, and an older
in-flight result cannot replace the new resource.

A previewable attachment opens directly into either its retained preview or a
visible loading state. It never renders an empty preview container between
those states. A failed read presents `Preview unavailable.` while unsupported
formats continue to use the truthful no-preview state. Closing and reopening a
failed preview retries the same resource.

### Saved text

Saved text attachments show a scrollable text preview in the popover.

Preview caps:

- at most `200` lines
- at most `64 KiB`

When truncated, the popover states that the preview was limited.

### Saved text-like files

Saved file attachments preview only when the MIME type is treated as text-like.

Current text-like MIME handling includes:

- `text/*`
- `application/json`
- `application/sql`
- `application/toml`
- `application/xml`
- `application/yaml`

Binary files show metadata and actions only.

### Saved folders

The current paste flow does not create saved folder attachments.

If a saved folder attachment is created by another internal path, the popover previews the persisted manifest snapshot:

- scrollable list of manifest entries
- folder/file distinction
- file byte sizes when present
- truncation note when manifest caps were hit

### Linked file/folder attachments

Linked attachments do not preview raw file/folder contents in the popover.

They show:

- metadata
- actions
- explanatory copy that the chip points to the original location

## Copy And Export Behavior

### Structured NFM

When serialized back to NFM:

- attachments emit inline `<attachment ... />` tokens
- they remain inline adjacent to surrounding text

### Plain-text clipboard output

For `text/plain` structure-preserving clipboard payloads, attachments are rendered as readable placeholders:

```text
[Attachment: report.txt]
```

This avoids leaking raw XML into plain-text copy while keeping the presence of the attachment visible.

### HTML / internal clipboard output

For internal BlockNote copy/export:

- attachment chips use custom inline-content external HTML rendering
- rich clipboard payloads preserve the structured attachment identity for editor round-trip

## Runtime Constraints

Desktop Electron:

- supports native clipboard inspection for file/folder paste
- validates metadata for Files captured by the current paste event
- transfers bounded rich content and native resource metadata together asynchronously
- supports resolving saved asset paths for open/reveal actions
- on Page surfaces, publishes new materialized attachments as independent
  Library Files and resolves their metadata/bytes through the containing Page
  occurrence authority

Browser runtime:

- does not support native file/folder paste inspection
- still supports oversized-text prompting
- still supports rendering existing saved or linked attachment chips

## Examples

### Oversized pasted text saved as an attachment

```text
User pastes a large markdown incident note.
Dialog shows Save a Copy / Paste Anyway / Cancel.
User chooses Save a Copy.
Result: inline <attachment kind="text" mode="materialized" ... />
```

### Native file paste kept as link

```text
User copies a file in Finder and pastes into the editor.
Dialog shows Save a Copy / Keep as Link / Cancel.
User chooses Keep as Link.
Result: inline <attachment kind="file" mode="link" source="/abs/path" ... />
```

### Native folder paste kept as link

```text
User copies a folder in Finder and pastes into the editor.
Dialog shows Keep as Link / Cancel.
User chooses Keep as Link.
Result: inline <attachment kind="folder" mode="link" source="/abs/path" ... />
```

### Plain copied path should not trigger attachment prompt

```text
/Users/abc/Documents/report.txt
```

If that text is pasted as plain text only:

- it is treated as normal text paste
- it does not trigger the native file/folder attachment prompt by itself

## Non-Goals

This feature does not currently try to:

- inline-preview arbitrary linked local file contents
- support linked oversized plain text
- provide browser-only support for desktop folder paste inspection

# Page Editor Attachment Chip Behavior

Status: Active
Last Updated: 2026-11-09

This document describes the current pasted-attachment behavior inside the BlockNote Page editor.

It is the detailed source of truth for:

- oversized-text paste prompting
- native file/folder paste prompting
- inline attachment chip insertion
- attachment chip rendering, hover, opening, and actions
- attachment-related Nodex Markdown serialization and clipboard plain-text behavior

The main product spec should stay high-level and defer to this document for exact behavior and examples.

## Scope

Included:

- paste interception for oversized text and native desktop file/folder pastes
- dialog choices and when each choice is shown
- inline Nodex Markdown syntax for attachments
- attachment chip visual contract and interaction model
- where each kind of attachment opens
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

User-facing copy uses:

- `Save a Copy`
- `Keep as Link`
- `Paste Anyway`

Stored attachment data uses:

- `mode="materialized|link"`

## Data Model

Attachments are inline atoms in Blocks and Nodex Markdown.

Exact Nodex Markdown:

```text
:attachment{kind="file" source="nodex://files/0199134e-cbb0-7000-8000-000000000006" name="report.txt"}
:attachment{kind="file" mode="link" source="/abs/path/report.txt" name="report.txt"}
```

Attribute rules:

- `kind` is required and must be `text`, `file`, or `folder`
- `mode` is `materialized` or `link`; exact text omits the default `materialized` value
- `source` is required
- `name` is required
- `mime`, `bytes`, and `origin` are optional; folders do not take `bytes`
- `origin` is typically present only for saved file/folder attachments that came from an original local path
- new materialized attachments in a Page use `nodex://files/<file-id>`; the
  source is stable identity and does not change when the File is renamed

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
  editable, read-only, and static Page editor surfaces
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

### Hover

Hover shows the full name, then what the attachment is:

- saved attachments: their format and byte size, such as `Markdown · 31 KB`
- linked attachments: the path they point to
- saved folders: `Folder`

The chip is a reference, like a Page mention: it never expands into a card or an
anchored details surface.

## Opening

Click opens the attachment where it is best read. Cmd-click (Ctrl-click on
Windows and Linux) or a double click keeps the tab it opens instead of reusing
the group's preview tab. With the chip selected by Arrow keys, Enter opens it;
the selected chip shows `Open file ↵` (`Open folder ↵` for a linked folder).

- A Library File in a Page's body opens as a Page File tab beside that Page,
  exactly as its row in the Page's Files property does (see
  [Page Files](page-files-behavior.md#opening-files)). Markdown renders, HTML
  shows its isolated preview, media plays, and text shows as source. An image
  shows over the Page in the image preview first, which offers its tab.
  Opening a File that already has a tab activates it.
- A Library File shown where no Page tab can open, such as a Page history
  revision, a recovery draft, or another read-only preview, opens in a viewer
  over the current surface. The viewer reads through that surface's exact File
  binding, so a revision shows the version it captured. It presents the File
  as a Page File tab does, except that HTML shows as source, and offers View
  source or View preview for Markdown and SVG, and Save….
- A linked file opens as a local file reference does anywhere in Nodex: in a
  Files tab in the side panel, or in the Browser for a local HTML page. A
  linked folder opens in the system file manager.
- A legacy saved attachment resolves its managed copy to a local path and
  opens it the same way.

The import `origin` of a saved attachment is provenance only. Nodex never opens
the original path in an external app; the saved File is the attachment.

## Actions

Right-click opens the attachment's context menu.

Library File:

- `Open` and, where a Page File tab can open, `Open in new tab`
- `Save…` reads the currently authorized File bytes through Core and opens a
  destination chooser; no Profile path is revealed
- `Copy reference` copies the stable `nodex://files/<file-id>` reference

Linked file or legacy saved attachment: the same menu as every local file
reference, including Open file, Open in the preferred editor, Open with, Save
as…, Copy path, Copy file contents and Reveal in Finder.

Linked folder: Reveal in Finder and Copy path.

## Copy And Export Behavior

### Nodex Markdown

In exact Nodex Markdown:

- attachments emit inline `:attachment{…}` directives
- they remain inline adjacent to surrounding text

### Plain-text clipboard output

For `text/plain` structure-preserving clipboard payloads, attachments copy as
Markdown links containing their current target:

```text
[report.txt](/absolute/path/report.txt)
[saved.txt](nodex://files/0199134e-cbb0-7000-8000-000000000006)
```

Linked files and folders retain their existing absolute paths regardless of the
`Copy file references as local paths` preference. Saved attachments retain
their Nodex locator by default; enabling the preference resolves that locator
through the existing authorized File export flow. Copy always uses `source`,
never the attachment's import `origin`. Paragraphs, nested Blocks, and table cells
use the same attachment presentation, with literal filename
and destination escaping. A missing target retains `[Attachment: name]`.

The complete plain-text export and clipboard ownership rules live in
[Page Editor Copy Behavior](nfm-editor-copy-behavior.md#plain-text-file-references).

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
Result: an inline saved-text attachment chip.
```

### Native file paste kept as link

```text
User copies a file in Finder and pastes into the editor.
Dialog shows Save a Copy / Keep as Link / Cancel.
User chooses Keep as Link.
Result: an inline file attachment chip linking to the original path.
```

### Native folder paste kept as link

```text
User copies a folder in Finder and pastes into the editor.
Dialog shows Keep as Link / Cancel.
User chooses Keep as Link.
Result: an inline folder attachment chip linking to the original path.
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

- expand an attachment's contents inline in the Page; it opens in its own viewer
- support linked oversized plain text
- provide browser-only support for desktop folder paste inspection

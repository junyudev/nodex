# Page Editor Link Behavior

Status: Active
Last Updated: 2026-08-17

This document describes the current explicit link behavior inside the BlockNote Page editor.

It is the detailed source of truth for manual link creation, editing, stored link marks, exact link-target preservation in the editor, and the Page editor's open-time link classification rules. The main product spec should stay high-level and defer to this document for exact rules and examples.

## Scope

Included:

- Manual link creation from the formatting toolbar
- Manual link editing from the hovered/selected link toolbar
- Submit-time trimming and exact-preservation rules
- Stored link-mark behavior as it relates to Nodex Markdown round trips

Not included:

- Automatic link recognition while typing or pasting
- Attachment-chip `Keep as link` behavior
- Transcript markdown link behavior outside the editor
- Copy/export serialization rules beyond normal stored link syntax

Canonical `nodex://pages/<page-id>` targets are ordinary stored links with an
internal Page open action. Their navigation and contextual paste behavior is
defined by [Page Connections](nfm-editor-page-reference-behavior.md).

## Overview

The Page editor has 2 different link paths:

1. Automatic link recognition
2. Explicit/manual link editing

This document is only about the second path.

Manual link creation and editing happen through the BlockNote-based editor UI:

- the formatting toolbar `Create link` flow
- the link toolbar shown for an existing selected/hovered link

Both flows use the same Nodex-local submit-time normalizer.
Both flows now also use Nodex-owned surfaces instead of BlockNote's default form-popover chrome. Existing-link actions use the compact toolbar described below; create-link keeps its separate URL form.

## Inline Link Visual Treatment

Ordinary links inside the editor use the shared interactive link treatment:

- a medium-weight blue foreground blended from the link and editor text tokens
- normal inline flow with no extra horizontal padding
- no underline at rest
- a 0.5px dashed underline with a 2px offset on hover

Page-mention chips are editor atoms rather than ordinary text links. Their
labels keep the editor's normal foreground color, stay in normal inline flow
without extra horizontal padding, and use a subtle solid
underline at rest (`0.05em` thickness, `10%` offset, and a 25% foreground mix).
Keyboard focus changes only that underline to the current label color; hover
does not change the underline. Their own chip hover and keyboard-focus
highlight remains independent from ordinary link styling. Thread/chat mentions
use the same label treatment and inline geometry; date mentions retain their
separate text-level visual style.

## Link Toolbar Affordance

For an existing selected or hovered link, the Page editor shows a compact toolbar anchored below the link by default. Floating UI may flip it above the link when viewport collision requires it.
Its chrome is a single 36px-high rounded toolbar with the same spacing and shadow in its normal and URL-editing states.
Both states use an opaque floating surface so editor content never shows through the toolbar, and they share the same link-action glyph set.
The toolbar uses the same light and dark outline shadow geometry as Notion's link toolbar. `Copy` and `Open` are icon-only actions; their tooltips and accessible names remain available.

The toolbar is intentionally concise:

- a truncated, non-interactive URL preview identifies the stored target
- `Edit` and `Clear` are icon-only actions
- `Copy` copies the stored raw `href` exactly as authored and flips to the shared `Copied` checkmark feedback state on success
- `Open` owns navigation and uses the existing open-time link classification rules

`Clear` removes the link mark without opening another surface. Blocked or unresolved targets keep the same failure reason and disable `Open`; the URL preview remains available for inspection.

Selecting `Edit` replaces the compact toolbar with another toolbar of the same height. The edit state contains one URL input with the placeholder `Type or paste a link` and an `Apply link` action rendered as a 20px filled circle with a 12px contrasting checkmark. It does not expose a link-title field: editing the target never changes the visible link text. URL changes continue to use the same trim-only normalizer and stored-link semantics, and the input keeps focus while the current draft target is updated.

This affordance change is visual and interaction-level only; it does not change how manual link targets are stored.

## Behavior Model

When the user confirms a manual link create/edit action, the editor:

- reads the URL field exactly as typed
- trims surrounding whitespace
- preserves the remaining value exactly as entered
- writes that final `href` into the BlockNote/Tiptap link mark

This is intentionally narrower than autolink behavior:

- autolink decides whether plain text should become a link automatically
- manual link editing decides how the submitted link target should be stored

## Submit-Time URL Rules

The editor applies exactly one transformation at submit time:

- trim surrounding whitespace from the URL field

After trimming, the editor preserves the submitted value exactly as entered.

Examples preserved as entered:

```text
https://example.com/docs
mailto:test@example.com
file:///Users/asc/repo/abc
/Users/asc/repo/abc
C:\repo\abc
./notes.md
../notes.md
folder/abc/file
example.com
www.example.com/docs
#section
?tab=details
```

### Empty values

If the submitted URL field is empty after trimming, the editor does not write a new link target.

The current implementation treats empty submit as a no-op for link creation/editing rather than silently storing an empty `href`.

## Local File Path Preservation

Absolute local paths are a first-class manual-link input in the editor.

This includes:

- absolute Unix-style paths such as `/Users/asc/repo/abc`
- absolute Windows paths such as `C:\repo\abc`
- `file://` URLs such as `file:///Users/asc/repo/abc`

These values must not be rewritten to `https://...`.

In particular, a value such as:

```text
/Users/asc/repo/abc
```

must remain:

```text
/Users/asc/repo/abc
```

and must not become:

```text
https:///Users/asc/repo/abc
```

This is a product behavior requirement, not just an implementation detail, because local-path links are part of the intended technical-notes workflow.

## Relative Link Preservation

The editor preserves relative/manual-reference forms as entered, including:

- `./foo`
- `../foo`
- `folder/abc/file`
- `#heading`
- `?tab=details`

These values are treated as intentionally authored references. The editor does not attempt to reinterpret them as absolute web URLs.

## Explicit Protocol Values

Explicit protocol values are also preserved as entered.

Examples:

```text
https://example.com
mailto:test@example.com
tel:+123456789
file:///Users/asc/repo/abc
```

## Link Persistence

Once a manual link is stored in the editor, Nodex Markdown keeps the final `href` value exactly as stored in the link mark.

Example:

```text
[link](/Users/asc/repo/abc)
```

round-trips as:

```text
[link](/Users/asc/repo/abc)
```

not:

```text
[link](https:///Users/asc/repo/abc)
```

This is because the behavior is enforced at manual-link submit time, before the value is written as Nodex Markdown.

## Open-Time Classification

Storage and opening are intentionally separate.

When the user clicks a stored manual link in the Page editor or a read-only Page preview, Nodex classifies the preserved stored `href` at open time instead of relying on browser-relative navigation.

Open-time rules:

- explicit safe protocol values such as `https://`, `http://`, `mailto:`, `tel:`, and `file://` open according to that protocol
- bare domain-like values such as `example.com` and `www.example.com/docs` open as `https://...` at click time only; the stored `href` stays unchanged
- absolute local paths and `file://` URLs open through the desktop local-file open path
- relative file-like values such as `folder/abc/file`, `./foo`, and `../foo` resolve against the active project workspace path and then open as local files
- fragment/query references such as `#section` and `?tab=details` stay literal and are not reinterpreted as file or web links
- unresolved relative file-like values fail closed and do not fall through to browser-relative navigation

Examples:

```text
Stored href: example.com
Stored value remains: example.com
Open-time target: https://example.com
```

```text
Stored href: folder/abc/file
Project workspace: /Users/asc/repo/nodex2
Open-time target: /Users/asc/repo/nodex2/folder/abc/file
```

```text
Stored href: folder/abc/file
No project workspace available
Open-time behavior: do not navigate; show unresolved-file tooltip instead
```

## Relationship To Autolink

Manual link behavior and autolink behavior intentionally differ.

Autolink:

- is conservative
- tries to avoid false positives for repo paths and filenames
- may leave many path-like values as plain text

Manual link editing:

- assumes explicit user intent
- preserves the submitted value exactly after trimming
- allows local file paths
- preserves author-entered relative references
- preserves protocol-less domain-like values instead of rewriting them
- classifies preserved values only when the user clicks them

So a value may:

- stay plain text when merely typed into the editor
- but still be accepted unchanged when the user explicitly enters it into the link dialog

That difference is expected.

## Examples

### Preserved unchanged

```text
https://example.com
mailto:test@example.com
file:///Users/asc/repo/abc
/Users/asc/repo/abc
C:\repo\abc
./notes.md
../notes.md
folder/abc/file
example.com
www.example.com/docs
#section
?tab=details
```

### Invalid prior regression

```text
Input in link editor:
/Users/asc/repo/abc

Incorrect old result:
https:///Users/asc/repo/abc

Correct current result:
/Users/asc/repo/abc
```

## Design Rationale

Nodex notes frequently include:

- local repository paths
- file references
- relative references between note sections
- ordinary public web links

The editor therefore needs a manual-link model that respects technical author intent instead of assuming every non-protocol value is a website.

The intended behavior is:

- explicit user-entered local paths should stay local paths
- relative references should stay relative references
- slash-separated relative file paths should stay exactly as entered
- explicit protocol links should stay untouched
- domain-like inputs should also stay exactly as entered when authored manually

## Implementation Notes

Current implementation shape:

- upstream BlockNote/Tiptap link marks still own the stored link mark type
- Nodex overrides the default BlockNote create/edit link UI submit path
- the custom submit normalizer trims only and otherwise preserves the user-entered `href` before Nodex Markdown serialization

This override exists because the upstream default React link editor prepends `https://` to any non-protocol value, which is too aggressive for Nodex's technical-note workflow.

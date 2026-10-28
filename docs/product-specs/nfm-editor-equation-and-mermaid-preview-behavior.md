# Page Editor Equation and Mermaid Preview Behavior

Status: Active

Last updated: 2026-08-27

## Purpose

Nodex supports source-authored mathematical equations and Mermaid diagrams without storing rendered output. Equations are first-class Block Document content. A Mermaid diagram remains a Code Block whose language is `mermaid`; preview format is a local way to view that source, not a second durable Block type.

## Durable model

A Block Equation is `mathBlock` with plain TeX source and no children. Inline Equation is inline `math` with plain TeX source. Both forms preserve that source exactly across the Core/Yrs document boundary. KaTeX HTML and MathML are derived at render time and never enter Nodex Markdown, Yjs, database state, collaborative updates, or Undo history.

Mermaid source is an ordinary `codeBlock` with `language: "mermaid"`. There is no durable `diagram`, `previewMode`, SVG, image, caption, or renderer property. Switching a Code Block into or out of Mermaid preserves its exact source. The code-language catalog remains the same exact 88-item catalog.

## Equation authoring

The Slash Menu exposes `Inline equation` in Text and `Block equation` in Blocks. Typing a complete `$$source$$` expression creates an Inline Equation when the opening delimiter is at the start of the text, after whitespace, or after `(`. The source must be non-empty and may not start or end with whitespace. Conversion happens when the second closing dollar is typed, keeps the source popup closed, and leaves the caret immediately after the new Equation. Invalid TeX still converts because rendering validity never controls source ownership. `$source$`, `\(source\)`, empty or edge-padded double-dollar expressions, escaped opening delimiters, incomplete delimiters, and double-dollar expressions adjacent to other text remain literal. `$$ ` and `\[ ` in an empty text Block also remain literal and never create a Block Equation.

`⌘/Ctrl+Shift+E` inserts an empty Inline Equation at a text caret or converts a same-Block plain-text selection into one. The text-action toolbar's Equation control invokes the same command for a selection. Both command paths open the source popup and select the complete source; an empty insertion opens at the empty source. A typed `$$source$$` conversion is one Undo operation back to its literal delimiters. Backspace immediately after the converted Equation deletes the Equation rather than reopening its literal syntax.

Block and Inline Equation previews expose accessible MathML. Clicking or selecting an editable preview opens its TeX source popup, focuses the source field, and selects the complete TeX source so the next edit can replace it immediately. The source field is named `Equation (LaTeX)`. Enter submits valid source; Shift+Enter inserts a line break in Block Equation; Escape closes and returns focus. `⌘/Ctrl+A` inside the popup selects only that equation's source. Invalid TeX remains editable, presents an alert, and disables Done rather than discarding source.

A closed invalid Block Equation presents the rendering diagnostic on a full-width danger surface, preserving the Block's visual boundary and enough room for the actionable parse message. Inline Equation failures instead remain compact in-flow badges. Dark error foregrounds retain at least 4.5:1 contrast. The source popup resolves every highlighted TeX token from the active BlockNote color scheme, and its primary action and error message use the same dark-aware product roles. Editable TeX remains a transparent source surface and never inherits Inline Code mark background, padding, or radius. Inline Equation placeholders participate in the surrounding text baseline, inherit the surrounding type metrics, and use the established Agent Config chip radius and horizontal padding. Its empty state is labeled `New equation`.

An Equation is selectable plain source but is not a plain-text merge target. Backspace at the beginning of a closed Equation is a no-op. Backspace with the complete Block Equation selected removes that Block through ordinary block-selection semantics. A following paragraph is not merged into an Equation. Turn Into exposes `Block equation`; conversions preserve textual source, promote children before entering the childless shape, and participate in the same single-operation Undo contract as other ordinary Block conversions.

## Nodex Markdown

Inline Equation uses `$$source$$`. Its delimiter is one dollar sign longer than the longest run in the source, and at least two; sources with boundary dollars or spaces use the padding defined by [Nodex Markdown](../references/nodex-markdown.md#links-and-mentions). Block Equation uses matching standalone dollar fences of at least two characters. The writer chooses a fence longer than every standalone dollar-only source line, so TeX remains literal and round-trips losslessly.

Clipboard and Agent-facing Nodex Markdown keep TeX source. External semantic HTML may contain MathML with a TeX annotation, but generated KaTeX markup is never authoritative.

## Mermaid preview formats

`Code - Mermaid` creates a regular Mermaid Code Block with starter source. Mermaid Code supports three renderer-local formats:

- `code`: source only;
- `preview`: diagram only;
- `split`: source followed by the diagram in one vertical surface.

The default is `split`. The value is stored per stable Block ID under `code-mermaid-preview-${blockId}`. A remount, move, or delete then Undo keeps it; a duplicate or new/imported Block receives a new ID and starts in split. Storage failure falls back to live in-memory state. Format changes never call an editor mutation and never affect Markdown text, Yjs, saving, collaboration, or Undo/Redo.

Preview-only keeps ProseMirror's required content mount inert, visually clipped, and outside the accessibility/tab order. Its trigger receives focus before the source is hidden. Returning to code or split restores a visible editable source region.

## Mermaid actions and presentation

At sufficient width the Mermaid Action Bar contains Language, Display, Expand, Download, Copy, and More. A divider follows the Language selector and separates it from every block action. Display is a 24px icon-only trigger with a `Display` tooltip. It opens a compact horizontal icon picker whose three 24px radio actions have `Code`, `Preview`, and `Split` tooltips and complete only-code, only-preview, and combined accessible labels; the selected format uses the same subtle action-hover tint as the bar. Its accessible names are:

- `Open language dropdown`
- `Open language preview format dropdown`
- `Expand diagram`
- `Download diagram as JPEG`
- `Copy code to clipboard`
- `Open block actions menu`

Compact layouts keep Display beside More so all three renderer formats remain available directly from the Action Bar. The shared Block actions menu does not duplicate the Code, Preview, or Split choices. Other controls progressively collapse into that menu. Action Bar, menus, Code background, equation popup, diagram, loading, and error surfaces all resolve from the active light or dark token scheme.

The diagram itself is keyboard focusable and named `Click diagram to expand in fullscreen`. Pointer, Enter, or Space opens the app-owned fullscreen dialog. Escape closes it and restores the initiating control. The fullscreen diagram canvas always paints an opaque app surface in both color schemes; transparency in the generated SVG must not expose the page behind the dialog. The root SVG has no fixed height, fills available width only up to the sanitized viewBox width, and preserves its aspect ratio; small diagrams remain at intrinsic size instead of being enlarged to the Code Block width. Copy always writes raw Mermaid source. Download rasterizes the latest valid sanitized SVG as a JPEG with bounded 2x scale, 40px padding, and theme background; rasterization failure downloads sanitized SVG and reports the fallback.

Empty source shows an authoring prompt. During a 300ms-debounced render the previous valid SVG may remain visible. If the latest source is invalid, the preview reports the error and may retain the last valid diagram while making the stale state explicit. Only the newest mounted request may update the surface. Read-only and history views present the diagram and retain source Copy without mutation controls.

## Runtime and security boundary

All editor and Streamdown Mermaid rendering goes through one app-owned lazy runtime. No feature or optional package may independently call `mermaid.initialize()`. The runtime owns strict security, disabled autostart/error SVG insertion, HTML-label prohibition, secure configuration keys, `maxTextSize: 500000`, and `maxEdges: 1500`.

Every render uses a unique ID and controlled light/dark theme input. Diagrams use the Dagre layout and classic appearance unless their authored source selects another layout or look. Output passes a second SVG sanitizer that removes executable elements, event handlers, foreign HTML, remote references, CSS imports, unsafe URLs, and fixed root height, then derives a safe intrinsic maximum width from the sanitized viewBox before preview or export. Temporary Mermaid DOM is removed after success or failure. A render failure never blocks source editing or Copy.

## Verification boundary

Pure tests own Nodex Markdown delimiter selection, Core/Yrs plain-inline round-trips, adapter/headless round-trips, local view-state semantics, structural capabilities, strict configuration, SVG sanitization, action capacity, and download fallback. Browser tests own real Math source popups and selection, Mermaid concurrency and cleanup, Code/preview/split accessibility, action reachability, theme rerender, error recovery, fullscreen focus, and NodeView lifecycle. Integrated manual QA covers valid, empty, long, invalid, inline, read-only, narrow, and dark states.

# Visual blocks

A Visual is a Page code block with language `visual`. Its source, data, parameters,
and caption travel with the Page through document history and collaboration.
The Page previews it offline. While a change contains an error, the preview
keeps the last successful render and reports the error. Offscreen Visuals can
display a cached snapshot while the window lends its live guests to visible
figures.

## Source contract

The source consists of optional pinned imports followed by one
`<nodex.Visualize>`, or one `<div>` containing Visuals. Each Visualize has a
literal caption naming the data source, literal `sources` and `params`
objects, and one synchronous child function. The function receives one row
array per source, `datum`, current `params` values and `theme` CSS values. It
returns SVG or a div of SVGs. An outer SVG's `width` and `height`, or its
`viewBox`, give its starting size; a narrower Page column scales the whole figure
down with its aspect ratio instead of cropping it. React hooks work inside the
callback.
Parameter values belong in source if they need to persist.

Each source declares a key column or columns with unique scalar values in every
row. Inline `data` and cached `query` sources contain row objects. A query
also carries its SQL and ISO `refreshedAt` timestamp. A `file` identifies a
File on the same Page and specifies JSON or CSV. A `table` identifies a table
on the same Page and uses its first header row for column names. CSV and table
cell values are strings. JSON preserves scalar and structured values. Nodex
resolves each source with the caller's access before rendering.

Spread `datum(row, field?)` onto a mark to associate its geometry with the
source row. The row must be the original object from the source array. Nodex
tracks visible JSX string literals in SVG text elements for source edits.
Editing a row field, a label, or a parameter changes only the selected literal.
Replacing a query result changes its data array and refresh timestamp.

Imports can use React, D3 Scale, D3 Shape, D3 Array, D3 Format, D3 Time, D3 Time
Format, D3 Hierarchy and Observable Plot from Nodex's pinned distribution.
Inline sources allow 2,000 rows and 256 KiB per source. The source text limit is
1 MiB. Resolved sources allow up to 20,000 rows per source and 4 MiB per Visual.

## In the Page

The editor shows the figure, not the source. On hover, a toolbar offers:

- **Data:** a table of each source's rows. Inline and query rows can be edited
  in place with a double-click, except key columns. File and table sources show where
  they come from.
- **Edit text:** outlines each label that can be rewritten; choosing one edits it in place.
- **Comment:** choose a data point, or anywhere on the figure, to start a Discussion on it.
- **Ask Nodex:** asks about the figure.
- **Source:** shows or hides the code.

Pointing at a data point outlines it and shows its key, field and value. A data
point with an open Discussion keeps a yellow outline, like highlighted text;
choosing it opens the Discussion. The figure itself takes no pointer input, so
scrolling over it scrolls the Page. Parameters
appear under the figure as sliders, choices and switches. Every edit rewrites one
literal in the source as an attributed change. While suggesting, it becomes a
Suggested edit of the code block. Escape leaves comment and text modes.

## Refresh and Portable Markdown

Refresh runs the saved SQL through Core with the current Member's access and
the Page's routing context. Results must fit the Visual source limits and
preserve unique row keys. A failed refresh leaves the current result in place.
The editor can write the refreshed data and timestamp together or offer that
change as a Suggested edit.

Page Markdown download and Copy content as Markdown include a light snapshot,
the caption, and a table for each source with rows. The snapshot is an embedded
PNG. Some Markdown readers hide embedded images, so the caption and data remain
readable on their own. When rendering fails after the sources resolve, export
keeps the caption and tables. When the source cannot be read, export preserves
the code fence. Exact Nodex Markdown continues to carry the editable Visual.

## Agent checks and export

Check the raw source, fix errors, inspect both appearances, and write the
Visual once. `nodex visual check FILE|-` and the `visual_check` MCP tool report
invalid structure, unsupported imports, offline-policy violations, and limits.
They also report layout warnings for measured label overlap and clipping,
unused datum bindings, missing accessible names, and hard-coded colors.
Warnings mark details for review.

Use `--block BLOCK` on the CLI or `blockId` in MCP to resolve that Block's Page
sources. `--out DIR` writes the captures locally. `nodex visual snapshot
--block BLOCK` and `visual_snapshot` render the stored Block with the same
runtime. Both support light and dark appearances. Svg and PNG snapshots are
derived data. A snapshot becomes a Page File through an explicit attachment.

See [the Visuals reference](../../agent-skills/nodex/references/visuals.md) for
the authoring example.

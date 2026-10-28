# Page Editor Table Block Behavior

Status: Active  
Last updated: 2026-06-24

## Summary

Page bodies support simple editable tables in Card Stage, inline toggle-list editors, read-only history previews, and the lightweight Page editor renderer. The table feature mirrors the Notion simple-table interaction model where possible while keeping Nodex design tokens for color, border, shadow, and typography.

## Syntax and Persistence

- GFM pipe tables read as `table` Blocks and remain serialized as pipe tables while they only use GFM-expressible state: rows, cells, header row, and column alignment.
- Exact text is a pipe table, wrapped in `:::table{…}` when header state, column widths or table color need attributes. A cell background is an attribute list at the end of its text. [Nodex Markdown](../references/nodex-markdown.md) owns canonical spelling; tables do not have merged cells.
- Tables are top-level or nested Blocks but are childless at the persistence boundary. Table cells contain inline rich text, including inline images; child Blocks, owning resources, dividers, and other Block content are not valid inside cells.
- Page bodies are stored in their owned collaborative Documents; Markdown text is a derived projection.

## Editor Behavior

- `/table` inserts a 2-column by 3-row simple table with no header row, no header column, and no fixed widths.
- BlockNote/ProseMirror owns table invariants, cell selections, Tab/Shift-Tab navigation, Enter-to-next-row behavior, column resizing, and table copy/paste normalization.
- Nodex enables header row/column table support and cell background support. Split/merge cells, database conversion, comments, and row-to-card import are shown only as disabled development-build controls until Nodex has the underlying product model.
- The block side menu shows live `Header row` and `Header column` actions for a single selected table block. Development builds can additionally show disabled placeholder rows such as `Fit table width`, row/column color placeholders, and `Create cards from rows`.
- Table row/column/cell handle menus use the same compact visual language as the Page editor block side menu: 265px main surface, 226px color flyout, 28px action rows, shared side-menu icons for `Color`, `Duplicate`, and `Delete`, right-side shortcuts/checkmarks, tokenized hover/background/shadow, and disabled mock rows only for actions whose product model is not implemented yet.
- Row and column handle `Duplicate` creates a copied row or column immediately after the selected row or column, preserving inline rich text, cell color props, text alignment, and column width where applicable. `Clear contents` empties selected row, column, or cell content while preserving cell styling and table dimensions. Cell-level duplicate remains absent because the reference simple-table behavior does not duplicate single-cell selections.
- Table paste priority is Notion block MIME, then BlockNote/default HTML handling, then GFM plain-text table handling. Notion `table` plus `table_row` records paste as table Blocks; database/collection tables are not converted.

## Layout and Visual Contract

- Editor table cells use 120px minimum width, 240px default maximum width, 32px minimum height, 7px/9px cell padding, 1px tokenized dividers, and 2px blue tokenized selection affordances.
- Row/column/cell handles use Notion-like compact geometry and motion but resolve color, border, background, shadow, and backdrop through Nodex tokens.
- Read-only renderers emit semantic HTML `<table>` markup with the same width and padding constraints and tokenized border/color classes.

## Clipboard and Prompt Serialization

- Whole-block copy and Page prompt serialization include table cell text in row-major order.
- Portable clipboard text writes tables as GFM pipe tables; Page prompts use exact Nodex Markdown with table directives when required.
- GFM pasted from plain text is parsed as Markdown only when the clipboard text contains a valid GFM table delimiter row, so ordinary pasted text remains plain text.

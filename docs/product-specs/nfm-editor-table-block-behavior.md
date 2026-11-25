# Page Editor Table Block Behavior

Status: Active  
Last updated: 2026-11-25

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
- The block side menu shows live `Header row`, `Header column`, `Fit to page width`, and `Fit columns to content` actions for a single selected table block.
- Table row/column/cell handle menus use the same compact visual language as the Page editor block side menu: 265px main surface, 226px color flyout, 28px action rows, shared side-menu icons for `Color`, `Duplicate`, and `Delete`, right-side shortcuts/checkmarks, tokenized hover/background/shadow, and disabled mock rows only for actions whose product model is not implemented yet.
- Row and column handle `Duplicate` creates a copied row or column immediately after the selected row or column, preserving inline rich text, cell color props, text alignment, and column width where applicable. `Clear contents` empties selected row, column, or cell content while preserving cell styling and table dimensions. Cell-level duplicate remains absent because the reference simple-table behavior does not duplicate single-cell selections.
- Table paste priority is Notion block MIME, then a GFM table written in the copied plain text, then BlockNote/default HTML handling. Notion `table` plus `table_row` records paste as table Blocks; database/collection tables are not converted.

## Column Widths

- A column is either auto or pinned. Auto columns have no stored width (`auto` in Nodex Markdown) and size from their content; pinned columns store whole pixels. Tables written by Agents, pasted as Markdown, or inserted with `/table` start with every column auto.
- An auto table is as wide as its content needs, up to the width of the text column; only a table whose content cannot fit that width scrolls horizontally. Columns never contribute a fixed minimum merely by existing.
- Auto cells are sized by their text length in display units, where East Asian wide and fullwidth characters count two: a cell of at most 20 units stays on one line; a longer cell wraps and keeps a minimum of 11em (8em in a header cell) so prose columns are never crushed; a column whose every cell is empty keeps a 9em typing width. Long unbroken tokens such as paths and URLs wrap anywhere rather than widening the table.
- Dragging a column edge pins every column at its current rendered width and moves only that edge, so the edge stays under the pointer; release commits all widths as one undo step. A press and release without movement changes nothing.
- Double-clicking a column edge returns that column to auto.
- The table's block side menu offers `Fit to page width`, which pins every column in proportion to its current width so the table, frame included, spans the text column, and `Fit columns to content`, which returns every column to auto and is enabled only when some column is pinned.
- A table whose every column is pinned renders those widths exactly and scrolls when wider than the text column. A mixed table sizes its auto columns from content around the pinned ones.
- While a table scrolls horizontally, each edge with more table beyond it fades out; a table that fits has crisp edges.

## Layout and Visual Contract

- Page editors, read-only Page renderers, and chat Markdown share one table look: a 1px rounded frame, horizontal rules between rows, and no column rules at rest. In the editor, faint column rules appear while the pointer is over the table or cells are selected, and the hovered column edge shows a 2px focus-colored resize rule.
- Table text is 0.9375em of the surrounding text at 1.5 line height with tabular figures; cells use 0.5em/0.875em padding and top alignment. Header cells use weight 500, a 4% foreground tint, and balanced wrapping.
- Selected cells take the text-selection tint. Cell background and text colors resolve through Nodex tokens in every renderer.
- Row/column/cell handles use compact Nodex-tokened geometry and motion.

## Clipboard and Prompt Serialization

- Whole-block copy and Page prompt serialization include table cell text in row-major order.
- Portable clipboard text writes tables as GFM pipe tables; Page prompts use exact Nodex Markdown with table directives when required.
- A GFM table in copied plain text becomes a table Block even beside rich text. Plain text alone follows the Page's [plain-text paste rules](../references/markdown-interchange.md#clipboard-sources).

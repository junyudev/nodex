# Kanban Drag and Drop Behavior

## Status
- Active
- Last updated: 2026-03-17

## Scope
This spec is the detailed source of truth for drag-and-drop behavior across the Kanban board and its directly connected editor surfaces.

It covers:
- Kanban card drag within the board
- Multi-card Kanban drag
- Drag behavior while Kanban search/filter/sort rules are active
- Block drag from NFM editors into Kanban
- Kanban card drag into NFM editors
- `cardToggle` drag back into Kanban when it materializes card data

It does not redefine general BlockNote side-menu behavior outside these Kanban-facing flows.

## Terms

### Visible cards
Cards currently rendered in the active Kanban view after applying search and toolbar filter/sort rules.

### Dragged cards
The card or card set currently being moved.

### Remaining cards
The target column after removing the dragged cards from that column.

### Visible slot
The insertion slot measured against the visible remaining cards in the rendered column.

### Persisted order
`newOrder` for Kanban card moves. This is always the insertion index after removing the dragged card or dragged cards from the target column.

This post-removal contract must stay identical across:
- Drag indicator placement
- Renderer optimistic transforms
- Backend `moveCard` / `moveCards` persistence

## Kanban Card Drag

### Pickup and preview
- Kanban card drag uses Atlassian Pragmatic Drag and Drop.
- Cards register their own draggable behavior locally.
- Board outcomes are resolved in one board-level monitor.
- The native drag preview preserves source geometry and source offset.
- While dragging, the source card stays rendered as a static ghost in place instead of live-shifting siblings.

### Same-column reorder
- Same-column reorder is measured against the remaining cards, not the raw pre-removal list.
- The insertion indicator is rendered from that same remaining-card slot space.
- Dropping between cards inserts into that exact visible gap.
- Same-column reorder must never require the user to mentally compensate for the dragged card still being visible as a ghost.

### Multi-card reorder
- Shift-click creates a temporary multi-selection.
- Dragging any selected card drags the full selected set.
- Same-column multi-card reorder preserves the dragged cards' relative order.
- Cross-column multi-card move inserts the dragged set as one block.
- Undo/redo treats the move as one grouped action.

### Cross-column move
- Dragging to another column changes card status to the target column.
- For same-project board moves, the operation stays local to the board mutation pipeline.
- Cross-column moves preserve grouped history semantics for multi-card drags.

## Filtered and Sorted Kanban

### Search and toolbar filters
- Kanban card drag remains enabled while search and toolbar filters are active.
- Reordering in a filtered view maps the visible slot back into the underlying board order.
- Hidden non-matching cards keep their relative order.
- If no visible anchor cards remain in a target column, the fallback behavior must be stable and deterministic.

### Sort-driven drag modes
- Kanban drag mode is decided by the primary sort key, not by a binary "sorted vs unsorted" check.
- `board-order` primary sort uses `manual-rank` mode.
- `priority` and `estimate` primary sorts use `property-sorted` mode.
- `created` and `title` primary sorts use `derived-move-only` mode.

### `manual-rank` mode
- When `board-order` is the primary sort key, same-column and cross-column drag both remain enabled.
- Secondary sort keys do not disable manual ranking.
- The visible slot still maps back to persisted post-removal `newOrder`.

### `property-sorted` mode
- When `priority` or `estimate` is the primary sort key, same-column drag stays enabled.
- The drop resolves to an inferred target bucket from the visible neighbor cards.
- If the dragged cards already belong to that bucket, the drop is a pure reorder inside the bucket.
- If the drop crosses buckets, the dragged cards receive one inferred property patch (`priority` or `estimate`) and then reorder using `board-order` as the intra-bucket tiebreaker.
- Grouped multi-card drags preserve relative order while sharing the same inferred property patch.

### `derived-move-only` mode
- When `created` or `title` is the primary sort key, same-column manual ranking is blocked.
- Cross-column status changes remain enabled.
- The board must explain the block with explicit feedback instead of silently no-oping the drop.
- In this mode, column drop targets stay active while card drop targets stay disabled.

### Block import while derived views are active
- Native block-drop import into Kanban stays blocked while free-text search is active.
- Structured derived views can still accept block-drop import when the board can explain the result as either an exact visible slot or a column-level create.
- Exact-slot import is allowed when newly created cards can remain in the active subset using only safe inferred workflow properties, and the resulting placement can be mapped to a persisted insertion anchor.
- Safe inferred properties are limited to workflow metadata already owned by the board/view contract, such as target column status, unambiguous priority defaults, required tags, and discrete sortable fields like priority or estimate.
- If the active sort does not support a truthful gap meaning for new cards (for example title/created ordering), the board falls back to column-level target feedback instead of an insertion line.
- Column-level import still creates cards in the hovered column, but the current sort owns their rendered position.
- The board must not invent title/description text or other search-only content just to keep a created card visible in the current query.

## Editor Interop

### NFM block -> Kanban
- Native block drag from visible NFM editors into Kanban creates card(s) using move semantics.
- Source blocks are removed after a successful grouped import.
- Pointer position determines the Kanban insert slot when block-drop import is allowed.
- The board shows a drop indicator for this import path.

### Kanban card -> NFM editor
- Dragging a Kanban card into a visible NFM editor creates a standalone `cardToggle` snapshot block.
- The source card is removed as part of the same grouped move operation.
- The editor renders a live insertion line even though the drag originates from the Kanban runtime.
- Self-drop into the source card/editor context must be blocked.

### `cardToggle` -> Kanban
- Dragging a `cardToggle` block back into Kanban materializes one or more cards.
- Snapshot-preserved properties travel with the drag payload, including workflow metadata such as priority, estimate, tags, assignee, and scheduling fields.
- Current title and description edits in the dragged block are used when materializing the new card.

## Visual Feedback Rules
- Same-column board reorder uses an insertion line resolved against remaining cards.
- The insertion line must never render above a dragged ghost when the actual persisted position is before the next remaining card.
- `property-sorted` drags render the same insertion line plus a property-preview label that states the inferred target bucket.
- `derived-move-only` same-column drags must not show a misleading insertion line.
- `derived-move-only` same-column drags must show an explicit blocked-sort message on the destination column.
- Sorted cross-column drags should highlight the destination column on the actual column header/body surfaces, not only on the outer wrapper edges.
- Editor-targeted card drags show an editor insertion line, not just board-column feedback.
- Bare column hits still derive a real insertion slot from pointer position when manual ranking is active.

## Persistence and History Invariants
- `newOrder` is a post-removal insertion index.
- `moveCard` and `moveCards` must interpret `newOrder` the same way.
- Renderer optimistic transforms and backend persistence must produce the same column order for identical inputs.
- Drop-derived property patches must be applied atomically with the move, not through a follow-up card update.
- Grouped drags must record one grouped undo/redo action.
- Move semantics must stay atomic when a drag updates one surface and deletes from another.

## Non-Goals
- Copy-style board drag that leaves the source card in place
- Allowing derived-view block import when insert semantics are ambiguous

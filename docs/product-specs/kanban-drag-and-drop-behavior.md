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

### Non-default sort
- When a non-default sort is active, cards remain draggable across columns and into editors.
- Same-column manual re-ranking is disabled in that state.
- The reason is semantic, not technical: the active sort owns the visible order, so a manual insertion line inside the same sorted column would be misleading.
- Sorted drags use column-level target feedback instead of a same-column insert line.
- Under non-default sort, column drop targets stay active while card drop targets are disabled. This split is required so cross-column drops still resolve even though same-column insert slots do not.

### Block import while derived views are active
- Native block-drop import into Kanban is disabled while search, filter, or sort rules are active.
- Creating new cards into a derived subset does not have a trustworthy insertion-slot meaning.

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
- Sorted same-column drags must not show a misleading insertion line.
- Sorted cross-column drags should highlight the destination column on the actual column header/body surfaces, not only on the outer wrapper edges.
- Editor-targeted card drags show an editor insertion line, not just board-column feedback.
- Bare column hits still derive a real insertion slot from pointer position when manual ranking is active.

## Persistence and History Invariants
- `newOrder` is a post-removal insertion index.
- `moveCard` and `moveCards` must interpret `newOrder` the same way.
- Renderer optimistic transforms and backend persistence must produce the same column order for identical inputs.
- Grouped drags must record one grouped undo/redo action.
- Move semantics must stay atomic when a drag updates one surface and deletes from another.

## Non-Goals
- Copy-style board drag that leaves the source card in place
- Same-column manual ranking while a non-default Kanban sort is active
- Allowing derived-view block import when insert semantics are ambiguous

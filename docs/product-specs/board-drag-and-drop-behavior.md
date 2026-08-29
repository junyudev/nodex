# Board Drag and Drop Behavior

## Status

- Active
- Last updated: 2026-08-29

## Scope

This spec is the detailed source of truth for drag-and-drop behavior across the Board and its directly connected editor surfaces.

It covers:

- Board card drag within the board
- Multi-card Board drag
- Drag behavior while Board search/filter/sort rules are active
- Block drag from NFM editors into Board
- Board card drag into NFM editors
- Block drag between independently mounted NFM editor surfaces

It does not redefine general BlockNote side-menu behavior outside these Board-facing flows.

## Terms

### Visible cards

Cards currently rendered in the active Board view after applying search and toolbar filter/sort rules.

### Dragged cards

The card or card set currently being moved.

### Remaining cards

The target column after removing the dragged cards from that column.

### Visible slot

The insertion slot measured against the visible remaining cards in the rendered column.

### Persisted order

`newOrder` for Board card moves. This is always the insertion index after removing the dragged card or dragged cards from the target column.

This post-removal contract must stay identical across:

- Drag indicator placement
- Renderer optimistic transforms
- Backend `moveCard` / `moveCards` persistence

## Board Card Drag

### Pickup and preview

- Board card drag uses Atlassian Pragmatic Drag and Drop.
- Cards register their own draggable behavior locally.
- Board outcomes are resolved in one board-level monitor.
- An idle card keeps the pointer cursor because clicking it opens the Page; the
  grabbing cursor appears only after a drag has actually started.
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

## Filtered and Sorted Board

### Search and toolbar filters

- Board card drag remains enabled while search and toolbar filters are active.
- Reordering in a filtered view maps the visible slot back into the underlying board order.
- Hidden non-matching cards keep their relative order.
- If no visible anchor cards remain in a target column, the fallback behavior must be stable and deterministic.

### Sort-driven drag modes

- Board drag mode is decided by the primary sort key, not by a binary "sorted vs unsorted" check.
- `board-order` primary sort uses `manual-rank` mode.
- A writable Property primary sort uses `property-sorted` mode.
- `created` and `title` primary sorts use `derived-move-only` mode.

### `manual-rank` mode

- A View with no explicit sort rule exposes its intrinsic ascending fractional
  manual order. An empty sort list never means that Pages have no order.
- When `board-order` is the primary sort key, same-column and cross-column drag both remain enabled.
- Secondary sort keys do not disable manual ranking.
- The visible slot still maps back to persisted post-removal `newOrder`.

### `property-sorted` mode

- When a writable Property is the active sort prefix, same-column drag stays enabled.
- Fractional rank is the final stable tie-break after the writable Property
  tuple, so Pages with equal sorted values remain directly reorderable.
- The drop resolves each writable sort value from the visible neighbors. Matching
  neighbors allow inference to continue to the next sort key; at the first
  differing key, the after neighbor wins, or the before neighbor at the end.
- If the dragged cards already belong to that bucket, the drop changes only
  their fractional rank inside the bucket.
- If the drop crosses buckets, every dragged Page receives the inferred Property
  patch in the same Database mutation as group/subgroup adoption.
- Grouped multi-card drags preserve relative order while sharing the same inferred sort tuple.

### `derived-move-only` mode

- When `created` or `title` is the primary sort key, same-column manual ranking is blocked.
- Cross-column status changes remain enabled.
- The board must explain the block with explicit feedback instead of silently no-oping the drop.
- In this mode, column drop targets stay active while card drop targets stay disabled.

### Block import while derived views are active

- Native block-drop import into Board stays blocked while free-text search is active.
- Structured derived views can still accept block-drop import when the board can explain the result as either an exact visible slot or a column-level create.
- Exact-slot import is allowed when newly created cards can remain in the active subset using only safe inferred workflow properties, and the resulting placement can be mapped to a persisted insertion anchor.
- Safe inferred properties are limited to active writable Properties explicitly
  named by the View sort; Relation and intrinsic title/created sorts are not invented.
- If the active sort does not support a truthful gap meaning for new cards (for example title/created ordering), the board falls back to column-level target feedback instead of an insertion line.
- Column-level import still creates cards in the hovered column, but the current sort owns their rendered position.
- The board must not invent title/description text or other search-only content just to keep a created card visible in the current query.

## Editor Interop

### NFM block -> Database View

- Task shorthand interpretation, literal fallback, modifiers, and authoring feedback follow [Task Shorthand Page Promotion Behavior](task-shorthand-page-promotion-behavior.md).
- Native block drag from Card Stage and independently mounted owning/reference editors into Board or List targets the Database parent, not a serialized row snapshot. The custom side-menu starts one window-local drag session only after BlockNote has established the exact root Block selection. The default operation is move; holding Alt/Option at drop time copies instead.
- Move submits one logical `BlockTransfer`: text-like roots promote to Cards in place, while non-convertible roots receive deterministic wrapper Cards. Copy recursively clones ownership with fresh IDs and leaves the source unchanged. Neither path serializes NFM nor mutates a Card description projection.
- Images and attachments retain their stable File IDs. On Move, any File
  exclusively placed by the transferred forest and currently owned by the
  source host is rehomed to the promoted target Page in the same Core
  transaction. Copy never rehomes the source File. A target path collision uses
  a deterministic suffix and is folded into the existing success feedback;
  ownership-only consequences add no extra toast.
- Multi-block order follows the selected top-level document order. Nested selected blocks are represented only once through their selected ancestor.
- Board and List interpret pointer geometry into their own raw placement intent, while one shared renderer command owns session validation, source fencing, transfer, receipt feedback, and Undo registration. Core resolves the final placement and Property adoption atomically.
- A mounted source editor must finish its native drag state and return a fresh
  causal Document head before the command is submitted. If that exact source
  participant has unmounted or changed, the drop fails and asks the user to
  start the drag again; it never submits an unfenced transfer.
- A direct Board placement freezes the complete effective presentation that
  authored the gesture. Core normalizes and validates grouping and writable
  sort values against that presentation, never against a different durable
  default hidden behind Profile-local View preferences.
- Pointer position determines the Board insert slot when block-drop import is allowed. List-specific gaps, groups, derived-sort feedback, and search rejection follow [Database Pages and Views Behavior](database-pages-and-views-behavior.md).
- The active Database View shows truthful drag feedback for this import path.
- Empty target columns use whole-column drop feedback instead of a floating insertion line, because there is no sibling list for a truthful gap preview.
- Auto-collapsed empty columns and user-collapsed populated columns stay collapsed
  while accepting a drop. Their drop tone outlines only the active rail, and its
  horizontal boundary sits below the complete collapsed header stack (marker,
  label, count, and actions), never through that stack.

### NFM editor -> NFM editor

- An explicit side-menu drag between different Card Documents carries stable root Block IDs and logical Document coordinates through the same window-local session. The destination renders the horizontal block insertion line and suppresses ProseMirror's vertical text caret.
- The target does not insert a serialized ProseMirror/HTML slice, and the source does not later delete its selection. One `BlockTransfer` commits both Document updates and Block locations or leaves both unchanged. That same transaction may rehome an exclusively moved Page File; a partial or foreign placement remains owned by its existing Page without blocking the Block transfer.
- Both mounted editors settle transient drag/focus state and supply causal
  Document heads before the transfer. A missing source or target participant
  fails closed.
- Same mounted-surface reorder remains BlockNote-native because it is already one Yjs transaction in one Document. Two separately mounted surfaces over the same logical Document fail closed until a stable-ID single-Document move command is available.
- In nested Card outliners, the closest `.nfm-editor` to the event target owns the drop. An outer editor capture listener must not steal a drop intended for an embedded Card body.

### Database Page -> NFM editor

- Dragging one or more ordered Board Cards or List rows into a Card Stage or independently mounted reference editor moves the real same-ID, childless Card shells into the target Document. Their separately owned title/body Documents are unchanged.
- Move is the default. Holding Alt/Option at drop time copies each recursive ownership closure with fresh application IDs and preserves the source Cards.
- The target editor shows pending feedback but does not insert or remove authority optimistically. `BlockTransfer` commits the source Database parent, target Y.Doc shells, projections, and receipt together; failure leaves both surfaces unchanged.
- Board preserves the canonical Card-shaped native drag preview and source ghost;
  List preserves its dense-row drag overlay. Both sources enter the same typed
  Page-transfer path.
- The editor renders one live insertion line and suppresses BlockNote's native
  cursor/placeholder while it owns the accepted Page transfer.
- Self-drop into the source card/editor context must be blocked.

### Cross-window transport

- Cross-window native DnD is intentionally unsupported. A drag payload is valid only while the same renderer owns its typed live session; another window fails closed without claiming or mutating it.
- Cross-window consistency is provided by SQLite/Y.Doc synchronization. Supporting cross-window gestures later would require a trusted live-session handoff into the same `BlockTransfer` command, not a second snapshot transport.

## Visual Feedback Rules

- Each accepted Board hover resolves one board-owned drop proposal. Cards are
  drag sources, not competing drop targets; the insertion/column feedback,
  Property preview, and final drop all consume the same target and clear on the
  same leave, drop, or drag-end lifecycle.
- Same-column board reorder uses an insertion line resolved against remaining cards.
- The insertion line must never render above a dragged ghost when the actual persisted position is before the next remaining card.
- A Property preview lists only values that the drop will actually change on at
  least one dragged Page, including grouping, subgrouping, and inferred writable
  sort values. A pure reorder with unchanged Property values shows no label.
- `property-sorted` drags render the same insertion line plus any applicable
  Property preview that states the inferred target bucket.
- `derived-move-only` same-column drags must not show a misleading insertion line.
- `derived-move-only` same-column drags must show an explicit blocked-sort message on the destination column.
- Sorted cross-column drags should highlight the destination column on the actual column header/body surfaces, not only on the outer wrapper edges.
- Empty and collapsed-column drops should highlight only the active column
  surface instead of rendering a detached card-slot line at index `0`; a
  collapsed rail places its own horizontal drop boundary below the full header.
- Editor-targeted card drags show an editor insertion line, not just board-column feedback.
- Copy feedback follows the live Alt/Option state: board indicators say `Copy` or `Copy · <inferred property>`, and editor insertion lines include an integrated token-colored plus marker.
- Bare column hits still derive a real insertion slot from pointer position when manual ranking is active.

## Persistence and History Invariants

- `newOrder` is a post-removal insertion index.
- `moveCard` and `moveCards` must interpret `newOrder` the same way.
- Renderer optimistic transforms and backend persistence must produce the same column order for identical inputs.
- After drop, the Page run stays continuously visible at the intended slot while the command acknowledgement, exact row effect, and canonical repair converge. A successful acknowledgement ends pending UI but does not expose an older Board snapshot.
- A failed delegated drop rolls back to canonical authority and keeps one readable error on every owning card in the attempted run; a rejected or false mutation result is never treated as a successful drop.
- Mouse-up freezes the inferred grouping and sorted-Property values as part of
  the drop intent. The renderer applies those values in the first post-drop
  frame, and receipt-fenced LocalCommit rebases preserve them until canonical
  authority materializes; transient window contents never reinterpret the
  accepted drop.
- A singleton projection effect may reorder a loaded window from fractional
  rank only when manual order is the primary presentation rule. Property- or
  intrinsic-sorted windows update the affected loaded row in place and retain
  their current projection order until the required canonical repair arrives.
- A singleton Database-row effect preserves Core's canonical `position_order`; it must not renumber the affected Page as the first row of its group. Group-scoped windows insert the row only when their scope contains its effective group and remove it otherwise.
- Move transforms are identity-keyed, all-or-nothing for multi-Page runs, preserve `pageIds` visual order, update each summary's target status, and become a reference no-op once canonical column, slot, and field values satisfy the intent.
- Drop-derived property patches must be applied atomically with the move, not through a follow-up card update.
- Position-derived grouping and writable-sort values own the accepted drop. If
  task shorthand proposes a conflicting scalar value, the drop still commits
  at the chosen position and that root keeps its complete literal title.
- Group IDs are globally unique and grouped history lookup is global rather than project-local, so undo/redo of a cross-project move restores every affected project atomically and publishes change notifications for each project.
- Cross-surface Move/Copy carries stable IDs and logical parents only and commits through one idempotent `BlockTransfer`; source and target authority are never separate renderer mutations.
- A cross-surface Move relocates the complete selected subtree. Existing Blocks detached from one Document and attached to another remain active and advance their placement revision exactly once at the destination; source detachment must never degrade into deletion or partial child promotion.
- A promotion Undo guards the generated Page's current File heads and namespace,
  while one transaction reverses required File ownership moves, restores source
  placements, and removes the generated Page. Any conflicting target File or
  placement change leaves both sides unchanged.
- Every causal Document head is a freshness fence resolved through current Library ownership and the bound Project's effective read access. A Project is an access context, never the physical owner encoded by the causal-head check.
- The side-menu selection that starts the gesture is authoritative. Container-level `dragstart` listeners may manage visual cleanup but must never infer or replace the selected Block IDs.

## Non-Goals

- Copy-style Board-to-Board drag
- Allowing derived-view block import when insert semantics are ambiguous

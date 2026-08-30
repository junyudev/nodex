# Page Relocation Behavior

Status: Active
Last updated: 2026-08-31

## Scope

`Move to` in Sidebar Pages, Board, List, and every other Page action surface
changes the Page's exclusive Library parent while preserving its Block/Page ID,
owned Document, content, Files, references, historical Database key assignments,
and deep links. All surfaces use the same picker, typed destination read,
mutation, success feedback, and Undo behavior. A Project is never a Page parent.
A Project name shown beside a Database is only quiet context for that Database's
primary binding.

Moving to a Database resolves its active default View and Data Source and
creates the current membership, View placement, Source-defined Properties, and
current Page key there. Moving to a Page creates an owning child Page shell in
that Page's Document. Moving to `Pages` makes the Page a Library root. Source
membership and Source-defined values become dormant when the destination is
not a Database; they are not copied into intrinsic Page state.

## Menu and picker

The Board/List Page action order is `Open in`, `Copy`, `Move to`, optional
`Reorder`, then the separated `Delete`. Sidebar Pages presents `Move to` in its
compact resource menu. The label is exactly `Move to`, without an ellipsis.
`Reorder` means position inside the current View and is unrelated to parent
relocation. It is shown only when the startup capability
`database-page-reorder-menu` is enabled.

`Move to` opens a portaled 330-pixel right-side submenu using the shared
destination-picker frame. Its autofocus search field searches two Core-owned
sections together. With an empty query they are:

- `Databases`: every active Database in the current Library with an active
  default View and Data Source. A primary Project name may appear as quiet
  secondary context and participates in search.
- `Recent`: up to eight eligible recently updated Page destinations. When the
  current parent is a Page it is first and labeled `Current`.
- `Pages`: `Pages` top level plus a lazily expandable Page tree.

Search removes `Recent` and replaces the Page tree with flat Page matches and
complete ownership paths while continuing to search Databases. Query-fresh
metadata preview rows may appear immediately but remain disabled until the
authoritative relocation read supplies their exact move ETag.

The current parent remains visible, is labeled `Current`, and cannot be
selected. The moving Page and its complete Page-owned subtree are absent. A
bounded window that has more entries directs the user to search.

Arrow Up and Arrow Down move through selectable rows and skip `Current`.
Arrow Right expands a focused Page, Arrow Left collapses it, Enter commits the
focused destination, and Escape closes the action menu. Loading feedback is
delayed for 400 milliseconds. A failed read or mutation stays inside the
picker as a compact retryable state.

## Authority and atomicity

The trusted Library destination read returns display metadata, a typed
`library | page | data_source` destination, current-parent state, and a move
ETag fenced to the source and exact destination authority. Renderer code does
not derive a Data Source from a Project, reconstruct ancestry, simulate Project
grants, or compose a source delete with a target insert.

One Library mutation revalidates the store epoch, source Page, destination
Library, active lifecycle, destination Document or Database/View/Data Source,
cycle exclusion, and move ETag. It then changes typed parentage, owning shells,
membership, View ranks, Page-key projection, affected Documents, history, and
LocalCommit delivery in one SQLite transaction. A stale or unauthorized target
leaves both source and destination unchanged.

## Undo

Every successful Page relocation returns a one-shot Undo token. Its Core-owned
recipe records the original typed parent and position plus the Page's resulting
parent and location revision. `Undo` runs a dedicated typed intent through the
same Page ownership compiler and consumes the token in that transaction.

For a Library source, Core records the previous and next top-level siblings.
For a Page source it records the owning Page, Document parent, and adjacent
siblings. Undo resolves those anchors against the current authoritative state,
so unrelated content edits survive; it restores before the original next
sibling when possible, otherwise after the original previous sibling. If the
source parent or all usable anchors disappeared, Undo fails closed rather than
silently appending or replacing a Document.

For a Data Source source, Core records the source Data Source, default View,
and exact active View ranks. Undo reactivates the source membership and dormant
Property values without applying new destination-group values, and restores
all saved ranks atomically. Reuse, tampering, store-epoch mismatch, or another
relocation of the Page fails before any write; the token remains retryable when
a recoverable source-position conflict is repaired.

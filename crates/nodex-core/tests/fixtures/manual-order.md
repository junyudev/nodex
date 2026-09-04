# Complete View order storage

`manual-order.sql` isolates the production complete-order storage boundary with
minimal canonical membership and Parent tables. Registered migrations and the
current schema are the production authority; this fixture exercises physical
space and lifecycle pressure without fabricating full Documents.

The storage tests cover bounded generation preparation, atomic publication,
default-tail identity order, whole-run positioning, local rank repair, inactive
Page restoration, and interruption/reopen. The 1,000/10,000/100,000-row matrix
measures SQLite VM work for forward, Undo and Redo with fixed-size selections.
These are Module/storage evidence, not full public-command performance acceptance.

Retained position witnesses use the complete published View set, each View's
semantic reset epoch, and the row's intrinsic revision. They survive default
freezing, inactive membership, Page capability removal, and physical generation
rebalance. Explicit positioning changes the row revision; resetting a View
advances its semantic reset epoch even when a rebuilt default row is revision
zero again. Unpublished relevant Views report preparation rather than silently
disappearing from the witness. Callers authorize the complete scope before reading.

List sibling evidence has a derived active-root index: child Pages cannot
become inverse anchors for root-only order. Eligibility follows the canonical
Task Parent edge even while its archived parent is hidden; presentation does
not rewrite that edge. Preparation, joins, membership changes, and edge
insertion/deletion keep the index current. A separate pressure test checks
root capture through 1,000/10,000/100,000 interleaved children.

Canonical rank remains View-global; eligibility does not create a second rank.
Production List capture, no-op detection and batched inverse placement use these
Interfaces. Public command work is measured separately in `database::tests`;
public List and Library coverage lives in their `tests/manual_order.rs` modules.

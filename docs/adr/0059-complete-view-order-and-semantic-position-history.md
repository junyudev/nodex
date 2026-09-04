# ADR 0059: Complete View order separates semantic position from physical rank

Status: Accepted. Supersedes eager position materialization in ADR 0017.

A Page move and its inverse must cost work proportional to selected Pages, not
their Data Source. An indexed sparse-position anti-join with a result limit may
still scan every positioned member. Database therefore owns one complete indexed
order per View, prepared in resumable slices and published atomically.

The complete sequence drives manual sorting, visual anchors and history.
Explicit-position metadata is not a nullable sort key: treating it as one would
reorder untouched Pages when a default tail becomes explicit. Manual direction
applies to the whole sequence; Property-sort null policy remains independent.

Commands capture selected runs against one observation and allocate bounded local
gaps. Exhausted space schedules preparation after rollback with a typed retry
coordinate. Physical generations invalidate keyset cursors, not semantic history;
semantic View resets have a separate monotonic identity. Before publication,
reads order import and implicit members exactly as preparation does.

Library consumers retain logical neighbors or semantic position witnesses. A
whole Database snapshot uses frozen ranks only to sort captured identities before
assigning fresh keys to its copy. Cached ranks and retired generations are never
live authority. Inactive order evidence is non-owning: canonical membership and
retained history determine content lifetime.

This trades one row per View member and temporary preparation storage for bounded
interactive work. Database owns preparation, publication and retired-row cleanup;
adapters do not materialize a View or allocate ranks.

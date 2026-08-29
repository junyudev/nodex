# ADR 0003: Database capability, Card membership, and durable views

- Status: Superseded by ADR 0017
- Date: 2026-07-11
- Owners: Nodex maintainers

## Context

The legacy Kanban model stores workflow status and dense order directly on each Card row. Inline list views inject snapshots of matching Cards into a host editor tree and synchronize edits back through projection controllers. This makes a displayed row look like a second content owner, mixes query results with host content, and prevents the same model from supporting multiple Databases and durable views.

Nodex needs Database behavior without duplicating Cards or treating each visual row as independent content.

## Decision

A Database is a Block with a relational Database capability. Its capability owns typed property definitions, Card memberships, shared view definitions, and view-specific positions.

A Database row is the presentation of an existing Card membership. The row has no duplicate Card identity or body. One active Card may have zero or one owning Database membership. ADR 0005 supersedes this ADR's placement-independent membership rule: an active membership is now the typed placement record for a Card whose exclusive parent is that Database. A linked view or reference does not create membership or change the target Card's parent.

Database property values belong to the membership. Property changes use field/path-level operations. Independent fields merge naturally; stale writes to the same scalar return a typed conflict; set-like values preserve add/remove intent. Card-intrinsic behavior such as execution settings, recurrence, reminders, and agent state remains generic Block properties with typed read models even when a Database View displays it.

ADR 0013 supersedes only the inclusion of Agent state in the preceding Card-intrinsic property decision. Execution configuration, recurrence, and reminders remain Card properties; live Agent execution state belongs to Thread/session runtime.

A durable Database View stores filter, presentation, and manual position configuration. ADR 0041
supersedes this ADR's presentation list, and ADR 0053 supersedes its multi-layout identity rule:
each View owns one Board or List layout, while editor toggle-list Blocks, Canvas, and Schedule are
separate surfaces. Each View owns one layout-independent fractional manual ordering; content
placement and another View's order are unaffected.

Membership, not manual position, determines whether a Card is a Database row. A membership may have no position in a given View; the View still evaluates that row through its filter, property sort, and grouping rules, and a manual sort treats the absent rank as null according to the View's explicit null policy. Reads must never require or synthesize a position merely to make a row visible. When a position does exist, it contains one complete View-global rank; grouping remains exclusively derived from the configured property authority.

Host Documents store only reference Blocks containing stable target IDs or durable `databaseViewId` values. Collapsed rows use Card summary projections. Only expanded and visible rows mount the target Card's independent Document editor. Query results and foreign bodies never become ProseMirror/Yjs children of the host Document.

## Consequences

The same Card can be shown in multiple views without copying content. A second Database and custom properties can be added without changing Card identity. View changes synchronize as relational mutations, while active view/search/selection/expansion remain window-local. Deleting, restoring, transferring, or cloning a Card preserves the distinction between Database membership and optional manual View participation.

Migration must seed one primary Database Block and one primary Kanban View per Project, map legacy status/properties/order into capability records, and prove normalized parity before cutover. Existing inline snapshots must become references; recoverable orphan snapshots create standalone Cards before being referenced.

The relational implementation uses stable property definitions and values scoped by both membership and Database identity. Composite foreign keys prevent a value from crossing Database or Project scope, and the historical-membership constraint preserves one dormant identity per Card/Database pair. Public membership management compiles to ADR 0005's `BlockTransfer`; `transfer_membership` remains only an internal atomic Database step and is rejected by public Database-mutation transports.

The one-membership constraint is deliberate for the first general model. If future product needs require multiple owning memberships, that decision must supersede this ADR rather than silently treating linked views as memberships.

## Alternatives considered

Copying a Card per Database row creates identity and synchronization conflicts. Storing query rows in a host Y.Doc makes query results durable content and duplicates foreign bodies. Keeping status/order as intrinsic Card columns prevents multiple schemas and view-specific order. These alternatives are rejected.

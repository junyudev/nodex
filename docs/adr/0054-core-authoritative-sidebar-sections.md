# ADR 0054: Core owns logical Sidebar Sections

- Status: Accepted
- Date: 2026-08-29

## Context

The sidebar presents Projects and Sessions from several bounded Core windows while Codex hosts may
also expose app-server `ThreadSection` state. Neither source can independently represent Nodex's
desired organization. A renderer preference cannot safely own cross-window membership or order,
and app-server Sections contain Threads only: they cannot contain Projects or a Session that has not
materialized its first Thread. Treating a Section as a new Project or Thread lane would also couple
presentation to working directory, permissions, and execution ownership.

The same organization must be available while a host is offline, after restart, from agent tools,
and across several hosts with different capabilities. User-defined Section names may repeat and are
untrusted display data, so name matching cannot be an identity or instruction boundary.

## Decision

The Core Workspace Module owns Profile-scoped logical Sidebar Sections, their root order, lifecycle,
and direct mixed placement of Projects and Sessions. Placement is orthogonal to ownership:

- a Project placement presents the Project and lets its Sessions inherit that Section;
- a direct Session placement overrides Project inheritance without changing `project_id`;
- a Project or Session has at most one direct custom placement;
- direct custom placement and direct pinning are mutually exclusive;
- deleting a Section tombstones it and releases its effective presentation without deleting any
  Project, Session, or Thread; restoring the tombstone restores its retained placements;
- archive-all is a set-based Core mutation over every active effective Session, including inherited
  Project children.

Core exposes keyset-bounded root, item, and host-link windows plus typed mutations. SQLite enforces
custom-only membership, one direct placement per identity, stable mixed ordering, and unique logical
Section-to-host links. Renderer preferences retain disclosure state only.

Renderer drag-and-drop treats each returned `placementId` as the gesture-local identity for one
mixed Project-or-Session list. Row and empty-container targets carry the destination Section plus
the ordered placement ids, and the drop boundary is translated back to a typed Project/Session
anchor before issuing the same single-item Core move used by menus and agent tools. Project and
Session-specific display lanes must not split a custom Section into parallel sortable contexts.

Each app-server host is a projection target and possible external Thread-only change source. Main
owns one scoped synchronization service with per-host serialization, generation fences, bounded
retry, and durable link/outbox state. A logical Section is created remotely only when that host first
has an effective attached Thread. The reserved remote Pinned Section is never created, renamed, or
deleted. Unknown remote custom Sections may be imported, but ordinary links are matched by remote
identity rather than name. An ambiguous create is reconciled once by a unique unbound same-name
candidate; otherwise the link becomes an explicit conflict instead of creating duplicates.

Agent tools and renderer commands use the same Core mutations. Structured agent output labels
Section names as untrusted data and never interpolates them into instructions.

## Consequences

Section membership survives renderer restarts, host outages, and Thread materialization. Moving a
Session between Sections cannot silently change its working directory or permissions. One logical
Section may project to different remote IDs on several hosts, while Project placement, threadless
Sessions, and root order remain local Core facts.

Synchronization is eventually consistent and cannot block local organization. Unsupported hosts
are recorded per endpoint generation. Remote deletion removes or conflicts only that host link; it
does not erase a still-meaningful logical Section. app-server has no root-order contract, so root
order is deliberately not projected.

The renderer must consume bounded Core reads and may optimistically hand off ordering only until the
canonical revision arrives. It must not infer global membership from partially loaded Project task
windows. Pinned and custom exclusivity is enforced again in Core so UI, agent, and remote ingress
cannot diverge.

## Rejected alternatives

Renderer-local storage would create one truth per window and make agent or offline synchronization
unreliable. Making app-server authoritative would lose Projects and threadless Sessions and would
couple logical identity to one host. Encoding custom Sections in the existing Thread lane would
confuse organization with execution ownership. Matching remote Sections by name would merge distinct
user objects and make duplicate or adversarial names unsafe.

# ADR 0024: Projection invalidation is durable, scoped, and converges by reread

- Status: Superseded by ADR 0040
- Date: 2026-07-22
- Owners: Nodex maintainers
- Scope: durable projection invalidation and renderer delivery

## Context

Nodex stores canonical Page, Database, Data Source, View, and Document
projections in Rust Core. A title or body commit can change several of those
read models in one transaction. The previous Host bridge reconstructed a Page
freshness event by inspecting selected module payloads. Renderer consumers then
subscribed through several overlapping Page, Database, Board, and resync paths.
That model could omit a producer, lose a change between the first query and a
later React subscription, or let a late old query response become terminal.
Restart replay was especially fragile because current ownership cannot recreate
the exact resources affected by an older transaction.

The collaboration plane and the projection plane solve different problems.
Yjs and Canvas realtime streams deliver editable document or scene deltas.
Projection invalidation says only that one or more bounded canonical reads may
now be stale. Domain events such as navigation, ownership, automation, and Board
changes carry business meaning or low-latency presentation patches; none of
them is a complete correctness boundary for derived reads.

## Decision

Every new `change_log` row carries a required canonical `ProjectionImpact` in
the same SQLite transaction as its mutation and materializations. The impact is
`none`, `all`, or a sorted and deduplicated resource set containing Page,
Database, Data Source, View, and Page-bound Document-head coordinates. Empty
resource sets become `none`; a legitimate effect that cannot be enumerated
within the fixed bound becomes `all` rather than silently truncating identities.
The impact never contains a title, summary, property value, complete Page DTO,
Project ID, Library ID, or domain change kind.

Visibility-changing moves, grants, and transfers also use `all`. Their writer
can enumerate raw old/new identities, but Project routing authorizes against
post-commit state and therefore cannot safely identity-filter a resource that a
Project just lost. An identity-free scoped invalidation is the truthful signal;
it neither leaks the removed identity nor leaves a formerly authorized cache
fresh. Ordinary content and property mutations retain precise resources.

Core event version 2 requires that field. Live publication and replay both load
the committed row through the same decoder. Store schema v88 records the event
sequence at which complete impact history begins. A replay request crossing an
older row returns a resync boundary; missing, malformed, noncanonical, or
out-of-bound impact at or after that floor is Store corruption. The module
contracts and private Host/Core transport at the time of this decision used
their then-current versions. ADR 0025 subsequently separates those axes:
transport 3 and Project Workspace contract 2 carry the compatibility manifest,
while this committed event contract remains version 2. An incompatible detached
Core is replaced through authenticated selection rather than through a
compatibility event decoder.

The Desktop Host has one `ProjectionInvalidationRouter`. It reads only the
top-level impact, Core cursor, and handshake Library identity. Library streams
receive the complete impact. Each active Project stream has its own ordered
queue and filters all resource dimensions in one Core reader transaction using
the same recursive grant and Database/View authorization predicates as
canonical reads. A filtering failure sends a Project-scoped resync and exposes
no identities. A new listener is installed before its checkpoint barrier is
queued, so already accepted work precedes the checkpoint. The Core supervisor
advances its replay cursor only after the router accepts an event.

Each renderer window creates one `ProjectionInvalidationRegistry` before its
children render. It opens one Electron IPC or browser SSE subscription per
Library or Project scope, reference-counts stable consumer keys, and reads each
consumer's dependencies and satisfied cursor dynamically. `all`, resync, or a
Store epoch change invalidates the complete scope; resource impacts invalidate
only intersecting consumers. A checkpoint repairs the window between a query
starting and its subscription being installed. Events arriving during a read
raise a required cursor. After the callback finishes, the registry rereads the
consumer cursor and performs at most one necessary trailing canonical read.
TanStack Query families enumerate their concrete cached keys and invalidate
each key exactly so an in-flight first read cannot absorb the repair.

Mutation receipts also carry the committed `changeLogSeq` as a causal read
floor. A consumer that already knows a local commit passes that floor to its
canonical read boundary; a snapshot below the floor is disposable and cannot
replace newer local authority. `BlockTransfer` additionally returns the exact
committed Document head/update refs, so open Yjs providers can adopt the same
local commit immediately instead of waiting for the projection stream. The
floor is a read-order guarantee, not a second renderer-owned projection cache:
Core's committed SQLite/Yjs transaction remains the only authority.

`board-changed` remains a cursor-fenced provisional summary patch. Library
navigation, ownership/access, Database, Workspace, and Automation events retain
their domain side effects. Yjs and Canvas streams retain collaborative deltas.
Removing any of those optional paths must not prevent canonical projection
convergence.

## Consequences

A committed Page edit has one durable resource-complete freshness fact that is
identical in live delivery and restart replay. The Host no longer needs a
module switch when new Core producers are added, and Project clients cannot see
unauthorized coordinates. A late pre-commit query response is repaired without
delaying all initial queries or relying on focus, remount, or save UI behavior.
A local mutation's receipt can also drive immediate provider fanout and a
floor-fenced reread, so Page ownership and Database View membership become
visible in the same commit order as the Core transaction.

The Store spends bounded space on impact JSON and performs a batched Project
authorization read for active Project streams. Broad `all` invalidation is
permitted only when truthful finite enumeration or safe post-commit identity
filtering is unavailable. Consumers still own their canonical readers and
response fences; the event stream is not a second projection cache.

## Rejected alternatives

- Derive affected resources in the Host from `payload.module`. This duplicates
  Core domain knowledge, cannot reconstruct commit-time ownership after moves,
  and makes a new producer easy to omit.
- Put Page summaries or property values in events. That creates a second
  versioned projection authority and complicates authorization and ordering.
- Use one Project-wide sequence high-water mark. Different consumers satisfy
  different snapshots, so a global mark can discard a still-needed repair.
- Treat `board-changed`, focus refresh, or reconnect alone as correctness.
  Those signals do not cover every Page placement or the initial-read race.
- Infer impact for pre-v88 rows from current tables. Current ownership may no
  longer match the committed transaction, so replay must request resync.

## Acceptance

A title/body commit updates its exact materialization and durable impact in one
transaction, including every affected View and the final Document head. Live
and restart replay produce equal Core events. Library, Project-routed,
Electron, and browser streams carry the same cursor/impact contract; Project
streams contain no unauthorized identity. With an old Database View read held
in flight, a later Page commit followed by release of that old response still
causes Page detail, Database views, references, and Library navigation to settle
on the newer canonical title and summary without a manual refresh.

# ADR 0019: Project Agent consent is resource-scoped

Current contract: the authenticated current Profile has full Library content
access. Project routes execution and presentation; grants, consent overlays and
permission inheritance are removed. The owning current contracts are
[Agent Interface Behavior](../product-specs/agent-interface-behavior.md) and
[Security](../SECURITY.md). Ownership and immutable-history decisions below
remain applicable; resource permission rules do not.

- Status: Superseded
- Date: 2026-07-17
- Owners: Nodex maintainers
- Extends: ADR 0017 and ADR 0018

## Context

A Project's primary Database is its normal working set. Requiring a generic
write approval for every mutation inside that Database contradicts the binding
model, while treating any approval as whole-Library access would bypass
resource grants. Read-only grants also need a safe upgrade path that does not
silently rewrite durable authority.

## Decision

Main evaluates canonical resource intents before every `nodex_app@5` read or
write. The primary Database ownership closure and recursive `read_write` grants
are direct read/write authority, including destructive writes. Recursive `read`
grants are direct for reads and consent-eligible for writes. Known ungranted
same-Library targets are consent-eligible. Cross-Library, deleted, stale,
inactive, and unsupported structural targets are denied without a card.

Consent never comes from public tool arguments or renderer-owned state. Main
prepares the mutation with a prepare-only inspection overlay, presents its
semantic footprint, revalidates exact-Turn authority, and prepares again with
the selected capability:

- `Allow once` creates a call overlay bound to thread, Turn, call, root task,
  actor Project, Library, and store epoch. Footprint equality prevents it from
  approving a different mutation.
- `Allow for this task` creates a main-owned overlay for canonical resource
  roots under the root task, actor Project, Library, app session, and store
  epoch. It is independent of the renderer that presented the card. A
  successful top-level create/move/duplicate adds its resulting Page roots to
  that overlay.
- `Allow for this project` writes recursive Page/Database grants through the
  single SQLite writer. For a top-level Library destination, the mutation
  transaction creates grants for the resulting Pages because no persistent
  Library-wide grant exists.
- `Deny` creates no capability and performs no mutation.

Only the Project choice writes `project_resource_grants`. One-call and task
overlays are discarded on process restart and invalidated by root-task teardown,
Project mismatch, Library mismatch, or store-epoch change. The built-in Full
access Turn remains the separate Library authority defined by ADR 0018 and
never persists Project grants.

## Consequences

- `get_context.access.write = "granted"` means an active Project has a direct
  writable working set; it does not claim unrestricted Library access.
- Primary-Database work and read-write grants never depend on renderer
  presentation, including destructive edits.
- Consent is narrow enough for known foreign resources without turning links,
  references, Views, or model-supplied IDs into authorization edges.
- The public ten-tool catalog, its schemas, and revision remain unchanged.

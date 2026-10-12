# ADR 0029: The Project's default View is the only Database View authority

- Status: Accepted
- Date: 2026-07-26
- Owners: Nodex maintainers
- Extends: ADR 0026
- Superseded in part by: ADR 0034, which replaces starter-Session
  materialization with a Project-owned Workbench Scene while retaining the
  Project default View as the only Database View authority.
- Superseded in part by: ADR 0041, which retains the default View as the
  Project Scene root while allowing every selected durable View to use the
  same Board/List presentation runtime.

## Context

ADR 0026 moved tabs into Window Sessions and kept one semantic remnant on the
shared Session row: `initial_database_view_id`, a per-Session foreign key naming
the Database View that the starter `Database View` Session should materialize.

That column was a denormalized copy of Project-level truth, and it rotted by
design: only Project creation ever wrote a value, ordinary Sessions were born
`NULL`, both Session move paths cleared it, and the foreign key was
`ON DELETE SET NULL`. Any store whose Sessions predated the current schema — or
had moved Sessions between Projects — carried only `NULL`s.

The workbench's "open DB View" action trusted that copy. When it was `NULL`,
tab creation silently produced no tab: the create-input type allowed a
`db_view` descriptor without a View identity, and the adapter dropped it with a
silent `return null`. Every entry point (empty-panel action, panel menu,
command palette) became a no-op with no feedback.

Meanwhile the authoritative fact already existed:
`database_containers.default_view_id`, maintained by Database mutations and
guarded by a trigger ("default View must be active and owned by its
Container"). `database:view-window:get` already resolved it server-side.

## Decision

1. The Project read model exposes `default_database_view_id`, resolved from
   `database_containers.default_view_id` (active Views only) at read time.
   Renderer callers resolve a Project's presentable View from the Project
   catalog; no Session-level copy exists.
2. Schema v93 rebuilds `project_sessions`, dropping
   `initial_database_view_id` and adding `database_starter INTEGER NOT NULL
   DEFAULT 0`, backfilled from pointer presence. The marker is an immutable
   semantic property ("this is the Project's starter Database Session") with
   no foreign key, so Session moves and View deletion cannot corrupt it; the
   two move-path `NULL`-out special cases are deleted.
3. Starter materialization combines `database_starter` with the Project's
   current `defaultDatabaseViewId` at materialization time. A starter moved to
   another Project presents that Project's Database, which is the coherent
   reading of "the database Session".
4. `WorkbenchProjectionDbViewTabConfig.databaseViewId` is required at every
   boundary (types and zod). Tab creation resolves the View first — existing
   project tab (focused, per spec), else the Project default — and the
   silent-null adapter branch is deleted as unrepresentable. When a Project has
   no active default View, the action reports it with a toast instead of doing
   nothing.
5. Because the Project catalog now projects View-derived data, committed
   Database events that touch View identities also emit the Project catalog
   invalidation; routine row edits still do not.

## Consequences

- "Open DB View" works in every Session of every store, or says why it cannot.
- No schema path can silently strand DB View creation again: the config type
  has no optional View identity, and the only durable inputs are the Project
  catalog (kept fresh by invalidation) and an FK-free boolean.
- Stores that had already lost their pointers before v93 migrate with
  `database_starter = 0` for those starter rows; their pinned `Database View`
  Sessions behave like ordinary Sessions (one click opens the DB tab). The
  honest backfill was preferred over name/pin heuristics.

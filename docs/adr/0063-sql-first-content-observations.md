# ADR 0063: SQL-first content observations

Status: Accepted
Date: 2026-09-07
Refines: ADR 0062 query ownership and ADR 0061 read discovery

## Context

Agents need to select content, read its body and retain edit conditions in one
observation. Materializing every Source Property before evaluating a query makes
small reads depend on unrelated data. Composing separate public reads cannot
provide a consistent cross-domain observation, and refreshing versions during
batch preparation silently discards the conditions originally observed.

## Decision

Give public SQL its own read-only Query Module. It owns one pinned reader
transaction, execution limits and cancellation. Library and Database provide
internal authorized projections against that reader; their domain rules remain
authoritative. Evaluate SQL in an isolated SQLite instance through lazy virtual
relations. Keep SQLite callback machinery in a narrow adapter crate so Core
continues to forbid unsafe code.

Use stable public relations for Pages, documents and catalogs, with explicit
Source bindings for typed Property columns. Metadata reads do not load bodies.
Reuse Library search and its observation-fenced cache; search relations represent
the requested top K and are evaluated once per argument set per observation.
Facts and View occurrences are complete within the budget or fail as a whole.

SQL is the default composable Agent read interface. Keep single-Page reads,
bounded relevance search and terminal conveniences where they serve a distinct
workflow. Keep all writes on existing semantic commands. Prepared Property edits
preserve observed membership and field revisions; the query observation ID is
informational and cannot authorize a write or reopen a historical snapshot.

## Consequences

The CLI stays a protocol Adapter and never opens the Store or assembles a
cross-domain snapshot. Queries share domain authorization while remaining
independent of Database ownership. Field and membership guards reject stale
edits without pretending to protect arbitrary predicates or joins. Public
relations, shape rules and limits are specified in
[Agent CLI queries](../product-specs/agent-cli-queries.md).

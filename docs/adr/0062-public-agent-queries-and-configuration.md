# ADR 0062: Public Agent queries and atomic configuration

Status: Accepted
Date: 2026-09-07
Extends: ADR 0061

## Context

Agents need complete aggregates and joins without reconstructing data from
paginated previews, and need to change schema or View settings without replacing
unrelated configuration. Ordinary discovery should return a directly usable
answer with the same stable IDs accepted by subsequent commands.

## Decision

Keep the CLI as a thin Adapter. Publish concise read DTOs, context defaults and
progressive schema help. Accept bare resource IDs throughout. The Database
Module owns read-only SQL over complete authorized public projections taken in
one Store snapshot. Evaluate user expressions only in an isolated transient
database with explicit action and resource limits. Input or output exhaustion
returns an error, never a partial aggregate presented as complete.

Use a typed declarative configuration script as a Database intent. Resolve
names and apply existing semantic operations inside the original transaction,
after durable retry lookup. Partial changes preserve omitted configuration.
Query-selected writes are explicit target/value/revision batches; commit never
reevaluates the query or expands its target set.

## Consequences

Agents can use SQLite expressions for questions while Core retains resource
authority, bounded work and snapshot correctness. SQL does not expose private
Store tables or create a parallel write path. Configuration and Property edits
retain normal atomicity, concurrency conditions and exact-retry receipts.
Schema discovery documents actual column spellings and value representations.
The public contract and budgets live in
[Agent CLI queries and configuration](../product-specs/agent-cli-queries.md).

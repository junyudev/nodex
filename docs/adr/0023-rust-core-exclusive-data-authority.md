# ADR 0023: Rust Core Is the Exclusive Data Authority

## Status

Accepted — 2026-07-21

The exclusive-authority decision remains current. The original v84/v85 Store
acceptance and TypeScript import boundary were superseded on 2026-08-20 by
[ADR 0046](0046-current-store-migration-baseline.md).

## Context

Nodex previously carried a TypeScript `better-sqlite3`/Yjs authority alongside
the native Rust Core migration. Keeping both implementations selectable made
schema ownership, recovery, scheduling, and Electron shutdown ambiguous. The
Codex app-server now also provides authoritative task-history search through
`thread/search`, so a Nodex-owned Thread transcript/FTS projection would be a
second search authority.

The initial cutover used the final TypeScript v84 schema as its import boundary
and v85 as the first Rust-owned identity. Those version-specific compatibility
details are historical; ADR 0046 owns the current Store acceptance policy.

## Decision

- One detached Rust Core process exclusively owns each Profile's SQLite file,
  WAL, Yrs/Canvas Documents, semantic transactions, projections, receipts,
  schedules, backups, restore journal, migrations, and event replay.
- Electron remains the Desktop/Codex Host. It owns windows, renderer routing,
  Hono, filesystem/OS presentation, mounted-surface flush/freeze coordination,
  and Codex app-server execution, but never opens `nodex.db` or reconstructs a
  durable Document transaction.
- At the original authority cutover, startup admitted a physically validated
  final TypeScript Store and published the first Rust-owned Store only after a
  durable backup. This established the exact-inventory, fail-closed migration
  rule; the accepted revisions and retained artifacts are now governed by ADR 0046.
- Task-history search delegates only to Codex app-server `thread/search`.
  Nodex stores Workspace metadata used to enrich results but owns no Thread
  transcript units, FTS tables, backfill queue, or search index.
- Automation definitions, revisions, scheduling policy, due leases, runs,
  inbox/read/archive state, occurrences, and reminders are Core-owned.
  Electron submits semantic reschedule policies with an expected definition
  revision; it does not calculate or overwrite an arbitrary next-run timestamp.
- The public `nodex` command is the native protocol Adapter shipped inside
  `Nodex.app`. Homebrew and the app-menu installer link directly to that binary;
  no npm launcher, HTTP command path, SQL inspection, or storage fallback exists.
- IPC and loopback HTTP expose typed product contracts only. Arbitrary SQL and
  private Core lifecycle/Store Administration routes are not public surfaces.

## Consequences

There is no in-process authority selector or downgrade path. A failed Core
launch is a startup failure. Rollback requires stopping the new build and
restoring a verified pre-migration backup with a compatible older build; a
binary must never open a Store identity it does not explicitly accept.

Module contracts, migration tests, the production bootstrap dependency audit,
failure matrix, no-Electron-database-handle test, and macOS arm64 package
verification are release gates. Host fakes in tests must implement the same
typed ports rather than instantiate a hidden SQLite authority.

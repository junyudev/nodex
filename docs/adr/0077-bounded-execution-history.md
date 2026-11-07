# ADR 0077: Execution history is bounded by what each part is for

- Status: Accepted
- Date: 2026-11-07
- Owners: Nodex maintainers
- Refines: [ADR 0068](0068-agent-runtime-execution-authority.md)

## Context

The Agent Runtime's SQLite store grew without limit: about 9 GiB in a month of daily use. Most of it
was the event log, which wrote a complete snapshot of each item on every status change and kept
all of them. Nothing read an event older than a client's reconnect window, because the projections
written in the same transaction already held the current state.

Providers also keep their own conversation records, and our sampling found almost all of this
content in them. Those records are not a substitute: a Provider can expire them, and each has its
own format. They hold no Nodex structure such as Runs, queues or checkpoints, and a Nodex Session
can span several of them. Reading them back would add a per-Provider path for every old Session,
and SQL search and handoff queries could not use it.

## Decision

Each part keeps what its readers need.

- **Projections are the durable history.** They are never rebuilt from events, so a projection
  change must migrate its rows.
- **The event log is a delivery tail.** Events the projections cover are deleted once a day old, so
  one to two days remain. A stream's newest event stays for its high water and stream version,
  `thread.created` stays as the import marker, and every event a command committed stays, so a
  retry of any age replays exactly. An unfinished transcript import and an ownerless provider
  thread also keep the events they are resolved from. These kept rows are a small share of the log.
- **A gap is never silent.** The boundary is published before deletion. A cursor below it that its
  thread has moved past fails, and the client reloads a snapshot. Only a reader that captured its
  cursor from the store moments earlier opts out of this check.
- **Freed space returns to the disk.** New stores use incremental auto-vacuum. An older store adopts
  it with one VACUUM at startup, once at least a quarter of it is free and the disk has room for
  the rewrite. A failed attempt leaves the store intact, starts normally and waits a week to retry.

## Consequences

- Store size follows current history rather than how long a Profile has run.
- Replaying events can no longer repair a projection. Tests keep that replay as an oracle over
  unpruned logs, and production has no rebuild path to fall back on.
- A window left open past the retained tail reloads its conversation rather than catching up.

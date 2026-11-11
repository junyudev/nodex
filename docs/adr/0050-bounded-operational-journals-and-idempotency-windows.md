# ADR 0050: Bound Operational Journals and Idempotency Windows

- Status: Accepted
- Date: 2026-08-26

## Context

Nodex originally retained every LocalCommit delivery graph and Core Module
receipt indefinitely. LocalCommit is the durable unit used to deliver an
already-committed semantic fact to connected consumers; a Module receipt lets a
caller retry the same operation and receive the original result. Neither is
the user's semantic history.

Indefinite retention coupled unrelated costs. Idle scheduler polls created
empty semantic commits, delivery evidence eventually dominated the Store, full
backup validation became proportional to that unbounded history, and Store
epoch replacement resealed the entire graph. Deleting old rows without a new
contract would be unsafe: replay cursors could silently skip facts and a retry
whose receipt disappeared could execute the mutation twice.

## Decision

Core Administration owns one versioned Operational Journal policy. The policy
accounts for complete LocalCommit delivery groups and Module receipts by row,
measured bytes, and age. It uses separate delivery and receipt high/low
watermarks plus a global byte envelope. Seal-time guards either prune a bounded
eligible slice in the same transaction or return retryable backpressure; the
envelope is therefore an admission boundary, not monitoring alone.

The journal stores a monotonic replay floor. Durable incremental replay covers
the interval `(replay floor, commit head]`; a consumer below the floor receives
a typed canonical-resync boundary. Before pruning a LocalCommit, still-live
receipt results are detached with the immutable Store coordinate and manifest
hash. Semantic state, user-visible revision history, pinned recovery roots, and
domain change sequences are not members of the operational journal.

Exact idempotency is explicitly finite. New operation identities carry a
version, issue time, fixed expiry, scope, and entropy. If no exact receipt exists
and the identity is expired or at/below the composite receipt floor, Core returns
a typed expiry rather than applying it. Existing legacy receipts remain exact;
missing legacy identities are accepted only during one rolling cutover window
and then fail explicitly. The composite floor includes time, Module, and
operation identity so concurrent identities issued in the same millisecond are
ordered without false expiry.

Explicit opaque retry keys enter through shared Core admission. Core binds each
key to the caller, command and argument fingerprint before issuing a bounded
operation identity. Nodex remembers a key for 7 days. Core prunes expired bindings
in bounded batches. Reusing a key after its window admits a fresh operation identity.
The receipt layer continues to enforce the original expiry of each operation identity.

Operations nested beneath a durable episode must remain stable across process
restart as well as in-memory retry. Agent tool calls therefore derive their
bounded identity from the Core-frozen Turn timestamp plus the exact
Thread/Turn/call/tool coordinate. Main never substitutes a fresh random identity
when the same external call is delivered again.

Conversely, an operation that is already idempotent by authoritative state and
has no durable retry owner starts a fresh bounded identity for each admitted
request, retaining that identity only across retries of the request itself. It
must not borrow an entity's creation timestamp or opaque identifier as the issue
coordinate: old entities would otherwise become unusable when the receipt
window expires. Recovery first reconciles authoritative state; it issues a new
operation only when that read proves the earlier episode did not commit.

Operational retention is self-silent. A logical prune or backfill slice never
seals a LocalCommit or receipt; it updates only journal metadata and operational
evidence in one short transaction. Backfill must fully measure and reconcile
both delivery and receipt populations before deletion is enabled. Every
candidate, detach, foreign-key, and semantic-reference lookup on the deletion
closure has an index whose leading columns match the bounded identity set;
limiting returned rows alone does not bound SQLite's work.

Logical deletion converges before physical reclamation runs. Current Stores opt
into incremental auto-vacuum when the empty database is created. A maintenance
pass with no logical progress may reclaim freelist pages in chunks of at most
64, checks its wall-clock budget between chunks, and has a 256-page ceiling. A
successful physical pass advances only the existing maintenance scheduling
revision, giving the next pass a fresh work identity without creating a
LocalCommit, receipt, replay event, or history row. Reclamation may be repeated
after any interruption. Existing database header modes are preserved; ordinary
maintenance never triggers an implicit full-Store rewrite.

Schedulers read typed due-work plans from their owning Core Module. A plan
contains a stable work token; the writer re-plans and validates that token before
claiming. Idle reads and stale ticks write nothing. The same due episode reuses
one bounded operation identity within its validity window.

Store epoch replacement invalidates all delivery cursors. It records one new
canonical resync boundary and discards the old bounded delivery graph instead of
rewriting history under the new epoch.

## Consequences

Store size and backup-validation cost converge to the size of semantic state
plus explicit operational envelopes rather than total process uptime. Long-idle
Profiles do not grow through polling alone. Interactive consumers may resync
after a sufficiently long disconnect, and callers cannot replay an operation
identity forever; both outcomes are explicit typed contracts.

The operation-identity format and retention policy are now cross-runtime
protocol obligations. New writers must use the canonical identity factory, and
new delivery or receipt payloads must participate in measured accounting.
Tests must prove floor behavior, detachment, legacy cutover, bounded pressure,
self-silent convergence, crash-safe backfill, and current-schema reconciliation.

## Rejected alternatives

Keeping all history and running periodic full `VACUUM` does not remove live
rows and would repeat an unbounded rewrite. Replacing restore-grade
`integrity_check` with `quick_check` weakens the recovery boundary without fixing
growth. Recording retention through ordinary durable mutations creates a
self-observing journal. Treating a missing old receipt as a new request risks a
duplicate semantic mutation and is therefore rejected.

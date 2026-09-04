# LocalCommit and Projection Delivery

## One committed fact

Every semantic Core mutation atomically persists its canonical state change,
private physical evidence, immutable receipt, one CommitManifest, affected
Projection revisions, visibility evidence, and Document effect references. Its
durable identity is the Store epoch, LocalCommit sequence, and manifest hash.

The command result and post-state delivery authorization are separate. A caller
may receive the command outcome even when it cannot read the post-state. When an
authorized apply delivery exists, Main admits it to the initiating renderer
before the feature Promise resolves. The renderer never waits for the event
stream, a reread, or another renderer acknowledgement to treat the command as
complete.

An apply packet and later stream packet are complementary presentations of the
same Manifest. Coverage is deduplicated by durable identity, audience, and
resource. A different Manifest hash at the same Store coordinate fails closed.

## Durable wake and replay

The global and scoped brokers install their wake receiver before scanning the
durable ledger. A wake carries no event data or cursor; it only requests another
keyset scan. Lost or coalesced wakes are recovered by a later wake or reconnect
barrier. The scanner advances across sequence gaps and commits that authorize
zero packets.

A cursor older than retained history returns a typed resync boundary. Replay
pages are indexed, bounded, authorized, and keyed by the complete Store
coordinate. The global LocalCommit sequence measures replay progress; it is not
a Projection revision, Document head, or change-log sequence.

The retained replay interval is `(replay floor, commit head]`. Core may remove
an older finalized LocalCommit only after its canonical semantic result remains
readable and every consumer below the new floor has a typed resync path. Receipt
results that are still inside the idempotency window are detached from their
LocalCommit parent before delivery evidence is removed. A Store epoch rotation
cuts one canonical resync boundary and drops the old delivery window instead of
resealing every historical operation under the new epoch.

Retention is internal bookkeeping, not a semantic mutation: it creates no
LocalCommit, projection event, change-log row, or module receipt of its own.
The seal path accounts for each complete delivery group and applies bounded
backpressure if maintenance cannot restore the configured operational-history
envelope safely.

Main admits scoped-live and durable-tail copies through one Main-scoped
LocalCommit runtime. Manifest/resource identity, completion signals, causal
lane actors, retry, checkpoint observation, and shutdown are one ownership
boundary. Delivery is FIFO within an exact Document, Projection scope,
authorization-scoped revocation, or notification lane; unrelated lanes remain
concurrent. The process admits at most 10,000 pending lane operations and
retries each operation at most three times. Saturation or terminal failure
prevents the durable checkpoint from advancing, and terminal failure releases
only the affected resource claims so replay can reclaim them.

Scoped-live admission schedules work without waiting for a lane. Durable-tail
delivery attaches to the exact same claim completion when scoped-live already
owns it. Its waiting fiber may be interrupted without cancelling the shared
delivery actor. Closing Main rejects every outstanding durable waiter,
interrupts active lane work, and retires all queues through the same Scope. The
initiating renderer's apply-response admission remains renderer-local and is
not a third Main ingress path.

Main multiplexes Core-authored audience packets to concrete renderer recipients.
Each renderer has independent delivery and acknowledgement state. Recipient
leases and resets are Core-issued; Main cannot broaden an audience. A destroyed
renderer retains no delivery timer or state.

Renderer audience membership, its current Core lease, pending delivery IDs,
required repair floor, ACK deadlines, and reset retry are one scoped aggregate.
Each recipient admits at most 128 pending envelopes. Overflow, NACK, send
failure, or a one-second ACK deadline fences that exact address and authors a
lease-bound reset; a replacement lease carries forward every in-flight floor
before retiring old delivery IDs. ACK and retry tasks are keyed child fibers,
not ambient timers. Quiet reset failure uses bounded exponential full-jitter
retry capped at one minute and at most 20 sends per ten-minute window. Renderer
release interrupts every task, rejects late ACKs, and publishes the new canonical
desired-scope set before the physical broker reconciles. Core lease grants belong
to that physical stream and survive temporary audience removal; only a replacement
Core barrier retires them. This lets a returning window subscribe when scope churn
returns to the active stream before its replacement opens.

Scoped live packets carry authorized metadata atoms alongside projection and
visibility effects, including recovery resolution and exact File invalidation.
They omit document update resources, which remain on the document stream. Atom
observers retain their own scoped audience and re-read after a delivery reset;
an apply response in one window cannot stand in for delivery to another window.

The multiplexed Projection live connection is one Main-scoped resource. Audience
changes publish only the latest desired scope set. A replacement opens in its
own child Scope while the current lease remains authoritative; its barrier is
installed before buffered packets become visible and before the old child Scope
closes. A clean overlap resets only newly added scopes. An unexpected end has no
overlap proof, so reconnect backs off on the Effect clock and resets every
desired scope. Callback ingress is ordered and bounded to 512 packets or repairs;
overflow fails and replaces that attempt instead of growing an unbounded queue.
Closing Main interrupts opening or backoff, closes the exact active subscription,
and fences callbacks that arrive after release.

## Projection freshness

Each projection advances on its exact scope revision and semantic dependencies.
A complete contiguous patch may apply immediately. A gap, unavailable patch,
integrity mismatch, conservative reset, or authorization change fences the stale
projection and schedules a bounded canonical read.

Patchless effects and advisory read-at-least requests accumulate into the latest
required coordinate per consumer. Interactive consumers repair after 300 ms of
quiet or at a 5 second starvation deadline, with one canonical read in flight;
reset, revocation, integrity failure, and a true causal gap stay urgent. Future
effect tails are Store-epoch keyed and capped at 128 entries because a canonical
repair can replace a compacted tail. These bounds prevent a busy Document writer
from turning projection convergence into an unbounded renderer queue. Failed
canonical reads retry with bounded exponential backoff; routine effects merge
into that pending retry instead of creating one failed read per notification.
Renderer admission also verifies inline Document resources through a small
fixed worker pool, so one large semantic commit cannot fan out an unbounded set
of buffer copies and digest jobs before its callbacks become visible.

Canonical reads derive their Store epoch, LocalCommit head, projection revision,
and values from one SQLite snapshot. Renderer stores admit the response only if
its authority/freshness stamp still covers every dependency observed since the
read began. A response started before a revoke or reset cannot repopulate stale
state.

Optimistic journals may keep an acknowledged semantic transform composed over
canonical base until the bounded projection actually materializes it. Promise
success or a broad commit cursor is not proof that one row/window contains the
result.

### Database List occurrence windows

Database List reads use a projection-identity-bound occurrence cursor over the
effective Filter, sort, grouping, subgrouping, presentation, and standard Parent
Relation projection.
Every response reports its logical start, total model count, total projection-row
count, and stable group, subgroup, Page, and transient-ancestor occurrence keys.
The renderer accepts a continuation only when identity, generation, start, and
occurrence uniqueness match the admitted prefix. A rejected or stale continuation
restarts from the first window; a transport failure keeps the admitted prefix
visible and offers retry.

Selection-all remains sparse until all windows are admitted, and drag is disabled
while selected Page authority is incomplete. A List drop commits Property,
Parent-Relation, and position intent in one transaction. The renderer may recompile
once after a typed revision conflict; otherwise it discards optimism and
converges from Core. Session Undo exists only when exact acknowledged before-
values and committed revisions make the inverse lossless.

## Visibility and authorization changes

Core computes authorization before and after the mutation inside the same
transaction and seals exact gains/losses into the Manifest. A revoke reaches the
affected resource before post-state content. Exact evidence evicts only matching
resources; a bounded closure overflow requests a conservative whole-address
reset.

Projection invalidation is not authorization. Every later read/write still
checks current Core authority. Relation and other reference edges do not expand
authorization; the product contract for Relation visibility is in
[Database, Pages, and Views Behavior](../product-specs/database-pages-and-views-behavior.md).

## Document effects

Large update bytes are referenced by verified Document effect metadata and may
be delivered through the exact Document resource lane. Operational compaction
may remove the bytes while retaining durable causal metadata. Replay then emits
`document_resync_required`; Main maps it to a history-compacted canonical resync
instead of inventing an empty update or declaring the commit lost.

Document delivery lanes serialize independently by Document identity. A multi-
Document commit may progress independently on unaffected lanes; retrying one
failed lane does not depend on unrelated notification delivery.

## Deep decisions

The durable projection model is recorded in
[ADR 0024](../adr/0024-durable-projection-invalidation.md) and the causal local
mutation boundary in
[ADR 0040](../adr/0040-local-commit-authority-and-causal-structural-mutations.md).
Finite replay and idempotency ownership is recorded in
[ADR 0050](../adr/0050-bounded-operational-journals-and-idempotency-windows.md).

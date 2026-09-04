# Document Sync, History, and Retention

## Exact live boundary

An exact Document subscription is both authorization and resource routing. Core
installs the addressed live receiver before reading authorization, Store epoch,
engine, generation, Document head, and LocalCommit head from one snapshot. The
resulting barrier guarantees that later addressed commits are buffered or
delivered after canonical synchronization adopts that boundary.

Earlier content comes from the engine's canonical state-vector or scene sync,
not from replaying the global LocalCommit ledger. Receiver lag, Store
replacement, route/payload failure, missing predecessor, or gap-buffer overflow
closes the physical stream and requires a fresh barrier plus canonical sync.
Awareness uses a separate ephemeral addressed channel and cannot crowd the
durable repair lane.

Main retains the logical lease across physical reconnection and consumes Core's
`reconnect_document_subscription` recovery evidence. Concurrent failures share
one reconnect; late failures from older connection versions cannot retire the
replacement. Core assigns each physical subscription a lease identity and
releases it conditionally, even when streams share a logical client session.
Terminal failures carry typed evidence to the renderer and settle its waiters.

## Page and Block Documents

A Page/Block Document writer applies bounded idempotent Yjs updates against the
current generation and durable head. The writer validates schema, application
Block identity, dependencies, projections, and receipts before commit. The
mounted surface receives acknowledgement only after durable transaction commit.

Document update and Canvas mutation identities are allocated when a submission
is frozen, using the shared bounded-operation factory. A long-lived client
session, sequence counter, entity creation time, or content hash cannot supply
the operation's issue time. Local journals and outboxes retain that exact
identity through response loss; expiry never mints a replacement automatically.
Manual checkpoint requests likewise carry a caller-owned operation identity
through IPC and Core. Regression coverage exercises the real producers against
a Profile whose legacy receipt overlap has ended, in addition to fresh-Profile
scenarios.

Each writable surface owns its client identity, local undo origins, selection,
and Awareness contribution. Another surface's or remote transactions converge
visibly without entering local undo. Deactivation clears ephemeral presence and
keeps durable work behind a bounded flush/checkpoint boundary.

One visible editing burst may produce many Yjs transactions. The provider merges
those commutative incremental updates before IPC, admits only one Core apply at
a time, and lets explicit lifecycle or structural flushes bypass the burst
timer. A merged apply never crosses the schema's update-byte envelope; an
oversized burst is drained through multiple ordered commits. The disposable
recovery cache independently merges only local deltas on a wider quiet/max
boundary; it never re-encodes the complete Y.Doc for every transaction or
checkpoints remote state that is already durable in Core. Cache implementations
atomically merge deltas for a Document boundary. A failed write retains one
compact retry delta and stops automatic retry until new local work or an
explicit lifecycle checkpoint arrives.

Structural operations that consume mounted Document shape first flush pending
updates and carry a typed causal head token. The mounted editor participant
finishes transient native drag/focus/IME state before that flush; losing any
required participant fails the command instead of silently omitting its causal
head. Core rechecks the token with every owner, membership, and authorization fact in the committing transaction.
Response-loss retry retains the original logical intent; the transient head
proof is not part of idempotent identity.

Yjs invokes editor observers synchronously while applying remote updates. An
observer may fail after the Y.Doc has already integrated the update, leaving
the editor projection and provider head behind the CRDT state. This boundary is
`recovery_required`: the provider isolates that replica, preserves recovery
material, and only then permits a fresh replica. A failed local preservation
never triggers automatic destruction of the only copy. It must not retry on the same Y.Doc or misclassify a local editor
projection failure as malformed Core content. Collaborative selection restore
falls back to a nearby valid selection when a remotely removed Node selection
no longer has a selectable node at its relative anchor.

Cross-Document transfer and copy prepare against isolated clones, then recheck
all captured heads and ownership facts under the writer. Each affected Document
advances at most once. Failure leaves canonical state and reusable base caches
unchanged.

Local checkpoints carry per-surface coverage; completed writes never imply
coverage of newer edits. Exact submitted requests are journaled before send
when local storage is available and retired after verified ACK. Unresolved
previous-session requests become retained drafts for review, not replayed
with new identity. Terminal preservation atomically retains the exact boundary's
cached bytes before removing its active checkpoint. Other generations remain.
Yjs local queues compact incrementally and stop admission at the schema's state
byte budget; bounded realtime overflow requests canonical synchronization and
presence is replaceable. Recovery storage refuses overflow rather than evicting
unconfirmed work.

Structural preparation uses one absolute deadline and cancellation scope;
cancelling a waiter leaves the durable queue and independent waiters intact.
The product states and recovery/export contract live in
[Document Sync and Recovery](../product-specs/document-sync-and-recovery-behavior.md).

## Canvas Documents

Canvas uses its scene-native engine and normalized element/app-state authority.
The renderer persists pending local scene mutations in a bounded outbox before
transport. Response loss retries the exact row. Deterministic rejection moves
that row to bounded quarantine, resynchronizes canonical scene state, and lets
later edits proceed.

Scene generation, head, file identity, and portable snapshot validation remain
separate. Remote repair never guesses a scene or enters local undo. Product
behavior is specified in [Canvas Behavior](../product-specs/canvas-behavior.md).

## Retained drafts

Owned Document owns durable recovery packages and their revisioned resolutions.
Renderer IndexedDB is staging until Core acknowledges the exact immutable package;
Main provides a typed Adapter and never writes a recovery database. Recovery
metadata publishes through LocalCommit independently of live document streams.
Packages survive source deletion and remain discoverable in their Library.

When accepting a Yjs or Canvas package, Core freezes the versions and default
names of its authorized File references in a canonical, hashed companion snapshot.
Canvas targets retain their scene slot coordinates, including separate versions
of one File. Its
retention index must agree with that snapshot. Unresolved targets stay explicit;
neither the source timestamp nor a later File head supplies missing evidence.
File presentation through a recovery package reads only its captured target.

A draft is pending or resolved as already saved, restored, copied, or discarded.
Restore/copy and resolution share one transaction and receipt. Retrying an uncertain
user choice keeps its persisted identity; stale draft revisions and preview heads
fail before mutation. Discard is soft and reversible for 30 days. Export and
closing a review do not change durable resolution.

Yjs analysis uses isolated engine snapshots, including delete sets and unresolved
dependencies. Canvas analysis checks every intended winning value and any retained
full scene. No renderer error label, state vector, age, or partial receipt is a
proof that the whole package was committed. Capability checks fail closed for
unavailable schemas, resource closures, changed ownership and structural barriers.

Yjs recovery merges the retained causal state before remapping File occurrences.
Changed Files are forked once per retained identity, so restoring or copying a
draft cannot rewind another Page's shared content. File creation, grants, Page
or Document changes, and resolution commit together. A recovered Page combines
its File and Page effects in one Library event within the same LocalCommit.
Canvas recovery keeps live fixed-version bindings and forks trashed targets per
distinct File/version/name. Missing retained slots are reconstructed from exact
evidence; conflicting current slot identities cannot silently redirect images.
Canvas copies compose their File and Canvas effects in the same Library event.

Recovery roots retain known source/owned Blocks and referenced immutable asset
hashes. Pending packages never expire. Bounded maintenance removes only handled
packages older than 30 days and releases their roots in the same transaction.
The package, aggregate storage, record count and summary page all have independent
bounds. Refusing new capture never deletes unacknowledged renderer staging.
The byte bounds include canonical File companion snapshots.

## Semantic history

Operational updates and semantic history have different retention. Document
revisions retain user-meaningful title/body or scene states and are immutable.
Human editing records bounded safety, active, and idle revisions; strict
semantic commands record immediate linked revisions.

Page History combines Document revisions with immutable property, Database,
lifecycle, and relocation activity. Only compatible Document revisions are
restorable. Restore pins current state, applies the selected state as one new
forward engine mutation, records its receipt/revision, and never rewinds Yjs or
Canvas causality.

Title/body snapshots include exact File versions and frozen default names.
Automatic coverage compares the complete snapshot, because shared File changes
can leave the Document head unchanged. A compatible restore reuses matching live
Files and forks changed targets in the same commit, while leaving Page paths
independent. A legacy revision without exact File evidence remains previewable
as unresolved and cannot silently restore current bytes.

Named and restore revisions are pinned. Unpinned revisions follow the current
age/tier/count policy implemented by the Document retention Module. Deleting a
revision never rewrites immutable mutation evidence; Activity may retain its
operation record after preview content expires.

## Compaction and collection

Yjs update compaction retains a valid canonical snapshot plus required tail and
does not change semantic Document identity. LocalCommit retains Document effect
metadata even when update bytes are compacted, enabling canonical resync.

Deleted Block collection is closure-based and fail-closed. Core proves no live
ownership, reference, history, recovery, Database, Session, schedule, relocation,
or unknown foreign-key root before physical removal. The complete candidate
rolls back if any constraint changes. Collected stable Block identities remain
retired permanently and are never reused. Each maintenance pass selects one
global bound of the oldest tombstones after applying the per-Library keep policy;
Library count cannot multiply a pass's in-memory candidate set.

Current reference evidence comes from the exact generation/head/schema-fenced
Document and Canvas projections written with authority. A pass parses current
projections, retained versions, immutable audit rows, relocation rows, recovery
artifacts, and extension foreign-key schema once on a consistent WAL reader
snapshot, then intersects that immutable evidence with each candidate closure.
The serialized writer never performs or repeats that full scan. Every writer
slice requires the snapshot's LocalCommit head to remain current; an intervening
product commit invalidates the pass and maintenance retries from a fresh
snapshot. Missing, stale, unregistered, or invalid projection evidence retains
the candidate; collection never falls back to Yjs or Canvas reconstruction.

Canvas tombstone/file compaction runs only after the last committed surface
closes and no pending/active copy remains. It pins a safety revision and rotates
the collaboration generation; inability to prove the boundary simply defers
maintenance.

Incremental vacuum may reclaim freed SQLite pages gradually. Retention and
compaction are storage maintenance, never user-visible undo.

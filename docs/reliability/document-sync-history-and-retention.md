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

Renderer commands are admitted against the exact subscription lifetime at send
time. Releasing the last subscriber or invalidating the session fences commands
still awaiting admission, even when the same session key is immediately revived.
Already-submitted durable writes retain their original receipt semantics. Core
withdraws session-owned Awareness on unsubscribe; local offline publication is
best effort and cannot keep a retired subscription alive. Main does not log a
retired session's late subscription-loss response as an active fault or reconnect
it. A late successful sync cannot adopt its boundary into a replacement session.
Active subscription loss still requires a fresh validated barrier.

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

Interactive structural history preserves the complete inverse request through
transport or LocalCommit-admission failure, including its operation identity
and original access scope. Retrying an unknown result resubmits that request;
it never creates a new request for an already consumed token or requires a new
Document head fence to retrieve a committed receipt. Transport failures returned
as error values have the same uncertain semantics as rejected requests. The
attempt retains its original branch through retries, so later input cannot make
its obsolete inverse reachable again. An authoritative non-commit rejection
ends that attempt; another gesture may prepare a fresh request. Surface shutdown
cancels preparation separately from history cleanup: release commands cannot
use the aborted preparation lifetime. Main acknowledges cleanup handoff, not a
Core mutation receipt, and owns exact pending requests beyond renderer waiters.
Local disposal can finish without awaiting an unavailable Core; late inverse
tokens are released instead of re-entering a closed history.

Main stamps structural writes with the application WebContents generation's
opaque retention owner. Core binds it to the authenticated desktop peer PID and
registers every returned recipe in the same transaction. Closing an owner
rejects late new writes but still permits exact committed receipt replay; it
releases only that owner's available recipes and Cut claims. Main retries this
cleanup independently of renderer cancellation. An authoritatively expired
cleanup identity may be renewed because closing the same owner is monotonic;
this exception never applies to uncertain content mutations or inverses.
Core's bounded maintenance proves Host process death before collecting abandoned
owners. It scans up to 1,024 PIDs in key order with a wrapping cursor and releases
at most 100 owners per pass; live Hosts cannot permanently hide later dead Hosts,
and one accumulated lifetime cannot monopolize a maintenance transaction.
A sleeping process, connection loss or access-check uncertainty cannot
release live history. Reload, main-document navigation and renderer loss end the
old window generation; retained editor remount, same-document navigation and
subframe navigation do not. Store replacement ends all old-epoch structural,
transfer and clipboard capabilities, including those without a Host owner, and
drops ephemeral roots in the epoch transition. Before that offline transition,
it completes dormant-source publication through individually committed legacy
artifact conversions. Interrupted preparation resumes without exposing a new
epoch or losing unowned content provenance. Interactive Undo is not restored
across Host restart.

Closed owner and surface markers are late-write fences, not content-retention
roots. They remain until proven Host death or Store replacement; deleting them
on an inactivity timer would allow a delayed request to register the same
lifetime again. Closing immediately fences recipe execution and Cut move claims,
then schedules physical release through durable, bounded cleanup slices. Unvisited
roots may conservatively retain content until their slice commits. The reaper's
indexed cursor discovers dead Hosts independently of pending cleanup, and each
maintenance writer admission releases only a bounded recipe/member/surface batch.
Cancellation or restart repeats only the uncommitted slice. Interactive work can
run between slices. Consumed and superseded recipes leave the live owner index in
their transition transaction and enqueue physical root cleanup, including ordinary
Undo and eviction. No single recipe can hide an unbounded member cascade. Terminal recipe
evidence is distinct from active retention and must not be discarded while a
reachable capability may still need to distinguish supersession from conflict.

Structural edits, Block promotions and Page relocations share one capability
registry, window-lifetime fence and retention lifecycle. Their semantic owners
decode their own inverse contents; a receipt's token never supplies authorization
or bypasses a closed owner. Promotion and relocation import preserves original
payload bytes, hash, scope and terminal state; one artifact is published into
chunk storage and removed from import input in the same transaction. Import does
not invent a desktop owner for older capabilities.

Structural inverse contents are stored separately from capability scope, hash,
and lifecycle evidence. Immutable UTF-8 chunks are at most 256 KiB; payload
collection removes at most four chunks per writer admission, with interruption
and elapsed-time checks between chunks. A payload becomes collectible only after
its recipe is terminal, one complete operation-receipt window has elapsed since
that transition, its producer receipt has been retired, and no owner, structural
root or active Cut claim still depends on it. Active inverses do not expire from
inactivity. Collection preserves the small consumed/superseded capability marker;
it never makes an old operation or token executable again.

New structural-edit and Block-transfer operation ledger entries retain a small
action description, request hash, actor, affected identities and committed
coordinates, without duplicating full requests or results. Exact replay belongs
to operation receipts; inverse contents belong to their capability; Page History
owns its checkpoints and relocation evidence. Property mutation requests and
field intents remain durable because exact conflict comparison and Page History
use them. Reducing ledger duplication does not shorten any of those owners'
retention contracts or imply that their body bytes have been reclaimed.

Redundant historical ledger request/result bodies are discovered once through a
durable identity cursor. Discovery only enqueues work; each collection admission
rewrites at most one old inline entry, after its receipt window and only without
a live receipt, inverse, owner/root or clipboard dependency. Retained candidates
are rescheduled through a due index, never repeatedly scanned as a growing prefix.
Body clearing and queue removal commit together. It preserves every ledger
identity, actor, field intent, hash and commit coordinate; SQLite rejects any
other evidence update, including a nullable-field change disguised as cleanup.
As with old inline inverses, this is a cold conversion cost, not a bounded-chunk
latency guarantee. New entries do not enter this collection queue. Reclaimed
SQLite pages become reusable without requiring a shrinking file or VACUUM.

Dormant Document provenance has its own minimal identity index, not a second
retention root or access grant. Structural writes publish it atomically with the
inverse. Collection checks current Document ownership, the exact placeholder and
all retention evidence; it does not recover provenance by scanning history JSON.
The due index selects a bounded candidate page before eligibility checks. Each
processed source is either removed or rescheduled, so retained candidates cannot
force an unbounded prefix scan. Restoring ownership removes its dormant source;
collection and obsolete-placeholder cleanup remove stale sources as well.
Backup and restore accept an unowned Document waiting for collection only when
its exact dormant provenance and current canonical placeholder shape agree;
ending its last retention root does not make valid pending collection corrupt.

Existing inline inverses are converted by resumable maintenance, one artifact
per separately committed writer call. Payload and provenance publication, inline
replacement and the backfill cursor commit together; an interruption repeats
only the uncommitted artifact. Payload collection and physical terminal-root
release remain disabled until the provenance backfill completes, so an interim
backup retains a complete explanation for every unowned Document. Moving an existing maximum-size inline row is a
cold conversion cost, not part of the short-transaction cleanup guarantee. New
inverses are chunked immediately and never enter the inline representation.

Local text history also retains its reachable Block identities and source
Document before a bridge has produced a recipe. The Provider waits for durable
retention admission before sending a local update that can create tombstones.
The journal maintains first/last references to changed Blocks, old and new
ancestors and sibling anchors; repeated typing on the same retained set does
not generate another retention request. Adding roots advances LocalCommit,
invalidating older GC plans without changing Document heads or content history.
Pure root release is durable monotonic maintenance with a no-op semantic receipt;
an older plan can only retain too much. It needs no Project event and remains
possible after the Library's last Project has gone. Recipe state transitions
still publish their separate lifecycle notifications.
Each set has an immutable source authority and monotonically increasing
revision. Closing it is terminal: late older membership cannot reopen it.
Main owns unknown attempts and terminal release handoff beyond renderer waiters.
Window owner cleanup removes both local roots and available recipes.

Database edits and Block transfers also hand their exact typed requests to Main
before the first send. Unknown outcomes retain the original identity, payload,
and access scope across connection recovery; concurrent waiters share the same
attempt. Losing or closing a renderer does not establish non-commit: Main
continues confirmation within its Profile lifetime. Block transfers carry the
same trusted editor owner on every attempt, so Core can return a prior receipt
but rejects a first write after closure. Database writes remain process-owned
until a definite outcome. Pending count and request-byte admission share the history
runtime's bounds. Main does not compute their inverses or persist a second outbox.

A surface retains at most 10,000 identity references. A Host history lifetime
admits at most 128 active local sets and 100,000 references across them; exceeding
Core admission bounds cannot allow the dependent Document update to overtake
the missing pin. The renderer's contiguous-history eviction enforces the
per-surface limit. A never-registered local ID may be referenced but is not
created or reserved by retention, and existing foreign or retired identities
cannot be newly claimed.

Eviction or surface closure can hand an exact forward structural edit, Promotion
or replay request to Main even while its window stays active. Main joins the
existing attempt, waits for a committed outcome or authoritative non-commit,
then releases the input and any returned inverse. Promotion cleanup releases
its registry resource even when the returned capability is only single-direction.
Transfer cleanup uses the same trusted renderer/Project binding and shared
request-count/byte admission as the original command.
Cleanup cannot race a still-uncertain inverse by revoking its input first.
Abandoned attempts, admitted request bytes and waiting commands are independently
bounded. A late result never recreates an evicted entry or takes focus back.
Once an entry is unreachable, its renderer request copy is dropped even if Main
cannot accept the extra early-release handoff. The original admitted attempt and
its durable window owner remain responsible for outcome recovery and retention;
the renderer does not build an unbounded second cleanup queue.

Recipe lifecycle has its own authorized Project projection. Notifications carry
no inverse contents; each surface reconciles only the capabilities it already
holds, in batches of at most 200. The read verifies Library, Project actor, Store
epoch, recipe identity and hash. Stale snapshots cannot regress a newer observed
state, and a snapshot must cover the exact requested capabilities. Only known
supersession removes a reachable action automatically. A real release is a
durable lifecycle transition with notification; an already released token does
not manufacture another transition.

Core also delivers address invalidation from its durable structural write
fences. Exact authorized Document effects carry the affected identities;
canonical sync reads the interval after the replica's known head. Repeated
delivery cannot invalidate newer local captures. Evidence is bounded to 512
barriers, 512 identities, and 16 KiB of encoded identities; overflow marks the
body for guarded semantic replay rather than dropping entries or resetting the
Document. These fences do not grant write authority: the semantic inverse still
checks current generation, placement, changed fields, and retained Block state.

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

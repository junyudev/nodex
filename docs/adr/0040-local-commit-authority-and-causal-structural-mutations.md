# ADR 0040: LocalCommit is the local mutation authority and structural commands use causal Document heads

- Status: Accepted (amended 2026-08-10)
- Date: 2026-08-06
- Owners: Nodex maintainers
- Extends: ADR 0004, ADR 0005, ADR 0024

## Context

One local command can change a Page body, Page ownership, Database membership,
and several projections. Waiting for the durable event stream before updating
the initiating renderer creates an avoidable round trip and allows a Board or
Page surface to look stale after Core has already committed. Conversely,
letting a structural command race a mounted Yjs provider's unsent body update
can compile ownership from an older Document head and lose the user's local
edit.

The apply response and the durable event stream are therefore two deliveries of
one committed fact. They need one identity and one retry model. The Document
body head is a different coordinate: it orders Yjs/Canvas updates within one
surface and is a causal precondition for a structural mutation, not a public
projection cursor.

## Decision

### Complete packet and recipient authorization amendment

LocalCommit delivery uses event/transport version 8 and one packet-v4 shape.
Each packet binds a logical `DeliveryAddress`, an equal Core-authored
authorization scope, Manifest coverage, projection and Document effects, and
Manifest-bound `VisibilityDelta` values. A delta is an exact Grant, an exact
Revoke, or a bounded `ConservativeReset`; visibility is admitted before any
post-state content. A packet containing only visibility evidence is valid.

Non-origin renderers subscribe only to logical Library/Project addresses. The
Core scoped-live barrier signs an `AuthorizedRecipientLease` for every active
address. Main may route with that lease but cannot construct, replace, or
broaden its authorization scope. The renderer IPC carries exactly one complete
packet or one lease-bound `AddressReset`; effect-only projection and revocation
channels do not exist. Send failure, NACK, ACK timeout, queue overflow,
integrity failure, reload, and epoch replacement fence the address and actively
retry reset delivery with one bounded jittered timer. Retry starts at 100 ms
and caps at 60 seconds; an independent retry-window budget keeps a continuously
failed active address within 20 attempts over ten minutes for every jitter
sequence. Disposal cancels the timer and discards the budget.
A reset ACK clears only the required floor it covers. If another WebContents
later subscribes to an already-active address, Main installs the retained Core
lease for that recipient and sends a floor reset before ordinary packets.

Apply responses, including Document apply ACKs, enter the same renderer
`LocalCommitIngress` before their feature Promise resolves. Audience packets
and later durable copies use the same packet validation and resource claims,
so complementary audiences enrich and exact repeats deduplicate. Transport
`AddressReset` and semantic `ConservativeReset` retain separate identities and
cannot be substituted for one another.

Core separates one semantic mutation into private evidence, one immutable
semantic Manifest, and dynamically authorized delivery. Physical journal rows
retain reconstruction evidence. The `CommitManifest` owns
`(store_epoch, commit_seq, manifest_hash)`, resource-atomic `DeliveryAtom`
descriptors, exact Document refs, audience-scoped Projection effects, scoped
resource revocations, routing claims, and the receipt reference. Each atom has
one closed typed payload and a canonical all-of `ResourceKey` requirement set;
aggregate physical events are never renderer-facing authorization units.
An `AuthorizedDeliveryPacket` is resolved after commit for one current access
context and may carry complementary inline/ref coverage without changing the
Manifest identity. A committed apply response always returns command outcome,
receipt, and Manifest identity; its delivery packet is optional and cannot
expand post-state read capability.

Store Administration is Library-scoped evidence, not a Project event. A
changed backup, delete, prune, maintenance, or restore command writes one
private `local_commit_library_effects` row and compiles its
`StoreAdministrationChanged` atom against the exact Library root. The ordinary
`change_log.project_id` column remains evidence for Project-domain events and is
never populated with a selected, archived, or synthetic Project merely to make
a LocalCommit seal. The same `DurableMutationScope::seal` and `no_op`
dispositions own these receipts; pre-filesystem retry uses the shared durable
replay path, so no-op observations and committed Manifests cannot borrow a
later ambient event.

Command authorization and delivery authorization are separate Core decisions.
A Project-bound command remains constrained by that Project. When the connected
adapter is the authenticated Electron Host, Core resolves the apply and
response-loss-recovery packet for an explicit Library-broker delivery audience
used by the process-wide coordinator; the original Project context is retained.
Native CLI, test, Agent, and loopback adapters keep their exact bound post-state
audience. This makes source revocation and target projection
available in the response fast path without a second request or a durable-stream
wait. The Host packet does not grant any renderer a read capability: routing
uses the packet's Core-authored scopes, and every canonical fetch authorizes
again in Core.

Authorization loss is commit evidence, not a delivery-time guess. In the same
SQLite transaction as an ownership, lifecycle, or Project-grant change, Core
records the exact Library/Project/Document scope that lost each Page, Document,
Database, Data Source, or View. Every packet also carries a Core-authored
authorization scope covered by `packet_hash`. A trusted Library stream may
carry Project-scoped revocations, but adapters never infer historical scope
from current ownership. Revocation identity uses a canonical structured scope
encoding, never delimiter-concatenated IDs. A packet containing only
revocations is valid.

Dirty facts remain mechanical rather than command-specific. UPDATE triggers
require an actual watched-value change, and ordinary content Block rows do not
enter the authority journal. When one commit promotes a Block and advances its
new Page/Document through genesis and placement states, every fact is retained
but pre-visibility is mechanically empty for those born roots. Any fact that
touches a pre-existing root falls back to exact reverse-overlay evaluation.

For a Page-to-Board promotion, heavy Yrs reconstruction and transformation run
against isolated working clones outside the SQLite writer. The writer then
revalidates command authorization, Document heads, ownership revisions,
membership, and Projection scope heads before one short transaction persists
the source removal, target Page genesis, exclusive ownership/membership,
Board patch, typed receipt, and one sealed Manifest. Same-Document Agent
batches compile one ordered Yrs update per Document and one outer Manifest;
they never prepare several updates against the same stale target head. The
transaction cannot return a successful response with only a final Library
effect or with an inferred operation-id grouping.

The initiating renderer validates and admits `ApplyResponse.delivery` into one
renderer-local `LocalCommitIngress` before the feature Promise resolves. Main's
Main-scoped `LocalCommitRuntime` admits only scoped-live and durable-tail
packets for other recipients. Both runtime boundaries validate Manifest hash
and coverage and claim authorization-scoped resource identities. Main uses
Scope-owned Queue actors and shared Deferred completions to schedule
independent ordered lanes for each exact Document, exact projection scope,
scoped resource revocation, and domain notification. Revocations are admitted
before ordinary Document effects from the same packet. Transactions affecting
overlapping Document sets serialize on each shared Document without creating a
composite lane that blocks unrelated Documents. Cancelling a tail waiter does
not cancel shared delivery; terminal failure prevents checkpoint progress and
releases only its exact claims for replay. No lane, durable stream, Main fanout,
or recipient acknowledgement delays the apply response.

Non-origin delivery is result-bearing. Main assigns a bounded recipient
sequence and renderer ACK means the packet entered causal ingress, not that
React painted. A failed send, NACK, missing ACK, queue overflow, reload, or
broker reset records an exact-scope reset that is delivered before later work;
the renderer then fences stale authority and performs a canonical repair.

Admission may select one DeliveryAtom for a notification lane, but the
Core-authored packet remains byte-for-byte intact with its original coverage
and `packet_hash`; adapters receive the selected effect as a separate argument
and never manufacture a sliced packet that reuses another packet's hash.
The later tailer copy enriches or deduplicates already delivered resources; an
identity collision fails closed. Stream checkpoints advance replay bookkeeping
only.

Core seals each affected projection scope with an independent
`base_revision`, `result_revision`, `covered_commit_seq`, `effect_hash`, an
optional complete patch, and `requires_read_at_least`. Main routes the already
authorized effect without reading. A renderer `CausalProjectionRuntime`
accepts only a contiguous revision edge, applies complete patches
synchronously, buffers bounded future edges, and coalesces canonical repair for
gaps, patchless effects, resets, or integrity conflicts. Canonical reads carry
the exact coordinate and cannot replace newer local authority. The global
LocalCommit sequence is never treated as a projection version.

Projection audiences are the union of pre-state and post-state authorized
scopes for the affected subjects, not merely the command actor. Lost scopes
receive revocation; retained and newly authorized scopes receive independent
revision transitions or explicit read floors. Equivalent authorization
fingerprints may share computed patch bytes, but never scope identity,
revision, hash, or deduplication. Main maintains one multiplexed scoped-live
broker and changes its active scope set make-before-break.

Every mounted collaborative Document editor registers one structural-mutation
participant over its `BlockDocumentMutationBarrier`. The participant first
settles transient editor state, including IME, native Block drag ownership, and
focus, then flushes local durable updates and returns a `DocumentHeadToken`
containing Document identity, Store epoch, generation, and head sequence.
Move-to and cross-surface Block DnD require the affected mounted participants
and pass their tokens as causal dependencies; a participant that disappears
causes the renderer command to fail closed. Core verifies the tokens while
preparing and revalidates them in the writer transaction against current SQLite
Document rows. The dependency is excluded from the semantic intent hash so a
retry after a fresh read remains the same idempotent command.

Document/Canvas live streams independently enforce per-surface head order. They
buffer a bounded future-head gap and emit typed repair on overflow or epoch
change. This preserves Yjs/scene convergence without making projection replay a
prerequisite for local command visibility.

An exact Document subscription is a post-state authorization and
resource-filtering boundary, not a durable replay stream. Core first installs a
receiver in a resource-addressed Document live Hub, then resolves access,
Store identity, engine, generation, Document head, and current LocalCommit head
in one SQLite read snapshot. That `DocumentLiveBarrier` opens the interval.
Main buffers any post-barrier events until the renderer's canonical
state-vector/scene sync adopts the same boundary; events covered by the sync are
dropped and later contiguous heads drain in order. Historical state is supplied
by canonical Document sync and the global durable stream, so Page opening cost
does not grow with retained LocalCommit history.

After commit, the server performs only a bounded O(1) enqueue before returning
the apply response. One ordered worker resolves immutable Document routing
claims and publishes to addressed channels only. A woken stream still asks Core
to resolve an exact post-state-authorized packet, so routing is never trusted as
authorization. SQLite scans and packet reconstruction execute on blocking
workers rather than the async transport reactor. Queue failure, receiver lag,
unavailable evidence, or Store replacement produces a typed repair boundary and
a fresh barrier; there is no exact-stream cursor to guess or replay.

Publication follows durable identity, not successful construction of optional
apply delivery. Core enqueues the wake first and republishes exact retries;
resource admission makes repeated copies harmless. Thus a committed command
whose response packet cannot be reconstructed is still recoverable by an
already-open live or durable consumer.

An already-open exact Document subscription remains a Core-authorized
capability for that Document. Apply-response and trusted root-stream packets may
therefore enrich active subscriptions for the exact Document, while dispatcher
resource identity deduplicates the later live/root copy. A scoped Document
revocation independently emits `access-revoked` and closes only the addressed
Project or Library subscription. Revocation and Document effects have separate
bridge entry points, so one lane cannot accidentally consume or suppress the
other.

Compaction may remove a retained Yjs update body but never removes the semantic
LocalCommit effect. Replay of such an effect returns the typed
`document_resync_required` boundary with verified identity/hash metadata; Main
maps it to a history-compacted surface resync, and the provider repairs from a
canonical snapshot/state vector rather than applying an invented empty update.

## Consequences

The initiating window renders the committed source-Document and target-View
result with the same latency as the Core response, while other windows and a
restarted process converge from scoped live delivery or the durable stream.
Renderer ingress and Main each own authorization-scoped resource deduplication
at their boundary; Main additionally owns bounded recipient delivery/reset,
while renderer stores own Core-derived snapshots, exact scope coordinates, and
deterministic reducers—not speculative ownership state.
Core projection authority distinguishes exact Page, Database View, Page Detail
Database, and Page Detail Data Source scopes.
Page Document commits advance exact Page and Database View scopes for every
Project audience that can read them, without materializing relational View rows
on the document writer's hot path.
Database and Data Source identities carried by an ordinary title or body edit
are routing evidence, not shared-descriptor mutations, and exact-resource
fallback never promotes them to a Project aggregate reset.
Row-local writes advance the changed Page plus affected Views, while Property,
option, and View mutations advance only their matching shared descriptor scope.
Page Detail ignores Database View effects and depends on exact Page plus Page
Detail Database and Page Detail Data Source authority, so even a patchless View
repair cannot evict cached sibling Page Details.
Revocations, checkpoints, and resets retain their conservative resource
matching and fencing semantics.
When access is lost, Page Detail, Board, and query stores synchronously remove
the matching cached authority for every revocation before any canonical repair.
Authority-bearing reads return a hash-bound `AuthorizedReadStamp` from the same
SQLite snapshot as their data. A renderer records only the request identity
before I/O; it learns direct, ancestor, membership, and overlapping-grant roots
from the stamp. The Core authorization evaluator returns those proof roots from
the same decision that establishes readability; response payload resources are
inputs to that evaluator, not substitutes for the proof. The root union uses the
generated `ResourceKey` order and includes every Page on an inherited
grant-to-subject ownership path, so grant changes and structural edge changes
both intersect dependent stamps without enumerating descendants. If an
otherwise valid proof union exceeds the stamp bound, Core replaces it with the
authorization scope's Library or Project aggregate root. Every exact visibility
change for that scope also invalidates the same aggregate root; compiler budget
overflow continues to emit a whole-address `ConservativeReset`. When an
authority edge changes but a candidate resource remains readable, its exact
`Grant` root schedules targeted proof repair; this prevents a registration from
retaining an obsolete path until a later revoke. The renderer verifies the
stamp's
closed resource union, address/scope/epoch/covered floor, and registers those
roots before adopting the response. Exact visibility changes fence only
matching registrations. Address or conservative reset fences the complete
address. Root floors survive older in-flight reads and active registrations;
capacity overflow clears the address authority and fails closed rather than
dropping an old floor. A whole-address fence advances a renderer-local
generation as well as its covered floor, which rejects reads started before a
same-floor reset. This is a client consistency guarantee, not a
replacement for Core's read authorization.

An admitted cross-surface structural command may also own one ephemeral local
semantic prediction. The renderer can immediately project source removal and
the final target shape while Core remains the only durable ownership authority.
Generated Page identities come from a read-only Core transfer plan that reuses
the commit planner. Prediction is fenced by the durable operation identity and
affected Page identities: a newer operation permanently supersedes older visible
ownership for the same Page, deterministic rejection rolls back only still-owned
prediction, and an unknown outcome keeps the same operation and projection until
receipt or canonical evidence resolves it.

Structural commands can still return a retryable revision conflict when a
mounted provider changes after its barrier or when an unmounted target changes
before Core applies the command. This is intentional: the command never
silently overwrites a newer Document body. No application-wide pending overlay
or UI freeze is needed for the normal commit path.

## Rejected alternatives

- Wait for the SSE tailer or projection callback before resolving apply. This
  makes a durable local commit look remote and couples command latency to
  renderer fanout.
- Let each renderer independently invent durable membership, Page ownership, or
  generated identities. This duplicates SQLite/Core authority and cannot safely
  reconcile ownership/body transactions. Renderer-local predicted presentation
  is permitted only when it is operation-scoped, non-durable, supersedable, and
  reconciled against Core receipts and canonical projections.
- Use only `max(commit_seq)` as a dedupe cursor. An out-of-order N+1 delivery
  would cause N to be discarded even though it may affect another Document or
  projection.
- Treat a Yjs head token as an idempotency hash. Freshness changes on retry;
  command identity must remain stable across a response-loss recovery.

## Acceptance

- The initiating renderer admits apply-response delivery before its feature
  Promise resolves, without waiting for a durable tailer, canonical read, Main
  fanout, or another renderer's ACK.
- A trusted local Project-bound cross-Project command returns a Library-scoped
  packet that can deliver both the source revocation and target projection
  before the command Promise resolves; the command authorization itself remains
  Project-bound.
- Packets for the same Manifest arriving from apply and tailer produce one delivery per
  resource identity, while complementary authorized coverage is preserved.
- A resource-atomic semantic packet contains an atom only when every declared
  requirement is readable in that packet scope; mixed-resource physical events
  neither leak a hidden sibling nor suppress a separately public atom.
- A pure scoped revocation packet survives apply/tailer deduplication, reaches
  only its authorization scope, closes exact Document subscriptions, and
  synchronously evicts matching renderer caches even when their cursor is newer.
- N and N+1 remain independently deliverable when they arrive out of order.
- A projection-lane failure cannot delay Document fanout, another projection
  scope, a revocation, or the apply response.
- A contiguous Database View patch updates Board cards, query rows, grouped
  windows, totals, and exact authority before repair I/O; mixed-revision reads
  and continuations are rejected.
- A mounted source/target body is flushed before Move-to or Board DnD, and Core
  rejects a stale causal head without a partial ownership/membership commit.
- An exact Page or Canvas Document subscription receives its own authorized
  post-barrier updates, never scans historical LocalCommits, and never receives
  unrelated semantic effects from a multi-resource Manifest.
- A receiver installed before the exact barrier plus canonical sync loses no
  commit at the open boundary: covered events are discarded and later events
  are delivered once in Document-head order.
- Exact live publication is not an apply-response prerequisite; queue or
  receiver pressure produces typed repair rather than synchronous replay or a
  best-effort silent drop.
- A non-origin send failure, missing ACK, queue overflow, or renderer reload
  establishes a bounded exact-scope reset and cannot block another recipient or
  the committed command.
- A high-pressure populated Board test moves 100 independently seeded nested
  100-child subtrees and reports commit/card visibility p50/p95/p99/max without
  a fixed sleep or manual refresh. Automated Electron coverage invokes the real
  renderer IPC mutation/projection boundary; native pointer DnD remains a
  manual smoke check because synthetic drag events are not a reliable product
  input model.

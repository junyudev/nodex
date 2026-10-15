# ADR 0040: LocalCommit is the local mutation authority and structural commands use causal Document heads

- Status: Accepted (amended 2026-10-14)
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

### Complete packet and recipient delivery

LocalCommit delivery carries one packet shape containing its logical
`DeliveryAddress`, immutable Manifest identity, exact coverage, projection
and Document effects. The current Profile is fully accessible; packets do
not contain resource grants, authorization scopes, read stamps or visibility
changes. Delivery addresses route subscriptions and preserve stateful Project
presentation; they do not limit content access.

Non-origin renderers subscribe only to logical Library/Project addresses. The
Core scoped-live barrier issues a physical recipient lease for every active
address. Main routes with its exact lease and delivery address. The renderer IPC carries exactly one complete
packet or one lease-bound `AddressReset`. Send failure, NACK, ACK timeout, queue overflow,
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
so complementary audiences enrich and exact repeats deduplicate. Each transport `AddressReset` retains its immutable identity and covered floor.

Core separates one semantic mutation into private evidence, one immutable
semantic Manifest, and authenticated connection delivery. Physical journal rows
retain reconstruction evidence. The `CommitManifest` owns
`(store_epoch, commit_seq, manifest_hash)`, resource-atomic `DeliveryAtom`
descriptors, exact Document refs, audience-addressed Projection effects,
routing claims, and the receipt reference. Each atom has one closed typed
payload and canonical resource coordinates. An authenticated delivery packet
may carry complementary inline/ref coverage without changing the Manifest
identity. A committed apply response always returns command outcome, receipt
and Manifest identity; its delivery packet remains optional.

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

The authenticated Profile connection provides full Library access for user and
Agent operations. Project coordinates identify execution context, ownership
associations and delivery routes. They do not constrain which Page, Database,
Canvas or File a command may read or change. Cross-Project writes use the same
transaction and delivery paths as local writes.

Dirty facts remain mechanical rather than command-specific. UPDATE triggers
require an actual watched-value change. Structural and lifecycle changes compile
exact resource/projection effects in the same transaction as their durable
content changes.

For a Page-to-Board promotion, heavy Yrs reconstruction and transformation run
against isolated working clones outside the SQLite writer. The writer then
revalidates execution identity, Document heads, ownership revisions,
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
and coverage and claim address-scoped resource identities. Main uses
Scope-owned Queue actors and shared Deferred completions to schedule
independent ordered lanes for each exact Document, exact projection scope,
and domain notification. Transactions affecting
overlapping Document sets serialize on each shared Document without creating a
composite lane that blocks unrelated Documents. Cancelling a tail waiter does
not cancel shared delivery; terminal failure prevents checkpoint progress and
releases only its exact claims for replay. No lane, durable stream, Main fanout,
or recipient acknowledgement delays the apply response.

Non-origin delivery is result-bearing. Main assigns a bounded recipient
sequence and renderer ACK means the packet entered causal ingress, not that
React painted. A failed send, NACK, missing ACK, queue overflow, reload, or
broker reset records an exact-scope reset that is delivered before later work;
the renderer then fences stale projections and performs a canonical repair.

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
exact effect without reading. A renderer `CausalProjectionRuntime`
accepts only a contiguous revision edge, applies complete patches
synchronously, buffers bounded future edges, and coalesces canonical repair for
gaps, patchless effects, resets, or integrity conflicts. Canonical reads carry
the exact coordinate and cannot replace newer local authority. The global
LocalCommit sequence is never treated as a projection version.

Projection audiences follow the affected resources' delivery coordinates,
independently of the command actor. Each scope owns its revision transition,
hash and deduplication. Main maintains one multiplexed scoped-live broker and
changes its active scope set make-before-break.

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

An exact Document subscription routes a live resource interval. Core first installs a
receiver in a resource-addressed Document live Hub, then resolves lifecycle,
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
to resolve an exact packet for the authenticated Profile and live Document identity. SQLite scans and packet reconstruction execute on blocking
workers rather than the async transport reactor. Queue failure, receiver lag,
unavailable evidence, or Store replacement produces a typed repair boundary and
a fresh barrier; there is no exact-stream cursor to guess or replay.

Publication follows durable identity, not successful construction of optional
apply delivery. Core enqueues the wake first and republishes exact retries;
resource admission makes repeated copies harmless. Thus a committed command
whose response packet cannot be reconstructed is still recoverable by an
already-open live or durable consumer.

An already-open exact Document subscription retains its Document and physical
client identity. Apply-response and root-stream packets enrich matching active
subscriptions while exact resource claims deduplicate later copies. Owner
deletion, generation changes and Store replacement invalidate the affected
subscription; Project or Library permissions do not participate.

Compaction may remove a retained Yjs update body but never removes the semantic
LocalCommit effect. Replay of such an effect returns the typed
`document_resync_required` boundary with verified identity/hash metadata; Main
maps it to a history-compacted surface resync, and the provider repairs from a
canonical snapshot/state vector rather than applying an invented empty update.

## Consequences

The initiating window renders the committed source-Document and target-View
result with the same latency as the Core response, while other windows and a
restarted process converge from scoped live delivery or the durable stream.
Renderer ingress and Main each own address-scoped resource deduplication
at their boundary; Main additionally owns bounded recipient delivery/reset,
while renderer stores own Core-derived snapshots, exact scope coordinates, and
deterministic reducers—not speculative ownership state.
Core projection authority distinguishes exact Page, Database View, Page Detail
Database, and Page Detail Data Source scopes.
Page Document commits advance exact Page and Database View scopes for every
Project audience observing them, without materializing relational View rows
on the document writer's hot path.
Database and Data Source identities carried by an ordinary title or body edit
are routing evidence, not shared-descriptor mutations, and exact-resource
fallback never promotes them to a Project aggregate reset.
Row-local writes advance the changed Page plus affected Views, while Property,
option, and View mutations advance only their matching shared descriptor scope.
Page Detail ignores Database View effects and depends on exact Page plus Page
Detail Database and Page Detail Data Source authority, so even a patchless View
repair cannot evict cached sibling Page Details.
Checkpoints and resets retain their resource matching and fencing semantics.
Canonical reads carry Store epoch, covered LocalCommit sequence and exact
resource/projection identities. Request generations reject a response from
before disposal, replacement or a same-floor reset. Projection revisions and
covered floors prevent older reads from overwriting newer patches. Reads and
repairs remain bounded and resource-keyed; no resource authorization index or
grant closure is retained in the renderer.

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
- A cross-Project command returns a packet with exact source and target effects
  before the command Promise resolves.
- Packets for the same Manifest arriving from apply and tailer produce one
  delivery per resource identity, while complementary coverage is preserved.
- A resource-atomic packet carries canonical resource identities and closed typed
  payloads; adapters preserve its Manifest and complete coverage.
- N and N+1 remain independently deliverable when they arrive out of order.
- A projection-lane failure cannot delay Document fanout, another projection
  scope or the apply response.
- A contiguous Database View patch updates Board cards, query rows, grouped
  windows, totals, and exact authority before repair I/O; mixed-revision reads
  and continuations are rejected.
- A mounted source/target body is flushed before Move-to or Board DnD, and Core
  rejects a stale causal head without a partial ownership/membership commit.
- An exact Page or Canvas Document subscription receives its own exact
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

# Reliability

## Purpose

Nodex is reliable when committed local work survives process and window
lifecycle, every authorized presentation converges on the same semantic state,
and recovery never introduces a second authority or replays stale work into a
new one.

This document is the reliability map and cross-system contract. Detailed
mechanisms live in the focused documents under `docs/reliability/`, product
behavior in `docs/product-specs/`, and executable version/schema/limit values in
code and tests.

## Reliability model

Nodex uses four distinct recovery layers:

1. **Semantic transaction:** Core validates one intent and atomically commits
   canonical state, receipt, history, projection effects, and visibility.
2. **Authorized delivery:** the initiating caller admits its authorized committed
   effect immediately; other consumers receive the same fact through durable or
   exact-resource delivery.
3. **Canonical repair:** a gap, stale projection, compacted update, or reconnect
   reloads a bounded current snapshot from the owning Module.
4. **Authority replacement:** whole-Store restore or authority drift rotates the
   Store epoch and relaunches every Adapter; stale transports and local recovery
   state fail closed.

These layers must not substitute for one another. A renderer reread cannot make
an uncommitted command real. An event cursor cannot stand in for a Projection
revision. A projection invalidation cannot grant access. A Core generation
reconnect cannot hot-adopt another Store epoch.

## Completion and acknowledgement

A durable mutation is complete when Core commits its transaction and returns or
can replay its immutable receipt. When an authorized apply delivery exists,
Main admits it to the initiating renderer before resolving the feature command.
The later event stream is fanout and recovery, not a second success condition.

Two contracts connect that transport fact to visible completion without
collapsing their owners:

- The exhaustive IPC endpoint contract classifies every channel as query,
  command, or control. A command declares `core_local_commit`, `main_revision`,
  or `plain_result` acknowledgement. LocalCommit and revision commands cannot
  compile unless their result carries the declared evidence; a plain result
  makes no persistence claim.
- The renderer semantic command contract names the owning Module and selects
  receipt-fenced projection, local Document replica, local Canvas outbox,
  revision-fenced local state, returned value, or pending operation. That owner
  alone defines immediate presentation, conflict, retry, materialization,
  rendered handoff, and failure.

For receipt-fenced projections, acknowledgement, exact bounded-projection
materialization, and a matching React render handoff are all required before
local presentation settles. Acknowledgement and materialization may arrive in
either order. An older operation's response or observation cannot settle a
newer conflicting intent. Operations without proof of a predictable post-state
remain pending or expose their typed terminal result; transport success is not
presented as invented domain success.

Response loss is handled by retrying the same idempotent intent. The original
receipt is returned without applying the mutation again. Reusing an operation
identity for different intent is a typed collision.

Exact retry history is finite. New operation identities carry a bounded issue
and expiry window; a retry whose receipt has already crossed the durable receipt
floor fails with a typed expiry instead of running again. A rolling cutover
keeps existing legacy receipts replayable for one complete window before a
missing legacy identity becomes an explicit error.

A child operation with a durable parent episode derives its bounded identity
from that parent's Core-owned issue coordinate and its own semantic key. In
particular, an Agent tool retry after a Main restart retains the same identity
for its frozen Turn and call rather than silently executing again.

A state-idempotent request with no durable retry owner instead receives a fresh
bounded identity at admission and keeps it only for that request's retry
episode. It never uses the target entity's age as the issue time. After a crash,
the owner reads authoritative state first and starts a new episode only when the
earlier mutation is known not to have committed.

Optimistic presentation may continue after acknowledgement until a bounded
projection materializes the committed result. The optimistic owner must remain
semantic and identity-keyed; it cannot infer canonical success from elapsed
time, a broad cursor, or the disappearance of a component.

Development builds may retain a fixed-capacity causal trace containing only
semantic keys, hashed operation identities, owner/protocol/scope labels, reason
codes, and render tokens. It is diagnostic evidence, not settlement authority;
payloads and unbounded histories are never recorded. Transport never invents a
random identity for diagnostics: the command envelope carries the owner-issued
identity, or the owner supplies the matching trace context explicitly.

Read [LocalCommit and Projection Delivery](reliability/local-commit-and-projections.md)
for Manifest, wake/replay, audience, projection-freshness, visibility, and
Document-effect rules.

## Core and Store lifecycle

One detached Rust Core is the only SQLite and durable Document authority for a
Profile. Electron selects an authenticated compatible generation before
initializing Adapters and never opens the Store itself.

A definitive transport loss may reconnect to a different Core process only
when Profile, Library, and Store epoch remain identical. Stable facades,
schedulers, cursors, and logical subscriptions survive the physical generation.
Repeated failures produce one app-wide unavailable state and a bounded circuit,
not many feature-local retry loops.

The reliable Core event tail advances its cursor only after canonical delivery and checkpoint
success. A retryable delivery or bounded callback-ingress overflow closes that physical stream and
reopens from the last durable cursor. A non-retryable canonical delivery failure atomically marks
Core authority unavailable, fences every later Core operation with the same typed failure, and
requests `RuntimeFatal`; `connection = failed` is therefore never a mutation-capable half-state.

Core, rather than Electron, owns request admission and completion. Interactive
work retains reserved execution capacity while background and maintenance work
use bounded subordinate lanes. One absolute request deadline and cancellation
token reach queued readers, the writer, and SQLite progress handlers. Deadline,
explicit cancellation, overload, and transport loss remain distinct failures;
Electron waits a short liveness grace beyond the semantic deadline before it
may report a transport timeout. Stale interactive searches actively cancel
their Core request as non-error control flow, and Store maintenance is
single-flight across all lanes. A cancelled writer waiter promptly releases its
execution capacity and cannot execute later; class-aware writer scheduling
prioritizes interaction with bounded aging, while maintenance yields between
short slices. SQLite planner statistics are maintained when
the Store opens and after writer use; FTS-backed searches keep the virtual
table as their driving loop even before an existing Store has statistics.
Health evidence includes active and queued requests, admission and execution
duration, and deadline/cancellation/overload counts.

Store migrations accept only exact catalog identities. Core validates the
source, creates a content-addressed SQLite Online Backup, applies the selected
forward step in one atomic live-Store transaction, and validates exact current
physical and semantic authority before readiness. The migration history and
backup retain recovery evidence; current reopen is idempotent. Accepted
source/current identities are executable data owned by the Store catalog,
migration code, snapshot, and tests rather than prose.

Read [Core Lifecycle and Store Reliability](reliability/core-lifecycle-and-store.md).

## Documents and collaborative state

Exact Page/Block and Canvas subscriptions establish an authorized live barrier
before canonical engine synchronization. Earlier state comes from state-vector
or full-scene sync; later effects arrive through the addressed lane. Missing or
out-of-order heads, receiver lag, generation changes, and compacted update bytes
produce typed canonical resync rather than guessed content.

A mounted writer acknowledges only durable updates. Each surface keeps its own
selection, undo origins, camera/tools, and ephemeral presence. Structural
operations flush mounted Documents and recheck exact causal heads in the same
transaction that changes ownership or placement.

Semantic history and operational update logs have different retention. Restore
creates a new forward mutation. Deleted-content collection proves complete
unreachability and permanently retires stable identities.

Structural clipboard bundles, editor history recipes, and Block-transfer Undo
recipes are explicit retention roots. Available cut claims retain their original
identity closure; consumed, superseded, or surface-released recipes drop their
normalized retention members.
Their persisted bytes and hashes remain immutable across Document schema
upgrades. Core authenticates the original capability first, then adapts its
materialized Block forest and every dependent root coordinate in memory before
Paste, Undo, or Redo.
Undo and Redo run new forward Core transactions and return fresh single-use
inverse tokens. Releasing history is durable internal housekeeping and does not
publish a content-change event.

Read [Document Sync, History, and Retention](reliability/document-sync-history-and-retention.md).

## Page-key allocation

Page-key allocation is part of the same Core transaction that commits Page
creation or Database placement. Exact receipt replay returns the original
assignment without consuming another number. Failed transactions consume
nothing; committed archive, deletion, or relocation never releases a number.
Cross-Database moves preserve the source assignment and allocate or reuse the
target assignment atomically with membership and projection effects.

Prefix changes are revision-fenced and retain the exact previously allocated
range for historical resolution. Projection repair may temporarily hide a key,
but it cannot synthesize, reserve, renumber, or reclaim one. Whole-Store backup,
restore, validation, and retention cover namespace, prefix, and assignment
authority together. Detailed identity and allocation decisions are recorded in
[ADR 0043](adr/0043-database-scoped-page-keys.md).

## Backup, restore, and maintenance

A whole-Store backup covers the database and managed assets behind one Core
maintenance boundary. The initiating renderer allocates a bounded operation
identity before submission and retains the exact normalized command while its
transport outcome is unknown. Main reports `submitted` once it owns the
background operation; durable Core admission may follow asynchronously and is
never inferred from a deadline. If another snapshot already occupies the lane,
Core durably coalesces the requested identity to that job and Main returns the
typed `already_running` outcome. Exact retries, including after Main restart,
therefore reconnect to the original job or replay that coalescence instead of
creating another snapshot. The renderer Backup runtime owns the visible
`submitting -> submitted/progress -> completed | failed | cancelled` lifecycle;
submission is never presented as terminal backup success.

Online database capture, complete validation, hashing, and asset copying run
outside the serialized Store writer, while short authority checks and final
receipt publication remain transactional. Managed asset files are immutable and become visible only
through same-filesystem atomic publication from a sibling staging directory
outside the backup closure; Core snapshots the database before
enumerating that asset closure, so concurrent materialization can add only an
unreferenced extra file, never omit a file referenced by the captured database.
Restore validates the complete candidate, journals database/WAL/assets
replacement, publishes all-or-nothing, rotates the Store epoch, and relaunches
Electron. Old outboxes, checkpoints, Awareness, and cursors cannot replay across
that epoch.

### Page File blobs

Page File bytes use a publish-before-reference protocol owned by Core. A bounded
stream is hashed into a private same-directory staging file, fsynced, published
without replacement under a content-addressed immutable name, and revalidated
before Core returns an opaque prepared receipt. The receipt is bound to Store
epoch, Project, operation identity, hash, size, and expiry. Only the matching
Page File manifest mutation may consume it. Consequently a failed metadata
commit can leave reclaimable unreferenced bytes, but a committed File version
cannot point to bytes that were never published.

Whole-Store backup copies the immutable asset tree under the existing snapshot
lease. Restore verifies every retained Page File version's managed blob size and
SHA-256 before installation. Blob garbage collection computes reachability from
live and retained File versions plus unexpired receipts, takes the destructive
side of the snapshot lease, and rechecks the Store coordinate before unlinking;
backup and GC therefore cannot race a reachable blob out of the closure.

Maintenance has one canonical coordinator for integrity, compaction, retention,
collection, and vacuum. It never rewrites immutable receipts/history or removes
pinned revisions. Block collection uses version-fenced current projections and
a commit-fenced WAL reader snapshot rather than reconstructing retained
Document checkpoints for every candidate. Retained tombstones carry bounded,
commit-fenced reevaluation times so candidate scans advance instead of spinning
on an uncollectible prefix. Evidence loading never owns the serialized writer,
and collection releases that writer between bounded candidate slices.

Operational delivery and idempotency evidence is not semantic history. Core
keeps it inside versioned time, row, byte, and global high/low watermarks,
advances durable replay and receipt floors, and prunes it in short self-silent
transactions. A cursor below the replay floor performs canonical resync;
semantic state, user-visible revision history, and pinned recovery roots are not
deleted with the delivery tail. Bounded identity sets and indexed foreign-key
and semantic-reference probes keep each logical deletion slice proportional to
the retained window rather than total historical ledger size. Logical pruning
finishes before time-budgeted incremental page reclamation; current Profiles
opt into incremental auto-vacuum at creation, while existing database header
modes are preserved without an implicit full rewrite.

The Main application scope owns the automatic backup and maintenance lanes.
Changing backup interval or retention replaces only the backup lane; it must not
stop maintenance. Maintenance lanes share a fair FIFO permit with at most one
queued pass per lane; only Core's due-work result may select an idle interval.
Core authority recovery wakes deferred lanes, and process scope close removes
their timers and power-resume listener together.

Read [Backup, Restore, and Maintenance](reliability/backup-restore-and-maintenance.md).

## Desktop process lifecycle

Electron performs only platform-required synchronous bootstrap before readiness: Profile paths,
diagnostics, privileged schemes, isolated-run ownership, the single-instance lock, and a lossless
early-event buffer. It does not acquire an application service. After readiness, `MainApp` opens one
Profile-scoped Main resource graph and builds the Core, Codex, Window, IPC, Browser, Terminal,
worker, scheduler, updater, and notification Layers inside it. A required acquisition failure
returns its Cause and rolls back every resource already acquired by that same Scope.
Bootstrap fixes the selected Profile's settings path once. Runtime settings reads and mutations use
that path through one serialized Profile-scoped owner; they never rediscover configuration from the
current directory or OS home. Isolated development and Electron scenarios therefore keep their own
Nodex and Agent homes while inheriting the launcher's normal HOME for Git, SSH, credential helpers,
shells, and user tooling.
The graph acquires canonical Window Session shells before Core opens the Store. Each shell is the
final BrowserWindow and WebContents with restored bounds, native material, final preload, and an
inline parser-time brand frame. Before authority acquisition, only bootstrap IPC exists and the
framework-free renderer waits without importing the Workbench. Post-Core activation attaches full
capabilities to the same WebContents and opens one renderer gate at a time, primary first. A shell
that encounters Core or renderer startup failure stays visible in its branded failure state and can
restart the app; only a renderer document that cannot load at all falls back to native error UI.
Layer acquisition itself is the application readiness boundary: the acquired `MainApplication`
contains only operations that are valid after startup, with no separate `start` method or
partially initialized controller that can escape the Scope.

`MainShutdown` is the first-wins quit or relaunch decision authority. Normal quit, process signals,
startup rollback, Store restore, and Core authority drift all close the same Profile Scope before
Electron or the development launcher terminates or relaunches the process. Shutdown has no
independent per-subsystem disposer list. Layer dependencies determine release order; keyed child
Scopes release their own resources, and Effect combines finalizer failures into the closing Cause
while continuing the remaining finalizers. Any physical release that can hang owns its bounded
deadline or escalation policy at the platform adapter rather than in a global shutdown coordinator.
The same first-wins decision races application acquisition and readiness, so a signal or first
`before-quit` during startup interrupts in-flight work and rolls back everything already acquired.
`before-quit` never consults a partially published runtime or performs window cleanup itself; it
only submits that decision, while Window and other Layers release their own resources.
Window release stops new admission, requests renderer-aware graceful close in parallel, and then
destroys only the still-live windows at the per-window deadline. Close and destroy outcomes are
reported without allowing one damaged window to block the rest of the resource graph.

The process boundary observes one `MainExit`. Normal shutdown retains its first-wins reason and
cleanup report; failure retains the full Effect Cause and its `pre-ready`, `startup`, `runtime`, or
`closing` phase. Fatal Core or Codex truth loss carries its subsystem and original cause into this
boundary, closes application admission first, and is presented as a runtime failure rather than a
misleading startup error. The root observability adapter preserves structured annotations, spans,
fiber identity, and the Cause tree; only that root boundary reports defects to diagnostics.

Process termination signals are lifecycle ingress, not a competing shutdown owner. Electron Main
translates `SIGINT` and `SIGTERM` into the Main shutdown request and waits for Scope release before
asking Electron to quit. The development isolated-run supervisor owns those signals in its own
process, waits for the foreground application group to stop, then drains the exact claimed Core
generation and releases its Profile lease. Neither process entry installs another handler that can
interrupt this transaction halfway through.

The first-run Project bootstrap is one scoped, serialized recovery transaction. It durably records
intent before claiming a source and applying the idempotent Core command; presentation failure leaves
that exact intent recoverable. Closing Main admission prevents a second transaction while allowing
an admitted commit to finish its durable boundary.

Logical control planes have narrower lifetimes under the Profile Scope. A Core event stream advances
its checkpoint only after ordered delivery succeeds. A Codex endpoint generation stops admission,
settles its pending requests, interrupts deadlines, and retires its child before replacement.
Browser guests, PTYs, worker sessions, file watchers, and renderer request fibers are likewise
released by their semantic owner. Supervised isolated runs, including development and packaged-release
verification, release their environment lease only after exact child/Core cleanup is proven. Uncertain
external cleanup fails closed and preserves recoverable state rather than claiming success.

## Runtime-specific recovery

### Codex conversations

The app-server endpoint generation is the wire authority, Core Workspace is the durable Thread and
execution-metadata authority, and one private Main Conversation Entity plus causal lane owns each
live Thread generation. Protocol occurrences are generation-fenced before they enter that lane. Endpoint
replacement, failed hydration, or Thread removal settles the old generation's pending requests and
interrupts its buffers and command fibers; recovery seeds durable Core facts, performs a fresh
bounded-tail app-server read, and publishes one complete resident replacement generation. Sidebar summaries
and persisted renderer artifacts are never treated as a second transcript.

Endpoint loss also invalidates every loaded renderer stream role immediately: Main marks the exact
Conversation Entities `needs_resume` and sends targeted transport resets before reconnect. A visible
surface therefore either adopts the replacement generation from canonical history or reaches its
terminal attachment failure state; it cannot remain attached to a dead generation behind a truthful
global reconnect indicator.

The canonical protocol ingress is a supervised application actor with explicit health. Physical
reader/writer/decode failure, application occurrence or settlement overflow, deferred Thread-start
release overflow, and canonical consequence failure all terminate the exact endpoint generation;
an actor defect requests typed runtime shutdown instead of leaving a ready-looking queue without a
consumer. Generated protocol payloads are decoded once at the connection boundary. Internal
extensions remain explicitly tagged and cannot weaken generated-message validation.

The physical JSONL transport limits incoming and outgoing retained message counts, retained bytes,
and single-frame bytes independently. An incoming encoded frame is rejected before JSON decode at
16 MiB; decoded history projection then applies its narrower 8 MiB resident-page budget without
advancing a rejected cursor. Because the protocol has no per-page byte parameter, a compliant page
may transiently occupy the difference between those two bounds, but it cannot grow without limit.
Exceeding any reliable transport budget terminates that exact
endpoint generation so replacement can hydrate from canonical state; it never blocks forever or
continues after silently dropping a command. Main observation hubs use bounded sliding publication
only where subscribers can reread the canonical owner. Variable terminal output is truncated before
publication, while reliable command queues use bounded backpressure and surface admission failure.
Before semantic routing, the application Inbox also applies process-wide admission of 4,096
occurrences / 16 MiB and rejects any single occurrence above 2 MiB. Queue and pending-request
references share one reservation ledger, so settlement releases bytes exactly once.
Main's no-renderer fallback coalesces prose/reasoning and command-output deltas in two process-wide
queues with key, update, per-key, and aggregate byte/code-unit budgets. Pressure synchronously
commits the already bounded batch before admitting more work. A live Turn has its own byte budget;
an oversized lifecycle payload is replaced at the first typed Endpoint seam by an explicit overflow
marker instead of entering either the Inbox or observation hub. A terminal event drains only its Thread, and Thread teardown
discards only that Thread's queued entries.

History fan-out passes through one host scheduler with global, priority, background-lane,
per-conversation, count, byte, expiry, and exact-request coalescing budgets. Tail and search pages
are generation-fenced and make cursor progress or fail closed. The resident Entity enforces active
Turn-count and byte budgets across every object graph; passive owner cleanup retires the complete
Entity generation. Complete export has its own bounded one-Turn working set, progress,
cancellation, and idle-job retention, and never mutates the resident snapshot.
Scheduler admission applies a capped object-graph estimate before canonical request-key encoding,
so an oversized request cannot force a second payload-sized allocation merely to be rejected.

Thread and child-Thread catalogs are metadata projections with independent page, result, byte,
cursor-progress, and total-deadline budgets. Sidebar refresh, relationship repair, fork-title
selection, and subagent discovery publish only a complete admitted result; truncation, cursor
cycles, generation replacement, or timeout fail closed instead of persisting a partial view or
falling back to transcript hydration.

Persisted-history search separately bounds the query, occurrence page, each occurrence's ids,
cursor, snippet, and retained index. A renderer-supplied oversized occurrence is rejected before
host dispatch, and the per-Thread hydration tracker is a bounded last-write-wins registry rather
than a lifetime request map. Structured-title helper Threads likewise require a metadata-only
start response; a transcript-bearing helper is unsubscribed without starting a Turn.

Main-to-renderer delivery rejects count-saturated destinations before JSON encoding, applies a
capped resident-graph preflight, and computes the exact JSON UTF-8 size while validating the graph
before allocating the serialized copy. It serializes the remaining encoding admission and then
applies per-target and process byte budgets. Large payloads use one-frame-at-a-time transfer with
exact generation/sequence acknowledgements, deadlines, bounded retry, and target release. A slow
or destroyed renderer therefore cannot create an unbounded queue or keep multiple encoded
transfers in flight.

One renderer owner is the sole visible conversation writer. Main validates and retains its accepted
document as a relay/recovery replica; followers first acknowledge an exact snapshot barrier and then
accept only contiguous patches from the same owner epoch. A revision gap, hash mismatch, owner
replacement, renderer loss, or transport reset requests a fresh barrier. Recovery never merges
competing renderer documents or advances a follower past an unacknowledged checkpoint.

Conversation Relationships are rebuilt projections rather than recoverable state of their own. A
parent refresh joins child identities observed in its canonical collaboration items with Core's
durable child-Thread relationships, then enriches them from any loaded metadata or bounded-tail child
generation. Archived and reparented children are excluded, canonical collaboration order precedes
durable creation order, and missing friendly identity schedules a keyed directory repair. A failed
refresh publishes no partial membership; later invalidation or repair recomputes the complete parent
projection. Repair concurrency and deletion tombstones are bounded; tombstone saturation disables
metadata enrichment and falls back to durable-only membership until a fresh scoped runtime replaces
the projection, rather than risking resurrection or retaining an unbounded exclusion set. Restart,
resume, reparenting, and late child materialization therefore converge without a relationship
journal or parallel parent map.

Core Workspace remains the cold-restart authority for a managed Thread's execution host, cwd,
worktree path, and writable roots. Resume projects that location into the new app-server generation
instead of adopting a stale `thread/read` cwd. App-local worktree initialization activity survives
renderer replacement in the live Main entity but intentionally disappears with Main and is not
fabricated into durable protocol history.

A retained worktree removal leaves either the physical worktree or a complete snapshot reference.
Restore recreates only the authorized durable path and retains the snapshot on failure.
Execution-location handoff journals every external boundary and reconciles against Core after
interruption, preserving at least one complete usable source or destination. Settings, archive,
retention, automation, fork, and host-to-host movement use the same execution-location authority.
The durable execution-host commit shares the Thread causal lane with persistent fork dispatch, so a
fork either completes against the captured current host or observes the committed handoff and fails
closed; it cannot race through the read-to-dispatch interval on an obsolete host.

Detailed behavior lives in
[Codex Owner/Follower Streaming](product-specs/codex-thread-owner-follower-streaming.md),
[Codex Thread Transcript Behavior](product-specs/codex-thread-transcript-behavior.md),
[Codex Workspace Behavior](product-specs/codex-workspace-behavior.md), and
[Codex Managed Worktree Lifecycle Behavior](product-specs/codex-managed-worktree-lifecycle-behavior.md).

### Dictation

Dictation is stream-first but record-always. The surface controller keeps a complete `MediaRecorder` recording while streaming PCM frames independently; prepare, socket, protocol, timeout, backpressure, or empty-final failure therefore falls back to the same complete audio. Abort is the only terminal path that intentionally suppresses fallback and text application. Session/generation checks make stop, cancel, dispose, recorder finalization, history finalization, and transcript completion idempotent.

Recording history appends ordered five-second chunks in a private Profile directory. Metadata uses temporary-file replacement; startup removes stale temporary files, reconstructs valid chunk facts, and marks unfinished recordings `interrupted`. Retention keeps at most twenty non-active entries and never removes a current recording. Retry and download rebuild audio from the same validated ordered chunks.

The Profile-scoped dictation runtime owns one session lease across native hotkey, correlated in-app acknowledgement, auxiliary-window readiness, transcription, and paste. A separate machine-wide ownership lease ensures that only one production, development, or disposable Profile can register global dictation at a time; loss is detected out of process and synchronously converges local native bindings and helper presentation to inactive. Renderer commands carry session/request identity; native events carry configuration/process generations, so late messages are ignored. Renderer teardown releases its microphone/global ownership, and Profile Scope closure interrupts active transcription and supervision before releasing IPC, helper, window, and machine ownership resources. Native-helper crash cancels the lease, marks capability degraded, and wakes one supervised recovery loop. Recovery uses jittered capped exponential backoff and atomically replays the complete desired binding set; expected configuration or permission rejection does not poison transport health. Clipboard restoration is conditional, so process delay or a new user copy cannot replay stale clipboard state. See [Dictation Behavior](product-specs/dictation-behavior.md) for visible behavior.

### Browser, Computer Use, Terminal, and Files

These are Main-owned runtime aggregates. Renderer surfaces hold presentation
descriptors and generation-fenced host bindings, not the runtime itself.
Unmounting, panel animation, or navigation cannot implicitly destroy or reassign
a live runtime. Explicit close/kill, owner teardown, app shutdown, or bounded
retention owns termination.

Browser guest attachment, readiness-sensitive messages, capture geometry,
downloads, and Computer Use native helpers are bounded and fail closed when the
verified runtime is unavailable. Their sandbox and peer trust requirements are
owned by [Security](SECURITY.md); product lifecycle is owned by
[Workbench Shell](product-specs/workbench-shell.md) and
[Codex Workspace Behavior](product-specs/codex-workspace-behavior.md).

Editable Files retain recoverable local drafts and use compare-and-swap save.
External changes preserve both versions in a conflict surface; close or preview
replacement cannot discard a dirty/conflicted draft silently.

### Git Review

One dedicated generation-bound worker owns each repository read plane. A stale
or canceled read never replaces a newer generation. Mutation invalidates the
same worker, and Review preserves its current visible snapshot until a coherent
replacement is ready.

The ownership decision is [ADR 0036](adr/0042-dedicated-git-read-worker.md), and
the visible contract is [Review Right Panel Behavior](product-specs/review-right-panel-behavior.md).

### Automations and reminders

Core owns definitions, schedules, occurrences, leases, run/inbox state, and
receipts. Host executors and notification delivery revalidate authority after
every async claim. Recovery defers work; it never starts an agent or notification
from a lease tied to the previous authority generation.
The Main application scope owns reminder and scheduled-agent timers, native
reminder notifications, and the system-resume listener as one runtime.

Read [Scheduled Route Behavior](product-specs/scheduled-route-behavior.md),
[Calendar and Reminders Behavior](product-specs/calendar-and-reminders-behavior.md),
and [Desktop Notification Behavior](product-specs/desktop-notification-behavior.md).

## Failure matrix

| Failure                                | Required response                                                                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mutation validation/conflict           | No state change; preserve authored input and return typed recovery guidance                                                                                                                                                                                                                  |
| Response lost after commit             | Replay the immutable receipt for the same intent                                                                                                                                                                                                                                             |
| Projection patch gap or stale read     | Fence affected state and coalesce a bounded canonical read                                                                                                                                                                                                                                   |
| Document update bytes compacted        | Canonical Document resync; never fabricate an empty update                                                                                                                                                                                                                                   |
| Exact resource authorization lost      | Revoke/evict before post-state presentation; later operations reauthorize                                                                                                                                                                                                                    |
| Core transport generation lost         | Single-flight reconnect to the same Profile/Library/Store epoch                                                                                                                                                                                                                              |
| Repeated Core losses                   | Open bounded circuit and show one app-wide Retry/Restart state                                                                                                                                                                                                                               |
| Codex app-server session lost          | Reject that session's pending requests, retire its child, then reconnect with one bounded supervisor; never carry pending RPC state into the replacement generation                                                                                                                          |
| Thread resume/start buffer saturated   | Fail the exact Codex generation and canonically read the Thread after replacement; never apply a later occurrence ahead of a dropped predecessor                                                                                                                                             |
| Worktree worker ingress saturated      | Terminate the exact worker generation, reject its pending operations, and let durable worktree reconciliation recover accepted work; never drop a progress/result message while keeping that worker ready                                                                                    |
| Main shutdown requested repeatedly     | Close the one process scope idempotently; report finalizer failures and continue later cleanup                                                                                                                                                                                               |
| Document/Canvas stream gap             | New exact live barrier plus canonical engine sync                                                                                                                                                                                                                                            |
| Files external edit during local draft | Preserve local and external versions in explicit conflict state                                                                                                                                                                                                                              |
| Browser/Terminal surface unmount       | Preserve Main-owned runtime unless explicit lifecycle closes it                                                                                                                                                                                                                              |
| Managed-worktree removal interrupted   | Preserve the snapshot ref or physical worktree; never clear the durable Chat location to hide failure                                                                                                                                                                                        |
| Chat handoff interrupted               | Reconcile the Main journal against Core's canonical execution location; finish commit or compensate while retaining at least one complete checkout. Cross-host cleanup locates an unknown completed import by its operation-scoped destination ref before deleting any destination artifact. |
| Backup or maintenance authority lost   | Stop/defer remaining work; do not publish retention or notification side effects                                                                                                                                                                                                             |
| Restore interrupted                    | Journal recovery yields the complete old or complete new Store/assets                                                                                                                                                                                                                        |
| Store epoch changed                    | Invalidate every old transport, outbox, checkpoint, lease, and subscription; relaunch                                                                                                                                                                                                        |
| Unsupported/corrupt Store              | Fail closed after preserving diagnostic/backup evidence where safe                                                                                                                                                                                                                           |
| Packaged runtime missing/tampered      | Disable the dependent capability; never fall back to ambient binaries                                                                                                                                                                                                                        |

## Operational evidence

Testing commands and suite selection live in [AGENTS.md](../AGENTS.md) and
[Development](development.md). Choose checks from the changed reliability seam:

- semantic mutations: focused Module/receipt/idempotency tests;
- projection delivery: gap, replay, revoke, reset, and canonical-repair tests;
- Document/Canvas: exact barrier, response-loss, generation, outbox, and
  compaction/resync tests;
- Core lifecycle: selection, authentication, same-authority recovery, circuit,
  shutdown fence, and idle-drain tests;
- migrations: frozen/current inventories, backup/staging, interruption, and
  semantic validation;
- backup/restore: every journal interruption phase, asset closure, epoch
  rotation, and stale-client rejection;
- release runtime: source gate, target-specific packaged verification, signed
  dual-architecture rehearsal, and immutable Release Bundle checks.

For Core read-model or transport changes, run the repository read-budget gate
and retain its byte/request/query-plan evidence. The transport maximum is a
fault boundary, not a target for an interactive projection.

Build, signing, notarization, appcast/delta, Homebrew, landing, runtime manifest,
and Release recovery procedures belong in
[the macOS Release Runbook](release-macos.md). Release identity and supply-chain
trust belong in [Security](SECURITY.md). Do not duplicate those inventories
here.

## Documentation ownership

| Information                                                 | Owner                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| Cross-system reliability layers and failure outcomes        | This document                                                               |
| Core selection, generation recovery, Store migration policy | [Core lifecycle and Store](reliability/core-lifecycle-and-store.md)         |
| LocalCommit, delivery, projection freshness, visibility     | [LocalCommit and projections](reliability/local-commit-and-projections.md)  |
| Document/Canvas sync, semantic history, retention           | [Document sync/history](reliability/document-sync-history-and-retention.md) |
| Backup, restore, Store replacement, maintenance             | [Backup/restore](reliability/backup-restore-and-maintenance.md)             |
| User-visible feature failure/recovery behavior              | Focused document in [Product Specifications](product-specs/index.md)        |
| Runtime ownership and critical flows                        | [Architecture](ARCHITECTURE.md) and ADRs                                    |
| Trust, sandbox, authorization, supply chain                 | [Security](SECURITY.md)                                                     |
| Exact schema versions, limits, filenames, protocol versions | Source contracts, generated artifacts, and tests                            |
| Release procedures and operational recovery                 | [macOS Release Runbook](release-macos.md)                                   |

Replace stale statements at the narrow owner. Do not append migration history,
per-file behavior, release inventories, or feature acceptance rules to this map.
